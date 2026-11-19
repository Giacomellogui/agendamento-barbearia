// Dados do catálogo usados nos cartões e na consulta de horários.
type Servico = {
  id: number;
  nome: string;
  duracaoMinutos: number;
  precoCentavos: number | null;
};

// Confere se o HTML fornece o controle esperado para cada ID.
function elemento<T extends HTMLElement>(id: string, tipo: new () => T) {
  const encontrado = document.getElementById(id);
  if (!(encontrado instanceof tipo)) throw new Error(`Elemento inválido: #${id}`);
  return encontrado;
}

const formulario = elemento("agendamento", HTMLFormElement);
const campos = elemento("campos", HTMLFieldSetElement);
const confirmar = elemento("confirmar", HTMLButtonElement);
const mensagem = elemento("mensagem", HTMLParagraphElement);
const acessoCliente = elemento("acesso-cliente", HTMLDivElement);
const contaCliente = elemento("conta-cliente", HTMLDivElement);
const nomeCliente = elemento("nome-cliente", HTMLElement);
const iniciaisCliente = elemento("iniciais-cliente", HTMLSpanElement);
const servicos = elemento("servicos", HTMLDivElement);
const horarios = elemento("horarios", HTMLDivElement);
const situacaoHorarios = elemento("situacao-horarios", HTMLParagraphElement);
const tituloHorarios = elemento("titulo-horarios", HTMLLegendElement);
const dias = elemento("dias", HTMLDivElement);
const mesAtual = elemento("mes-atual", HTMLParagraphElement);
const mesAnterior = elemento("mes-anterior", HTMLButtonElement);
const mesSeguinte = elemento("mes-seguinte", HTMLButtonElement);
const abaAgendar = elemento("agendar", HTMLElement);
const abaHistorico = elemento("minha-agenda", HTMLElement);
const linkAgendar = elemento("link-agendar", HTMLAnchorElement);
const linkHistorico = elemento("link-minha-agenda", HTMLAnchorElement);
const historico = elemento("historico", HTMLUListElement);
const situacaoHistorico = elemento("situacao-historico", HTMLParagraphElement);
const proximos = elemento("proximos-agendamentos", HTMLUListElement);
const proximosVazio = elemento("proximos-vazio", HTMLParagraphElement);
const historicoVazio = elemento("historico-vazio", HTMLParagraphElement);
const mensagemHistorico = elemento("mensagem-historico", HTMLParagraphElement);
const dialogo = elemento("dialogo-reagendar", HTMLDialogElement);
const formReagendar = elemento("form-reagendar", HTMLFormElement);
const camposReagendar = elemento("campos-reagendar", HTMLFieldSetElement);
const dataReagendar = elemento("data-reagendar", HTMLInputElement);
const horaReagendar = elemento("hora-reagendar", HTMLSelectElement);
const salvarReagendar = elemento("salvar-reagendar", HTMLButtonElement);
const situacaoReagendar = elemento("situacao-reagendar", HTMLParagraphElement);
const reservaReagendar = elemento("reserva-reagendar", HTMLParagraphElement);

// Estado das escolhas do cliente e do mês visível no calendário.
const hoje = new Date();
const primeiroMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
let mesVisivel = primeiroMes;
let dataSelecionada = hoje;
let servicoSelecionado: Servico | undefined;
let horarioSelecionado = "";
let clienteLogado = false;
let consulta: AbortController | undefined;

const mesFormatado = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
const dataLonga = new Intl.DateTimeFormat("pt-BR", { dateStyle: "full" });
const dataCurta = new Intl.DateTimeFormat("pt-BR");
const moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

type ReservaCliente = {
  id: number;
  data: string;
  inicio: number;
  fim: number;
  servico: string;
  cancelada: boolean;
  editavel: boolean;
  comparecimento: "concluido" | "falta" | null;
};

function horaFormatada(minutos: number) {
  const horas = String(Math.floor(minutos / 60)).padStart(2, "0");
  const resto = String(minutos % 60).padStart(2, "0");
  return `${horas}:${resto}`;
}

let consultaHistorico: AbortController | undefined;
let consultaReagendar: AbortController | undefined;
let reservaSelecionada: ReservaCliente | undefined;

function aviso(area: HTMLElement, mensagem: string, sucesso: boolean) {
  area.textContent = mensagem;
  area.dataset.estado = sucesso ? "sucesso" : "erro";
}

function rotaReserva(reserva: ReservaCliente) {
  return `/cliente/agendamentos/${reserva.id}`;
}

// Pede confirmação e atualiza o histórico e as vagas depois do cancelamento.
async function cancelarAgendamento(reserva: ReservaCliente, botao: HTMLButtonElement) {
  if (!window.confirm(`Cancelar a reserva de ${reserva.servico}?`)) return;
  botao.disabled = true;
  try {
    const resposta = await fetch(rotaReserva(reserva), { method: "DELETE" });
    const resultado: { mensagem: string } = await resposta.json();
    aviso(mensagemHistorico, resultado.mensagem, resposta.ok);
    if (resposta.ok || resposta.status === 404 || resposta.status === 401) await carregarHistorico();
    if (resposta.ok) void atualizarHorarios();
  } catch {
    aviso(mensagemHistorico, "Não foi possível cancelar o agendamento.", false);
  } finally {
    botao.disabled = false;
  }
}

// Busca vagas para a nova data e cancela consultas anteriores.
async function carregarHorariosReagendamento() {
  consultaReagendar?.abort();
  horaReagendar.replaceChildren(new Option("Selecione um horário", ""));
  horaReagendar.disabled = true;
  salvarReagendar.disabled = true;
  if (!reservaSelecionada || !dataReagendar.value || !dataReagendar.validity.valid) {
    situacaoReagendar.textContent = "";
    return;
  }
  const pedido = new AbortController();
  consultaReagendar = pedido;
  situacaoReagendar.textContent = "Carregando horários...";
  try {
    const parametros = new URLSearchParams({ data: dataReagendar.value });
    const resposta = await fetch(`${rotaReserva(reservaSelecionada)}?${parametros}`, { signal: pedido.signal });
    if (!resposta.ok) throw new Error();
    const opcoes: string[] = await resposta.json();
    if (pedido.signal.aborted) return;
    opcoes.forEach((hora) => horaReagendar.add(new Option(hora, hora)));
    horaReagendar.disabled = !opcoes.length;
    situacaoReagendar.textContent = opcoes.length ? "" : "Nenhum outro horário disponível nesta data.";
  } catch {
    if (!pedido.signal.aborted) situacaoReagendar.textContent = "Não foi possível consultar os horários desta reserva.";
  }
}

// Abre o diálogo na data atual da reserva para permitir a troca só de horário.
function abrirReagendamento(reserva: ReservaCliente) {
  reservaSelecionada = reserva;
  reservaReagendar.textContent = reserva.servico;
  delete situacaoReagendar.dataset.estado;
  dataReagendar.min = dataIso(new Date());
  dataReagendar.value = reserva.data;
  dialogo.showModal();
  void carregarHorariosReagendamento();
}

elemento("fechar-reagendar", HTMLButtonElement).addEventListener("click", () => dialogo.close());
dialogo.addEventListener("close", () => {
  consultaReagendar?.abort();
  reservaSelecionada = undefined;
});
dialogo.addEventListener("cancel", (evento) => {
  if (camposReagendar.disabled) evento.preventDefault();
});
dataReagendar.addEventListener("change", () => {
  delete situacaoReagendar.dataset.estado;
  void carregarHorariosReagendamento();
});
horaReagendar.addEventListener("change", () => { salvarReagendar.disabled = !horaReagendar.value; });

// Envia o novo horário e atualiza as duas abas após o sucesso.
formReagendar.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!reservaSelecionada || !horaReagendar.value || camposReagendar.disabled) return;
  camposReagendar.disabled = true;
  try {
    const resposta = await fetch(rotaReserva(reservaSelecionada), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: dataReagendar.value, horario: horaReagendar.value }),
    });
    const resultado: { mensagem: string } = await resposta.json();
    if (resposta.ok) {
      dialogo.close();
      aviso(mensagemHistorico, resultado.mensagem, true);
      await carregarHistorico();
      void atualizarHorarios();
    } else {
      if (resposta.status === 409 || resposta.status === 400) await carregarHorariosReagendamento();
      if (resposta.status === 401 || resposta.status === 404) salvarReagendar.disabled = true;
      aviso(situacaoReagendar, resultado.mensagem, false);
    }
  } catch {
    aviso(situacaoReagendar, "Não foi possível reagendar. Tente novamente.", false);
  } finally {
    camposReagendar.disabled = false;
  }
});

// Divide as reservas entre próximos atendimentos e histórico. A API decide quais são editáveis.
async function carregarHistorico() {
  consultaHistorico?.abort();
  const pedido = new AbortController();
  consultaHistorico = pedido;
  historico.replaceChildren();
  proximos.replaceChildren();
  proximosVazio.hidden = true;
  historicoVazio.hidden = true;
  situacaoHistorico.textContent = "Carregando sua agenda...";
  try {
    const resposta = await fetch("/cliente/agendamentos", { signal: pedido.signal });
    if (pedido.signal.aborted) return;
    if (resposta.status === 401) {
      mostrarSessao(null);
      situacaoHistorico.textContent = "Entre na sua conta para consultar sua agenda.";
      return;
    }
    if (!resposta.ok) throw new Error();
    const reservas: ReservaCliente[] = await resposta.json();
    if (pedido.signal.aborted) return;
    const agora = new Date();
    for (const reserva of reservas) {
      const data = new Date(`${reserva.data}T00:00:00`);
      const fim = new Date(data);
      fim.setMinutes(reserva.fim);
      const estado = reserva.cancelada ? "Cancelado"
        : reserva.comparecimento === "concluido" ? "Concluído"
        : reserva.comparecimento === "falta" ? "Falta"
        : fim <= agora ? "Passado" : "Agendado";
      const item = document.createElement("li");
      const nome = document.createElement("strong");
      nome.textContent = reserva.servico;
      const horario = document.createElement("p");
      horario.textContent = `${dataCurta.format(data)} · ${horaFormatada(reserva.inicio)}–${horaFormatada(reserva.fim)}`;
      const status = document.createElement("span");
      status.className = "agenda-status";
      status.dataset.estado = estado;
      status.textContent = estado;
      item.append(nome, horario, status);
      if (reserva.editavel) {
        const acoes = document.createElement("div");
        acoes.className = "agenda-acoes-reserva";
        const reagendar = document.createElement("button");
        reagendar.type = "button";
        reagendar.className = "botao-secundario";
        reagendar.textContent = "Reagendar";
        reagendar.addEventListener("click", () => abrirReagendamento(reserva));
        const cancelar = document.createElement("button");
        cancelar.type = "button";
        cancelar.className = "botao-secundario";
        cancelar.textContent = "Cancelar";
        cancelar.addEventListener("click", () => void cancelarAgendamento(reserva, cancelar));
        acoes.append(reagendar, cancelar);
        item.append(acoes);
      }
      // A API retorna os mais recentes primeiro. Inserir no início inverte só a lista futura.
      if (!reserva.cancelada && fim > agora) proximos.prepend(item);
      else historico.append(item);
    }
    situacaoHistorico.textContent = "";
    proximosVazio.hidden = proximos.childElementCount > 0;
    historicoVazio.hidden = historico.childElementCount > 0;
  } catch {
    if (!pedido.signal.aborted) situacaoHistorico.textContent = "Não foi possível carregar sua agenda. Tente abrir a aba novamente.";
  }
}

// O endereço da aba permite voltar pelo navegador sem perder as escolhas do formulário.
function sincronizarAba() {
  const vendoHistorico = location.hash === "#minha-agenda";
  abaAgendar.hidden = vendoHistorico;
  abaHistorico.hidden = !vendoHistorico;
  const ativo = vendoHistorico ? linkHistorico : linkAgendar;
  const inativo = vendoHistorico ? linkAgendar : linkHistorico;
  ativo.setAttribute("aria-current", "page");
  inativo.removeAttribute("aria-current");
  if (vendoHistorico) void carregarHistorico();
  else {
    consultaHistorico?.abort();
    historico.replaceChildren();
    proximos.replaceChildren();
  }
}

window.addEventListener("hashchange", sincronizarAba);
linkHistorico.addEventListener("click", () => {
  if (location.hash === "#minha-agenda") void carregarHistorico();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !abaHistorico.hidden) void carregarHistorico();
});

function dataIso(data: Date) {
  const doisDigitos = (valor: number) => String(valor).padStart(2, "0");
  return `${data.getFullYear()}-${doisDigitos(data.getMonth() + 1)}-${doisDigitos(data.getDate())}`;
}

function atualizarBotao() {
  confirmar.disabled = !clienteLogado || !servicoSelecionado || !horarioSelecionado;
}

// Mostra o nome, as iniciais e a opção de sair quando há sessão ativa.
function mostrarSessao(nome: string | null) {
  clienteLogado = nome !== null;
  acessoCliente.hidden = clienteLogado;
  contaCliente.hidden = !clienteLogado;
  nomeCliente.textContent = nome ?? "";
  const partes = nome?.trim().split(/\s+/) ?? [];
  const primeiro = partes[0]?.[0] ?? "";
  const ultimo = partes.length > 1 ? partes.at(-1)?.[0] ?? "" : "";
  iniciaisCliente.textContent = (primeiro + ultimo).toLocaleUpperCase("pt-BR");
  atualizarBotao();
}

// O calendário usa datas locais para preservar o dia escolhido em qualquer fuso.
function renderizarCalendario() {
  const ano = mesVisivel.getFullYear();
  const mes = mesVisivel.getMonth();
  const limite = new Date(ano, mes + 1, 0).getDate();
  const fragmento = document.createDocumentFragment();
  for (let coluna = 0; coluna < mesVisivel.getDay(); coluna++) {
    const espaco = document.createElement("span");
    espaco.setAttribute("aria-hidden", "true");
    fragmento.append(espaco);
  }

  for (let dia = 1; dia <= limite; dia++) {
    const data = new Date(ano, mes, dia);
    const iso = dataIso(data);
    const botao = document.createElement("button");
    botao.type = "button";
    botao.textContent = String(dia);
    botao.disabled = iso < dataIso(hoje);
    botao.setAttribute("aria-label", dataLonga.format(data));
    botao.setAttribute("aria-pressed", String(iso === dataIso(dataSelecionada)));
    if (iso === dataIso(hoje)) botao.setAttribute("aria-current", "date");
    botao.addEventListener("click", () => {
      dias.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
      botao.setAttribute("aria-pressed", "true");
      dataSelecionada = data;
      void atualizarHorarios();
    });
    fragmento.append(botao);
  }

  dias.replaceChildren(fragmento);
  mesAtual.textContent = mesFormatado.format(mesVisivel);
  mesAnterior.disabled = mesVisivel <= primeiroMes;
  mesSeguinte.disabled = ano === 9999 && mes === 11;
}

function mudarMes(delta: number) {
  mesVisivel = new Date(mesVisivel.getFullYear(), mesVisivel.getMonth() + delta, 1);
  renderizarCalendario();
  if (delta < 0 && mesAnterior.disabled) mesSeguinte.focus();
}

mesAnterior.addEventListener("click", () => mudarMes(-1));
mesSeguinte.addEventListener("click", () => mudarMes(1));

// Usa botões de rádio para seleção única e navegação por teclado.
function criarOpcao(grupo: string, valor: string) {
  const rotulo = document.createElement("label");
  const entrada = document.createElement("input");
  entrada.type = "radio";
  entrada.name = grupo;
  entrada.value = valor;
  rotulo.append(entrada);
  return { rotulo, entrada };
}

// Descarta respostas antigas se o cliente trocar rapidamente o serviço ou a data.
async function atualizarHorarios() {
  consulta?.abort();
  horarios.replaceChildren();
  horarioSelecionado = "";
  atualizarBotao();
  tituloHorarios.textContent = `Horários · ${dataCurta.format(dataSelecionada)}`;
  if (!servicoSelecionado) return;

  const pedido = new AbortController();
  consulta = pedido;
  situacaoHorarios.textContent = "Carregando horários...";
  const parametros = new URLSearchParams({
    data: dataIso(dataSelecionada),
    servicoId: String(servicoSelecionado.id),
  });
  try {
    const resposta = await fetch(`/horarios?${parametros}`, { signal: pedido.signal });
    if (!resposta.ok) throw new Error();
    const disponiveis: string[] = await resposta.json();
    if (pedido.signal.aborted) return;
    situacaoHorarios.textContent = disponiveis.length ? "" : "Nenhum horário disponível para esta data.";
    for (const hora of disponiveis) {
      const { rotulo, entrada } = criarOpcao("horario", hora);
      const texto = document.createElement("span");
      texto.textContent = hora;
      rotulo.append(texto);
      entrada.addEventListener("change", () => {
        horarioSelecionado = hora;
        atualizarBotao();
      });
      horarios.append(rotulo);
    }
  } catch {
    if (!pedido.signal.aborted) situacaoHorarios.textContent = "Não foi possível carregar os horários.";
  }
}

// Exibe cartões com duração e preço em reais, quando cadastrado.
async function carregarServicos() {
  const resposta = await fetch("/servicos");
  if (!resposta.ok) throw new Error();
  const catalogo: Servico[] = await resposta.json();
  if (!catalogo.length) servicos.textContent = "Nenhum serviço disponível.";
  for (const servico of catalogo) {
    const { rotulo, entrada } = criarOpcao("servico", String(servico.id));
    const cartao = document.createElement("span");
    const nome = document.createElement("strong");
    nome.textContent = servico.nome;
    const detalhes = document.createElement("small");
    const preco = servico.precoCentavos === null ? "" : ` · ${moeda.format(servico.precoCentavos / 100)}`;
    detalhes.textContent = `${servico.duracaoMinutos} min${preco}`;
    cartao.append(nome, detalhes);
    rotulo.append(cartao);
    entrada.addEventListener("change", () => {
      servicoSelecionado = servico;
      void atualizarHorarios();
    });
    servicos.append(rotulo);
  }
}

// Envia a reserva para o servidor validar a sessão e a disponibilidade.
formulario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (campos.disabled || !clienteLogado || !servicoSelecionado || !horarioSelecionado) return;
  campos.disabled = true;
  delete mensagem.dataset.estado;
  mensagem.textContent = "Confirmando agendamento...";
  try {
    const resposta = await fetch("/agendamentos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        servicoId: servicoSelecionado.id,
        data: dataIso(dataSelecionada),
        horario: horarioSelecionado,
      }),
    });
    const resultado: { mensagem: string } = await resposta.json();
    mensagem.dataset.estado = resposta.ok ? "sucesso" : "erro";
    mensagem.textContent = resposta.ok
      ? `Agendamento confirmado: ${servicoSelecionado.nome}, dia ${dataCurta.format(dataSelecionada)} às ${horarioSelecionado}.`
      : resultado.mensagem;
    if (resposta.status === 401) mostrarSessao(null);
    if (resposta.ok && !abaHistorico.hidden) void carregarHistorico();
    if (resposta.ok || resposta.status === 409 || resposta.status === 400) await atualizarHorarios();
  } catch {
    mensagem.dataset.estado = "erro";
    mensagem.textContent = "Não foi possível confirmar o agendamento.";
  } finally {
    campos.disabled = false;
  }
});

renderizarCalendario();
sincronizarAba();
void carregarServicos().catch(() => { servicos.textContent = "Não foi possível carregar os serviços."; });
void fetch("/cliente/sessao").then(async (resposta) => {
  if (!resposta.ok) throw new Error();
  const cliente: { nome: string } | null = await resposta.json();
  mostrarSessao(cliente?.nome ?? null);
}).catch(() => {
  mensagem.textContent = "Não foi possível consultar sua conta. Atualize a página.";
});
export {};
