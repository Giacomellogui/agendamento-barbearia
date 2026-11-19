import { banco } from "./banco.ts";

export const enfileirarAviso = banco.prepare(`
  INSERT INTO avisos_whatsapp (reserva_id, anterior, novo, proxima_tentativa) VALUES (?, ?, ?, ?)
`);
const proximoAviso = banco.prepare(
  "SELECT * FROM avisos_whatsapp WHERE estado <> 'aceito' AND proxima_tentativa <= ? ORDER BY id LIMIT 1",
);
const aceitarAviso = banco.prepare("UPDATE avisos_whatsapp SET estado = 'aceito', erro = NULL WHERE id = ?");
const adiarAviso = banco.prepare(`
  UPDATE avisos_whatsapp SET estado = 'falha', erro = ?, tentativas = tentativas + 1, proxima_tentativa = ? WHERE id = ?
`);
const listarAvisos = banco.prepare(`
  SELECT id, reserva_id, anterior, novo, estado, erro
  FROM avisos_whatsapp ORDER BY id DESC LIMIT 30
`);
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
export const whatsappConfigurado = whatsappInvalidos.length === 0;

export function estadoDosAvisos() {
  return { configurado: whatsappConfigurado, avisos: listarAvisos.all() };
}

let enviandoAvisos = false;
// A fila fica no SQLite para sobreviver a falhas temporárias do WhatsApp ou reinícios.
export async function enviarAvisos() {
  if (!whatsappConfigurado || enviandoAvisos) return;
  enviandoAvisos = true;
  try {
    for (let enviados = 0; enviados < 10; enviados++) {
      const aviso = proximoAviso.get(Date.now());
      if (!aviso) break;
      let erro = "Falha de conexão com a Meta.";
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
          erro = detalhes;
          console.warn(`WhatsApp recusou o aviso da reserva #${aviso.reserva_id} (${detalhes}).`);
          throw new Error("Aviso recusado");
        }
        if (!resultado?.messages?.[0]?.id) {
          erro = "Resposta sem confirmação da Meta.";
          throw new Error(erro);
        }
        aceitarAviso.run(aviso.id);
        console.info(`WhatsApp aceitou o aviso da reserva #${aviso.reserva_id}. Confira a entrega no celular.`);
      } catch {
        // Aumenta o intervalo entre tentativas após falhas, até o limite de uma hora.
        const espera = Math.min(3600, 30 * 2 ** Math.min(Number(aviso.tentativas), 7));
        adiarAviso.run(erro, Date.now() + espera * 1000, aviso.id);
        console.warn("Aviso de reagendamento pendente no WhatsApp. Confira a configuração e a conexão.");
      }
    }
  } finally {
    enviandoAvisos = false;
  }
}

export function descreverHorario(data: string, inicio: number) {
  const [ano, mes, dia] = data.split("-");
  const hora = String(Math.floor(inicio / 60)).padStart(2, "0");
  const minuto = String(inicio % 60).padStart(2, "0");
  return `${dia}/${mes}/${ano} às ${hora}:${minuto}`;
}


export function iniciarAvisos() {
  if (whatsappConfigurado) {
    console.info("WhatsApp configurado. Novos reagendamentos entram na fila de envio.");
    void enviarAvisos();
    setInterval(() => void enviarAvisos(), 15000).unref();
  } else {
    console.info(`WhatsApp desativado. Variáveis ausentes ou inválidas: ${whatsappInvalidos.join(", ")}.`);
  }
}
