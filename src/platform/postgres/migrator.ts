import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { withTransaction } from "./pool.js";

/**
 * Plain-SQL migrator. Each bounded context owns a migrations directory; the order of
 * directories is fixed in `migrations.ts`. Files are applied in filename order within a
 * directory and recorded as "<label>/<file>" in public.schema_migrations.
 * Each file runs in its own transaction. A session-level advisory lock prevents two
 * processes migrating at once.
 */

export interface MigrationSource {
  readonly label: string; // "memory" | "governance" | "retrieval"
  readonly dir: string; // absolute path
}

const LOCK_KEY = 7_361_902_117; // arbitrary constant

export async function migrate(pool: pg.Pool, sources: readonly MigrationSource[]): Promise<readonly string[]> {
  const lock = await pool.connect();
  try {
    // Lock first: concurrent starters would otherwise race on CREATE TABLE IF NOT EXISTS
    // (pg_type uniqueness violation) and on applying the same files.
    await lock.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await lock.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Set((await pool.query<{ name: string }>("SELECT name FROM public.schema_migrations")).rows.map((r) => r.name));
    const done: string[] = [];

    for (const source of sources) {
      const files = (await readdir(source.dir)).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        const name = `${source.label}/${file}`;
        if (applied.has(name)) continue;
        const sql = await readFile(join(source.dir, file), "utf8");
        await withTransaction(pool, async (client) => {
          await client.query(sql);
          await client.query("INSERT INTO public.schema_migrations (name) VALUES ($1)", [name]);
        });
        done.push(name);
      }
    }
    return done;
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    lock.release();
  }
}
