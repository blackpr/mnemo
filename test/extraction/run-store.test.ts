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
    expect(await runs.complete(claim!, extractor, { usage: { inputTokens: 120, outputTokens: 30, latencyMs: 5, cachedInputTokens: 80, cacheWriteTokens: 10 }, candidates: 1, asserted: 1, superseded: 0, invalidated: 0, historical: 0, rejected: 0 }, now)).toBe(true);
    // A failed attempt's usage counts too (the ledger is spend, not success), and absent cache numbers stay null, not 0.
    const second = await runs.claimNext(now, { staleAfterMs: 1_000, maxAttempts: 3 });
    expect(second?.episodeId).toBe("e2");
    expect(await runs.fail(second!, "boom", now, new Date(now.getTime() + 60_000), { inputTokens: 50, outputTokens: 0, latencyMs: 1 })).toBe(true);
    const row = await db.pool.query<{ cached_input_tokens: number | null }>("SELECT cached_input_tokens FROM extraction.runs WHERE episode_id = 'e2'");
    expect(row.rows[0]?.cached_input_tokens).toBeNull();

    expect(await runs.summaryByBank(bankA)).toEqual({ counts: { pending: 0, running: 0, done: 1, failed: 1, dead: 0, skipped: 0 }, inputTokens: 170, outputTokens: 30, cachedInputTokens: 80, cacheWriteTokens: 10, llmAttempts: 2 });
    expect(await runs.summaryByBank(bankB)).toEqual({ counts: { pending: 1, running: 0, done: 0, failed: 0, dead: 0, skipped: 0 }, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, llmAttempts: 0 });
    expect(await runs.summaryByBank(asBankId("bank-none"))).toEqual({ counts: { pending: 0, running: 0, done: 0, failed: 0, dead: 0, skipped: 0 }, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, llmAttempts: 0 });
  });

  it("cache columns: NULL when the provider reports none, kept by fail() when it does", async () => {
    const runs = new PgExtractionRunStore(db.pool);
    const now = new Date("2026-01-01T00:00:00Z");
    const bank = asBankId("bank-c");
    const tenant = asTenantId("t1");
    const extractor: ModelRef = { provider: "test", model: "scripted", version: "t1" };
    await runs.enqueue(asEpisodeId("c1"), bank, tenant, now);
    await runs.enqueue(asEpisodeId("c2"), bank, tenant, new Date(now.getTime() + 1));
    const a = await runs.claimNext(new Date(now.getTime() + 10), { staleAfterMs: 1_000, maxAttempts: 3 });
    await runs.complete(a!, extractor, { usage: { inputTokens: 10, outputTokens: 1, latencyMs: 1 }, candidates: 0, asserted: 0, superseded: 0, invalidated: 0, historical: 0, rejected: 0 }, now);
    const b = await runs.claimNext(new Date(now.getTime() + 10), { staleAfterMs: 1_000, maxAttempts: 3 });
    await runs.fail(b!, "boom", now, undefined, { inputTokens: 20, outputTokens: 0, latencyMs: 1, cachedInputTokens: 15, cacheWriteTokens: 0 });
    const { rows } = await db.pool.query<{ episode_id: string; cached_input_tokens: number | null; cache_write_tokens: number | null }>("SELECT episode_id, cached_input_tokens, cache_write_tokens FROM extraction.runs WHERE bank_id = 'bank-c' ORDER BY episode_id");
    expect(rows).toEqual([
      { episode_id: "c1", cached_input_tokens: null, cache_write_tokens: null },
      { episode_id: "c2", cached_input_tokens: 15, cache_write_tokens: 0 },
    ]);
  });
});
