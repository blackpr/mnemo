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
  // pgvector (>= 0.8): with an HNSW index, a filtered nearest-neighbour query (recall filters by bank,
  // embedder, kind, retraction and validity after the index scan) would otherwise stop at the first
  // hnsw.ef_search candidates and return fewer rows than exist. Iterative scans keep walking the graph
  // until LIMIT is met (bounded by hnsw.max_scan_tuples, default 20000). Sent as a session default in
  // the connection startup packet (libpq `options`): no extra query, no privilege, every connection of
  // this process; on a database without pgvector it is an inert placeholder GUC. `relaxed_order` may
  // return rows slightly out of distance order; the pgvector engine sorts its hits.
  return new pg.Pool({ connectionString, max, options: "-c hnsw.iterative_scan=relaxed_order" });
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
