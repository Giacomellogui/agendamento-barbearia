import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// As páginas e os arquivos compilados são carregados ao iniciar o servidor.
const pagina = readFileSync(new URL("./index.html", import.meta.url));
const estilos = readFileSync(new URL("./estilos.css", import.meta.url));
const fotoBarbearia = readFileSync(new URL("./assets/barbearia.png", import.meta.url));
const tema = readFileSync(new URL("./tema.js", import.meta.url));
const agendamento = readFileSync(new URL("./agendamento.js", import.meta.url));
const painel = readFileSync(new URL("./painel.html", import.meta.url));
const scriptPainel = readFileSync(new URL("./painel.js", import.meta.url));
const login = readFileSync(new URL("./login.html", import.meta.url));
const cadastroCliente = readFileSync(new URL("./cadastro-cliente.html", import.meta.url));
const loginCliente = readFileSync(new URL("./login-cliente.html", import.meta.url));
// A senha vem do ambiente. A sessão fica em memória e expira após oito horas.
const senha = process.env.BARBEIRO_SENHA;
const duracaoSessao = 8 * 60 * 60;
let sessao: { token: string; expira: number } | undefined;

// Produz um valor de tamanho fixo para a comparação da senha do barbeiro.
function hashSenha(valor: string) {
  return createHash("sha256").update(valor).digest();
}

// Confere se o cookie pertence à sessão ativa.
function autenticado(req: IncomingMessage) {
  const cookie = req.headers.cookie?.split(";").map((item) => item.trim())
    .find((item) => item.startsWith("sessao_barbearia="));
  return !!sessao && Date.now() < sessao.expira &&
    cookie === `sessao_barbearia=${sessao.token}`;
}

// O navegador abre o destino com GET após o envio de um formulário.
function redirecionar(res: ServerResponse, destino: string) {
  res.writeHead(303, { Location: destino, "Cache-Control": "no-store" });
  res.end();
}
// Abre o banco local e cria a tabela na primeira execução.
const banco = new DatabaseSync(fileURLToPath(new URL("./agenda.sqlite", import.meta.url)));
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
  CREATE TABLE IF NOT EXISTS avisos_whatsapp (
    id INTEGER PRIMARY KEY,
    reserva_id INTEGER NOT NULL,
    anterior TEXT NOT NULL,
    novo TEXT NOT NULL,
    proxima_tentativa INTEGER NOT NULL,
    tentativas INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO expediente VALUES (1, 127, '09:00', '18:00', NULL, NULL);
  INSERT OR IGNORE INTO servicos VALUES
    (1, 'Corte de cabelo', 30, NULL),
    (2, 'Barba', 20, NULL),
    (3, 'Corte e barba', 50, NULL);
`);

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
banco.exec("CREATE INDEX IF NOT EXISTS reservas_cliente_data ON reservas (cliente_id, data DESC, inicio DESC)");
// A consulta de sessão retorna o perfil. O hash e o salt são usados no login.
const clientePorId = banco.prepare("SELECT id, nome, telefone FROM clientes WHERE id = ?");
const clientePorTelefone = banco.prepare("SELECT id, salt, hash FROM clientes WHERE telefone = ?");
const inserirCliente = banco.prepare(`
  INSERT INTO clientes (nome, telefone, salt, hash) VALUES (?, ?, ?, ?)
  ON CONFLICT(telefone) DO NOTHING RETURNING id
`);
const derivarSenha = promisify(scrypt);
const sessoesClientes = new Map<string, { id: number; expira: number }>();

// Salva telefones com DDD em um formato único para a busca da conta.
function telefoneNormalizado(valor: string) {
  if (!/^\+?[\d\s().-]+$/.test(valor)) return "";
  const digitos = valor.replace(/\D/g, "");
  const nacional = /^55\d{10,11}$/.test(digitos) ? digitos.slice(2) : digitos;
  return /^\d{10,11}$/.test(nacional) ? nacional : "";
}

function tokenCliente(req: IncomingMessage) {
  return req.headers.cookie?.match(/(?:^|;\s*)sessao_cliente=([a-f0-9]{64})(?:;|$)/)?.[1] ?? "";
}

function clienteAutenticado(req: IncomingMessage) {
  const token = tokenCliente(req);
  const cliente = sessoesClientes.get(token);
  if (cliente && Date.now() < cliente.expira) return clientePorId.get(cliente.id);
  sessoesClientes.delete(token);
}

// Gera um token aleatório e o envia em um cookie inacessível ao JavaScript.
function iniciarSessaoCliente(req: IncomingMessage, res: ServerResponse, id: number) {
  const agora = Date.now();
  for (const [token, sessao] of sessoesClientes) {
    if (sessao.expira <= agora) sessoesClientes.delete(token);
  }
  sessoesClientes.delete(tokenCliente(req));
  const token = randomBytes(32).toString("hex");
  sessoesClientes.set(token, { id, expira: agora + duracaoSessao * 1000 });
  res.setHeader("Set-Cookie", `sessao_cliente=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${duracaoSessao}`);
}

// O catálogo e o expediente são editados pelo barbeiro e persistem no SQLite.
const listarServicos = banco.prepare("SELECT * FROM servicos ORDER BY id");
const consultarServico = banco.prepare("SELECT * FROM servicos WHERE id = ?");
const criarServico = banco.prepare("INSERT INTO servicos (nome, duracaoMinutos, precoCentavos) VALUES (?, ?, ?) RETURNING *");
const editarServico = banco.prepare("UPDATE servicos SET nome = ?, duracaoMinutos = ?, precoCentavos = ? WHERE id = ? RETURNING *");
const consultarExpediente = banco.prepare("SELECT dias, abertura, fechamento, inicioPausa, fimPausa FROM expediente WHERE id = 1");
const salvarExpediente = banco.prepare("UPDATE expediente SET dias = ?, abertura = ?, fechamento = ?, inicioPausa = ?, fimPausa = ? WHERE id = 1");

function minutos(hora: unknown) {
  if (typeof hora !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hora)) return NaN;
  return Number(hora.slice(0, 2)) * 60 + Number(hora.slice(3));
}

// Há sobreposição quando cada intervalo começa antes do fim do outro.
const conflitos = banco.prepare(`
  SELECT 1 FROM reservas WHERE data = ? AND inicio < ? AND fim > ? AND cancelada_em IS NULL
`);
// Confere conflitos e insere a reserva na mesma instrução SQL.
const inserirReserva = banco.prepare(`
  INSERT INTO reservas (nome, servico_id, data, inicio, fim, cliente_id, servico_nome)
  SELECT ?, ?, ?, ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1 FROM reservas WHERE data = ? AND inicio < ? AND fim > ? AND cancelada_em IS NULL
  )
`);
const listarReservas = banco.prepare(`
  SELECT r.id, r.nome, r.servico_id, r.inicio, r.fim,
    COALESCE(r.servico_nome, s.nome, 'Serviço indisponível') AS servico, c.telefone
  FROM reservas r LEFT JOIN servicos s ON s.id = r.servico_id
  LEFT JOIN clientes c ON c.id = r.cliente_id
  WHERE r.data = ? AND r.cancelada_em IS NULL ORDER BY r.inicio
`);
// O histórico mantém reservas canceladas e limita a consulta à conta autenticada.
const historicoCliente = banco.prepare(`
  SELECT r.id, r.data, r.inicio, r.fim,
    COALESCE(r.servico_nome, s.nome, 'Serviço indisponível') AS servico,
    r.cancelada_em IS NOT NULL AS cancelada
  FROM reservas r LEFT JOIN servicos s ON s.id = r.servico_id
  WHERE r.cliente_id = ? ORDER BY r.data DESC, r.inicio DESC, r.id DESC
`);
// Marca a reserva como cancelada para liberar o horário e preservar o registro.
const cancelarReserva = banco.prepare(
  "UPDATE reservas SET cancelada_em = CURRENT_TIMESTAMP WHERE id = ? AND cancelada_em IS NULL",
);
const reservaDoCliente = banco.prepare(
  "SELECT data, inicio, fim FROM reservas WHERE id = ? AND cliente_id = ? AND cancelada_em IS NULL",
);
// Exclui a própria reserva da comparação de horários ao reagendar.
const conflitosReagendamento = banco.prepare(`
  SELECT 1 FROM reservas WHERE data = ? AND inicio < ? AND fim > ? AND id <> ? AND cancelada_em IS NULL
`);
const reagendarReserva = banco.prepare(`
  UPDATE reservas SET data = ?, inicio = ?, fim = ?
  WHERE id = ? AND cliente_id = ? AND cancelada_em IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM reservas WHERE data = ? AND inicio < ? AND fim > ? AND id <> ? AND cancelada_em IS NULL
    )
`);
const enfileirarAviso = banco.prepare(`
  INSERT INTO avisos_whatsapp (reserva_id, anterior, novo, proxima_tentativa) VALUES (?, ?, ?, ?)
`);
const proximoAviso = banco.prepare("SELECT * FROM avisos_whatsapp WHERE proxima_tentativa <= ? ORDER BY id LIMIT 1");
const excluirAviso = banco.prepare("DELETE FROM avisos_whatsapp WHERE id = ?");
const adiarAviso = banco.prepare("UPDATE avisos_whatsapp SET tentativas = tentativas + 1, proxima_tentativa = ? WHERE id = ?");
// Lê as credenciais no ambiente do servidor sem expor os valores no terminal.
const whatsappToken = process.env.WHATSAPP_TOKEN?.trim() ?? "";
const whatsappRemetente = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
const whatsappDestino = process.env.WHATSAPP_BARBEIRO_NUMERO?.trim() ?? "";
const whatsappModelo = process.env.WHATSAPP_TEMPLATE?.trim() ?? "";
const whatsappVersao = process.env.WHATSAPP_GRAPH_VERSION?.trim() ?? "v27.0";
const whatsappInvalidos = [
  [Boolean(whatsappToken), "WHATSAPP_TOKEN"],
  [/^\d+$/.test(whatsappRemetente), "WHATSAPP_PHONE_NUMBER_ID"],
  [/^[1-9]\d{7,14}$/.test(whatsappDestino), "WHATSAPP_BARBEIRO_NUMERO"],
  [/^[a-z0-9_]+$/.test(whatsappModelo), "WHATSAPP_TEMPLATE"],
  [/^v\d+\.\d+$/.test(whatsappVersao), "WHATSAPP_GRAPH_VERSION"],
].filter(([valido]) => !valido).map(([, nome]) => nome);
const whatsappConfigurado = whatsappInvalidos.length === 0;

let enviandoAvisos = false;
// A fila fica no SQLite para sobreviver a falhas temporárias do WhatsApp ou reinícios.
async function enviarAvisos() {
  if (!whatsappConfigurado || enviandoAvisos) return;
  enviandoAvisos = true;
  try {
    for (let enviados = 0; enviados < 10; enviados++) {
      const aviso = proximoAviso.get(Date.now());
      if (!aviso) break;
      try {
        // A ordem dos três parâmetros deve corresponder ao modelo aprovado na Meta.
        const resposta = await fetch(`https://graph.facebook.com/${whatsappVersao}/${whatsappRemetente}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${whatsappToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: whatsappDestino,
            type: "template",
            template: {
              name: whatsappModelo,
              language: { code: "pt_BR" },
              components: [{
                type: "body",
                parameters: [aviso.reserva_id, aviso.anterior, aviso.novo]
                  .map((valor) => ({ type: "text", text: String(valor) })),
              }],
            },
          }),
          signal: AbortSignal.timeout(8000),
        });
        const resultado = await resposta.json().catch(() => null) as {
          messages?: Array<{ id?: string }>;
          error?: { code?: number; error_subcode?: number };
        } | null;
        if (!resposta.ok) {
          const codigo = resultado?.error?.code;
          const subcodigo = resultado?.error?.error_subcode;
          const detalhes = [
            `HTTP ${resposta.status}`,
            Number.isInteger(codigo) ? `Meta ${codigo}` : "",
            Number.isInteger(subcodigo) ? `subcódigo ${subcodigo}` : "",
          ].filter(Boolean).join(", ");
          console.warn(`WhatsApp recusou o aviso da reserva #${aviso.reserva_id} (${detalhes}).`);
          throw new Error("Aviso recusado");
        }
        if (!resultado?.messages?.[0]?.id) throw new Error("Aviso sem confirmação da API");
        excluirAviso.run(aviso.id);
        console.info(`WhatsApp aceitou o aviso da reserva #${aviso.reserva_id}. Confira a entrega no celular.`);
      } catch {
        // Aumenta o intervalo entre tentativas após falhas, até o limite de uma hora.
        const espera = Math.min(3600, 30 * 2 ** Math.min(Number(aviso.tentativas), 7));
        adiarAviso.run(Date.now() + espera * 1000, aviso.id);
        console.warn("Aviso de reagendamento pendente no WhatsApp. Confira a configuração e a conexão.");
      }
    }
  } finally {
    enviandoAvisos = false;
  }
}

function descreverHorario(data: string, inicio: number) {
  const [ano, mes, dia] = data.split("-");
  const hora = String(Math.floor(inicio / 60)).padStart(2, "0");
  const minuto = String(inicio % 60).padStart(2, "0");
  return `${dia}/${mes}/${ano} às ${hora}:${minuto}`;
}

// O cliente só pode alterar a reserva antes do horário de início.
function reservaFutura(data: string, inicio: number) {
  const horario = new Date(`${data}T00:00:00`);
  horario.setMinutes(inicio);
  return horario.getTime() > Date.now();
}

function responderJson(res: ServerResponse, status: number, dados: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(dados));
}

// Valida a data e calcula os horários em que o serviço inteiro cabe no expediente.
function horariosPossiveis(data: unknown, duracao: number) {
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return [];
  const dia = new Date(`${data}T00:00:00Z`);
  if (Number.isNaN(dia.getTime()) || dia.toISOString().slice(0, 10) !== data) return [];

  const agora = new Date();
  const hoje = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}-${String(agora.getDate()).padStart(2, "0")}`;
  if (data < hoje) return [];

  const expediente = consultarExpediente.get()!;
  if (!(Number(expediente.dias) & (1 << dia.getUTCDay()))) return [];
  const abertura = minutos(expediente.abertura);
  const fechamento = minutos(expediente.fechamento);
  const inicioPausa = minutos(expediente.inicioPausa);
  const fimPausa = minutos(expediente.fimPausa);

  // Os horários são calculados em minutos desde a meia-noite.
  const horarios = [];
  const minutoAtual = agora.getHours() * 60 + agora.getMinutes();
  for (let inicio = abertura; inicio + duracao <= fechamento; inicio += 30) {
    if (data === hoje && inicio <= minutoAtual) continue;
    if (inicio < fimPausa && inicio + duracao > inicioPausa) continue;
    const hora = String(Math.floor(inicio / 60)).padStart(2, "0");
    const minuto = String(inicio % 60).padStart(2, "0");
    horarios.push({ inicio, texto: `${hora}:${minuto}` });
  }
  return horarios;
}

// Lê o corpo da requisição em partes e limita os dados mantidos em memória.
async function lerCorpo(req: IncomingMessage) {
  const partes: Buffer[] = [];
  let tamanho = 0;
  for await (const parte of req) {
    tamanho += parte.length;
    if (tamanho <= 4096) partes.push(parte);
  }
  if (tamanho > 4096) return null;
  return Buffer.concat(partes).toString("utf8");
}

async function lerJson(req: IncomingMessage) {
  return lerCorpo(req).then((corpo) => JSON.parse(corpo ?? "null")).catch(() => null);
}

// Cada rota combina o método HTTP com o caminho pedido pelo navegador.
const servidor = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  // O cadastro e o login do cliente usam uma sessão separada da do barbeiro.
  const criandoConta = url.pathname === "/cliente/cadastro";
  if (criandoConta || url.pathname === "/cliente/login") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(criandoConta ? cadastroCliente : loginCliente);
      return;
    }
    if (req.method === "POST") {
      if (req.headers["sec-fetch-site"] === "cross-site") {
        responderJson(res, 403, { mensagem: "Abra o formulário da barbearia para continuar." });
        return;
      }
      const corpo = await lerCorpo(req).catch(() => null);
      const dados = new URLSearchParams(corpo ?? "");
      const telefone = telefoneNormalizado(dados.get("telefone") ?? "");
      const senhaCliente = dados.get("senha") ?? "";
      const nome = (dados.get("nome") ?? "").trim().replace(/\s+/g, " ");
      if (!telefone || senhaCliente.length < 8 || senhaCliente.length > 128 ||
          (criandoConta && (nome.length > 100 || !/^\S+ .+/.test(nome)))) {
        redirecionar(res, `${url.pathname}?erro=dados`);
        return;
      }
      const cadastro = criandoConta ? undefined : clientePorTelefone.get(telefone);
      // Deriva a senha com scrypt e um salt armazenado junto à conta.
      const salt = cadastro ? String(cadastro.salt) : randomBytes(16).toString("hex");
      const hash = await derivarSenha(senhaCliente, salt, 64).catch(() => null) as Buffer | null;
      if (!hash) {
        responderJson(res, 503, { mensagem: "Não foi possível acessar a conta. Tente novamente." });
        return;
      }
      if (criandoConta) {
        const cliente = inserirCliente.get(nome, telefone, salt, hash.toString("hex"));
        if (!cliente) {
          redirecionar(res, "/cliente/cadastro?erro=telefone");
          return;
        }
        iniciarSessaoCliente(req, res, Number(cliente.id));
      } else {
        if (!cadastro || !timingSafeEqual(hash, Buffer.from(String(cadastro.hash), "hex"))) {
          redirecionar(res, "/cliente/login?erro=credenciais");
          return;
        }
        iniciarSessaoCliente(req, res, Number(cadastro.id));
      }
      redirecionar(res, "/");
      return;
    }
  }
  if (url.pathname === "/cliente/sessao" && req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    const cliente = clienteAutenticado(req);
    responderJson(res, 200, cliente ? { nome: cliente.nome } : null);
    return;
  }
  if (url.pathname === "/cliente/agendamentos" && req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    const cliente = clienteAutenticado(req);
    if (!cliente) {
      responderJson(res, 401, { mensagem: "Entre para consultar sua agenda." });
      return;
    }
    const reservas = historicoCliente.all(cliente.id).map((reserva) => ({
      ...reserva,
      cancelada: Boolean(reserva.cancelada),
      editavel: !reserva.cancelada && reservaFutura(String(reserva.data), Number(reserva.inicio)),
    }));
    responderJson(res, 200, reservas);
    return;
  }
  // Verifica se a reserva pertence ao cliente e pode ser alterada.
  const rotaReservaCliente = /^\/cliente\/agendamentos\/(\d+)$/.exec(url.pathname);
  if (rotaReservaCliente && (req.method === "GET" || req.method === "PUT" || req.method === "DELETE")) {
    const dados = req.method === "PUT" ? await lerJson(req) : null;
    res.setHeader("Cache-Control", "no-store");
    const cliente = clienteAutenticado(req);
    if (!cliente) {
      responderJson(res, 401, { mensagem: "Entre para alterar sua reserva." });
      return;
    }
    const id = Number(rotaReservaCliente[1]);
    const reserva = Number.isSafeInteger(id) ? reservaDoCliente.get(id, cliente.id) : undefined;
    if (!reserva || !reservaFutura(String(reserva.data), Number(reserva.inicio))) {
      responderJson(res, 404, { mensagem: "Esta reserva futura não está disponível." });
      return;
    }
    if (req.method === "DELETE") {
      cancelarReserva.run(id);
      responderJson(res, 200, { mensagem: "Agendamento cancelado." });
      return;
    }
    // Mantém a duração original da reserva mesmo após mudanças no catálogo.
    const duracao = Number(reserva.fim) - Number(reserva.inicio);
    if (req.method === "GET") {
      const data = url.searchParams.get("data") ?? "";
      const horarios = horariosPossiveis(data, duracao)
        .filter(({ inicio }) => !(data === reserva.data && inicio === reserva.inicio))
        .filter(({ inicio }) => !conflitosReagendamento.get(data, inicio + duracao, inicio, id))
        .map(({ texto }) => texto);
      responderJson(res, 200, horarios);
      return;
    }
    const data: unknown = dados?.data;
    const horario = horariosPossiveis(data, duracao).find(({ texto }) => texto === dados?.horario);
    if (typeof data !== "string" || !horario || (data === reserva.data && horario.inicio === reserva.inicio)) {
      responderJson(res, 400, { mensagem: "Escolha uma data e um horário diferentes dos atuais." });
      return;
    }
    const { inicio } = horario;
    const fim = inicio + duracao;
    // Salva o novo horário e a entrada na fila de avisos na mesma transação.
    banco.exec("BEGIN IMMEDIATE");
    try {
      const alterada = reagendarReserva.run(data, inicio, fim, id, cliente.id, data, fim, inicio, id);
      if (alterada.changes === 0) {
        banco.exec("ROLLBACK");
        responderJson(res, 409, { mensagem: "Esse horário já foi ocupado. Escolha outro." });
        return;
      }
      if (whatsappConfigurado) {
        enfileirarAviso.run(id, descreverHorario(String(reserva.data), Number(reserva.inicio)),
          descreverHorario(data, inicio), Date.now());
      }
      banco.exec("COMMIT");
    } catch {
      banco.exec("ROLLBACK");
      responderJson(res, 500, { mensagem: "Não foi possível reagendar. Tente novamente." });
      return;
    }
    responderJson(res, 200, { mensagem: "Agendamento remarcado." });
    void enviarAvisos();
    return;
  }
  if (url.pathname === "/cliente/sair" && req.method === "POST") {
    sessoesClientes.delete(tokenCliente(req));
    res.setHeader("Set-Cookie", "sessao_cliente=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    redirecionar(res, "/");
    return;
  }
  // Exibe o login e cria uma sessão quando a senha confere.
  if (url.pathname === "/login" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(login);
    return;
  }
  if (url.pathname === "/login" && req.method === "POST") {
    if (!senha) {
      redirecionar(res, "/login?erro=configuracao");
      return;
    }
    const corpo = await lerCorpo(req).catch(() => null);
    const informada = new URLSearchParams(corpo ?? "").get("senha") ?? "";
    if (!timingSafeEqual(hashSenha(informada), hashSenha(senha))) {
      redirecionar(res, "/login?erro=senha");
      return;
    }
    sessao = { token: randomBytes(32).toString("hex"), expira: Date.now() + duracaoSessao * 1000 };
    res.setHeader("Set-Cookie", `sessao_barbearia=${sessao.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${duracaoSessao}`);
    redirecionar(res, "/painel");
    return;
  }
  // Encerra a sessão e remove o cookie do navegador.
  if (url.pathname === "/sair" && req.method === "POST") {
    if (autenticado(req)) sessao = undefined;
    res.setHeader("Set-Cookie", "sessao_barbearia=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    redirecionar(res, "/login");
    return;
  }
  // Entrega a página de agendamento e os arquivos usados pelo navegador.
  if (req.method === "GET" && url.pathname === "/") {
    if (!clienteAutenticado(req)) {
      redirecionar(res, "/cliente/login");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(pagina);
    return;
  }
  if (req.method === "GET" && url.pathname === "/estilos.css") {
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    res.end(estilos);
    return;
  }
  if (req.method === "GET" && url.pathname === "/assets/barbearia.png") {
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    res.end(fotoBarbearia);
    return;
  }
  if (req.method === "GET" && url.pathname === "/agendamento.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(agendamento);
    return;
  }
  if (req.method === "GET" && url.pathname === "/tema.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(tema);
    return;
  }
  if (req.method === "GET" && url.pathname === "/painel.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(scriptPainel);
    return;
  }
  if (req.method === "GET" && url.pathname === "/servicos") {
    res.setHeader("Cache-Control", "no-store");
    responderJson(res, 200, listarServicos.all());
    return;
  }
  const rotaServico = /^\/servicos\/(\d+)$/.exec(url.pathname);
  if ((req.method === "POST" && url.pathname === "/servicos") ||
      (req.method === "PUT" && rotaServico)) {
    const dados = await lerJson(req);
    if (!autenticado(req)) {
      responderJson(res, 401, { mensagem: "Entre no painel para alterar serviços." });
      return;
    }
    const nome = typeof dados?.nome === "string" ? dados.nome.trim() : "";
    const duracao = dados?.duracaoMinutos;
    const preco = dados?.precoCentavos;
    if (!nome || nome.length > 100 || !Number.isInteger(duracao) || duracao < 1 || duracao > 1439 ||
        (preco !== null && (!Number.isSafeInteger(preco) || preco < 0 || preco > 99999999))) {
      responderJson(res, 400, { mensagem: "Informe um nome, uma duração válida e um preço de até R$ 999.999,99." });
      return;
    }
    const servico = rotaServico
      ? editarServico.get(nome, duracao, preco, Number(rotaServico[1]))
      : criarServico.get(nome, duracao, preco);
    if (!servico) {
      responderJson(res, 404, { mensagem: "Serviço não encontrado." });
      return;
    }
    responderJson(res, rotaServico ? 200 : 201, { mensagem: "Serviço salvo.", servico });
    return;
  }
  if (url.pathname === "/expediente" && (req.method === "GET" || req.method === "PUT")) {
    const dados = req.method === "PUT" ? await lerJson(req) : null;
    res.setHeader("Cache-Control", "no-store");
    if (!autenticado(req)) {
      responderJson(res, 401, { mensagem: "Entre no painel para acessar o expediente." });
      return;
    }
    if (req.method === "GET") {
      responderJson(res, 200, consultarExpediente.get());
      return;
    }
    const { dias, abertura, fechamento, inicioPausa, fimPausa } = dados ?? {};
    const inicio = minutos(abertura);
    const fim = minutos(fechamento);
    const pausaInicio = minutos(inicioPausa);
    const pausaFim = minutos(fimPausa);
    const pausaValida = (inicioPausa === null && fimPausa === null) ||
      (inicio <= pausaInicio && pausaInicio < pausaFim && pausaFim <= fim);
    if (!Number.isInteger(dias) || dias < 0 || dias > 127 || !(inicio < fim) || !pausaValida) {
      responderJson(res, 400, { mensagem: "Confira os dias, a ordem dos horários e se a pausa está dentro do expediente." });
      return;
    }
    salvarExpediente.run(dias, abertura, fechamento, inicioPausa, fimPausa);
    responderJson(res, 200, { mensagem: "Expediente salvo." });
    return;
  }
  // Protege a página do painel e as operações de consulta e cancelamento.
  if (req.method === "GET" && url.pathname === "/painel") {
    if (!autenticado(req)) {
      redirecionar(res, "/login");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(painel);
    return;
  }
  if (req.method === "GET" && url.pathname === "/agendamentos") {
    res.setHeader("Cache-Control", "no-store");
    if (!autenticado(req)) {
      responderJson(res, 401, { mensagem: "Entre no painel para consultar a agenda." });
      return;
    }
    const data = url.searchParams.get("data");
    if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      responderJson(res, 400, { mensagem: "Escolha uma data." });
      return;
    }
    responderJson(res, 200, listarReservas.all(data));
    return;
  }
  if (req.method === "DELETE" && /^\/agendamentos\/\d+$/.test(url.pathname)) {
    if (!autenticado(req)) {
      responderJson(res, 401, { mensagem: "Entre no painel para cancelar agendamentos." });
      return;
    }
    const id = Number(url.pathname.split("/").at(-1));
    const cancelado = cancelarReserva.run(id).changes > 0;
    responderJson(res, cancelado ? 200 : 404, {
      mensagem: cancelado ? "Agendamento cancelado." : "Agendamento indisponível ou já cancelado.",
    });
    return;
  }
  // Filtra os horários que se sobrepõem a reservas existentes.
  if (req.method === "GET" && url.pathname === "/horarios") {
    const data = url.searchParams.get("data");
    const id = url.searchParams.get("servicoId");
    const servico = id && /^\d+$/.test(id) ? consultarServico.get(Number(id)) : undefined;
    if (!data || !servico) {
      responderJson(res, 400, { mensagem: "Escolha um serviço e uma data." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    const duracao = Number(servico.duracaoMinutos);
    const horarios = horariosPossiveis(data, duracao)
      .filter(({ inicio }) => !conflitos.get(data, inicio + duracao, inicio))
      .map(({ texto }) => texto);
    responderJson(res, 200, horarios);
    return;
  }
  // Valida os dados no servidor e tenta salvar o agendamento.
  if (req.method === "POST" && url.pathname === "/agendamentos") {
    const reserva = await lerJson(req);
    const cliente = clienteAutenticado(req);
    if (!cliente) {
      responderJson(res, 401, { mensagem: "Entre na sua conta para confirmar o agendamento." });
      return;
    }
    const servico = Number.isSafeInteger(reserva?.servicoId)
      ? consultarServico.get(reserva.servicoId) : undefined;
    const data = reserva?.data;
    const duracao = Number(servico?.duracaoMinutos);
    const horario = servico && horariosPossiveis(data, duracao)
      .find(({ texto }) => texto === reserva?.horario);
    if (!servico || !horario) {
      responderJson(res, 400, { mensagem: "Escolha um serviço, uma data e um horário válidos." });
      return;
    }

    const inicio = horario.inicio;
    const fim = inicio + duracao;
    const resultado = inserirReserva.run(cliente.nome, servico.id, data, inicio, fim, cliente.id, servico.nome, data, fim, inicio);
    if (resultado.changes === 0) {
      responderJson(res, 409, { mensagem: "Esse horário já foi ocupado. Escolha outro." });
      return;
    }
    responderJson(res, 201, { mensagem: `Agendamento confirmado para ${horario.texto}.` });
    return;
  }

  res.statusCode = 404;
  res.end("Rota desconhecida");
});

// Escuta apenas no endereço local deste computador.
servidor.listen(3000, "127.0.0.1", () => {
  console.log("Servidor rodando em http://127.0.0.1:3000");
  if (whatsappConfigurado) {
    console.info("WhatsApp configurado. Novos reagendamentos entram na fila de envio.");
    void enviarAvisos();
    setInterval(() => void enviarAvisos(), 15000).unref();
  } else {
    console.info(`WhatsApp desativado. Variáveis ausentes ou inválidas: ${whatsappInvalidos.join(", ")}.`);
  }
});
