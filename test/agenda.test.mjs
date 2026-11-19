import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

test("regras da agenda pela API HTTP", { timeout: 15000 }, async (t) => {
  const pasta = await mkdtemp(join(tmpdir(), "barbearia-teste-"));
  const arquivoBanco = join(pasta, "agenda.sqlite");
  const arquivoEnv = join(pasta, ".env");
  await writeFile(arquivoEnv, "BARBEIRO_SENHA=senha-de-teste\n");
  const liberarMeta = join(pasta, "liberar-meta");
  // Intercepta apenas chamadas à Meta. A API de agendamento roda normalmente via HTTP.
  const metaSimulada = `
    import { existsSync } from "node:fs";
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = async (url, opcoes) => {
      if (new URL(url).hostname !== "graph.facebook.com") return fetchOriginal(url, opcoes);
      const dados = JSON.parse(opcoes.body);
      const novo = dados.template.components[0].parameters[2].text;
      if (novo.endsWith("12:00")) {
        while (!existsSync(${JSON.stringify(liberarMeta)})) await new Promise(resolve => setTimeout(resolve, 10));
        return Response.json({ error: { code: 190 } }, { status: 401 });
      }
      return Response.json({ messages: [{ id: "id-simulado" }] });
    };
  `;
  const ambiente = { ...process.env };
  delete ambiente.BARBEIRO_SENHA;
  const servidor = spawn(process.execPath, [`--env-file-if-exists=${arquivoEnv}`,
    "--import", `data:text/javascript,${encodeURIComponent(metaSimulada)}`, "server.ts"], {
    env: { ...ambiente, AGENDA_DB: arquivoBanco, AGENDA_PORT: "0",
      WHATSAPP_TOKEN: "token-simulado",
      WHATSAPP_PHONE_NUMBER_ID: "1234", WHATSAPP_BARBEIRO_NUMERO: "5511912340000",
      WHATSAPP_TEMPLATE: "reagendamento_teste", WHATSAPP_GRAPH_VERSION: "v27.0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const fim = once(servidor, "exit");
  t.after(async () => {
    servidor.kill();
    await fim;
    await rm(pasta, { recursive: true, force: true });
  });
  const url = await Promise.race([
    (async () => {
      for await (const linha of createInterface({ input: servidor.stdout })) {
        const endereco = linha.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (endereco) return endereco;
      }
    })(),
    fim.then(([codigo]) => { throw new Error(`Servidor terminou com código ${codigo}`); }),
  ]);
  const req = (rota, { cookie, method = "GET", dados } = {}) => fetch(url + rota, {
    method,
    redirect: "manual",
    headers: cookie ? { cookie } : {},
    body: dados instanceof URLSearchParams ? dados : JSON.stringify(dados),
  });
  async function cadastrar(nome, telefone) {
    const resposta = await req("/cliente/cadastro", {
      method: "POST", dados: new URLSearchParams({ nome, telefone, senha: "senha-de-teste" }),
    });
    assert.equal(resposta.headers.get("location"), "/");
    return resposta.headers.get("set-cookie").split(";")[0];
  }
  const clienteA = await cadastrar("Cliente Um", "11912340001");
  const clienteB = await cadastrar("Cliente Dois", "11912340002");
  const login = await req("/login", { method: "POST", dados: new URLSearchParams({ senha: "senha-de-teste" }) });
  assert.equal(login.headers.get("location"), "/painel");
  const barbeiro = login.headers.get("set-cookie").split(";")[0];
  const data = "2099-01-05";
  const reservar = (cookie, horario) => req("/agendamentos", {
    cookie, method: "POST", dados: { servicoId: 1, data, horario },
  });

  let dono, outro, reserva;
  await t.test("somente uma reserva vence quando dois clientes pedem a mesma vaga", async () => {
    const concorrentes = [clienteA, clienteB];
    const respostas = await Promise.all(concorrentes.map((cookie) => reservar(cookie, "09:00")));
    assert.deepEqual(respostas.map(({ status }) => status).sort(), [201, 409]);
    const indice = respostas.findIndex(({ status }) => status === 201);
    dono = concorrentes[indice];
    outro = concorrentes[1 - indice];
    [reserva] = await (await req("/cliente/agendamentos", { cookie: dono })).json();
    assert.ok(reserva.id);
  });
  await t.test("só o dono pode reagendar ou cancelar a reserva", async () => {
    const rota = `/cliente/agendamentos/${reserva.id}`;
    assert.equal((await req(rota, { cookie: outro, method: "PUT", dados: { data, horario: "10:00" } })).status, 404);
    assert.equal((await req(rota, { cookie: outro, method: "DELETE" })).status, 404);
    assert.deepEqual(await (await req("/cliente/agendamentos", { cookie: outro })).json(), []);
  });
  await t.test("reagendar protege a nova vaga e libera o horário anterior", async () => {
    const rota = `/cliente/agendamentos/${reserva.id}`;
    assert.equal((await reservar(outro, "10:00")).status, 201);
    assert.equal((await req(rota, { cookie: dono, method: "PUT", dados: { data, horario: "10:00" } })).status, 409);
    assert.equal((await reservar(outro, "09:00")).status, 409);
    assert.equal((await req(rota, { cookie: dono, method: "PUT", dados: { data, horario: "11:00" } })).status, 200);
    assert.equal((await reservar(outro, "11:00")).status, 409);
    assert.equal((await reservar(outro, "09:00")).status, 201);
    assert.equal((await req(rota, { cookie: dono, method: "DELETE" })).status, 200);
    assert.equal((await (await req("/cliente/agendamentos", { cookie: dono })).json())[0].cancelada, true);
  });
  await t.test("o barbeiro bloqueia um intervalo ou o dia inteiro sem apagar reservas existentes", async () => {
    const bloqueio = { data, inicio: "09:45", fim: "11:00", diaInteiro: false };
    assert.equal((await req("/bloqueios", { cookie: dono, method: "POST", dados: bloqueio })).status, 401);
    assert.equal((await req("/bloqueios", { cookie: barbeiro, method: "POST", dados: { ...bloqueio, data: "2099-02-30" } })).status, 400);
    const prever = async (dados) => (await req("/bloqueios/previsao", { cookie: barbeiro, method: "POST", dados })).json();
    const { afetadas } = await prever(bloqueio);
    assert.equal(afetadas.length, 1);
    assert.equal(afetadas[0].inicio, 600);
    assert.equal((await req("/bloqueios", { cookie: barbeiro, method: "POST", dados: bloqueio })).status, 409);
    assert.equal((await req("/bloqueios", { cookie: barbeiro, method: "POST",
      dados: { ...bloqueio, afetadasConfirmadas: afetadas.map(({ id }) => id) } })).status, 201);
    const horarios = async () => (await req(`/horarios?servicoId=1&data=${data}`)).json();
    assert.ok(!(await horarios()).includes("09:30"));
    assert.ok((await horarios()).includes("11:00"));
    assert.equal((await reservar(dono, "09:30")).status, 400);
    const [bloqueioSalvo] = await (await req(`/bloqueios?data=${data}`, { cookie: barbeiro })).json();
    assert.equal((await req(`/bloqueios/${bloqueioSalvo.id}`, { cookie: barbeiro, method: "DELETE" })).status, 200);
    assert.ok((await horarios()).includes("09:30"));
    const integral = { data, diaInteiro: true };
    const previaIntegral = await prever(integral);
    assert.equal(previaIntegral.afetadas.length, 2);
    assert.equal((await req("/bloqueios", { cookie: barbeiro, method: "POST",
      dados: { ...integral, afetadasConfirmadas: previaIntegral.afetadas.map(({ id }) => id) } })).status, 201);
    assert.deepEqual(await horarios(), []);
    const existentes = await (await req(`/agendamentos?data=${data}`, { cookie: barbeiro })).json();
    assert.equal(existentes.length, 2);
    const rotaReagendar = `/cliente/agendamentos/${existentes[0].id}`;
    assert.deepEqual(await (await req(`${rotaReagendar}?data=${data}`, { cookie: outro })).json(), []);
    assert.equal((await req(rotaReagendar, { cookie: outro, method: "PUT", dados: { data, horario: "13:00" } })).status, 400);
    const [diaBloqueado] = await (await req(`/bloqueios?data=${data}`, { cookie: barbeiro })).json();
    assert.equal((await req(`/bloqueios/${diaBloqueado.id}`, { cookie: barbeiro, method: "DELETE" })).status, 200);
  });
  await t.test("o painel registra o resultado da Meta e protege os dados dos avisos", async () => {
    assert.equal((await req("/avisos-whatsapp", { cookie: dono })).status, 401);
    const reservas = await (await req("/cliente/agendamentos", { cookie: outro })).json();
    assert.equal((await req(`/cliente/agendamentos/${reservas[0].id}`, {
      cookie: outro, method: "PUT", dados: { data, horario: "12:00" },
    })).status, 200);

    const pendentes = await (await req("/avisos-whatsapp", { cookie: barbeiro })).json();
    assert.equal(pendentes.avisos[0].estado, "pendente");
    await writeFile(liberarMeta, "");
    let avisos = [];
    for (let tentativa = 0; tentativa < 20; tentativa++) {
      const resposta = await req("/avisos-whatsapp", { cookie: barbeiro });
      assert.equal(resposta.status, 200);
      const resultado = await resposta.json();
      assert.equal(resultado.configurado, true);
      avisos = resultado.avisos;
      if (avisos.some(({ estado }) => estado === "falha")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(avisos.map(({ estado }) => estado), ["falha", "aceito"]);
    assert.match(avisos[0].erro, /HTTP 401, Meta 190/);
    assert.match(avisos[1].novo, /11:00/);
  });
  await t.test("o barbeiro pode reagendar pelo painel com as mesmas regras e sem duplicar avisos", async () => {
    const agenda = await (await req(`/agendamentos?data=${data}`, { cookie: barbeiro })).json();
    const rota = `/agendamentos/${agenda[0].id}/reagendar`;
    assert.equal((await req(`${rota}?data=${data}`, { cookie: outro })).status, 401);
    const horarios = await (await req(`${rota}?data=${data}`, { cookie: barbeiro })).json();
    assert.ok(horarios.includes("13:00"));
    assert.ok(!horarios.includes("12:00"));
    assert.equal((await req(rota, { cookie: barbeiro, method: "PUT", dados: { data, horario: "12:00" } })).status, 409);
    assert.equal((await req(rota, { cookie: barbeiro, method: "PUT", dados: { data, horario: "13:00" } })).status, 200);
    const atualizadas = await (await req("/cliente/agendamentos", { cookie: outro })).json();
    assert.ok(atualizadas.some(({ inicio, fim }) => inicio === 780 && fim === 810));
    const { avisos } = await (await req("/avisos-whatsapp", { cookie: barbeiro })).json();
    assert.equal(avisos.length, 2);
  });
  await t.test("comparecimento exige acesso do barbeiro e um atendimento encerrado", async () => {
    const banco = new DatabaseSync(arquivoBanco);
    let id;
    try {
      const cliente = banco.prepare("SELECT id FROM clientes WHERE telefone = ?").get("11912340001");
      const reserva = banco.prepare(`
        INSERT INTO reservas (nome, servico_id, data, inicio, fim, cliente_id, servico_nome)
        VALUES ('Cliente Um', 1, '2020-01-01', 540, 570, ?, 'Corte de cabelo') RETURNING id
      `).get(cliente.id);
      id = reserva.id;
    } finally {
      banco.close();
    }
    const comparecimento = (reservaId, cookie, estado) => req(`/agendamentos/${reservaId}/comparecimento`, {
      cookie, method: "PUT", dados: { comparecimento: estado },
    });
    const agenda = await (await req(`/agendamentos?data=${data}`, { cookie: barbeiro })).json();
    assert.equal((await comparecimento(agenda[0].id, barbeiro, "concluido")).status, 409);
    assert.equal((await comparecimento(id, clienteA, "concluido")).status, 401);
    for (const estado of ["concluido", "falta", null]) {
      assert.equal((await comparecimento(id, barbeiro, estado)).status, 200);
      const reservas = await (await req("/cliente/agendamentos", { cookie: clienteA })).json();
      assert.equal(reservas.find((reserva) => reserva.id === id).comparecimento, estado);
    }
  });
});
