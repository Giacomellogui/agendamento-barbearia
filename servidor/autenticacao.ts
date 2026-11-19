import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { banco } from "./banco.ts";
import { lerCorpo, redirecionar, responderJson } from "./http.ts";
import { emailConfigurado, enviarLinkPorEmail } from "./email.ts";

const login = readFileSync(new URL("../login.html", import.meta.url));
const cadastroCliente = readFileSync(new URL("../cadastro-cliente.html", import.meta.url));
const loginCliente = readFileSync(new URL("../login-cliente.html", import.meta.url));
const paginaRecuperacao = readFileSync(new URL("../recuperar-senha.html", import.meta.url));
const paginaEmail = readFileSync(new URL("../email-cliente.html", import.meta.url));
// A senha vem do ambiente. A sessão fica em memória e expira após oito horas.
const senha = process.env.BARBEIRO_SENHA;
const duracaoSessao = 8 * 60 * 60;
const cookieSeguro = process.env.RENDER === "true" || process.env.APP_BASE_URL?.startsWith("https://")
  ? "; Secure" : "";
let sessao: { token: string; expira: number } | undefined;

// Produz um valor de tamanho fixo para a comparação da senha do barbeiro.
function hashSenha(valor: string) {
  return createHash("sha256").update(valor).digest();
}

// Confere se o cookie pertence à sessão ativa.
export function autenticado(req: IncomingMessage) {
  const cookie = req.headers.cookie?.split(";").map((item) => item.trim())
    .find((item) => item.startsWith("sessao_barbearia="));
  return !!sessao && Date.now() < sessao.expira &&
    cookie === `sessao_barbearia=${sessao.token}`;
}

// A consulta de sessão retorna o perfil. O hash e o salt são usados no login.
const clientePorId = banco.prepare("SELECT id, nome, telefone, email_verificado, hash FROM clientes WHERE id = ?");
const clientePorTelefone = banco.prepare("SELECT id, salt, hash FROM clientes WHERE telefone = ?");
const inserirCliente = banco.prepare(`
  INSERT INTO clientes (nome, telefone, salt, hash) VALUES (?, ?, ?, ?)
  ON CONFLICT(telefone) DO NOTHING RETURNING id
`);
const derivarSenha = promisify(scrypt);
const sessoesClientes = new Map<string, { id: number; hash: string; expira: number }>();
const caminhoRecuperacao = "/cliente/recuperar-senha";
const caminhoEmail = "/cliente/email";
const janelaEnvios = 15 * 60_000;
const enviosPorOrigem = new Map<string, { inicio: number; total: number }>();
const clientePorEmail = banco.prepare("SELECT id FROM clientes WHERE email_verificado = ?");
const credencialPorId = banco.prepare("SELECT hash, salt FROM clientes WHERE id = ?");
// Mantém um link ativo por conta e finalidade e limita a frequência dos reenvios.
const emitirLink = banco.prepare(`
  INSERT INTO links_cliente (cliente_id, tipo, email, digest, expira_em, solicitado_em, janela_inicio, envios)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(cliente_id, tipo) DO UPDATE SET
    email = excluded.email, digest = excluded.digest, expira_em = excluded.expira_em,
    solicitado_em = excluded.solicitado_em,
    envios = CASE WHEN links_cliente.janela_inicio <= ? THEN 1 ELSE links_cliente.envios + 1 END,
    janela_inicio = CASE WHEN links_cliente.janela_inicio <= ? THEN excluded.janela_inicio ELSE links_cliente.janela_inicio END
  WHERE links_cliente.solicitado_em <= ? AND (links_cliente.janela_inicio <= ? OR links_cliente.envios < 3)
`);
const consultarLink = banco.prepare("SELECT cliente_id, email FROM links_cliente WHERE tipo = ? AND digest = ? AND expira_em > ?");
const invalidarLink = banco.prepare("UPDATE links_cliente SET digest = NULL WHERE digest = ?");
const invalidarLinksCliente = banco.prepare("UPDATE links_cliente SET digest = NULL WHERE cliente_id = ?");
const verificarEmail = banco.prepare(`
  UPDATE clientes SET email_verificado = ? WHERE id = ?
  AND NOT EXISTS (SELECT 1 FROM clientes WHERE email_verificado = ? AND id <> ?)
`);
const atualizarSenha = banco.prepare("UPDATE clientes SET salt = ?, hash = ? WHERE id = ? AND email_verificado = ?");

function normalizarEmail(valor: string) {
  const email = valor.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email) ? email : "";
}

function permitirSolicitacao(origem: string) {
  const agora = Date.now();
  for (const [endereco, janela] of enviosPorOrigem) {
    if (agora - janela.inicio >= janelaEnvios) enviosPorOrigem.delete(endereco);
  }
  const janela = enviosPorOrigem.get(origem) ?? { inicio: agora, total: 0 };
  if (janela.total >= 20) return false;
  janela.total++;
  enviosPorOrigem.set(origem, janela);
  return true;
}

// Envia um token aleatório por e-mail e guarda somente o hash no banco.
async function solicitarLink(id: number, email: string, tipo: "verificacao" | "recuperacao") {
  const agora = Date.now();
  const inicioJanela = agora - janelaEnvios;
  const token = randomBytes(32).toString("base64url");
  const digest = hashSenha(token).toString("hex");
  const verificando = tipo === "verificacao";
  const validade = verificando ? 60 * 60_000 : 15 * 60_000;
  const emitido = await emitirLink.run(id, tipo, email, digest, agora + validade, agora, agora,
    inicioJanela, inicioJanela, agora - 60_000, inicioJanela);
  if (!emitido.changes) return;
  try {
    const caminho = verificando ? caminhoEmail + "/confirmar" : caminhoRecuperacao + "/redefinir";
    if (await enviarLinkPorEmail(email, caminho, token, verificando)) return;
  } catch {
    // O endereço, o token e o conteúdo do provedor ficam fora do log.
  }
  await invalidarLink.run(digest);
  console.warn("Não foi possível enviar um e-mail de acesso. Confira as credenciais e o remetente.");
}

function digestLink(token: string | null) {
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? hashSenha(token).toString("hex") : "";
}

// A mudança e o consumo do link são atômicos. A operação também revalida a expiração.
function concluirLink(tipo: "verificacao" | "recuperacao", digest: string, atualizar: (id: number, email: string) => Promise<boolean>) {
  return banco.transacao(async () => {
    const link = await consultarLink.get(tipo, digest, Date.now());
    if (!link || !await atualizar(Number(link.cliente_id), String(link.email))) return undefined;
    const id = Number(link.cliente_id);
    // Descarta links antigos após trocar a senha ou confirmar um novo e-mail.
    await invalidarLinksCliente.run(id);
    return id;
  });
}

async function redefinirSenha(digest: string, senhaNova: string) {
  if (!digest || !await consultarLink.get("recuperacao", digest, Date.now())) return false;
  const salt = randomBytes(16).toString("hex");
  const hash = await derivarSenha(senhaNova, salt, 64) as Buffer;
  const id = await concluirLink("recuperacao", digest, async (clienteId, email) =>
    Boolean((await atualizarSenha.run(salt, hash.toString("hex"), clienteId, email)).changes));
  if (id === undefined) return false;
  for (const [token, sessao] of sessoesClientes) {
    if (sessao.id === id) sessoesClientes.delete(token);
  }
  return true;
}

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

export async function clienteAutenticado(req: IncomingMessage) {
  const token = tokenCliente(req);
  const cliente = sessoesClientes.get(token);
  if (cliente && Date.now() < cliente.expira) {
    const perfil = await clientePorId.get(cliente.id);
    if (perfil?.hash === cliente.hash && sessoesClientes.get(token) === cliente) return perfil;
  }
  sessoesClientes.delete(token);
}

// Gera um token aleatório e o envia em um cookie inacessível ao JavaScript.
function iniciarSessaoCliente(req: IncomingMessage, res: ServerResponse, id: number, hash: string) {
  const agora = Date.now();
  for (const [token, sessao] of sessoesClientes) {
    if (sessao.expira <= agora) sessoesClientes.delete(token);
  }
  sessoesClientes.delete(tokenCliente(req));
  const token = randomBytes(32).toString("hex");
  sessoesClientes.set(token, { id, hash, expira: agora + duracaoSessao * 1000 });
  res.setHeader("Set-Cookie", `sessao_cliente=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${duracaoSessao}${cookieSeguro}`);
}


function consoleEmail() {
  console.warn("Não foi possível processar um link de acesso por e-mail.");
}

export async function atenderAutenticacao(req: IncomingMessage, res: ServerResponse, url: URL) {
  const rotaEmail = url.pathname === caminhoEmail || url.pathname === caminhoEmail + "/confirmar";
  const rotaRecuperacao = url.pathname === caminhoRecuperacao || url.pathname === caminhoRecuperacao + "/redefinir";
  if ((rotaEmail || rotaRecuperacao) && req.method === "GET") {
    if (url.pathname === caminhoEmail && !await clienteAutenticado(req)) {
      redirecionar(res, "/cliente/login");
      return true;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.end(rotaEmail ? paginaEmail : paginaRecuperacao);
    return true;
  }
  if ((rotaEmail || rotaRecuperacao) && req.method === "POST") {
    if (req.headers["sec-fetch-site"] === "cross-site") {
      responderJson(res, 403, { mensagem: "Abra o formulário da barbearia para continuar." });
      return true;
    }
    const corpo = await lerCorpo(req).catch(() => null);
    const dados = new URLSearchParams(corpo ?? "");
    const email = normalizarEmail(dados.get("email") ?? "");
    const origem = req.socket.remoteAddress ?? "local";
    if (url.pathname === caminhoRecuperacao) {
      if (!emailConfigurado) {
        redirecionar(res, caminhoRecuperacao + "?estado=indisponivel");
      } else if (!email) {
        redirecionar(res, caminhoRecuperacao + "?estado=email");
      } else {
        // Dá a mesma resposta para e-mails verificados e endereços desconhecidos.
        redirecionar(res, caminhoRecuperacao + "?estado=solicitado");
        if (permitirSolicitacao(origem)) {
          const cliente = await clientePorEmail.get(email);
          if (cliente) void solicitarLink(Number(cliente.id), email, "recuperacao").catch(consoleEmail);
        }
      }
      return true;
    }
    if (url.pathname === caminhoEmail) {
      const cliente = await clienteAutenticado(req);
      if (!cliente) {
        redirecionar(res, "/cliente/login");
        return true;
      }
      const senhaAtual = dados.get("senha") ?? "";
      if (!emailConfigurado || !email || senhaAtual.length < 8 || senhaAtual.length > 128 || !permitirSolicitacao(origem)) {
        const estado = emailConfigurado ? "dados" : "indisponivel";
        redirecionar(res, caminhoEmail + "?estado=" + estado);
        return true;
      }
      // Alterar o endereço de recuperação exige revalidar a senha da conta.
      const id = Number(cliente.id);
      const credencial = await credencialPorId.get(id);
      const hash = credencial ? await derivarSenha(senhaAtual, String(credencial.salt), 64).catch(() => null) as Buffer | null : null;
      if (!hash || !credencial || !timingSafeEqual(hash, Buffer.from(String(credencial.hash), "hex")) ||
          (await clienteAutenticado(req))?.id !== cliente.id || (await credencialPorId.get(id))?.hash !== credencial.hash) {
        redirecionar(res, caminhoEmail + "?estado=senha");
        return true;
      }
      redirecionar(res, caminhoEmail + "?estado=solicitado");
      const existente = await clientePorEmail.get(email);
      if (!existente && email !== cliente.email_verificado) {
        void solicitarLink(id, email, "verificacao").catch(consoleEmail);
      }
      return true;
    }
    const digest = digestLink(dados.get("token"));
    if (rotaEmail) {
      let confirmado = false;
      try {
        confirmado = Boolean(digest && await concluirLink("verificacao", digest, async (id, destino) =>
          Boolean((await verificarEmail.run(destino, id, destino, id)).changes)));
      } catch {
        consoleEmail();
      }
      redirecionar(res, caminhoEmail + "/confirmar?estado=" + (confirmado ? "verificado" : "invalido"));
      return true;
    }
    const senhaNova = dados.get("senha") ?? "";
    if (senhaNova.length < 8 || senhaNova.length > 128 || senhaNova !== dados.get("confirmacao")) {
      responderJson(res, 400, { mensagem: "Confira se as duas senhas são iguais e têm pelo menos oito caracteres." });
      return true;
    }
    try {
      if (await redefinirSenha(digest, senhaNova)) {
        res.setHeader("Set-Cookie", `sessao_cliente=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSeguro}`);
        responderJson(res, 200, { mensagem: "Senha alterada." });
      } else {
        responderJson(res, 400, { mensagem: "Link inválido, expirado ou já usado. Solicite outro." });
      }
    } catch {
      responderJson(res, 503, { mensagem: "Não foi possível alterar a senha agora. Tente novamente." });
    }
    return true;
  }
  // O cadastro e o login do cliente usam uma sessão separada da do barbeiro.
  const criandoConta = url.pathname === "/cliente/cadastro";
  if (criandoConta || url.pathname === "/cliente/login") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(criandoConta ? cadastroCliente : loginCliente);
      return true;
    }
    if (req.method === "POST") {
      if (req.headers["sec-fetch-site"] === "cross-site") {
        responderJson(res, 403, { mensagem: "Abra o formulário da barbearia para continuar." });
        return true;
      }
      const corpo = await lerCorpo(req).catch(() => null);
      const dados = new URLSearchParams(corpo ?? "");
      const telefone = telefoneNormalizado(dados.get("telefone") ?? "");
      const senhaCliente = dados.get("senha") ?? "";
      const nome = (dados.get("nome") ?? "").trim().replace(/\s+/g, " ");
      if (!telefone || senhaCliente.length < 8 || senhaCliente.length > 128 ||
          (criandoConta && (nome.length > 100 || !/^\S+ .+/.test(nome)))) {
        redirecionar(res, `${url.pathname}?erro=dados`);
        return true;
      }
      const emailInformado = criandoConta ? (dados.get("email") ?? "").trim() : "";
      const emailRecuperacao = normalizarEmail(emailInformado);
      if (emailInformado && !emailRecuperacao) {
        redirecionar(res, "/cliente/cadastro?erro=email");
        return true;
      }
      const cadastro = criandoConta ? undefined : await clientePorTelefone.get(telefone);
      // Deriva a senha com scrypt e um salt armazenado junto à conta.
      const salt = cadastro ? String(cadastro.salt) : randomBytes(16).toString("hex");
      const hash = await derivarSenha(senhaCliente, salt, 64).catch(() => null) as Buffer | null;
      if (!hash) {
        responderJson(res, 503, { mensagem: "Não foi possível acessar a conta. Tente novamente." });
        return true;
      }
      if (criandoConta) {
        const cliente = await inserirCliente.get(nome, telefone, salt, hash.toString("hex"));
        if (!cliente) {
          redirecionar(res, "/cliente/cadastro?erro=telefone");
          return true;
        }
        const id = Number(cliente.id);
        iniciarSessaoCliente(req, res, id, hash.toString("hex"));
        if (emailRecuperacao) {
          // Cria a conta imediatamente e confirma o endereço em uma etapa separada.
          redirecionar(res, caminhoEmail + "?estado=" + (emailConfigurado ? "solicitado" : "indisponivel"));
          if (emailConfigurado && permitirSolicitacao(req.socket.remoteAddress ?? "local") &&
              !await clientePorEmail.get(emailRecuperacao)) {
            void solicitarLink(id, emailRecuperacao, "verificacao").catch(consoleEmail);
          }
          return true;
        }
      } else {
        if (!cadastro || !timingSafeEqual(hash, Buffer.from(String(cadastro.hash), "hex")) ||
            (await clientePorTelefone.get(telefone))?.hash !== cadastro.hash) {
          redirecionar(res, "/cliente/login?erro=credenciais");
          return true;
        }
        iniciarSessaoCliente(req, res, Number(cadastro.id), hash.toString("hex"));
      }
      redirecionar(res, "/");
      return true;
    }
  }
  if (url.pathname === "/cliente/sessao" && req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    const cliente = await clienteAutenticado(req);
    responderJson(res, 200, cliente ? { nome: cliente.nome, email: cliente.email_verificado } : null);
    return true;
  }
  if (url.pathname === "/cliente/sair" && req.method === "POST") {
    sessoesClientes.delete(tokenCliente(req));
    res.setHeader("Set-Cookie", `sessao_cliente=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSeguro}`);
    redirecionar(res, "/");
    return true;
  }
  // Exibe o login e cria uma sessão quando a senha confere.
  if (url.pathname === "/login" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(login);
    return true;
  }
  if (url.pathname === "/login" && req.method === "POST") {
    if (!senha) {
      redirecionar(res, "/login?erro=configuracao");
      return true;
    }
    const corpo = await lerCorpo(req).catch(() => null);
    const informada = new URLSearchParams(corpo ?? "").get("senha") ?? "";
    if (!timingSafeEqual(hashSenha(informada), hashSenha(senha))) {
      redirecionar(res, "/login?erro=senha");
      return true;
    }
    sessao = { token: randomBytes(32).toString("hex"), expira: Date.now() + duracaoSessao * 1000 };
    res.setHeader("Set-Cookie", `sessao_barbearia=${sessao.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${duracaoSessao}${cookieSeguro}`);
    redirecionar(res, "/painel");
    return true;
  }
  // Encerra a sessão e remove o cookie do navegador.
  if (url.pathname === "/sair" && req.method === "POST") {
    if (autenticado(req)) sessao = undefined;
    res.setHeader("Set-Cookie", `sessao_barbearia=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSeguro}`);
    redirecionar(res, "/login");
    return true;
  }
  return false;
}
