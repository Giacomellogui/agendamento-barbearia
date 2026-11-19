import type { IncomingMessage, ServerResponse } from "node:http";

// O navegador abre o destino com GET após o envio de um formulário.
export function redirecionar(res: ServerResponse, destino: string) {
  res.writeHead(303, { Location: destino, "Cache-Control": "no-store" });
  res.end();
}

export function responderJson(res: ServerResponse, status: number, dados: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(dados));
}

// Lê o corpo da requisição em partes e limita os dados mantidos em memória.
export async function lerCorpo(req: IncomingMessage) {
  const partes: Buffer[] = [];
  let tamanho = 0;
  for await (const parte of req) {
    tamanho += parte.length;
    if (tamanho <= 4096) partes.push(parte);
  }
  if (tamanho > 4096) return null;
  return Buffer.concat(partes).toString("utf8");
}

export async function lerJson(req: IncomingMessage) {
  return lerCorpo(req).then((corpo) => JSON.parse(corpo ?? "null")).catch(() => null);
}
