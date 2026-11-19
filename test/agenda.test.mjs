import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import pg from "pg";

test("regras da agenda pela API HTTP", { timeout: 15000 }, async (t) => {
  const pasta = await mkdtemp(join(tmpdir(), "barbearia-teste-"));
  const arquivoBanco = join(pasta, "agenda.sqlite");
  const urlPostgresTeste = process.env.TEST_DATABASE_URL;
  let servidor, fim, poolPostgres, esquema;
  let conexaoPostgres;
  let urlIsolada = "";
  t.after(async () => {
    try {
      if (servidor) {
        servidor.kill();
        await fim;
      }
      await conexaoPostgres?.end();
      if (poolPostgres && esquema) await poolPostgres.query(`DROP SCHEMA IF EXISTS ${esquema} CASCADE`);
    } finally {
      await poolPostgres?.end();
      await rm(pasta, { recursive: true, force: true });
    }
  });
  if (urlPostgresTeste) {
    esquema = `barbearia_teste_${randomUUID().replaceAll("-", "")}`;
    poolPostgres = new pg.Pool({ connectionString: urlPostgresTeste, connectionTimeoutMillis: 5000 });
    await poolPostgres.query(`CREATE SCHEMA ${esquema}`);
    const url = new URL(urlPostgresTeste);
    url.searchParams.set("options", `-c search_path=${esquema}`);
    urlIsolada = url.href;
    conexaoPostgres = new pg.Pool({ connectionString: urlIsolada, connectionTimeoutMillis: 5000 });
    const { rows } = await conexaoPostgres.query("SELECT current_schema() AS nome");
    assert.equal(rows[0].nome, esquema, "O PostgreSQL deve usar o esquema isolado dos testes.");
  }
  async function consultarBanco(sql, ...parametros) {
    if (conexaoPostgres) {
      let indice = 0;
      return (await conexaoPostgres.query(sql.replace(/\?/g, () => `$${++indice}`), parametros)).rows;
    }
    const banco = new DatabaseSync(arquivoBanco);
    try { return banco.prepare(sql).all(...parametros); }
    finally { banco.close(); }
  }
  const arquivoEnv = join(pasta, ".env");
  await writeFile(arquivoEnv, "BARBEIRO_SENHA=senha-de-teste\n");
  const liberarMeta = join(pasta, "liberar-meta");
  const mensagemVerificacao = join(pasta, "email-verificacao.json");
  const mensagemCadastro = join(pasta, "email-cadastro.json");
  const mensagemRecuperacao = join(pasta, "email-recuperacao.json");
  // Intercepta os provedores externos. A API de agendamento roda normalmente via HTTP.
  const metaSimulada = `
    import { existsSync, writeFileSync } from "node:fs";
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = async (url, opcoes) => {
      const host = new URL(url).hostname;
      if (host === "api.resend.com") {
        const dados = JSON.parse(opcoes.body);
        const destino = dados.to[0] === "novo@example.test" ? ${JSON.stringify(mensagemCadastro)}
          : dados.text.includes("/confirmar#") ? ${JSON.stringify(mensagemVerificacao)} : ${JSON.stringify(mensagemRecuperacao)};
        writeFileSync(destino, JSON.stringify(dados));
        return Response.json({ id: "email-simulado" });
      }
      if (host !== "graph.facebook.com") return fetchOriginal(url, opcoes);
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
  delete ambiente.AGENDA_HOST;
  delete ambiente.AGENDA_PORT;
  delete ambiente.PORT;
  async function iniciarServidor() {
    servidor = spawn(process.execPath, [`--env-file-if-exists=${arquivoEnv}`,
      "--import", `data:text/javascript,${encodeURIComponent(metaSimulada)}`, "server.ts"], {
      env: { ...ambiente, DATABASE_URL: urlIsolada, AGENDA_DB: arquivoBanco,
        ...(urlPostgresTeste ? { PORT: "0" } : { AGENDA_PORT: "0" }),
        WHATSAPP_TOKEN: "token-simulado",
        WHATSAPP_PHONE_NUMBER_ID: "1234", WHATSAPP_BARBEIRO_NUMERO: "5511912340000",
        WHATSAPP_TEMPLATE: "reagendamento_teste", WHATSAPP_GRAPH_VERSION: "v27.0",
        RESEND_API_KEY: "email-simulado", EMAIL_FROM: "Barbearia <agenda@example.test>",
        APP_BASE_URL: "https://barbearia.example.test" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    fim = once(servidor, "exit");
    return Promise.race([
      (async () => {
        for await (const linha of createInterface({ input: servidor.stdout })) {
          const endereco = linha.match(/http:\/\/(127\.0\.0\.1|0\.0\.0\.0):(\d+)/);
          if (endereco) {
            assert.equal(endereco[1], urlPostgresTeste ? "0.0.0.0" : "127.0.0.1");
            return `http://127.0.0.1:${endereco[2]}`;
          }
        }
      })(),
      fim.then(([codigo]) => { throw new Error(`Servidor terminou com código ${codigo}`); }),
    ]);
  }
  let url = await iniciarServidor();
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

  await t.test("catálogo e expediente preservam os campos e os IDs existentes", async () => {
    const catalogo = await (await req("/servicos")).json();
    assert.equal(catalogo[0].duracaoMinutos, 30);
    const cadastro = await req("/servicos", {
      cookie: barbeiro, method: "POST", dados: { nome: "Serviço Teste", duracaoMinutos: 25, precoCentavos: 1200 },
    });
    assert.equal(cadastro.status, 201);
    const { servico } = await cadastro.json();
    assert.ok(servico.id > 3);
    assert.equal(servico.precoCentavos, 1200);
    const expediente = await (await req("/expediente", { cookie: barbeiro })).json();
    assert.equal(expediente.inicioPausa, null);
    assert.equal((await req("/expediente", { cookie: barbeiro, method: "PUT", dados: expediente })).status, 200);
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
    const [cliente] = await consultarBanco("SELECT id FROM clientes WHERE telefone = ?", "11912340001");
    const [{ id }] = await consultarBanco(`
      INSERT INTO reservas (nome, servico_id, data, inicio, fim, cliente_id, servico_nome)
      VALUES ('Cliente Um', 1, '2020-01-01', 540, 570, ?, 'Corte de cabelo') RETURNING id
    `, cliente.id);
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
  await t.test("verifica e-mail, recupera a senha uma vez e encerra as sessões antigas", async () => {
    const telefone = "11912340001";
    const email = "cliente@example.test";
    const caminho = "/cliente/recuperar-senha";
    const enviarFormulario = (rota, campos, cookie) =>
      req(rota, { method: "POST", dados: new URLSearchParams(campos), cookie });
    const entrar = (senha) => enviarFormulario("/cliente/login", { telefone, senha });
    async function lerLink(arquivo, rota) {
      let texto;
      for (let tentativa = 0; tentativa < 40 && !texto; tentativa++) {
        texto = await readFile(arquivo, "utf8").catch((erro) => {
          if (erro.code !== "ENOENT") throw erro;
        });
        if (!texto) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(texto, "O provedor simulado deve receber o e-mail.");
      const payload = JSON.parse(texto);
      assert.deepEqual(payload.to, [email]);
      const link = new URL(payload.text.match(/https:\/\/[^\s]+/)[0]);
      assert.equal(link.origin, "https://barbearia.example.test");
      assert.equal(link.pathname, rota);
      assert.match(link.hash.slice(1), /^[A-Za-z0-9_-]{43}$/);
      return link.hash.slice(1);
    }

    const sessaoAntiga = (await entrar("senha-de-teste")).headers.get("set-cookie").split(";")[0];
    assert.match(await (await req("/cliente/login")).text(), /href="\/cliente\/recuperar-senha"/);
    assert.equal((await req("/cliente/email")).headers.get("location"), "/cliente/login");
    const errado = await enviarFormulario("/cliente/email", { email, senha: "senha-errada" }, clienteA);
    assert.match(errado.headers.get("location"), /estado=senha/);
    const envio = await enviarFormulario("/cliente/email", { email: " Cliente@Example.test ", senha: "senha-de-teste" }, clienteA);
    assert.match(envio.headers.get("location"), /estado=solicitado/);
    const verificar = await lerLink(mensagemVerificacao, "/cliente/email/confirmar");
    assert.equal((await req("/cliente/email/confirmar")).status, 200);
    assert.equal((await (await req("/cliente/sessao", { cookie: clienteA })).json()).email, null);
    const semVerificacao = await enviarFormulario(caminho, { email });
    assert.match(semVerificacao.headers.get("location"), /estado=solicitado/);
    await assert.rejects(access(mensagemRecuperacao), { code: "ENOENT" });
    const verificado = await enviarFormulario("/cliente/email/confirmar", { token: verificar });
    assert.match(verificado.headers.get("location"), /estado=verificado/);
    assert.equal((await (await req("/cliente/sessao", { cookie: clienteA })).json()).email, email);
    assert.match((await enviarFormulario("/cliente/email/confirmar", { token: verificar })).headers.get("location"), /estado=invalido/);
    const desconhecido = await enviarFormulario(caminho, { email: "nao-cadastrado@example.test" });
    const pedido = await enviarFormulario(caminho, { email });
    assert.equal(pedido.headers.get("location"), desconhecido.headers.get("location"));
    const token = await lerLink(mensagemRecuperacao, caminho + "/redefinir");
    const senha = "nova-senha-de-teste";
    const trocar = (link) => enviarFormulario(caminho + "/redefinir", { token: link, senha, confirmacao: senha });
    assert.equal((await trocar(verificar)).status, 400);
    assert.equal((await req(caminho + "/redefinir")).status, 200);
    const atualizarValidade = "UPDATE links_cliente SET expira_em = ? WHERE tipo = 'recuperacao'";
    const [{ expira_em }] = await consultarBanco("SELECT expira_em FROM links_cliente WHERE tipo = 'recuperacao'");
    await consultarBanco(atualizarValidade, Date.now() - 1);
    assert.equal((await trocar(token)).status, 400);
    await consultarBanco(atualizarValidade, expira_em);
    const concorrentes = await Promise.all([trocar(token), trocar(token)]);
    assert.deepEqual(concorrentes.map((resposta) => resposta.status).sort(), [200, 400]);
    assert.equal((await trocar(token)).status, 400);
    for (const cookie of [clienteA, sessaoAntiga]) {
      assert.equal(await (await req("/cliente/sessao", { cookie })).json(), null);
    }
    assert.match((await entrar("senha-de-teste")).headers.get("location"), /erro=credenciais/);
    assert.equal((await entrar(senha)).headers.get("location"), "/");
  });
  await t.test("o cadastro solicita confirmação para o e-mail de recuperação informado", async () => {
    const cadastrarComEmail = (email) => req("/cliente/cadastro", {
      method: "POST",
      dados: new URLSearchParams({
        nome: "Cliente Novo", telefone: "11912340003", senha: "senha-de-teste", email,
      }),
    });
    assert.match(await (await req("/cliente/cadastro")).text(), /name="email" type="email"/);
    assert.match((await cadastrarComEmail("email-invalido")).headers.get("location"), /erro=email/);
    const cadastro = await cadastrarComEmail("Novo@Example.test");
    assert.equal(cadastro.headers.get("location"), "/cliente/email?estado=solicitado");
    const cookie = cadastro.headers.get("set-cookie").split(";")[0];
    const perfil = async () => (await req("/cliente/sessao", { cookie })).json();
    assert.equal((await perfil()).email, null);

    let texto;
    for (let tentativa = 0; tentativa < 40 && !texto; tentativa++) {
      texto = await readFile(mensagemCadastro, "utf8").catch((erro) => {
        if (erro.code !== "ENOENT") throw erro;
      });
      if (!texto) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(texto, "O cadastro deve enviar a confirmação.");
    const mensagem = JSON.parse(texto);
    assert.deepEqual(mensagem.to, ["novo@example.test"]);
    const link = new URL(mensagem.text.match(/https:\/\/[^\s]+/)[0]);
    assert.equal(link.pathname, "/cliente/email/confirmar");
    const confirmar = await req(link.pathname, {
      method: "POST", dados: new URLSearchParams({ token: link.hash.slice(1) }),
    });
    assert.match(confirmar.headers.get("location"), /estado=verificado/);
    assert.equal((await perfil()).email, "novo@example.test");
  });
  await t.test("contas, reservas e avisos continuam no banco depois de reiniciar", async () => {
    servidor.kill();
    await fim;
    url = await iniciarServidor();
    assert.equal(await (await req("/cliente/sessao", { cookie: clienteA })).json(), null);
    const sessao = await req("/cliente/login", {
      method: "POST", dados: new URLSearchParams({ telefone: "11912340001", senha: "nova-senha-de-teste" }),
    });
    assert.equal(sessao.headers.get("location"), "/");
    const login = await req("/login", { method: "POST", dados: new URLSearchParams({ senha: "senha-de-teste" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const agenda = await (await req(`/agendamentos?data=${data}`, { cookie })).json();
    assert.deepEqual(agenda.map(({ inicio }) => inicio), [720, 780]);
    const { avisos } = await (await req("/avisos-whatsapp", { cookie })).json();
    assert.deepEqual(avisos.map(({ estado }) => estado), ["falha", "aceito"]);
  });
});
