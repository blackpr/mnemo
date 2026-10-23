import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asBankId, asEpisodeId, asTenantId, type ModelRef } from "../../src/shared-kernel/index.js";
import { PgExtractionRunStore } from "../../src/extraction/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";

describeWithDb("PgExtractionRunStore.summaryByBank", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.truncateAll();
  });

  it("reports queue counts and token spend for one bank only", async () => {
    const runs = new PgExtractionRunStore(db.pool);
    const now = new Date("2026-01-01T00:00:00Z");
    const tenant = asTenantId("t1");
    const bankA = asBankId("bank-a");
    const bankB = asBankId("bank-b");
    await runs.enqueue(asEpisodeId("e1"), bankA, tenant, now);
    await runs.enqueue(asEpisodeId("e2"), bankA, tenant, now);
    await runs.enqueue(asEpisodeId("e3"), bankB, tenant, now);
    const claim = await runs.claimNext(now, { staleAfterMs: 1_000, maxAttempts: 3 });
    expect(claim?.episodeId).toBe("e1");
    const extractor: ModelRef = { provider: "test", model: "scripted", version: "t1" };
    expect(await runs.complete(claim!, extractor, { usage: { inputTokens: 120, outputTokens: 30, latencyMs: 5 }, candidates: 1, asserted: 1, superseded: 0, invalidated: 0, historical: 0, rejected: 0 }, now)).toBe(true);

    expect(await runs.summaryByBank(bankA)).toEqual({ counts: { pending: 1, running: 0, done: 1, failed: 0, dead: 0, skipped: 0 }, inputTokens: 120, outputTokens: 30 });
    expect(await runs.summaryByBank(bankB)).toEqual({ counts: { pending: 1, running: 0, done: 0, failed: 0, dead: 0, skipped: 0 }, inputTokens: 0, outputTokens: 0 });
    expect(await runs.summaryByBank(asBankId("bank-none"))).toEqual({ counts: { pending: 0, running: 0, done: 0, failed: 0, dead: 0, skipped: 0 }, inputTokens: 0, outputTokens: 0 });
  });
});
