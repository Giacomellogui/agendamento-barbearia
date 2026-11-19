const chave = process.env.RESEND_API_KEY?.trim() ?? "";
const remetente = process.env.EMAIL_FROM?.trim() ?? "";
const origem = obterOrigem();

// A origem confiável vem da configuração. HTTP só é permitido no computador local.
function obterOrigem() {
  try {
    const url = new URL(process.env.APP_BASE_URL ?? "http://127.0.0.1:3000");
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export const emailConfigurado = Boolean(chave && remetente && origem);

export async function enviarLinkPorEmail(destino: string, caminho: string, token: string, verificando: boolean) {
  const link = new URL(caminho, origem);
  // O fragmento guarda o token fora das requisições GET e dos logs HTTP.
  link.hash = token;
  const acao = verificando ? "Confirme seu e-mail de recuperação" : "Redefina sua senha";
  const validade = verificando ? "uma hora" : "15 minutos";
  const resposta = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: remetente,
      to: [destino],
      subject: `${acao} | Barbearia`,
      text: `${acao} na Barbearia:\n\n${link.href}\n\nO link vale por ${validade} e pode ser usado uma vez. Se você não pediu isso, ignore este e-mail.`,
    }),
    signal: AbortSignal.timeout(8000),
  });
  const resultado = await resposta.json().catch(() => null) as { id?: string } | null;
  return resposta.ok && Boolean(resultado?.id);
}
