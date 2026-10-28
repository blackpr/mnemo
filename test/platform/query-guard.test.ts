import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CROSS_BANK_STATEMENTS, SCOPED_TABLES, crossBank, crossBankTagOf } from "../../src/platform/postgres/bank-isolation.js";
import { checkStatement, loadParser, unpinnedTables } from "../helpers/query-guard.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";

describe("query guard: the bank-isolation check on one statement", () => {
  beforeAll(async () => loadParser());

  const pinned = (sql: string) => expect(unpinnedTables(sql), sql).toEqual([]);
  const unpinned = (sql: string, ...tables: string[]) => expect(unpinnedTables(sql).map((p) => p.split(" ")[0]), sql).toEqual(tables);

  it("accepts an equality on the scope column to a parameter, constant or list of them", () => {
    pinned("SELECT * FROM memory.facts WHERE bank_id = $1 AND id = $2");
    pinned("SELECT * FROM memory.facts WHERE id = $2 AND $1 = bank_id");
    pinned("SELECT * FROM memory.facts WHERE bank_id = ANY($1::text[])");
    pinned("SELECT * FROM memory.facts WHERE bank_id IN ('a', 'b')");
    pinned("SELECT * FROM memory.facts WHERE bank_id = $1::text");
    pinned("SELECT * FROM memory.banks WHERE id = $1 FOR UPDATE");
    pinned("SELECT * FROM governance.audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1");
    pinned("SELECT * FROM governance.grants WHERE principal_id = $1");
    pinned("UPDATE memory.facts SET statement = $3 WHERE id = $1 AND bank_id = $2");
    pinned("DELETE FROM retrieval.pgvector_index WHERE bank_id = $1");
  });

  it("refuses a statement on a scoped table without the pin, also in DML and the target of an UPDATE", () => {
    unpinned("SELECT * FROM memory.facts WHERE id = $1", "memory.facts");
    unpinned("SELECT count(*) FROM memory.outbox", "memory.outbox");
    unpinned("UPDATE retrieval.pgvector_index SET retracted = true WHERE kind = 'fact' AND ref_id = $1", "retrieval.pgvector_index");
    unpinned("DELETE FROM extraction.runs WHERE status = 'dead'", "extraction.runs");
    unpinned("SELECT * FROM governance.api_keys WHERE key_hash = $1", "governance.api_keys");
    unpinned("SELECT * FROM memory.banks WHERE tenant_id = $1", "memory.banks");
  });

  it("an equality under OR or NOT, a non-equality, or an unrelated column pins nothing", () => {
    unpinned("SELECT * FROM memory.facts WHERE bank_id = $1 OR id = $2", "memory.facts");
    unpinned("SELECT * FROM memory.facts WHERE NOT (bank_id = $1)", "memory.facts");
    unpinned("SELECT * FROM memory.facts WHERE bank_id <> $1", "memory.facts");
    unpinned("SELECT * FROM memory.facts WHERE bank_id IS NOT NULL", "memory.facts");
    unpinned("SELECT * FROM memory.facts WHERE bank_id = bank_id", "memory.facts");
    unpinned("SELECT * FROM memory.facts WHERE bank_id IN ($1, id)", "memory.facts");
    unpinned("SELECT * FROM memory.facts WHERE bank_id = ANY(other_ids)", "memory.facts");
  });

  it("a subquery is never a pin value, even an uncorrelated one (it is checked on its own)", () => {
    unpinned("SELECT * FROM memory.facts WHERE bank_id = (SELECT id FROM memory.banks WHERE id = $1)", "memory.facts");
    unpinned("DELETE FROM memory.facts f WHERE f.bank_id = (SELECT e.bank_id FROM memory.episodes e WHERE e.id = f.id AND e.bank_id = f.bank_id)", "memory.facts", "memory.episodes");
    unpinned("UPDATE memory.outbox o SET failed_at = NULL WHERE o.bank_id = (SELECT o.bank_id)", "memory.outbox");
  });

  it("operand order does not matter", () => {
    pinned("SELECT * FROM memory.facts f JOIN memory.episodes e ON f.bank_id = e.bank_id WHERE $1 = f.bank_id");
    pinned("SELECT * FROM memory.facts f LEFT JOIN memory.episodes e ON f.bank_id = e.bank_id WHERE f.bank_id = $1");
    pinned("SELECT * FROM memory.facts f LEFT JOIN memory.episodes e ON e.bank_id = f.bank_id WHERE f.bank_id = $1");
  });

  it("joins: a column equal to a pinned column is pinned; an outer join's ON pins only its nullable side", () => {
    pinned("SELECT * FROM memory.facts f JOIN memory.episodes e ON e.bank_id = f.bank_id AND e.id = f.id WHERE f.bank_id = $1");
    unpinned("SELECT * FROM memory.facts f JOIN memory.episodes e ON e.id = f.id WHERE f.bank_id = $1", "memory.episodes");
    unpinned("SELECT * FROM memory.facts f, memory.episodes e WHERE f.bank_id = e.bank_id", "memory.facts", "memory.episodes");
    pinned("SELECT * FROM memory.facts f LEFT JOIN memory.episodes e ON e.bank_id = $1 WHERE f.bank_id = $1");
    unpinned("SELECT * FROM memory.facts f LEFT JOIN memory.episodes e ON f.bank_id = $1 AND e.bank_id = $1", "memory.facts");
    // A pin on the nullable side does not flow back to the preserved side.
    unpinned("SELECT * FROM memory.facts f LEFT JOIN memory.banks b ON b.id = f.bank_id AND b.id = $1", "memory.facts");
    unpinned("SELECT * FROM memory.episodes e RIGHT JOIN memory.facts f ON e.bank_id = f.bank_id AND e.bank_id = $1", "memory.facts");
    unpinned("SELECT * FROM memory.facts f FULL JOIN memory.episodes e ON e.bank_id = f.bank_id AND e.bank_id = $1 AND f.bank_id = $1", "memory.facts", "memory.episodes");
    // USING is not interpreted: it pins nothing.
    unpinned("SELECT * FROM memory.facts f JOIN memory.episodes e USING (bank_id) WHERE f.bank_id = $1", "memory.episodes");
    // Unqualified columns with several relations are ambiguous to the guard: qualify them.
    unpinned("SELECT * FROM memory.facts f JOIN memory.episodes e ON e.id = f.id WHERE bank_id = $1", "memory.facts", "memory.episodes");
  });

  it("subqueries, derived tables, CTEs and set operations are each checked; a correlated subquery may lean on its outer pin", () => {
    pinned("SELECT * FROM (SELECT * FROM memory.episodes WHERE bank_id = $1 LIMIT 3) recent ORDER BY occurred_at");
    unpinned("SELECT * FROM (SELECT * FROM memory.episodes LIMIT 3) recent", "memory.episodes");
    pinned("SELECT (SELECT count(*) FROM memory.facts WHERE bank_id = $1) AS a, (SELECT count(*) FROM memory.outbox WHERE bank_id = $1) AS b");
    unpinned("SELECT (SELECT count(*) FROM memory.facts WHERE bank_id = $1) AS a, (SELECT count(*) FROM memory.outbox) AS b", "memory.outbox");
    pinned("SELECT * FROM memory.facts f WHERE f.bank_id = $1 AND EXISTS (SELECT 1 FROM memory.episodes e WHERE e.bank_id = f.bank_id)");
    unpinned("SELECT * FROM memory.facts f WHERE f.bank_id = $1 AND EXISTS (SELECT 1 FROM memory.episodes e WHERE e.id = f.id)", "memory.episodes");
    // A subquery's own predicates never pin the outer query.
    unpinned("SELECT * FROM memory.facts f WHERE NOT EXISTS (SELECT 1 FROM memory.episodes e WHERE e.bank_id = $1 AND e.bank_id = f.bank_id)", "memory.facts");
    unpinned("WITH x AS (SELECT * FROM memory.facts) SELECT * FROM x", "memory.facts");
    pinned("WITH x AS (SELECT * FROM memory.facts WHERE bank_id = $1) SELECT * FROM x");
    unpinned("SELECT id FROM memory.facts WHERE bank_id = $1 UNION SELECT id FROM memory.episodes", "memory.episodes");
    unpinned("INSERT INTO memory.facts SELECT * FROM memory.facts WHERE id = $1", "memory.facts");
    unpinned("SELECT * FROM memory.facts TABLESAMPLE BERNOULLI (100)", "memory.facts");
    pinned("SELECT * FROM memory.facts f TABLESAMPLE SYSTEM (10) WHERE f.bank_id = $1");
    unpinned("SELECT 1 UNION SELECT 2 LIMIT (SELECT count(*) FROM memory.facts)", "memory.facts");
    unpinned("SELECT 1 UNION SELECT 2 ORDER BY (SELECT max(id) FROM memory.facts)", "memory.facts");
    unpinned("WITH x AS (SELECT 1) SELECT * FROM memory.facts WHERE bank_id = $1 AND EXISTS (SELECT 1 FROM memory.outbox)", "memory.outbox");
    unpinned("INSERT INTO memory.episodes (id, bank_id) VALUES ($1, $2) RETURNING (SELECT count(*) FROM memory.facts)", "memory.facts");
    pinned("INSERT INTO memory.episodes (id, bank_id) VALUES ($1, $2) RETURNING (SELECT count(*) FROM memory.facts f WHERE f.bank_id = episodes.bank_id)");
  });

  it("an upsert's DO UPDATE must stay inside the inserted row's bank", () => {
    pinned("INSERT INTO memory.episodes (id, bank_id) VALUES ($1, $2)");
    pinned("INSERT INTO extraction.runs (episode_id, bank_id) VALUES ($1, $2) ON CONFLICT (episode_id) DO NOTHING");
    unpinned("INSERT INTO retrieval.pgvector_index (bank_id, kind, ref_id) VALUES ($1, $2, $3) ON CONFLICT (kind, ref_id) DO UPDATE SET text = EXCLUDED.text", "retrieval.pgvector_index");
    pinned("INSERT INTO retrieval.pgvector_index (bank_id, kind, ref_id) VALUES ($1, $2, $3) ON CONFLICT (kind, ref_id) DO UPDATE SET text = EXCLUDED.text WHERE pgvector_index.bank_id = EXCLUDED.bank_id");
    pinned("INSERT INTO retrieval.pgvector_index (bank_id, kind, ref_id) VALUES ($1, $2, $3) ON CONFLICT (kind, ref_id) DO UPDATE SET text = EXCLUDED.text WHERE EXCLUDED.bank_id = pgvector_index.bank_id");
    // Every scope column must be pinned: the conflict on `id` alone could overwrite another tenant's principal.
    unpinned("INSERT INTO governance.principals (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind", "governance.principals");
    pinned("INSERT INTO governance.principals (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind WHERE principals.tenant_id = EXCLUDED.tenant_id");
    pinned("INSERT INTO governance.grants (principal_id, bank_id) VALUES ($1, $2) ON CONFLICT (principal_id, bank_id) DO UPDATE SET capabilities = EXCLUDED.capabilities");
    unpinned("INSERT INTO retrieval.pgvector_index (bank_id, kind, ref_id) VALUES ($1, $2, $3) ON CONFLICT (kind, ref_id) DO UPDATE SET text = EXCLUDED.text WHERE pgvector_index.bank_id = EXCLUDED.bank_id AND EXISTS (SELECT 1 FROM memory.facts)", "memory.facts");
  });

  it("statement kinds the guard does not interpret fail on a scoped table; unparseable SQL fails", () => {
    unpinned("TRUNCATE memory.facts", "memory.facts");
    unpinned("MERGE INTO memory.facts f USING memory.episodes e ON f.id = e.id WHEN MATCHED THEN DELETE", "memory.facts", "memory.episodes");
    unpinned("COPY (SELECT * FROM memory.facts WHERE bank_id = $1) TO STDOUT", "memory.facts");
    unpinned("CREATE TABLE x AS SELECT * FROM memory.facts", "memory.facts");
    unpinned("DROP TABLE memory.facts", "memory.facts");
    pinned("DROP INDEX IF EXISTS retrieval.pgvector_index_embedding_hnsw_idx");
    expect(unpinnedTables("DO $$ BEGIN DELETE FROM memory.facts; END $$")[0]).toMatch(/cannot see into/);
    expect(unpinnedTables("SELEC broken")[0]).toMatch(/could not be parsed/);
  });

  it("a row never moves to another bank: assigning a scope column is refused", () => {
    unpinned("UPDATE memory.facts SET bank_id = $2 WHERE bank_id = $1", "memory.facts");
    unpinned("INSERT INTO governance.grants (principal_id, bank_id) VALUES ($1, $2) ON CONFLICT (principal_id, bank_id) DO UPDATE SET bank_id = EXCLUDED.bank_id", "governance.grants");
  });

  it("ignores tables outside the list, DDL and session statements", () => {
    pinned("SELECT name FROM public.schema_migrations");
    pinned("SELECT key, value FROM retrieval.settings WHERE key = ANY($1::text[])");
    pinned("SET LOCAL mem.erasure = 'on'");
    pinned("LOCK TABLE retrieval.pgvector_index IN ACCESS EXCLUSIVE MODE");
    pinned("ALTER TABLE retrieval.pgvector_index ALTER COLUMN embedding TYPE vector(64)");
  });

  it("a tag exempts a statement only when it names an allowlist entry and the statement needs it", () => {
    const sql = `${crossBank("outbox.pending-count")}SELECT count(*) FROM memory.outbox WHERE published_at IS NULL`;
    expect(crossBankTagOf(sql)).toBe("outbox.pending-count");
    expect(checkStatement(sql)).toEqual({ tag: "outbox.pending-count", problems: [] });
    expect(checkStatement("/* cross-bank: no-such-entry */ SELECT count(*) FROM memory.outbox").problems).toEqual(['tag "no-such-entry" is not in CROSS_BANK_STATEMENTS']);
    expect(checkStatement(`${crossBank("outbox.pending-count")}SELECT count(*) FROM memory.outbox WHERE bank_id = $1`).problems[0]).toMatch(/already pinned/);
    // The tag covers its entry's tables only: another unpinned table in the same statement is still reported.
    expect(checkStatement(`${crossBank("outbox.pending-count")}SELECT (SELECT count(*) FROM memory.outbox), (SELECT count(*) FROM memory.facts)`).problems).toEqual([
      'memory.facts is not pinned by bank_id (not among the tables of "outbox.pending-count")',
    ]);
    expect(checkStatement("/* cross-bank: constructor */ SELECT count(*) FROM memory.outbox").problems).toEqual(['tag "constructor" is not in CROSS_BANK_STATEMENTS']);
    expect(checkStatement(`${crossBank("outbox.pending-count")}SELECT count(*) FROM memory.outbox; DELETE FROM memory.outbox`).problems[0]).toMatch(/several statements/);
    // Only a leading comment is a tag.
    expect(crossBankTagOf("SELECT 1 /* cross-bank: outbox.claim */")).toBeUndefined();
  });
});

describe("query guard: the allowlist", () => {
  it("every entry is tagged on exactly one statement in src/, and every tag in src/ names an entry", () => {
    const files = readdirSync("src", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith("bank-isolation.ts"));
    const uses = new Map<string, number>();
    for (const f of files) {
      for (const m of readFileSync(join("src", f), "utf8").matchAll(/crossBank\("([^"]+)"\)|cross-bank: ([a-z0-9.-]+)/g)) {
        const name = m[1] ?? m[2]!;
        uses.set(name, (uses.get(name) ?? 0) + 1);
      }
    }
    expect(Object.fromEntries(uses)).toEqual(Object.fromEntries(Object.keys(CROSS_BANK_STATEMENTS).map((k) => [k, 1])));
  });
});

describeWithDb("query guard: the scoped-table list covers the schema", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => db.close());

  it("every table of ours with a bank_id or tenant_id column is in SCOPED_TABLES, and every listed column exists", async () => {
    const { rows } = await db.pool.query<{ t: string; c: string }>(
      `SELECT table_schema || '.' || table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema IN ('memory', 'governance', 'retrieval', 'extraction', 'portability')`,
    );
    const columns = new Map<string, Set<string>>();
    for (const r of rows) columns.set(r.t, (columns.get(r.t) ?? new Set()).add(r.c));
    const withScope = [...columns].filter(([, cs]) => cs.has("bank_id") || cs.has("tenant_id")).map(([t]) => t);
    expect(withScope.filter((t) => !(t in SCOPED_TABLES))).toEqual([]);
    for (const [table, scopeColumns] of Object.entries(SCOPED_TABLES)) for (const c of scopeColumns) expect(columns.get(table)?.has(c), `${table}.${c}`).toBe(true);
  });
});
