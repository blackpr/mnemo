import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asFactId } from "../../src/shared-kernel/index.js";
import { PgBankRepository, PgEpisodeRepository, PgFactRepository, supersede, invalidate } from "../../src/memory/index.js";
import { HashingEmbedder, IndexingProjector, PgvectorEngine } from "../../src/retrieval/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { bankFixture, factFixture, scopeFor, tenant } from "../helpers/fixtures.js";

describeWithDb("IndexingProjector", () => {
  let db: TestDb;
  const bankA = bankFixture("bank-a");
  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.truncateAll();
    await new PgBankRepository(db.pool).create(bankA);
  });

  it("on FactSuperseded retracts the old fact in the index and indexes the new one; redelivery is safe", async () => {
    const facts = new PgFactRepository(db.pool);
    const engine = new PgvectorEngine(db.pool, new HashingEmbedder(128));
    const projector = new IndexingProjector(engine, facts, new PgEpisodeRepository(db.pool));
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-06-01T00:00:00Z");
    const a = factFixture(bankA.id, "f-a", "the user lives in Berlin", t0);
    const b = factFixture(bankA.id, "f-b", "the user lives in Lisbon", t1);
    await facts.insert(a);
    await facts.insert(b);
    await projector.handle([{ type: "memory.FactAsserted", occurredAt: t0, tenantId: tenant, bankId: bankA.id, payload: { factId: a.id } }]);
    expect((await engine.recall(scopeFor(bankA.id), "where does the user live", { limit: 5 })).map((h) => h.factId)).toEqual(["f-a"]);

    const s = supersede(a, b, t1);
    if (!s.ok) throw new Error("setup");
    await facts.update(s.value.old);
    await facts.update(s.value.replacement);
    const ev = { type: "memory.FactSuperseded", occurredAt: t1, tenantId: tenant, bankId: bankA.id, payload: { oldFactId: a.id, newFactId: b.id } } as const;
    await projector.handle([ev]);
    await projector.handle([ev]);
    expect((await engine.recall(scopeFor(bankA.id), "where does the user live", { limit: 5 })).map((h) => h.factId)).toEqual(["f-b"]);

    const inv = invalidate(b, "contradicted", new Date("2026-10-01T00:00:00Z"));
    if (!inv.ok) throw new Error("setup");
    await facts.update(inv.value);
    await projector.handle([{ type: "memory.FactInvalidated", occurredAt: new Date(), tenantId: tenant, bankId: bankA.id, payload: { factId: asFactId("f-b"), reason: "contradicted" } }]);
    expect(await engine.recall(scopeFor(bankA.id), "where does the user live", { limit: 5 })).toEqual([]);
  });

  it("ignores events whose subject no longer exists", async () => {
    const engine = new PgvectorEngine(db.pool, new HashingEmbedder(128));
    const projector = new IndexingProjector(engine, new PgFactRepository(db.pool), new PgEpisodeRepository(db.pool));
    await projector.handle([{ type: "memory.FactAsserted", occurredAt: new Date(), tenantId: tenant, bankId: bankA.id, payload: { factId: asFactId("gone") } }]);
    const { rows } = await db.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM retrieval.pgvector_index");
    expect(rows[0]?.n).toBe("0");
  });
});
