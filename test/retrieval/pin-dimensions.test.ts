import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Embedder } from "../../src/retrieval/index.js";
import { HashingEmbedder, HNSW_INDEX_NAME, PgvectorEngine, foreignRows, pinIndexDimensions, readPinnedIndex } from "../../src/retrieval/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { bankFixture, episodeFixture, factFixture, fromArray, scopeFor } from "../helpers/fixtures.js";

/**
 * `admin pin-dimensions` as a library call. The pin retypes a shared column that the other suites need
 * untyped (they mix hashing-64 and hashing-256 rows); `setupTestDb` resets it on every suite's setup, and
 * this suite's own `unpin` is a courtesy on top of that, not what the others depend on.
 */
describeWithDb("pinIndexDimensions", () => {
  let db: TestDb;
  const bankA = bankFixture("bank-a");
  const bankB = bankFixture("bank-b");
  const hashing256 = new HashingEmbedder(256);
  /** Same vectors, different identity: what an embedder switch at equal width looks like. */
  const other256: Embedder = { id: "other-256", dimensions: 256, embed: (t) => hashing256.embed(t) };

  const columnType = async () => (await db.pool.query<{ t: string }>("SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'retrieval.pgvector_index'::regclass AND attname = 'embedding'")).rows[0]!.t;
  const hasIndex = async () => ((await db.pool.query("SELECT 1 FROM pg_indexes WHERE schemaname = 'retrieval' AND indexname = $1", [HNSW_INDEX_NAME])).rowCount ?? 0) > 0;
  const unpin = async () => {
    await db.pool.query(`DROP INDEX IF EXISTS retrieval.${HNSW_INDEX_NAME}`);
    await db.pool.query("ALTER TABLE retrieval.pgvector_index ALTER COLUMN embedding TYPE vector");
    await db.pool.query("DELETE FROM retrieval.settings");
  };

  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => {
    await unpin();
    await db.close();
  });
  beforeEach(async () => {
    await unpin();
    await db.truncateAll();
  });

  it("deletes foreign-embedder rows, types the column, builds the HNSW index, records the pin; recall and purge keep working", async () => {
    const engine = new PgvectorEngine(db.pool, hashing256);
    const foreign = new PgvectorEngine(db.pool, new HashingEmbedder(64));
    await engine.indexFact(factFixture(bankA.id, "f1", "the user's editor is neovim"));
    await engine.indexFact(factFixture(bankA.id, "f2", "the user's dog is called Rex"));
    await engine.indexEpisode(episodeFixture(bankA.id, "e1", "I switched to neovim last week"));
    await engine.indexFact(factFixture(bankB.id, "fb", "bank B likes espresso"));
    await foreign.indexFact(factFixture(bankB.id, "f-old", "an old-embedder row"));
    expect(await readPinnedIndex(db.pool)).toBeUndefined();
    expect(await columnType()).toBe("vector");
    expect(await foreignRows(db.pool, hashing256.id)).toEqual([{ embedder: "hashing-64", rows: 1 }]);

    const r = await pinIndexDimensions(db.pool, hashing256.id, 256);
    expect(r).toEqual({ deletedForeignRows: 1, deletedByEmbedder: [{ embedder: "hashing-64", rows: 1 }], retypedColumn: true, createdIndex: true, previous: undefined });
    expect(await columnType()).toBe("vector(256)");
    expect(await hasIndex()).toBe(true);
    expect(await readPinnedIndex(db.pool)).toMatchObject({ dimensions: 256, embedder: "hashing-256", pinnedAt: expect.any(Date) });
    expect((await db.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM retrieval.pgvector_index")).rows[0]!.n).toBe("4");

    // The index is what recall now goes through; results are unchanged and bank-scoped.
    const hits = await engine.recall(scopeFor(bankA.id), "which editor does the user prefer, neovim or vscode?", { limit: 3, includeEpisodes: true });
    expect(hits[0]?.factId).toBe("f1");
    expect(hits.map((h) => h.factId ?? h.episodeId).sort()).toEqual(["e1", "f1", "f2"]);
    expect((await engine.recall(scopeFor(bankB.id), "espresso", { limit: 5 })).map((h) => h.factId)).toEqual(["fb"]);
    // Retraction and as-of filtering still apply on top of the index scan.
    await engine.retractFact(factFixture(bankA.id, "f2", "x").id);
    expect((await engine.recall(scopeFor(bankA.id), "the user's dog Rex", { limit: 5 })).map((h) => h.factId)).toEqual(["f1"]);
    expect(await engine.recall(scopeFor(bankA.id), "neovim editor", { limit: 5, asOf: new Date("2020-01-01T00:00:00Z") })).toEqual([]);
    expect(await engine.purgeBank(bankB.id)).toEqual({ deleted: 1, remaining: 0 });

    // A row of another width is now refused by the database: the pin is enforced, not advisory.
    await expect(foreign.indexFact(factFixture(bankA.id, "f-wide", "x"))).rejects.toThrow(/dimensions/);
  });

  it("is idempotent, and a pin whose width disagrees with the embedder's own rows is refused before anything changes", async () => {
    const engine = new PgvectorEngine(db.pool, hashing256);
    await engine.indexFact(factFixture(bankA.id, "f1", "the user's editor is neovim"));
    await pinIndexDimensions(db.pool, hashing256.id, 256);
    const first = await readPinnedIndex(db.pool);
    const again = await pinIndexDimensions(db.pool, hashing256.id, 256);
    expect(again).toMatchObject({ deletedForeignRows: 0, retypedColumn: false, createdIndex: false, previous: { dimensions: 256, embedder: "hashing-256" } });
    // A no-op pin does not touch the settings rows, so `pinnedAt` dates the pin, not the last run of the command.
    expect(await readPinnedIndex(db.pool)).toEqual(first);
    // Repair path: the column is typed but the index is missing (dropped by hand); the pin recreates it alone.
    await db.pool.query(`DROP INDEX retrieval.${HNSW_INDEX_NAME}`);
    expect(await pinIndexDimensions(db.pool, hashing256.id, 256)).toMatchObject({ retypedColumn: false, createdIndex: true });
    expect(await hasIndex()).toBe(true);

    await expect(pinIndexDimensions(db.pool, hashing256.id, 512)).rejects.toThrow(/do not have 512 dimensions/);
    expect(await columnType()).toBe("vector(256)");
    expect(await readPinnedIndex(db.pool)).toMatchObject({ dimensions: 256 });
    await expect(pinIndexDimensions(db.pool, hashing256.id, 0)).rejects.toThrow(/positive integer/);
    await expect(pinIndexDimensions(db.pool, hashing256.id, 2001)).rejects.toThrow(/2000/);
  });

  it("an embedder switch at the pinned width: pin again (old rows go), reindex rebuilds, recall works through the rebuilt index", async () => {
    const old = new PgvectorEngine(db.pool, hashing256);
    const f = factFixture(bankA.id, "f1", "the user's editor is neovim");
    await old.indexFact(f);
    await pinIndexDimensions(db.pool, hashing256.id, 256);

    const current = new PgvectorEngine(db.pool, other256);
    expect(await current.recall(scopeFor(bankA.id), "neovim editor", { limit: 5 })).toEqual([]);
    const repin = await pinIndexDimensions(db.pool, other256.id, 256);
    expect(repin).toMatchObject({ deletedForeignRows: 1, retypedColumn: false, createdIndex: false, previous: { embedder: "hashing-256" } });
    expect(await readPinnedIndex(db.pool)).toMatchObject({ dimensions: 256, embedder: "other-256" });
    await current.rebuild(bankA.id, fromArray([f]), fromArray([]));
    expect((await current.recall(scopeFor(bankA.id), "neovim editor", { limit: 5 })).map((h) => h.factId)).toEqual(["f1"]);
    expect(await current.staleRowCount(bankA.id)).toBe(0);
  });

  it("re-pinning to another width (after the old rows are gone) retypes the column and rebuilds the index", async () => {
    await pinIndexDimensions(db.pool, hashing256.id, 256);
    const wide = new PgvectorEngine(db.pool, new HashingEmbedder(512));
    const r = await pinIndexDimensions(db.pool, wide.embedderId, 512);
    expect(r).toMatchObject({ deletedForeignRows: 0, retypedColumn: true, createdIndex: true, previous: { dimensions: 256 } });
    expect(await columnType()).toBe("vector(512)");
    expect(await hasIndex()).toBe(true);
    await wide.indexFact(factFixture(bankA.id, "f1", "the user's editor is neovim"));
    expect((await wide.recall(scopeFor(bankA.id), "neovim", { limit: 5 })).map((h) => h.factId)).toEqual(["f1"]);
  });
});
