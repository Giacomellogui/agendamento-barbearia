export {};

type Reserva = {
  id: number;
  nome: string;
  servico: string;
  inicio: number;
  fim: number;
};

const data = document.querySelector<HTMLInputElement>("#data")!;
const mensagem = document.querySelector<HTMLParagraphElement>("#mensagem")!;
const situacao = document.querySelector<HTMLParagraphElement>("#situacao")!;
const lista = document.querySelector<HTMLUListElement>("#reservas")!;
const hoje = new Date();
const doisDigitos = (valor: number) => String(valor).padStart(2, "0");
data.value = `${hoje.getFullYear()}-${doisDigitos(hoje.getMonth() + 1)}-${doisDigitos(hoje.getDate())}`;
const formatarHora = (minutos: number) =>
  `${doisDigitos(Math.floor(minutos / 60))}:${doisDigitos(minutos % 60)}`;

async function cancelar(reserva: Reserva, botao: HTMLButtonElement) {
  if (!window.confirm(`Cancelar o agendamento de ${reserva.nome} às ${formatarHora(reserva.inicio)}?`)) return;
  botao.disabled = true;
  try {
    const resposta = await fetch(`/agendamentos/${reserva.id}`, { method: "DELETE" });
    if (resposta.status === 401) {
      location.assign("/login");
      return;
    }
    if (!resposta.ok && resposta.status !== 404) throw new Error();
    const resultado: { mensagem: string } = await resposta.json();
    mensagem.textContent = resultado.mensagem;
    await carregarAgenda();
  } catch {
    mensagem.textContent = "Não foi possível cancelar o agendamento.";
    botao.disabled = false;
  }
}

let consulta: AbortController | undefined;
async function carregarAgenda() {
  consulta?.abort();
  lista.replaceChildren();
  if (!data.value) {
    situacao.textContent = "Escolha uma data.";
    return;
  }
  const pedido = new AbortController();
  consulta = pedido;
  situacao.textContent = "Carregando agenda...";
  try {
    const parametros = new URLSearchParams({ data: data.value });
    const resposta = await fetch(`/agendamentos?${parametros}`, { signal: pedido.signal });
    if (resposta.status === 401) {
      location.assign("/login");
      return;
    }
    if (!resposta.ok) throw new Error();
    const reservas: Reserva[] = await resposta.json();
    if (pedido.signal.aborted) return;
    situacao.textContent = reservas.length ? "" : "Nenhum agendamento para este dia.";
    for (const reserva of reservas) {
      const item = document.createElement("li");
      const botao = document.createElement("button");
      botao.type = "button";
      botao.textContent = "Cancelar";
      botao.addEventListener("click", () => cancelar(reserva, botao));
      item.append(
        `${formatarHora(reserva.inicio)}–${formatarHora(reserva.fim)} · ${reserva.servico} · ${reserva.nome} `,
        botao,
      );
      lista.append(item);
    }
  } catch {
    if (!pedido.signal.aborted) situacao.textContent = "Não foi possível carregar a agenda.";
  }
}

data.addEventListener("change", () => {
  mensagem.textContent = "";
  carregarAgenda();
});
carregarAgenda();
