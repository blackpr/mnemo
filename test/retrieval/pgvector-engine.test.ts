import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { HashingEmbedder, PgvectorEngine, EngineMemoryFinder } from "../../src/retrieval/index.js";
import { PgBankRepository, PgEpisodeRepository, PgFactRepository, RecallHandler } from "../../src/memory/index.js";
import { PgAuditLog, scopeAccessPolicy } from "../../src/governance/index.js";
import { systemClock } from "../../src/shared-kernel/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { retrievalEngineContract } from "./retrieval-engine.contract.js";
import { bankFixture, factFixture, scopeFor } from "../helpers/fixtures.js";

describeWithDb("PgvectorEngine", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => db.truncateAll());

  retrievalEngineContract(() => new PgvectorEngine(db.pool, new HashingEmbedder(256)));

  it("records the embedder id on every row so an embedder change is detectable", async () => {
    const engine = new PgvectorEngine(db.pool, new HashingEmbedder(64));
    await engine.indexFact(factFixture(bankFixture("bank-a").id, "f1", "anything"));
    const { rows } = await db.pool.query<{ embedder: string }>("SELECT embedder FROM retrieval.pgvector_index");
    expect(rows.map((r) => r.embedder)).toEqual(["hashing-64"]);
  });

  it("end to end: RecallHandler re-reads facts under the scope and applies policy", async () => {
    const bankA = bankFixture("bank-a");
    const bankB = bankFixture("bank-b");
    const banks = new PgBankRepository(db.pool);
    await banks.create(bankA);
    await banks.create(bankB);
    const facts = new PgFactRepository(db.pool);
    const engine = new PgvectorEngine(db.pool, new HashingEmbedder(256));

    const fa = factFixture(bankA.id, "fa", "the user's editor is neovim");
    await facts.insert(fa);
    await engine.indexFact(fa);
    // Poisoned index row pointing at a fact that does not exist in the system of record:
    await engine.indexFact(factFixture(bankA.id, "ghost", "the user's editor is emacs"));

    const recall = new RecallHandler(new EngineMemoryFinder(engine), facts, new PgEpisodeRepository(db.pool), scopeAccessPolicy, new PgAuditLog(db.pool), systemClock);

    const ok = await recall.handle(scopeFor(bankA.id, ["read"]), { bankId: bankA.id, query: "which editor", limit: 5 });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      // Only facts present in memory.facts come back; the ghost index row is dropped.
      expect(ok.value.facts.map((f) => f.id)).toEqual(["fa"]);
      expect(ok.value.facts[0]?.provenance.sourceEpisodeIds).toEqual(["ep-1"]);
    }

    const denied = await recall.handle(scopeFor(bankA.id, ["write"]), { bankId: bankA.id, query: "which editor", limit: 5 });
    expect(denied.ok).toBe(false);

    const wrongBank = await recall.handle(scopeFor(bankB.id, ["read"]), { bankId: bankA.id, query: "which editor", limit: 5 });
    expect(wrongBank.ok).toBe(false);
  });
});
