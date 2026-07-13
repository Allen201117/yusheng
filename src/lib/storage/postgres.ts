import { Pool, type PoolClient } from "@neondatabase/serverless";

export interface SqlExecutor {
  query<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T>;
}

type Queryable = Pick<Pool | PoolClient, "query">;

function createClientExecutor(client: PoolClient): SqlExecutor {
  const executor: SqlExecutor = {
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      const result = await client.query<T>(text, params);
      return result.rows;
    },
    async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) {
      return work(executor);
    },
  };
  return executor;
}

export function createPoolExecutor(pool: Pool): SqlExecutor {
  return {
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      const result = await (pool as Queryable).query<T>(text, params);
      return result.rows;
    },
    async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(createClientExecutor(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

let cached: SqlExecutor | null = null;

export function getSql(databaseUrl = process.env.DATABASE_URL): SqlExecutor {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!cached) {
    cached = createPoolExecutor(new Pool({ connectionString: databaseUrl }));
  }
  return cached;
}
