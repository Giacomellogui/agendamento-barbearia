import type { IncomingMessage, ServerResponse } from "node:http";
import { banco } from "./banco.ts";
import { autenticado, clienteAutenticado } from "./autenticacao.ts";
import { lerJson, responderJson } from "./http.ts";
import { descreverHorario, enfileirarAviso, enviarAvisos, whatsappConfigurado } from "./whatsapp.ts";

// O catálogo e o expediente usam as mesmas colunas nos dois bancos.
const listarServicos = banco.prepare("SELECT * FROM servicos ORDER BY id");
const consultarServico = banco.prepare("SELECT * FROM servicos WHERE id = ?");
const criarServico = banco.prepare('INSERT INTO servicos (nome, "duracaoMinutos", "precoCentavos") VALUES (?, ?, ?) RETURNING *');
const editarServico = banco.prepare('UPDATE servicos SET nome = ?, "duracaoMinutos" = ?, "precoCentavos" = ? WHERE id = ? RETURNING *');
const consultarExpediente = banco.prepare('SELECT dias, abertura, fechamento, "inicioPausa", "fimPausa" FROM expediente WHERE id = 1');
const salvarExpediente = banco.prepare('UPDATE expediente SET dias = ?, abertura = ?, fechamento = ?, "inicioPausa" = ?, "fimPausa" = ? WHERE id = 1');
const listarBloqueios = banco.prepare("SELECT id, inicio, fim FROM bloqueios WHERE data = ? ORDER BY inicio, fim");
const inserirBloqueio = banco.prepare("INSERT INTO bloqueios (data, inicio, fim) VALUES (?, ?, ?)");
const excluirBloqueio = banco.prepare("DELETE FROM bloqueios WHERE id = ?");

function minutos(hora: unknown) {
  if (typeof hora !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hora)) return NaN;
  return Number(hora.slice(0, 2)) * 60 + Number(hora.slice(3));
}

const reservasOcupadas = banco.prepare("SELECT id, inicio, fim FROM reservas WHERE data = ? AND cancelada_em IS NULL");
// Confere conflitos e insere a reserva na mesma instrução SQL.
const inserirReserva = banco.prepare(`
  INSERT INTO reservas (nome, servico_id, data, inicio, fim, cliente_id, servico_nome)
  SELECT ?, ?, ?, ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1 FROM reservas WHERE data = ? AND inicio < ? AND fim > ? AND cancelada_em IS NULL
  )
`);
const listarReservas = banco.prepare(`
  SELECT r.id, r.nome, r.servico_id, r.data, r.inicio, r.fim, r.comparecimento,
    COALESCE(r.servico_nome, s.nome, 'Serviço indisponível') AS servico, c.telefone
  FROM reservas r LEFT JOIN servicos s ON s.id = r.servico_id
  LEFT JOIN clientes c ON c.id = r.cliente_id
  WHERE r.data = ? AND r.cancelada_em IS NULL ORDER BY r.inicio
`);
// O histórico mantém reservas canceladas e limita a consulta à conta autenticada.
const historicoCliente = banco.prepare(`
  SELECT r.id, r.data, r.inicio, r.fim, r.comparecimento,
    COALESCE(r.servico_nome, s.nome, 'Serviço indisponível') AS servico,
    r.cancelada_em IS NOT NULL AS cancelada
  FROM reservas r LEFT JOIN servicos s ON s.id = r.servico_id
  WHERE r.cliente_id = ? ORDER BY r.data DESC, r.inicio DESC, r.id DESC
`);
// Marca a reserva como cancelada para liberar o horário e preservar o registro.
const cancelarReserva = banco.prepare(
  "UPDATE reservas SET cancelada_em = CAST(CURRENT_TIMESTAMP AS TEXT) WHERE id = ? AND cancelada_em IS NULL AND comparecimento IS NULL",
);
const reservaDoCliente = banco.prepare(
  "SELECT data, inicio, fim FROM reservas WHERE id = ? AND cliente_id = ? AND cancelada_em IS NULL",
);
const reservaDoPainel = banco.prepare(
  "SELECT data, inicio, fim FROM reservas WHERE id = ? AND cancelada_em IS NULL",
);
const registrarComparecimento = banco.prepare(
  "UPDATE reservas SET comparecimento = ? WHERE id = ? AND cancelada_em IS NULL",
);
const reservasAfetadas = banco.prepare(`
  SELECT id, nome, inicio, fim, servico_nome AS servico
  FROM reservas WHERE data = ? AND inicio < ? AND fim > ? AND cancelada_em IS NULL
  ORDER BY inicio, id
`);
const reagendarReserva = banco.prepare(`
  UPDATE reservas SET data = ?, inicio = ?, fim = ?
  WHERE id = ? AND cancelada_em IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM reservas WHERE data = ? AND inicio < ? AND fim > ? AND id <> ? AND cancelada_em IS NULL
    )
`);
// O cliente só pode alterar a reserva antes do horário de início.
function reservaFutura(data: string, inicio: number) {
  const horario = new Date(`${data}T00:00:00`);
  horario.setMinutes(inicio);
  return horario.getTime() > Date.now();
}
function dataValida(data: unknown): data is string {
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return false;
  const dia = new Date(`${data}T00:00:00Z`);
  return !Number.isNaN(dia.getTime()) && dia.toISOString().slice(0, 10) === data;
}

// Calcula os horários em que o serviço inteiro cabe entre o expediente e os bloqueios.
async function horariosPossiveis(data: unknown, duracao: number) {
  if (!dataValida(data)) return [];
  const dia = new Date(`${data}T00:00:00Z`);

  const agora = new Date();
  const hoje = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}-${String(agora.getDate()).padStart(2, "0")}`;
  if (data < hoje) return [];

  const expediente = (await consultarExpediente.get())!;
  if (!(Number(expediente.dias) & (1 << dia.getUTCDay()))) return [];
  const abertura = minutos(expediente.abertura);
  const fechamento = minutos(expediente.fechamento);
  const inicioPausa = minutos(expediente.inicioPausa);
  const fimPausa = minutos(expediente.fimPausa);
  const bloqueios = (await listarBloqueios.all(data)).map(({ inicio, fim }) => ({
    inicio: Number(inicio), fim: Number(fim),
  }));

  // Os horários são calculados em minutos desde a meia-noite.
  const horarios = [];
  const minutoAtual = agora.getHours() * 60 + agora.getMinutes();
  for (let inicio = abertura; inicio + duracao <= fechamento; inicio += 30) {
    if (data === hoje && inicio <= minutoAtual) continue;
    if (inicio < fimPausa && inicio + duracao > inicioPausa) continue;
    if (bloqueios.some((bloqueio) => inicio < bloqueio.fim && inicio + duracao > bloqueio.inicio)) continue;
    const hora = String(Math.floor(inicio / 60)).padStart(2, "0");
    const minuto = String(inicio % 60).padStart(2, "0");
    horarios.push({ inicio, texto: `${hora}:${minuto}` });
  }
  return horarios;
}

// Consulta todos os intervalos de uma vez e ignora a própria reserva no reagendamento.
async function horariosLivres(data: string, duracao: number, ignorarId?: number) {
  const horarios = await horariosPossiveis(data, duracao);
  if (!horarios.length) return [];
  const ocupadas = (await reservasOcupadas.all(data)).filter(({ id }) => id !== ignorarId);
  return horarios.filter(({ inicio }) =>
    !ocupadas.some((reserva) => inicio < Number(reserva.fim) && inicio + duracao > Number(reserva.inicio)));
}

export async function atenderAgenda(req: IncomingMessage, res: ServerResponse, url: URL) {
  const rotaBloqueio = /^\/bloqueios\/(\d+)$/.exec(url.pathname);
  const preverBloqueio = url.pathname === "/bloqueios/previsao" && req.method === "POST";
  if ((url.pathname === "/bloqueios" && (req.method === "GET" || req.method === "POST")) ||
      preverBloqueio || (rotaBloqueio && req.method === "DELETE")) {
    const dados = req.method === "POST" ? await lerJson(req) : null;
    res.setHeader("Cache-Control", "no-store");
    if (!autenticado(req)) {
      responderJson(res, 401, { mensagem: "Entre no painel para gerenciar bloqueios." });
      return true;
    }
    if (rotaBloqueio) {
      const id = Number(rotaBloqueio[1]);
      const removido = Number.isSafeInteger(id) && (await excluirBloqueio.run(id)).changes > 0;
      responderJson(res, removido ? 200 : 404, { mensagem: removido ? "Bloqueio removido." : "Bloqueio não encontrado." });
      return true;
    }
    const data = req.method === "GET" ? url.searchParams.get("data") : dados?.data;
    if (!dataValida(data)) {
      responderJson(res, 400, { mensagem: "Escolha uma data válida." });
      return true;
    }
    if (req.method === "GET") {
      responderJson(res, 200, await listarBloqueios.all(data));
      return true;
    }
    const diaInteiro = dados?.diaInteiro === true;
    const inicio = diaInteiro ? 0 : minutos(dados?.inicio);
    const fim = diaInteiro ? 1440 : minutos(dados?.fim);
    if (!(inicio < fim)) {
      responderJson(res, 400, { mensagem: "O fim do bloqueio precisa ser depois do início." });
      return true;
    }
    if (preverBloqueio) {
      responderJson(res, 200, { afetadas: await reservasAfetadas.all(data, fim, inicio) });
      return true;
    }
    // Exige nova confirmação se uma reserva entrou no intervalo desde a prévia.
    const impacto = await banco.transacao(async () => {
      const afetadas = await reservasAfetadas.all(data, fim, inicio);
      const confirmadas = dados?.afetadasConfirmadas;
      if (afetadas.length && (!Array.isArray(confirmadas) ||
          afetadas.some(({ id }) => !confirmadas.includes(id)))) return afetadas;
      await inserirBloqueio.run(data, inicio, fim);
    });
    if (impacto) {
      responderJson(res, 409, { mensagem: "Confira as reservas afetadas antes de salvar o bloqueio.", afetadas: impacto });
      return true;
    }
    responderJson(res, 201, { mensagem: "Bloqueio salvo." });
    return true;
  }
  if (url.pathname === "/cliente/agendamentos" && req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    const cliente = await clienteAutenticado(req);
    if (!cliente) {
      responderJson(res, 401, { mensagem: "Entre para consultar sua agenda." });
      return true;
    }
    const reservas = (await historicoCliente.all(cliente.id)).map((reserva) => ({
      ...reserva,
      cancelada: Boolean(reserva.cancelada),
      editavel: !reserva.cancelada && reservaFutura(String(reserva.data), Number(reserva.inicio)),
    }));
    responderJson(res, 200, reservas);
    return true;
  }
  // Verifica se a reserva pertence ao cliente e pode ser alterada.
  const rotaReservaCliente = /^\/cliente\/agendamentos\/(\d+)$/.exec(url.pathname);
  const rotaReagendarPainel = /^\/agendamentos\/(\d+)\/reagendar$/.exec(url.pathname);
  const rotaReagendar = rotaReservaCliente ?? rotaReagendarPainel;
  if (rotaReagendar && (req.method === "GET" || req.method === "PUT" ||
      (rotaReservaCliente && req.method === "DELETE"))) {
    const dados = req.method === "PUT" ? await lerJson(req) : null;
    res.setHeader("Cache-Control", "no-store");
    const cliente = rotaReservaCliente ? await clienteAutenticado(req) : undefined;
    if (rotaReservaCliente ? !cliente : !autenticado(req)) {
      responderJson(res, 401, { mensagem: "Entre para alterar a reserva." });
      return true;
    }
    const id = Number(rotaReagendar[1]);
    const consultarReserva = async () => Number.isSafeInteger(id)
      ? cliente ? await reservaDoCliente.get(id, cliente.id) : await reservaDoPainel.get(id)
      : undefined;
    const indisponivel = "Esta reserva futura não está disponível.";
    if (req.method === "GET") {
      const reserva = await consultarReserva();
      if (!reserva || !reservaFutura(String(reserva.data), Number(reserva.inicio))) {
        responderJson(res, 404, { mensagem: indisponivel });
        return true;
      }
      const data = url.searchParams.get("data") ?? "";
      const duracao = Number(reserva.fim) - Number(reserva.inicio);
      const horarios = (await horariosLivres(data, duracao, id))
        .filter(({ inicio }) => !(data === reserva.data && inicio === reserva.inicio))
        .map(({ texto }) => texto);
      responderJson(res, 200, horarios);
      return true;
    }
    // Salva o novo horário e a entrada na fila de avisos na mesma transação.
    const resultado = await banco.transacao(async () => {
      const reserva = await consultarReserva();
      if (!reserva || !reservaFutura(String(reserva.data), Number(reserva.inicio))) {
        return { status: 404, mensagem: indisponivel };
      }
      if (req.method === "DELETE") {
        const cancelada = await cancelarReserva.run(id);
        return cancelada.changes ? { status: 200, mensagem: "Agendamento cancelado." }
          : { status: 404, mensagem: indisponivel };
      }
      // Mantém a duração original da reserva mesmo após mudanças no catálogo.
      const duracao = Number(reserva.fim) - Number(reserva.inicio);
      const data: unknown = dados?.data;
      const horario = (await horariosPossiveis(data, duracao)).find(({ texto }) => texto === dados?.horario);
      if (typeof data !== "string" || !horario || (data === reserva.data && horario.inicio === reserva.inicio)) {
        return { status: 400, mensagem: "Escolha uma data e um horário diferentes dos atuais." };
      }
      const { inicio } = horario;
      const fim = inicio + duracao;
      const alterada = await reagendarReserva.run(data, inicio, fim, id, data, fim, inicio, id);
      if (alterada.changes === 0) {
        return { status: 409, mensagem: "Esse horário já foi ocupado. Escolha outro." };
      }
      if (cliente && whatsappConfigurado) {
        await enfileirarAviso.run(id, descreverHorario(String(reserva.data), Number(reserva.inicio)),
          descreverHorario(data, inicio), Date.now());
      }
      return { status: 200, mensagem: "Agendamento remarcado." };
    });
    responderJson(res, resultado.status, { mensagem: resultado.mensagem });
    if (req.method === "PUT" && resultado.status === 200 && cliente) void enviarAvisos();
    return true;
  }
  if (req.method === "GET" && url.pathname === "/servicos") {
    res.setHeader("Cache-Control", "no-store");
    responderJson(res, 200, await listarServicos.all());
    return true;
  }
  const rotaServico = /^\/servicos\/(\d+)$/.exec(url.pathname);
  if ((req.method === "POST" && url.pathname === "/servicos") ||
      (req.method === "PUT" && rotaServico)) {
    const dados = await lerJson(req);
    if (!autenticado(req)) {
      responderJson(res, 401, { mensagem: "Entre no painel para alterar serviços." });
      return true;
    }
    const nome = typeof dados?.nome === "string" ? dados.nome.trim() : "";
    const duracao = dados?.duracaoMinutos;
    const preco = dados?.precoCentavos;
    if (!nome || nome.length > 100 || !Number.isInteger(duracao) || duracao < 1 || duracao > 1439 ||
        (preco !== null && (!Number.isSafeInteger(preco) || preco < 0 || preco > 99999999))) {
      responderJson(res, 400, { mensagem: "Informe um nome, uma duração válida e um preço de até R$ 999.999,99." });
      return true;
    }
    const servico = await banco.transacao(() => rotaServico
      ? editarServico.get(nome, duracao, preco, Number(rotaServico[1]))
      : criarServico.get(nome, duracao, preco));
    if (!servico) {
      responderJson(res, 404, { mensagem: "Serviço não encontrado." });
      return true;
    }
    responderJson(res, rotaServico ? 200 : 201, { mensagem: "Serviço salvo.", servico });
    return true;
  }
  if (url.pathname === "/expediente" && (req.method === "GET" || req.method === "PUT")) {
    const dados = req.method === "PUT" ? await lerJson(req) : null;
    res.setHeader("Cache-Control", "no-store");
    if (!autenticado(req)) {
      responderJson(res, 401, { mensagem: "Entre no painel para acessar o expediente." });
      return true;
    }
    if (req.method === "GET") {
      responderJson(res, 200, await consultarExpediente.get());
      return true;
    }
    const { dias, abertura, fechamento, inicioPausa, fimPausa } = dados ?? {};
    const inicio = minutos(abertura);
    const fim = minutos(fechamento);
    const pausaInicio = minutos(inicioPausa);
    const pausaFim = minutos(fimPausa);
    const pausaValida = (inicioPausa === null && fimPausa === null) ||
      (inicio <= pausaInicio && pausaInicio < pausaFim && pausaFim <= fim);
    if (!Number.isInteger(dias) || dias < 0 || dias > 127 || !(inicio < fim) || !pausaValida) {
      responderJson(res, 400, { mensagem: "Confira os dias, a ordem dos horários e se a pausa está dentro do expediente." });
      return true;
    }
    await banco.transacao(() => salvarExpediente.run(dias, abertura, fechamento, inicioPausa, fimPausa));
    responderJson(res, 200, { mensagem: "Expediente salvo." });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/agendamentos") {
    res.setHeader("Cache-Control", "no-store");
    if (!autenticado(req)) {
      responderJson(res, 401, { mensagem: "Entre no painel para consultar a agenda." });
      return true;
    }
    const data = url.searchParams.get("data");
    if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      responderJson(res, 400, { mensagem: "Escolha uma data." });
      return true;
    }
    const reservas = (await listarReservas.all(data)).map((reserva) => ({
      ...reserva,
      editavel: reservaFutura(data, Number(reserva.inicio)),
      encerrada: !reservaFutura(data, Number(reserva.fim)),
    }));
    responderJson(res, 200, reservas);
    return true;
  }
  const rotaComparecimento = /^\/agendamentos\/(\d+)\/comparecimento$/.exec(url.pathname);
  if (req.method === "PUT" && rotaComparecimento) {
    const dados = await lerJson(req);
    if (!autenticado(req)) {
      responderJson(res, 401, { mensagem: "Entre no painel para registrar o comparecimento." });
      return true;
    }
    const comparecimento = dados?.comparecimento;
    if (comparecimento !== null && comparecimento !== "concluido" && comparecimento !== "falta") {
      responderJson(res, 400, { mensagem: "Escolha concluído, falta ou sem registro." });
      return true;
    }
    const id = Number(rotaComparecimento[1]);
    const reserva = Number.isSafeInteger(id) ? await reservaDoPainel.get(id) : undefined;
    if (!reserva) {
      responderJson(res, 404, { mensagem: "Reserva indisponível." });
      return true;
    }
    if (reservaFutura(String(reserva.data), Number(reserva.fim))) {
      responderJson(res, 409, { mensagem: "Aguarde o fim do horário para registrar o comparecimento." });
      return true;
    }
    await registrarComparecimento.run(comparecimento, id);
    responderJson(res, 200, { mensagem: "Comparecimento atualizado." });
    return true;
  }
  if (req.method === "DELETE" && /^\/agendamentos\/\d+$/.test(url.pathname)) {
    if (!autenticado(req)) {
      responderJson(res, 401, { mensagem: "Entre no painel para cancelar agendamentos." });
      return true;
    }
    const id = Number(url.pathname.split("/").at(-1));
    const cancelado = (await cancelarReserva.run(id)).changes > 0;
    responderJson(res, cancelado ? 200 : 404, {
      mensagem: cancelado ? "Agendamento cancelado." : "Agendamento indisponível ou já cancelado.",
    });
    return true;
  }
  // Filtra os horários que se sobrepõem a reservas existentes.
  if (req.method === "GET" && url.pathname === "/horarios") {
    const data = url.searchParams.get("data");
    const id = url.searchParams.get("servicoId");
    const servico = id && /^\d+$/.test(id) ? await consultarServico.get(Number(id)) : undefined;
    if (!data || !servico) {
      responderJson(res, 400, { mensagem: "Escolha um serviço e uma data." });
      return true;
    }
    res.setHeader("Cache-Control", "no-store");
    const duracao = Number(servico.duracaoMinutos);
    const horarios = (await horariosLivres(data, duracao)).map(({ texto }) => texto);
    responderJson(res, 200, horarios);
    return true;
  }
  // Valida os dados no servidor e tenta salvar o agendamento.
  if (req.method === "POST" && url.pathname === "/agendamentos") {
    const reserva = await lerJson(req);
    const cliente = await clienteAutenticado(req);
    if (!cliente) {
      responderJson(res, 401, { mensagem: "Entre na sua conta para confirmar o agendamento." });
      return true;
    }
    const resultado = await banco.transacao(async () => {
      const servico = Number.isSafeInteger(reserva?.servicoId)
        ? await consultarServico.get(reserva.servicoId) : undefined;
      const data = reserva?.data;
      const duracao = Number(servico?.duracaoMinutos);
      const horario = servico && (await horariosPossiveis(data, duracao))
        .find(({ texto }) => texto === reserva?.horario);
      if (!servico || !horario) {
        return { status: 400, mensagem: "Escolha um serviço, uma data e um horário válidos." };
      }
      const inicio = horario.inicio;
      const fim = inicio + duracao;
      const inserida = await inserirReserva.run(cliente.nome, servico.id, data, inicio, fim, cliente.id, servico.nome, data, fim, inicio);
      return inserida.changes
        ? { status: 201, mensagem: `Agendamento confirmado para ${horario.texto}.` }
        : { status: 409, mensagem: "Esse horário já foi ocupado. Escolha outro." };
    });
    responderJson(res, resultado.status, { mensagem: resultado.mensagem });
    return true;
  }
  return false;
}
