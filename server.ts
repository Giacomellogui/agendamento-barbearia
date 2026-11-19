import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { atenderAgenda } from "./servidor/agenda.ts";
import { atenderAutenticacao, autenticado, clienteAutenticado } from "./servidor/autenticacao.ts";
import { redirecionar, responderJson } from "./servidor/http.ts";
import { estadoDosAvisos, iniciarAvisos } from "./servidor/whatsapp.ts";

// As páginas e os arquivos compilados são carregados ao iniciar o servidor.
const pagina = readFileSync(new URL("./index.html", import.meta.url));
const estilos = readFileSync(new URL("./estilos.css", import.meta.url));
const fotoBarbearia = readFileSync(new URL("./assets/barbearia.png", import.meta.url));
const arquivosInstalacao = new Map([
  ["/app.webmanifest", "application/manifest+json"],
  ["/barbeiro.webmanifest", "application/manifest+json"],
  ["/assets/app-192.png", "image/png"],
  ["/assets/app-512.png", "image/png"],
  ["/assets/barbeiro-192.png", "image/png"],
  ["/assets/barbeiro-512.png", "image/png"],
].map(([caminho, tipo]) => [caminho, {
  tipo,
  conteudo: readFileSync(new URL(`.${caminho}`, import.meta.url)),
}] as const));
const tema = readFileSync(new URL("./tema.js", import.meta.url));
const agendamento = readFileSync(new URL("./agendamento.js", import.meta.url));
const painel = readFileSync(new URL("./painel.html", import.meta.url));
const scriptPainel = readFileSync(new URL("./painel.js", import.meta.url));

// Cada rota combina o método HTTP com o caminho pedido pelo navegador.
async function atender(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  // Os manifestos e ícones dos dois apps ficam disponíveis antes do login.
  const arquivoInstalacao = arquivosInstalacao.get(url.pathname);
  if (arquivoInstalacao && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, { "Content-Type": arquivoInstalacao.tipo });
    res.end(arquivoInstalacao.conteudo);
    return;
  }
  if (await atenderAutenticacao(req, res, url) || await atenderAgenda(req, res, url)) return;
  if (req.method === "GET" && url.pathname === "/avisos-whatsapp") {
    res.setHeader("Cache-Control", "no-store");
    if (!autenticado(req)) {
      responderJson(res, 401, { mensagem: "Entre no painel para ver os avisos." });
      return;
    }
    responderJson(res, 200, await estadoDosAvisos());
    return;
  }
  // Entrega a página de agendamento e os arquivos usados pelo navegador.
  if (req.method === "GET" && url.pathname === "/") {
    if (!await clienteAutenticado(req)) {
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

  res.statusCode = 404;
  res.end("Rota desconhecida");
}

const servidor = createServer((req, res) => {
  void atender(req, res).catch(() => {
    console.error("Não foi possível processar uma requisição.");
    if (res.headersSent) res.end();
    else responderJson(res, 500, { mensagem: "Não foi possível concluir a operação. Tente novamente." });
  });
});

// O Render injeta PORT. Sem essa variável, o acesso continua restrito ao computador local.
const host = process.env.AGENDA_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const porta = Number(process.env.AGENDA_PORT ?? process.env.PORT ?? 3000);
servidor.listen(porta, host, () => {
  const endereco = servidor.address();
  if (endereco && typeof endereco === "object") {
    console.log(`Servidor rodando em http://${host}:${endereco.port}`);
  }
  iniciarAvisos();
});
