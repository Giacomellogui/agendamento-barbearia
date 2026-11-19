export {};

type Comparecimento = "concluido" | "falta" | null;

// Dados de uma reserva retornada pela API do painel.
type Reserva = {
  id: number;
  nome: string;
  servico: string;
  data: string;
  inicio: number;
  fim: number;
  telefone: string | null;
  comparecimento: Comparecimento;
  editavel: boolean;
  encerrada: boolean;
};

// Controles do painel. A primeira consulta usa a data local de hoje.
const data = document.querySelector<HTMLInputElement>("#data")!;
const mensagem = document.querySelector<HTMLParagraphElement>("#mensagem")!;
const situacao = document.querySelector<HTMLParagraphElement>("#situacao")!;
const lista = document.querySelector<HTMLUListElement>("#reservas")!;
// Mostra a contagem de reservas da data consultada.
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
      const acoes = document.createElement("div");
      acoes.className = "painel-reserva-acoes";
      if (reserva.editavel) {
        const reagendar = document.createElement("button");
        reagendar.type = "button";
        reagendar.textContent = "Reagendar";
        reagendar.addEventListener("click", () => abrirReagendamentoPainel(reserva));
        acoes.append(reagendar);
      }
      if (reserva.encerrada) acoes.append(controleComparecimento(reserva));
      if (!reserva.comparecimento) acoes.append(botao);
      item.append(horario, dados, acoes);
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

function controleComparecimento(reserva: Reserva) {
  const rotulo = document.createElement("label");
  rotulo.className = "painel-comparecimento campos-formulario";
  rotulo.textContent = "Comparecimento";
  const seletor = document.createElement("select");
  seletor.add(new Option("Sem registro", ""));
  seletor.add(new Option("Concluído", "concluido"));
  seletor.add(new Option("Falta", "falta"));
  seletor.value = reserva.comparecimento ?? "";
  seletor.setAttribute("aria-label", `Comparecimento de ${reserva.nome}`);
  seletor.addEventListener("change", async () => {
    seletor.disabled = true;
    try {
      const resultado = await consultarJson<{ mensagem: string }>(`/agendamentos/${reserva.id}/comparecimento`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comparecimento: seletor.value || null }),
      });
      if (data.value === reserva.data) {
        mensagem.textContent = resultado.mensagem;
        await carregarAgenda();
      }
    } catch (erro) {
      if (data.value === reserva.data) mensagem.textContent = mensagemErro(erro);
      seletor.value = reserva.comparecimento ?? "";
    } finally {
      seletor.disabled = false;
    }
  });
  rotulo.append(seletor);
  return rotulo;
}

// Carrega os dias e horários cadastrados antes de habilitar o formulário.
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

// Mantém o seletor e os dados de edição sincronizados com a resposta da API.
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

// Usa POST para criar e PUT para editar, enviando o preço em centavos.
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

type Bloqueio = { id: number; inicio: number; fim: number };
const formBloqueio = document.querySelector<HTMLFormElement>("#form-bloqueio")!;
const camposBloqueio = formBloqueio.querySelector("fieldset")!;
const diaInteiro = document.querySelector<HTMLInputElement>("#bloqueio-dia-inteiro")!;
const inicioBloqueio = document.querySelector<HTMLInputElement>("#bloqueio-inicio")!;
const fimBloqueio = document.querySelector<HTMLInputElement>("#bloqueio-fim")!;
const dataBloqueio = document.querySelector<HTMLElement>("#data-bloqueio")!;
const listaBloqueios = document.querySelector<HTMLUListElement>("#lista-bloqueios")!;
const situacaoBloqueios = document.querySelector<HTMLElement>("#situacao-bloqueios")!;
const dialogoImpacto = document.querySelector<HTMLDialogElement>("#dialogo-impacto-bloqueio")!;
const listaImpacto = document.querySelector<HTMLUListElement>("#lista-impacto-bloqueio")!;
let consultaBloqueios: AbortController | undefined;
let salvandoBloqueio = false;

type ReservaAfetada = Pick<Reserva, "id" | "nome" | "inicio" | "fim"> & { servico: string | null };

function confirmarImpacto(afetadas: ReservaAfetada[]) {
  if (!afetadas.length) return Promise.resolve(true);
  listaImpacto.replaceChildren();
  for (const reserva of afetadas) {
    const item = document.createElement("li");
    const servico = reserva.servico ? ` · ${reserva.servico}` : "";
    item.textContent = `${formatarHora(reserva.inicio)}–${formatarHora(reserva.fim)} · ${reserva.nome}${servico}`;
    listaImpacto.append(item);
  }
  dialogoImpacto.returnValue = "";
  return new Promise<boolean>((resolve) => {
    dialogoImpacto.addEventListener("close", () => resolve(dialogoImpacto.returnValue === "confirmar"), { once: true });
    dialogoImpacto.showModal();
  });
}

// Os bloqueios acompanham a mesma data selecionada na agenda do barbeiro.
async function carregarBloqueios() {
  consultaBloqueios?.abort();
  listaBloqueios.replaceChildren();
  const dia = data.value;
  camposBloqueio.disabled = salvandoBloqueio || !dia;
  dataBloqueio.textContent = dia ? `Bloqueios de ${dia.split("-").reverse().join("/")}` : "";
  situacaoBloqueios.textContent = dia ? "Carregando bloqueios..." : "Escolha a data na agenda.";
  if (!dia) return;
  const pedido = new AbortController();
  consultaBloqueios = pedido;
  try {
    const bloqueios = await consultarJson<Bloqueio[]>(`/bloqueios?data=${encodeURIComponent(dia)}`, { signal: pedido.signal });
    if (pedido.signal.aborted) return;
    situacaoBloqueios.textContent = bloqueios.length ? "" : "Nenhum bloqueio nesta data.";
    for (const bloqueio of bloqueios) {
      const item = document.createElement("li");
      const periodo = bloqueio.inicio === 0 && bloqueio.fim === 1440
        ? "Dia inteiro"
        : `${formatarHora(bloqueio.inicio)}–${formatarHora(bloqueio.fim)}`;
      const remover = document.createElement("button");
      remover.type = "button";
      remover.className = "botao-secundario";
      remover.textContent = "Remover";
      remover.setAttribute("aria-label", `Remover bloqueio: ${periodo}`);
      remover.addEventListener("click", async () => {
        remover.disabled = true;
        try {
          const resultado = await consultarJson<{ mensagem: string }>(`/bloqueios/${bloqueio.id}`, { method: "DELETE" });
          if (dia === data.value) estadoFormulario(formBloqueio, resultado.mensagem);
          await carregarBloqueios();
        } catch (erro) {
          if (dia === data.value) estadoFormulario(formBloqueio, mensagemErro(erro), true);
          remover.disabled = false;
        }
      });
      item.append(periodo, remover);
      listaBloqueios.append(item);
    }
  } catch (erro) {
    if (!pedido.signal.aborted) situacaoBloqueios.textContent = mensagemErro(erro);
  }
}

diaInteiro.addEventListener("change", () => {
  inicioBloqueio.disabled = diaInteiro.checked;
  fimBloqueio.disabled = diaInteiro.checked;
});
data.addEventListener("change", () => {
  estadoFormulario(formBloqueio, "");
  void carregarBloqueios();
});
formBloqueio.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (salvandoBloqueio || !data.value) return;
  const dia = data.value;
  salvandoBloqueio = true;
  camposBloqueio.disabled = true;
  try {
    const periodo = { data: dia, diaInteiro: diaInteiro.checked, inicio: inicioBloqueio.value, fim: fimBloqueio.value };
    estadoFormulario(formBloqueio, "Verificando as reservas...");
    const { afetadas } = await consultarJson<{ afetadas: ReservaAfetada[] }>("/bloqueios/previsao", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(periodo),
    });
    if (dia !== data.value || !await confirmarImpacto(afetadas)) {
      estadoFormulario(formBloqueio, "");
      return;
    }
    const resultado = await consultarJson<{ mensagem: string }>("/bloqueios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...periodo, afetadasConfirmadas: afetadas.map(({ id }) => id) }),
    });
    if (dia === data.value) estadoFormulario(formBloqueio, resultado.mensagem);
    await carregarBloqueios();
  } catch (erro) {
    if (dia === data.value) estadoFormulario(formBloqueio, mensagemErro(erro), true);
  } finally {
    salvandoBloqueio = false;
    camposBloqueio.disabled = !data.value;
  }
});
void carregarBloqueios();

const dialogoReagendar = document.querySelector<HTMLDialogElement>("#dialogo-reagendar-painel")!;
const formReagendar = document.querySelector<HTMLFormElement>("#form-reagendar-painel")!;
const camposReagendar = formReagendar.querySelector("fieldset")!;
const novaData = document.querySelector<HTMLInputElement>("#data-reagendar-painel")!;
const novoHorario = document.querySelector<HTMLSelectElement>("#hora-reagendar-painel")!;
const salvarHorario = document.querySelector<HTMLButtonElement>("#salvar-reagendamento-painel")!;
const resumoReagendar = document.querySelector<HTMLElement>("#reserva-reagendar-painel")!;
const situacaoReagendar = document.querySelector<HTMLElement>("#situacao-reagendar-painel")!;
let reservaParaReagendar: Reserva | undefined;
let consultaReagendamento: AbortController | undefined;

function abrirReagendamentoPainel(reserva: Reserva) {
  reservaParaReagendar = reserva;
  resumoReagendar.textContent = `${reserva.nome} · ${reserva.servico}`;
  const agora = new Date();
  novaData.min = `${agora.getFullYear()}-${doisDigitos(agora.getMonth() + 1)}-${doisDigitos(agora.getDate())}`;
  novaData.value = reserva.data;
  dialogoReagendar.showModal();
  void consultarHorariosPainel();
}

// O painel usa a mesma disponibilidade aplicada ao reagendamento pela conta do cliente.
async function consultarHorariosPainel() {
  consultaReagendamento?.abort();
  novoHorario.replaceChildren(new Option("Selecione um horário", ""));
  novoHorario.disabled = true;
  salvarHorario.disabled = true;
  situacaoReagendar.textContent = "";
  if (!reservaParaReagendar || !novaData.value || !novaData.validity.valid) return;
  const pedido = new AbortController();
  consultaReagendamento = pedido;
  situacaoReagendar.textContent = "Carregando horários...";
  try {
    const rota = `/agendamentos/${reservaParaReagendar.id}/reagendar?data=${encodeURIComponent(novaData.value)}`;
    const horarios = await consultarJson<string[]>(rota, { signal: pedido.signal });
    if (pedido.signal.aborted) return;
    for (const horario of horarios) novoHorario.add(new Option(horario, horario));
    novoHorario.disabled = !horarios.length;
    situacaoReagendar.textContent = horarios.length ? "" : "Nenhum outro horário disponível nesta data.";
  } catch (erro) {
    if (!pedido.signal.aborted) situacaoReagendar.textContent = mensagemErro(erro);
  }
}

document.querySelector("#fechar-reagendamento-painel")!.addEventListener("click", () => dialogoReagendar.close());
dialogoReagendar.addEventListener("close", () => {
  consultaReagendamento?.abort();
  reservaParaReagendar = undefined;
});
dialogoReagendar.addEventListener("cancel", (evento) => {
  if (camposReagendar.disabled) evento.preventDefault();
});
novaData.addEventListener("change", consultarHorariosPainel);
novoHorario.addEventListener("change", () => { salvarHorario.disabled = !novoHorario.value; });
formReagendar.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!reservaParaReagendar || !novoHorario.value || camposReagendar.disabled) return;
  const dia = novaData.value;
  camposReagendar.disabled = true;
  situacaoReagendar.textContent = "Salvando horário...";
  try {
    const resultado = await consultarJson<{ mensagem: string }>(`/agendamentos/${reservaParaReagendar.id}/reagendar`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: dia, horario: novoHorario.value }),
    });
    dialogoReagendar.close();
    data.value = dia;
    data.dispatchEvent(new Event("change"));
    mensagem.textContent = resultado.mensagem;
  } catch (erro) {
    await consultarHorariosPainel();
    situacaoReagendar.textContent = mensagemErro(erro);
  } finally {
    camposReagendar.disabled = false;
  }
});

type AvisoWhatsApp = {
  reserva_id: number;
  anterior: string;
  novo: string;
  estado: "pendente" | "aceito" | "falha";
  erro: string | null;
};
const nomesEstados = { pendente: "Pendente", aceito: "Aceito pela Meta", falha: "Falha" };
const secaoAvisos = document.querySelector<HTMLDetailsElement>("#secao-avisos")!;
const atualizarAvisos = document.querySelector<HTMLButtonElement>("#atualizar-avisos")!;
const listaAvisos = document.querySelector<HTMLUListElement>("#lista-avisos")!;
const situacaoAvisos = document.querySelector<HTMLElement>("#situacao-avisos")!;

// Aceito significa que a Meta aceitou a solicitação, sem confirmação de entrega no celular.
async function carregarAvisos() {
  if (atualizarAvisos.disabled) return;
  atualizarAvisos.disabled = true;
  situacaoAvisos.textContent = "Consultando avisos...";
  try {
    const { configurado, avisos } = await consultarJson<{ configurado: boolean; avisos: AvisoWhatsApp[] }>("/avisos-whatsapp");
    listaAvisos.replaceChildren();
    situacaoAvisos.textContent = !configurado
      ? "WhatsApp desativado neste servidor."
      : avisos.length ? "" : "Nenhum aviso registrado.";
    for (const aviso of avisos) {
      const item = document.createElement("li");
      const detalhes = document.createElement("div");
      const titulo = document.createElement("strong");
      titulo.textContent = `Reserva #${aviso.reserva_id}`;
      const horario = document.createElement("div");
      horario.textContent = `${aviso.anterior} → ${aviso.novo}`;
      detalhes.append(titulo, horario);
      if (aviso.erro) {
        const erro = document.createElement("small");
        erro.textContent = configurado ? `${aviso.erro} · Nova tentativa programada` : aviso.erro;
        detalhes.append(erro);
      }
      const estado = document.createElement("span");
      estado.className = "painel-estado-aviso";
      estado.dataset.estado = aviso.estado;
      estado.textContent = nomesEstados[aviso.estado];
      item.append(detalhes, estado);
      listaAvisos.append(item);
    }
  } catch (erro) {
    situacaoAvisos.textContent = mensagemErro(erro);
  } finally {
    atualizarAvisos.disabled = false;
  }
}

secaoAvisos.addEventListener("toggle", () => {
  if (secaoAvisos.open) void carregarAvisos();
});
atualizarAvisos.addEventListener("click", carregarAvisos);
