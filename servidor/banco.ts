import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// Abre o banco local e cria a tabela na primeira execução.
export const banco = new DatabaseSync(process.env.AGENDA_DB ?? fileURLToPath(new URL("../agenda.sqlite", import.meta.url)));
banco.exec(`
  CREATE TABLE IF NOT EXISTS reservas (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    servico_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    inicio INTEGER NOT NULL,
    fim INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS servicos (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    duracaoMinutos INTEGER NOT NULL,
    precoCentavos INTEGER
  );
  CREATE TABLE IF NOT EXISTS expediente (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    dias INTEGER NOT NULL,
    abertura TEXT NOT NULL,
    fechamento TEXT NOT NULL,
    inicioPausa TEXT,
    fimPausa TEXT
  );
  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    telefone TEXT NOT NULL UNIQUE,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS links_cliente (
    cliente_id INTEGER NOT NULL REFERENCES clientes(id),
    tipo TEXT NOT NULL CHECK (tipo IN ('verificacao', 'recuperacao')),
    email TEXT NOT NULL,
    digest TEXT UNIQUE,
    expira_em INTEGER NOT NULL,
    solicitado_em INTEGER NOT NULL,
    janela_inicio INTEGER NOT NULL,
    envios INTEGER NOT NULL,
    PRIMARY KEY (cliente_id, tipo)
  );
  CREATE TABLE IF NOT EXISTS avisos_whatsapp (
    id INTEGER PRIMARY KEY,
    reserva_id INTEGER NOT NULL,
    anterior TEXT NOT NULL,
    novo TEXT NOT NULL,
    proxima_tentativa INTEGER NOT NULL,
    tentativas INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS bloqueios (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    inicio INTEGER NOT NULL,
    fim INTEGER NOT NULL,
    CHECK (inicio >= 0 AND fim <= 1440 AND inicio < fim)
  );
  CREATE INDEX IF NOT EXISTS bloqueios_data ON bloqueios (data);
  INSERT OR IGNORE INTO expediente VALUES (1, 127, '09:00', '18:00', NULL, NULL);
  INSERT OR IGNORE INTO servicos VALUES
    (1, 'Corte de cabelo', 30, NULL),
    (2, 'Barba', 20, NULL),
    (3, 'Corte e barba', 50, NULL);
`);

// As contas que já existem podem adicionar um e-mail após entrar pelo telefone.
if (!banco.prepare("PRAGMA table_info(clientes)").all().some(({ name }) => name === "email_verificado")) {
  banco.exec("ALTER TABLE clientes ADD COLUMN email_verificado TEXT");
}
banco.exec("CREATE UNIQUE INDEX IF NOT EXISTS clientes_email_verificado ON clientes (email_verificado) WHERE email_verificado IS NOT NULL");

// Acrescenta os campos de histórico sem recriar a tabela de reservas.
const colunasReserva = banco.prepare("PRAGMA table_info(reservas)").all().map(({ name }) => name);
if (!colunasReserva.includes("cliente_id")) {
  banco.exec("ALTER TABLE reservas ADD COLUMN cliente_id INTEGER REFERENCES clientes(id)");
}
if (!colunasReserva.includes("cancelada_em")) {
  banco.exec("ALTER TABLE reservas ADD COLUMN cancelada_em TEXT");
}
if (!colunasReserva.includes("servico_nome")) {
  banco.exec("ALTER TABLE reservas ADD COLUMN servico_nome TEXT");
  banco.exec("UPDATE reservas SET servico_nome = (SELECT nome FROM servicos WHERE id = reservas.servico_id)");
}
if (!colunasReserva.includes("comparecimento")) {
  banco.exec(`ALTER TABLE reservas ADD COLUMN comparecimento TEXT
    CHECK (comparecimento IN ('concluido', 'falta'))`);
}
banco.exec("CREATE INDEX IF NOT EXISTS reservas_cliente_data ON reservas (cliente_id, data DESC, inicio DESC)");

// Os avisos antigos ainda na fila começam como pendentes.
const colunasAviso = banco.prepare("PRAGMA table_info(avisos_whatsapp)").all().map(({ name }) => name);
if (!colunasAviso.includes("estado")) {
  banco.exec("ALTER TABLE avisos_whatsapp ADD COLUMN estado TEXT NOT NULL DEFAULT 'pendente'");
}
if (!colunasAviso.includes("erro")) {
  banco.exec("ALTER TABLE avisos_whatsapp ADD COLUMN erro TEXT");
}
