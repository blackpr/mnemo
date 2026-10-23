import { describe } from "vitest";
import type pg from "pg";
import { createPool } from "../../src/platform/postgres/pool.js";
import { migrate } from "../../src/platform/postgres/migrator.js";
import { migrationSources } from "../../src/platform/postgres/migrations.js";

/**
 * Database-backed tests run only when DATABASE_URL is set (see .env.example and
 * `npm run db:up`). Without it they are skipped, not failed, so the pure domain suite
 * stays runnable anywhere.
 */
export const databaseUrl = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;

export const describeWithDb: typeof describe = (databaseUrl ? describe : describe.skip) as typeof describe;

export interface TestDb {
  readonly pool: pg.Pool;
  truncateAll(): Promise<void>;
  close(): Promise<void>;
}

export async function setupTestDb(): Promise<TestDb> {
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  const pool = createPool(databaseUrl, 4);
  await migrate(pool, migrationSources);
  return {
    pool,
    async truncateAll() {
      await pool.query(`TRUNCATE
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
