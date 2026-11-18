export {};

// Dados de uma reserva retornada pela API do painel.
type Reserva = {
  id: number;
  nome: string;
  servico: string;
  inicio: number;
  fim: number;
  telefone: string | null;
};

// Controles do painel. A primeira consulta usa a data local de hoje.
const data = document.querySelector<HTMLInputElement>("#data")!;
const mensagem = document.querySelector<HTMLParagraphElement>("#mensagem")!;
const situacao = document.querySelector<HTMLParagraphElement>("#situacao")!;
const lista = document.querySelector<HTMLUListElement>("#reservas")!;
const totalReservas = document.querySelector<HTMLParagraphElement>("#total-reservas")!;
const hoje = new Date();
const doisDigitos = (valor: number) => String(valor).padStart(2, "0");
data.value = `${hoje.getFullYear()}-${doisDigitos(hoje.getMonth() + 1)}-${doisDigitos(hoje.getDate())}`;
// Converte minutos desde a meia-noite em um horário no formato HH:MM.
const formatarHora = (minutos: number) =>
  `${doisDigitos(Math.floor(minutos / 60))}:${doisDigitos(minutos % 60)}`;

// Pede confirmação, cancela a reserva e consulta a agenda novamente.
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

// Cancela a busca anterior para evitar exibir reservas de outra data.
let consulta: AbortController | undefined;
async function carregarAgenda() {
  consulta?.abort();
  lista.replaceChildren();
  totalReservas.textContent = "";
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
    totalReservas.textContent = `${reservas.length} ${reservas.length === 1 ? "agendamento" : "agendamentos"}`;
    situacao.textContent = reservas.length ? "" : "Nenhum agendamento para este dia.";
    // Cria os elementos da lista com os dados retornados pelo servidor.
    for (const reserva of reservas) {
      const item = document.createElement("li");
      const horario = document.createElement("span");
      horario.className = "painel-reserva-horario";
      horario.textContent = `${formatarHora(reserva.inicio)}–${formatarHora(reserva.fim)}`;
      const dados = document.createElement("div");
      dados.className = "painel-reserva-dados";
      const cliente = document.createElement("strong");
      cliente.textContent = reserva.nome;
      const servico = document.createElement("p");
      servico.textContent = reserva.servico;
      dados.append(cliente, servico);
      const botao = document.createElement("button");
      botao.type = "button";
      botao.textContent = "Cancelar";
      botao.setAttribute("aria-label", `Cancelar agendamento de ${reserva.nome} às ${formatarHora(reserva.inicio)}`);
      botao.addEventListener("click", () => cancelar(reserva, botao));
      if (reserva.telefone) {
        const contato = document.createElement("div");
        const link = document.createElement("a");
        link.href = `tel:+55${reserva.telefone}`;
        link.textContent = `(${reserva.telefone.slice(0, 2)}) ${reserva.telefone.slice(2, -4)}-${reserva.telefone.slice(-4)}`;
        contato.append("Telefone: ", link);
        dados.append(contato);
      }
      item.append(horario, dados, botao);
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

type Expediente = {
  dias: number;
  abertura: string;
  fechamento: string;
  inicioPausa: string | null;
  fimPausa: string | null;
};

type Servico = {
  id: number;
  nome: string;
  duracaoMinutos: number;
  precoCentavos: number | null;
};

// Reutiliza o tratamento de sessão e dos erros da API nos formulários do painel.
async function consultarJson<T>(rota: string, opcoes?: RequestInit): Promise<T> {
  const resposta = await fetch(rota, opcoes);
  if (resposta.status === 401) location.assign("/login");
  const dados = await resposta.json();
  if (!resposta.ok) throw new Error(dados.mensagem ?? "Não foi possível concluir a operação.");
  return dados;
}

function estadoFormulario(formulario: HTMLFormElement, texto: string, erro = false) {
  const aviso = formulario.querySelector<HTMLElement>('[role="status"]')!;
  aviso.textContent = texto;
  aviso.dataset.estado = erro ? "erro" : "";
}

function mensagemErro(erro: unknown) {
  return erro instanceof Error ? erro.message : "Não foi possível concluir a operação.";
}

const formExpediente = document.querySelector<HTMLFormElement>("#form-expediente")!;
const camposExpediente = formExpediente.querySelector("fieldset")!;
const diasExpediente = Array.from(formExpediente.querySelectorAll<HTMLInputElement>('[name="dia"]'));
const camposHora = ["abertura", "fechamento", "inicioPausa", "fimPausa"] as const;

// A máscara usa um bit por dia, do domingo ao sábado.
consultarJson<Expediente>("/expediente").then((expediente) => {
  for (const dia of diasExpediente) {
    dia.checked = Boolean(expediente.dias & (1 << Number(dia.value)));
  }
  for (const nome of camposHora) {
    formExpediente.querySelector<HTMLInputElement>(`[name="${nome}"]`)!.value = expediente[nome] ?? "";
  }
  camposExpediente.disabled = false;
}).catch((erro) => estadoFormulario(formExpediente, mensagemErro(erro), true));

formExpediente.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const dados = new FormData(formExpediente);
  const dias = dados.getAll("dia").reduce((mascara, dia) => mascara | (1 << Number(dia)), 0);
  camposExpediente.disabled = true;
  estadoFormulario(formExpediente, "Salvando expediente...");
  try {
    const resultado = await consultarJson<{ mensagem: string }>("/expediente", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dias,
        abertura: dados.get("abertura"),
        fechamento: dados.get("fechamento"),
        inicioPausa: dados.get("inicioPausa") || null,
        fimPausa: dados.get("fimPausa") || null,
      }),
    });
    estadoFormulario(formExpediente, resultado.mensagem);
  } catch (erro) {
    estadoFormulario(formExpediente, mensagemErro(erro), true);
  } finally {
    camposExpediente.disabled = false;
  }
});

const formServico = document.querySelector<HTMLFormElement>("#form-servico")!;
const camposServico = formServico.querySelector("fieldset")!;
const seletorServico = formServico.querySelector("select")!;
const nomeServico = formServico.querySelector<HTMLInputElement>('[name="nome"]')!;
const duracaoServico = formServico.querySelector<HTMLInputElement>('[name="duracaoMinutos"]')!;
const precoServico = formServico.querySelector<HTMLInputElement>('[name="preco"]')!;
const catalogo = new Map<string, Servico>();

function atualizarCatalogo(servico: Servico) {
  const id = String(servico.id);
  const opcao = Array.from(seletorServico.options).find((item) => item.value === id);
  if (opcao) opcao.textContent = servico.nome;
  else seletorServico.add(new Option(servico.nome, id));
  catalogo.set(id, servico);
}

consultarJson<Servico[]>("/servicos").then((servicos) => {
  servicos.forEach(atualizarCatalogo);
  camposServico.disabled = false;
}).catch((erro) => estadoFormulario(formServico, mensagemErro(erro), true));

seletorServico.addEventListener("change", () => {
  const servico = catalogo.get(seletorServico.value);
  nomeServico.value = servico?.nome ?? "";
  duracaoServico.value = servico ? String(servico.duracaoMinutos) : "";
  precoServico.value = servico?.precoCentavos == null ? "" : (servico.precoCentavos / 100).toFixed(2);
  estadoFormulario(formServico, "");
});

formServico.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const id = seletorServico.value;
  camposServico.disabled = true;
  estadoFormulario(formServico, "Salvando serviço...");
  try {
    const resultado = await consultarJson<{ mensagem: string; servico: Servico }>(
      id ? `/servicos/${id}` : "/servicos",
      {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: nomeServico.value,
          duracaoMinutos: duracaoServico.valueAsNumber,
          precoCentavos: precoServico.value ? Math.round(precoServico.valueAsNumber * 100) : null,
        }),
      },
    );
    atualizarCatalogo(resultado.servico);
    seletorServico.value = String(resultado.servico.id);
    estadoFormulario(formServico, resultado.mensagem);
  } catch (erro) {
    estadoFormulario(formServico, mensagemErro(erro), true);
  } finally {
    camposServico.disabled = false;
  }
});
