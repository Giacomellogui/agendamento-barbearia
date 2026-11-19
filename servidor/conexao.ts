import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { PoolClient } from "pg";

type Linha = Record<string, SQLOutputValue | boolean>;
type Executor = PoolClient | true;
type Resultado = { linhas: Linha[]; changes: number };

const url = process.env.DATABASE_URL?.trim();
if (process.env.RENDER === "true" && !url && !process.env.AGENDA_DB) {
  console.error("Configure DATABASE_URL no Render para manter as contas e reservas em um banco persistente.");
  process.exit(1);
}
export const usaPostgres = Boolean(url);
const postgres = url ? new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10000, max: 5 }) : undefined;
const sqlite = postgres ? undefined : new DatabaseSync(
  process.env.AGENDA_DB ?? fileURLToPath(new URL("../agenda.sqlite", import.meta.url)),
);
postgres?.on("error", () => console.error("Uma conexão ociosa do PostgreSQL foi encerrada."));

const transacaoAtual = new AsyncLocalStorage<Executor>();
let filaSqlite = Promise.resolve();

// O SQLite usa uma conexão. Nenhuma outra requisição pode executar nela no meio de uma transação.
function naFilaSqlite<T>(executar: () => T | Promise<T>) {
  const resultado = filaSqlite.then(executar);
  filaSqlite = resultado.then(() => undefined, () => undefined);
  return resultado;
}

async function executar(sql: string, valores: unknown[], modo: "all" | "run"): Promise<Resultado> {
  const executor = transacaoAtual.getStore();
  if (postgres) {
    const resultado = await (executor && executor !== true ? executor : postgres).query(sql, valores);
    return { linhas: resultado.rows, changes: resultado.rowCount ?? 0 };
  }
  const consulta = () => {
    const instrucao = sqlite!.prepare(sql);
    const parametros = valores as SQLInputValue[];
    if (modo === "run") return { linhas: [], changes: Number(instrucao.run(...parametros).changes) };
    const linhas = instrucao.all(...parametros);
    return { linhas, changes: linhas.length };
  };
  return executor ? consulta() : naFilaSqlite(consulta);
}

export const conexao = {
  prepare(sql: string) {
    // As consultas da aplicação usam ? para parâmetros, sem literais contendo esse caractere.
    let indice = 0;
    const consulta = postgres ? sql.replace(/\?/g, () => `$${++indice}`) : sql;
    return {
      async all(...valores: unknown[]) { return (await executar(consulta, valores, "all")).linhas; },
      async get(...valores: unknown[]): Promise<Linha | undefined> {
        return (await executar(consulta, valores, "all")).linhas[0];
      },
      async run(...valores: unknown[]) {
        const { changes } = await executar(consulta, valores, "run");
        return { changes };
      },
    };
  },

  async exec(sql: string) {
    const executor = transacaoAtual.getStore();
    if (postgres) {
      await (executor && executor !== true ? executor : postgres).query(sql);
    } else if (executor) {
      sqlite!.exec(sql);
    } else {
      await naFilaSqlite(() => sqlite!.exec(sql));
    }
  },

  async transacao<T>(executar: () => Promise<T>) {
    if (transacaoAtual.getStore()) throw new Error("Transações aninhadas não são suportadas.");
    if (postgres) {
      const cliente = await postgres.connect();
      try {
        await cliente.query("BEGIN");
        // Serializa alterações relacionadas à agenda, mesmo se dois processos usarem o mesmo banco.
        await cliente.query("SELECT pg_advisory_xact_lock(29186380)");
        const resultado = await transacaoAtual.run(cliente, executar);
        await cliente.query("COMMIT");
        return resultado;
      } catch (erro) {
        await cliente.query("ROLLBACK").catch(() => {});
        throw erro;
      } finally {
        cliente.release();
      }
    }

    return naFilaSqlite(async () => {
      sqlite!.exec("BEGIN IMMEDIATE");
      try {
        const resultado = await transacaoAtual.run(true, executar);
        sqlite!.exec("COMMIT");
        return resultado;
      } catch (erro) {
        sqlite!.exec("ROLLBACK");
        throw erro;
      }
    });
  },
};
