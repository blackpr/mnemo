import pg from "pg";

/**
 * Minimal query surface shared by pg.Pool and pg.PoolClient, so repositories can run
 * either standalone (pool) or inside a unit of work (client in a transaction).
 */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: readonly unknown[]): Promise<pg.QueryResult<R>>;
}

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}

/** Run `work` inside BEGIN/COMMIT; ROLLBACK on throw. */
export async function withTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection may already be broken; the original error matters */
    }
    throw e;
  } finally {
    client.release();
  }
}
