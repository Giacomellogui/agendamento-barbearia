import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const pagina = readFileSync(new URL("./index.html", import.meta.url));
const estilos = readFileSync(new URL("./estilos.css", import.meta.url));
const agendamento = readFileSync(new URL("./agendamento.js", import.meta.url));
const painel = readFileSync(new URL("./painel.html", import.meta.url));
const scriptPainel = readFileSync(new URL("./painel.js", import.meta.url));
const login = readFileSync(new URL("./login.html", import.meta.url));
const senha = process.env.BARBEIRO_SENHA;
const duracaoSessao = 8 * 60 * 60;
let sessao: { token: string; expira: number } | undefined;

function hashSenha(valor: string) {
  return createHash("sha256").update(valor).digest();
}

function autenticado(req: IncomingMessage) {
  const cookie = req.headers.cookie?.split(";").map((item) => item.trim())
    .find((item) => item.startsWith("sessao_barbearia="));
  return !!sessao && Date.now() < sessao.expira &&
    cookie === `sessao_barbearia=${sessao.token}`;
}

function redirecionar(res: ServerResponse, destino: string) {
  res.writeHead(303, { Location: destino, "Cache-Control": "no-store" });
  res.end();
}
type Servico = {
  id: number;
  nome: string;
  duracaoMinutos: number;
};

const servicos: Servico[] = [
  { id: 1, nome: "Corte de cabelo", duracaoMinutos: 30 },
  { id: 2, nome: "Barba", duracaoMinutos: 20 },
  { id: 3, nome: "Corte e barba", duracaoMinutos: 50 },
];

const banco = new DatabaseSync(fileURLToPath(new URL("./agenda.sqlite", import.meta.url)));
banco.exec(`
  CREATE TABLE IF NOT EXISTS reservas (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    servico_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    inicio INTEGER NOT NULL,
    fim INTEGER NOT NULL
  )
`);

const conflitos = banco.prepare(`
  SELECT 1 FROM reservas WHERE data = ? AND inicio < ? AND fim > ?
`);
const inserirReserva = banco.prepare(`
  INSERT INTO reservas (nome, servico_id, data, inicio, fim)
  SELECT ?, ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1 FROM reservas WHERE data = ? AND inicio < ? AND fim > ?
  )
`);
const listarReservas = banco.prepare(`
  SELECT id, nome, servico_id, inicio, fim FROM reservas
  WHERE data = ? ORDER BY inicio
`);
const excluirReserva = banco.prepare("DELETE FROM reservas WHERE id = ?");

function responderJson(res: ServerResponse, status: number, dados: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(dados));
}

function horariosPossiveis(data: unknown, duracao: number) {
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return [];
  const dia = new Date(`${data}T00:00:00Z`);
  if (Number.isNaN(dia.getTime()) || dia.toISOString().slice(0, 10) !== data) return [];

  const agora = new Date();
  const hoje = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}-${String(agora.getDate()).padStart(2, "0")}`;
  if (data < hoje) return [];

  const horarios = [];
  const minutoAtual = agora.getHours() * 60 + agora.getMinutes();
  for (let inicio = 9 * 60; inicio + duracao <= 18 * 60; inicio += 30) {
    if (data === hoje && inicio <= minutoAtual) continue;
    const hora = String(Math.floor(inicio / 60)).padStart(2, "0");
    const minuto = String(inicio % 60).padStart(2, "0");
    horarios.push({ inicio, texto: `${hora}:${minuto}` });
  }
  return horarios;
}

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

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
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
  if (url.pathname === "/sair" && req.method === "POST") {
    if (autenticado(req)) sessao = undefined;
    res.setHeader("Set-Cookie", "sessao_barbearia=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    redirecionar(res, "/login");
    return;
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(pagina);
    return;
  }
  if (req.method === "GET" && url.pathname === "/estilos.css") {
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    res.end(estilos);
    return;
  }
  if (req.method === "GET" && url.pathname === "/agendamento.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(agendamento);
    return;
  }
  if (req.method === "GET" && url.pathname === "/painel.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(scriptPainel);
    return;
  }
  if (req.method === "GET" && url.pathname === "/servicos") {
    responderJson(res, 200, servicos);
    return;
  }
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
    const reservas = listarReservas.all(data).map((reserva) => ({
      ...reserva,
      servico: servicos.find(({ id }) => id === reserva.servico_id)?.nome ?? "Serviço indisponível",
    }));
    responderJson(res, 200, reservas);
    return;
  }
  if (req.method === "DELETE" && /^\/agendamentos\/\d+$/.test(url.pathname)) {
    if (!autenticado(req)) {
      responderJson(res, 401, { mensagem: "Entre no painel para cancelar agendamentos." });
      return;
    }
    const id = Number(url.pathname.split("/").at(-1));
    const cancelado = excluirReserva.run(id).changes > 0;
    responderJson(res, cancelado ? 200 : 404, {
      mensagem: cancelado ? "Agendamento cancelado." : "Agendamento já removido.",
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/horarios") {
    const data = url.searchParams.get("data");
    const servico = servicos.find(({ id }) => String(id) === url.searchParams.get("servicoId"));
    if (!data || !servico) {
      responderJson(res, 400, { mensagem: "Escolha um serviço e uma data." });
      return;
    }
    const horarios = horariosPossiveis(data, servico.duracaoMinutos)
      .filter(({ inicio }) => !conflitos.get(data, inicio + servico.duracaoMinutos, inicio))
      .map(({ texto }) => texto);
    responderJson(res, 200, horarios);
    return;
  }
  if (req.method === "POST" && url.pathname === "/agendamentos") {
    const reserva = await lerCorpo(req).then((corpo) => JSON.parse(corpo ?? "null")).catch(() => null);
    const nome = typeof reserva?.nome === "string" ? reserva.nome.trim() : "";
    const servico = servicos.find(({ id }) => id === reserva?.servicoId);
    const data = reserva?.data;
    const horario = servico && horariosPossiveis(data, servico.duracaoMinutos)
      .find(({ texto }) => texto === reserva?.horario);
    if (!nome || nome.length > 100 || !servico || !horario) {
      responderJson(res, 400, { mensagem: "Informe seu nome e escolha um serviço, uma data e um horário válidos." });
      return;
    }

    const inicio = horario.inicio;
    const fim = inicio + servico.duracaoMinutos;
    const resultado = inserirReserva.run(nome, servico.id, data, inicio, fim, data, fim, inicio);
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

servidor.listen(3000, "127.0.0.1", () => {
  console.log("Servidor rodando em http://127.0.0.1:3000");
});
