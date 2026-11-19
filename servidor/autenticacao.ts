import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { banco } from "./banco.ts";
import { lerCorpo, redirecionar, responderJson } from "./http.ts";

const login = readFileSync(new URL("../login.html", import.meta.url));
const cadastroCliente = readFileSync(new URL("../cadastro-cliente.html", import.meta.url));
const loginCliente = readFileSync(new URL("../login-cliente.html", import.meta.url));
// A senha vem do ambiente. A sessão fica em memória e expira após oito horas.
const senha = process.env.BARBEIRO_SENHA;
const duracaoSessao = 8 * 60 * 60;
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

export function clienteAutenticado(req: IncomingMessage) {
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


export async function atenderAutenticacao(req: IncomingMessage, res: ServerResponse, url: URL) {
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
      const cadastro = criandoConta ? undefined : clientePorTelefone.get(telefone);
      // Deriva a senha com scrypt e um salt armazenado junto à conta.
      const salt = cadastro ? String(cadastro.salt) : randomBytes(16).toString("hex");
      const hash = await derivarSenha(senhaCliente, salt, 64).catch(() => null) as Buffer | null;
      if (!hash) {
        responderJson(res, 503, { mensagem: "Não foi possível acessar a conta. Tente novamente." });
        return true;
      }
      if (criandoConta) {
        const cliente = inserirCliente.get(nome, telefone, salt, hash.toString("hex"));
        if (!cliente) {
          redirecionar(res, "/cliente/cadastro?erro=telefone");
          return true;
        }
        iniciarSessaoCliente(req, res, Number(cliente.id));
      } else {
        if (!cadastro || !timingSafeEqual(hash, Buffer.from(String(cadastro.hash), "hex"))) {
          redirecionar(res, "/cliente/login?erro=credenciais");
          return true;
        }
        iniciarSessaoCliente(req, res, Number(cadastro.id));
      }
      redirecionar(res, "/");
      return true;
    }
  }
  if (url.pathname === "/cliente/sessao" && req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    const cliente = clienteAutenticado(req);
    responderJson(res, 200, cliente ? { nome: cliente.nome } : null);
    return true;
  }
  if (url.pathname === "/cliente/sair" && req.method === "POST") {
    sessoesClientes.delete(tokenCliente(req));
    res.setHeader("Set-Cookie", "sessao_cliente=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
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
    res.setHeader("Set-Cookie", `sessao_barbearia=${sessao.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${duracaoSessao}`);
    redirecionar(res, "/painel");
    return true;
  }
  // Encerra a sessão e remove o cookie do navegador.
  if (url.pathname === "/sair" && req.method === "POST") {
    if (autenticado(req)) sessao = undefined;
    res.setHeader("Set-Cookie", "sessao_barbearia=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    redirecionar(res, "/login");
    return true;
  }
  return false;
}
