// O calendário usa a data local do navegador.
const hoje = new Date();
const ano = hoje.getFullYear();
const mes = String(hoje.getMonth() + 1).padStart(2, "0");
const dia = String(hoje.getDate()).padStart(2, "0");

// Referências aos controles do formulário e à área de mensagens.
const campoData = obterElemento("data", HTMLInputElement);
const menuServico = obterElemento("servico", HTMLSelectElement);
const menuHorario = obterElemento("horario", HTMLSelectElement);
const formulario = obterElemento("agendamento", HTMLFormElement);
const campos = obterElemento("campos", HTMLFieldSetElement);
const confirmar = obterElemento("confirmar", HTMLButtonElement);
const campoNome = obterElemento("nome", HTMLInputElement);
const mensagem = obterElemento("mensagem", HTMLParagraphElement);
const dataHoje = `${ano}-${mes}-${dia}`;
campoData.min = dataHoje;

// Cancela a consulta anterior quando o serviço ou a data muda.
let consulta: AbortController | undefined;
async function atualizarHorarios() {
  consulta?.abort();
  const pedido = new AbortController();
  consulta = pedido;
  const opcaoInicial = new Option("Escolha um serviço e uma data", "");
  menuHorario.replaceChildren(opcaoInicial);
  menuHorario.disabled = true;
  confirmar.disabled = true;

  if (!menuServico.value || !campoData.value || !campoData.validity.valid) {
    return;
  }

  opcaoInicial.textContent = "Carregando horários...";
  const parametros = new URLSearchParams({
    data: campoData.value,
    servicoId: menuServico.value,
  });
  try {
    const resposta = await fetch(`/horarios?${parametros}`, {
      signal: pedido.signal,
    });
    if (!resposta.ok) throw new Error("Falha ao buscar horários");
    const horarios: string[] = await resposta.json();
    if (pedido.signal.aborted) return;
    for (const horario of horarios) {
      menuHorario.add(new Option(horario, horario));
    }
    menuHorario.disabled = horarios.length === 0;
    opcaoInicial.textContent = menuHorario.disabled
      ? "Nenhum horário disponível para esta data"
      : "Selecione...";
  } catch {
    if (!pedido.signal.aborted) {
      opcaoInicial.textContent = "Falha ao carregar horários";
    }
  }
}

// Atualiza os horários quando o serviço ou a data muda.
menuServico.addEventListener("change", atualizarHorarios);
campoData.addEventListener("change", atualizarHorarios);
menuHorario.addEventListener("change", () => {
  confirmar.disabled = !menuHorario.value;
});

// Envia a reserva sem recarregar a página e mostra o retorno do servidor.
formulario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!menuHorario.value) return;
  // Mantém os campos bloqueados até a API responder.
  campos.disabled = true;
  delete mensagem.dataset.estado;
  mensagem.textContent = "Confirmando agendamento...";
  try {
    const resposta = await fetch("/agendamentos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nome: campoNome.value,
        servicoId: Number(menuServico.value),
        data: campoData.value,
        horario: menuHorario.value,
      }),
    });
    const resultado: RespostaAgendamento = await resposta.json();
    const [anoReserva, mesReserva, diaReserva] = campoData.value.split("-");
    const dataFormatada = `${diaReserva}/${mesReserva}/${anoReserva}`;
    const servicoEscolhido = menuServico.selectedOptions[0].textContent;
    mensagem.dataset.estado = resposta.ok ? "sucesso" : "erro";
    mensagem.textContent = resposta.ok
      ? `Agendamento confirmado: ${servicoEscolhido}, dia ${dataFormatada} às ${menuHorario.value}.`
      : resultado.mensagem;
    if (resposta.ok) campoNome.value = "";
    // Recarrega os horários após a confirmação ou quando a API aponta um conflito.
    if (resposta.ok || resposta.status === 409) await atualizarHorarios();
  } catch {
    mensagem.dataset.estado = "erro";
    mensagem.textContent = "Não foi possível confirmar o agendamento.";
  } finally {
    campos.disabled = false;
  }
});

// Busca o catálogo e transforma cada serviço em uma opção do menu.
async function carregarServicos() {
  const resposta = await fetch("/servicos");

  if (!resposta.ok) {
    throw new Error("Falha ao buscar serviços");
  }

  const servicos: Servico[] = await resposta.json();

  for (const servico of servicos) {
    const opcao = document.createElement("option");
    opcao.value = String(servico.id);
    opcao.textContent = `${servico.nome} (${servico.duracaoMinutos} min)`;
    menuServico.append(opcao);
  }
}

carregarServicos().catch(() => {
  mensagem.textContent = "Não foi possível carregar os serviços.";
});
export {};

// Formato dos dados que o formulário recebe da API.
type Servico = {
  id: number;
  nome: string;
  duracaoMinutos: number;
};

type RespostaAgendamento = {
  mensagem: string;
};

// Confere se o HTML contém o elemento esperado e se ele tem o tipo correto.
function obterElemento<T extends HTMLElement>(
  id: string,
  tipo: new () => T,
): T {
  const elemento = document.getElementById(id);
  if (!(elemento instanceof tipo)) {
    throw new Error(`Elemento inválido ou ausente: #${id}`);
  }
  return elemento;
}
