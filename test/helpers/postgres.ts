import { describe } from "vitest";
import type pg from "pg";
import { createPool } from "../../src/platform/postgres/pool.js";
import { migrate } from "../../src/platform/postgres/migrator.js";
import { migrationSources } from "../../src/platform/postgres/migrations.js";
import { HNSW_INDEX_NAME } from "../../src/retrieval/infrastructure/pgvector/pin-dimensions.js";
import { installQueryGuard } from "./query-guard.js";

/**
 * Database-backed tests run only when TEST_DATABASE_URL is set (see .env.example and
 * `npm run db:up`, which also creates the mem_test database). Tests TRUNCATE every table, so
 * they must never point at the development database; DATABASE_URL is deliberately ignored.
 * Without TEST_DATABASE_URL they are skipped, not failed, so the pure domain suite stays
 * runnable anywhere.
 */
export const databaseUrl = process.env.TEST_DATABASE_URL;

export const describeWithDb: typeof describe = (databaseUrl ? describe : describe.skip) as typeof describe;

export interface TestDb {
  readonly pool: pg.Pool;
  truncateAll(): Promise<void>;
  close(): Promise<void>;
}

export async function setupTestDb(): Promise<TestDb> {
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL not set");
  const pool = createPool(databaseUrl, 4);
  await migrate(pool, migrationSources);
  // The pin suite types the shared embedding column; the other suites mix 64- and 256-dimension rows and need it
  // untyped. Undo any pin a crashed run left behind, so no suite depends on another's cleanup.
  await pool.query(`DROP INDEX IF EXISTS retrieval.${HNSW_INDEX_NAME}`);
  await pool.query("ALTER TABLE retrieval.pgvector_index ALTER COLUMN embedding TYPE vector");
  await pool.query("DELETE FROM retrieval.settings");
  // From here on every statement the application runs on this pool is checked for bank isolation (query-guard.ts).
  await installQueryGuard(pool);
  return {
    pool,
    async truncateAll() {
      await pool.query(`TRUNCATE
        portability.exports,
        extraction.runs,
        retrieval.pgvector_index,
        governance.audit_log, governance.erasure_requests, governance.api_keys, governance.grants, governance.principals,
        memory.outbox, memory.facts, memory.episodes, memory.banks
        CASCADE`);
    },
    async close() {
      await pool.end();
    },
  };
}
