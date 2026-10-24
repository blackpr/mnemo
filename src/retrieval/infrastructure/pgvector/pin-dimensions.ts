import type pg from "pg";
import { withTransaction, type Queryable } from "../../../platform/postgres/pool.js";

/**
 * Pinning the pgvector index to one embedding dimensionality.
 *
 * `retrieval.pgvector_index.embedding` is created untyped (`vector`) so the embedder could be chosen
 * after the spike. pgvector can only build an HNSW index on a typed column, so the pin does three
 * things in one transaction: delete every row written by an embedder other than the current one
 * (derived state; `admin reindex` rebuilds it), retype the column to `vector(N)`, and create the
 * cosine HNSW index. N and the embedder id are recorded in `retrieval.settings` so the server can
 * refuse to boot with an embedder of another width, and so a later pin to a different N is an
 * explicit re-pin (drop index, retype, recreate) instead of a silent rewrite. Filtered recall through
 * the index relies on `hnsw.iterative_scan`, which `createPool` sets on every connection.
 *
 * This is an operator step (`admin pin-dimensions`) rather than a migration because migrations are
 * plain SQL applied unconditionally at boot (platform/postgres/migrator.ts) and N comes from the
 * deployment's EMBEDDING_DIMENSIONS. ALTER TABLE and CREATE INDEX take an exclusive lock on the
 * table for the duration; on a large index run it while the server is stopped.
 */

export const SETTING_DIMENSIONS = "pgvector.dimensions";
export const SETTING_EMBEDDER = "pgvector.embedder";
export const HNSW_INDEX_NAME = "pgvector_index_embedding_hnsw_idx";
/** pgvector's HNSW access method refuses `vector` columns wider than this (halfvec would go to 4000; not used here). */
export const HNSW_MAX_DIMENSIONS = 2000;

/** Throws when N cannot be pinned: not a positive integer, or wider than an HNSW index allows. */
export function assertPinnableDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error(`dimensions must be a positive integer, got ${dimensions}`);
  if (dimensions > HNSW_MAX_DIMENSIONS) {
    throw new Error(`${dimensions} dimensions exceed the ${HNSW_MAX_DIMENSIONS} an HNSW index supports; request a reduced width from the provider with EMBEDDING_DIMENSIONS (text-embedding-3-* and gemini-embedding-001 support 1536 or 768)`);
  }
}

export interface PinnedIndex {
  readonly dimensions: number;
  readonly embedder: string;
  readonly pinnedAt: Date;
}

export interface PinOutcome {
  /** Rows from other embedders deleted before the column was retyped. */
  readonly deletedForeignRows: number;
  /** Which embedders those rows came from, with counts. */
  readonly deletedByEmbedder: readonly { readonly embedder: string; readonly rows: number }[];
  readonly retypedColumn: boolean;
  readonly createdIndex: boolean;
  readonly previous: PinnedIndex | undefined;
}

export async function readPinnedIndex(db: Queryable): Promise<PinnedIndex | undefined> {
  const { rows } = await db.query<{ key: string; value: string; updated_at: Date }>("SELECT key, value, updated_at FROM retrieval.settings WHERE key = ANY($1::text[])", [[SETTING_DIMENSIONS, SETTING_EMBEDDER]]);
  const dims = rows.find((r) => r.key === SETTING_DIMENSIONS);
  const embedder = rows.find((r) => r.key === SETTING_EMBEDDER);
  if (!dims || !embedder) return undefined;
  return { dimensions: Number(dims.value), embedder: embedder.value, pinnedAt: dims.updated_at };
}

/** Rows that would be deleted by a pin for `embedderId`: everything another embedder wrote. */
export async function foreignRows(db: Queryable, embedderId: string): Promise<readonly { readonly embedder: string; readonly rows: number }[]> {
  const { rows } = await db.query<{ embedder: string; n: string }>("SELECT embedder, count(*)::text AS n FROM retrieval.pgvector_index WHERE embedder <> $1 GROUP BY embedder ORDER BY embedder", [embedderId]);
  return rows.map((r) => ({ embedder: r.embedder, rows: Number(r.n) }));
}

/** Idempotent: a second pin with the same embedder and N deletes nothing, retypes nothing and creates nothing. */
export async function pinIndexDimensions(pool: pg.Pool, embedderId: string, dimensions: number): Promise<PinOutcome> {
  assertPinnableDimensions(dimensions);
  return withTransaction(pool, async (client) => {
    // The pin is the only writer of the column type; keep concurrent pins out and let writers drain.
    await client.query("LOCK TABLE retrieval.pgvector_index IN ACCESS EXCLUSIVE MODE");
    const previous = await readPinnedIndex(client);

    const deletedByEmbedder = await foreignRows(client, embedderId);
    const del = await client.query("DELETE FROM retrieval.pgvector_index WHERE embedder <> $1", [embedderId]);

    const wrong = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM retrieval.pgvector_index WHERE vector_dims(embedding) <> $1", [dimensions]);
    if (Number(wrong.rows[0]?.n ?? 0) > 0) {
      throw new Error(`${wrong.rows[0]!.n} row(s) written by embedder "${embedderId}" do not have ${dimensions} dimensions; the embedder id and EMBEDDING_DIMENSIONS disagree, refusing to pin`);
    }

    const typmod = await client.query<{ atttypmod: number }>("SELECT atttypmod FROM pg_attribute WHERE attrelid = 'retrieval.pgvector_index'::regclass AND attname = 'embedding'");
    const current = typmod.rows[0]?.atttypmod ?? -1; // -1: untyped `vector`; otherwise N
    const retypedColumn = current !== dimensions;
    if (retypedColumn) {
      // An HNSW index is bound to the column's type; it must go before the retype and be rebuilt after.
      await client.query(`DROP INDEX IF EXISTS retrieval.${HNSW_INDEX_NAME}`);
      await client.query(`ALTER TABLE retrieval.pgvector_index ALTER COLUMN embedding TYPE vector(${dimensions})`);
    }
    const existing = await client.query("SELECT 1 FROM pg_indexes WHERE schemaname = 'retrieval' AND indexname = $1", [HNSW_INDEX_NAME]);
    const createdIndex = (existing.rowCount ?? 0) === 0;
    if (createdIndex) {
      // The HNSW graph is built in memory; past maintenance_work_mem pgvector falls back to a build an order
      // of magnitude slower, under the exclusive lock. A cap for this transaction only, no privilege needed.
      await client.query("SET LOCAL maintenance_work_mem = '1GB'");
      await client.query(`CREATE INDEX ${HNSW_INDEX_NAME} ON retrieval.pgvector_index USING hnsw (embedding vector_cosine_ops)`);
    }

    if (previous?.dimensions !== dimensions || previous.embedder !== embedderId) {
      await client.query(
        `INSERT INTO retrieval.settings (key, value, updated_at) VALUES ($1, $2, now()), ($3, $4, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [SETTING_DIMENSIONS, String(dimensions), SETTING_EMBEDDER, embedderId],
      );
    }
    return { deletedForeignRows: del.rowCount ?? 0, deletedByEmbedder, retypedColumn, createdIndex, previous };
  });
}
