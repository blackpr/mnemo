import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asEpisodeId, systemClock, type ModelRef } from "../../src/shared-kernel/index.js";
import { PgAuditLog, scopeAccessPolicy } from "../../src/governance/index.js";
import { PgBankRepository, PgEpisodeRepository, PgFactRepository, PgOutboxRelay, PgUnitOfWork, RecallHandler, RecordEpisodeHandler, WriteExtractedFactsHandler, type Bank } from "../../src/memory/index.js";
import { EngineMemoryFinder, HashingEmbedder, IndexingProjector, PgvectorEngine } from "../../src/retrieval/index.js";
import { LlmCallError, LlmExtractor, PgExtractionRunStore, RetainPipeline, type Extractor } from "../../src/extraction/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { bankFixture, factFixture, scopeFor, tenant } from "../helpers/fixtures.js";
import { ScriptedLlmClient } from "../helpers/scripted-llm.js";

const extractorRef: ModelRef = { provider: "test", model: "scripted", version: "t1" };

describeWithDb("RetainPipeline (worker + outbox)", () => {
  let db: TestDb;
  const base = bankFixture("bank-a");
  const bankA: Bank = { ...base, policy: { ...base.policy, extractor: extractorRef } };
  const t0 = new Date("2026-01-01T00:00:00Z");
  const t1 = new Date("2026-06-01T00:00:00Z");

  const build = (llm: ScriptedLlmClient, opts: { extractorFor?: () => Extractor; backoffMs?: (n: number) => number; maxAttempts?: number; staleClaimMs?: number } = {}) => {
    const engine = new PgvectorEngine(db.pool, new HashingEmbedder(256));
    const facts = new PgFactRepository(db.pool);
    const episodes = new PgEpisodeRepository(db.pool);
    const uow = new PgUnitOfWork(db.pool);
    const runs = new PgExtractionRunStore(db.pool);
    const extractor: Extractor = new LlmExtractor(llm);
    const pipeline = new RetainPipeline({
      banks: new PgBankRepository(db.pool),
      episodes,
      facts,
      runs,
      extractorFor: opts.extractorFor ?? (() => extractor),
      write: new WriteExtractedFactsHandler(uow, scopeAccessPolicy, systemClock),
      clock: systemClock,
      backoffMs: opts.backoffMs ?? (() => 0),
      ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
      ...(opts.staleClaimMs !== undefined ? { staleClaimMs: opts.staleClaimMs } : {}),
    });
    const projector = new IndexingProjector(engine, facts, episodes);
    const relay = new PgOutboxRelay(db.pool, { backoffMs: () => 0 });
    const drainOutbox = () =>
      relay.drainAll(async (events) => {
        await projector.handle(events);
        await pipeline.handle(events);
      });
    const recall = new RecallHandler(new EngineMemoryFinder(engine), facts, episodes, scopeAccessPolicy, new PgAuditLog(db.pool), systemClock);
    const record = new RecordEpisodeHandler(uow, scopeAccessPolicy, systemClock);
    const retain = (id: string, text: string, at = t1, role: "user" | "assistant" = "user") =>
      record.handle(scopeFor(bankA.id), { id: asEpisodeId(id), bankId: bankA.id, kind: "conversation_turn", source: "t", role, text, occurredAt: at });
    const run = (id: string) => db.pool.query<Record<string, unknown>>("SELECT * FROM extraction.runs WHERE episode_id = $1", [id]).then((r) => r.rows[0]);
    return { facts, pipeline, relay, runs, drainOutbox, recall, retain, run, engine };
  };

  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.truncateAll();
    await new PgBankRepository(db.pool).create(bankA);
  });

  it("episode -> enqueue -> worker extracts -> supersession -> index -> recall reflects new state and history", async () => {
    const facts = new PgFactRepository(db.pool);
    const berlin = factFixture(bankA.id, "f-berlin", "The Subject lives in Berlin", t0);
    await facts.insert(berlin);
    const llm = new ScriptedLlmClient([
      { candidates: [{ statement: "The Subject lives in Lisbon", predicate: null, validFrom: "2026-06-01T00:00:00Z", sourceEpisodeIds: ["ep-move"], related: [{ factId: "f-berlin", relation: "updates" }], faithfulness: 1 }] },
    ]);
    const { drainOutbox, pipeline, recall, retain, relay, run, engine } = build(llm);
    await engine.indexFact(berlin);

    expect((await retain("ep-move", "I moved to Lisbon last month, Berlin was too cold.")).ok).toBe(true);

    // Relay: projector indexes the episode; pipeline only enqueues. No model call yet.
    expect(await drainOutbox()).toBe(1);
    expect(llm.calls).toHaveLength(0);
    expect((await run("ep-move"))?.["status"]).toBe("pending");

    // Worker: extracts and applies.
    expect(await pipeline.drain()).toBe(1);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.user).toContain('<fact id="f-berlin"');
    expect(llm.calls[0]?.user).toContain("I moved to Lisbon");
    const r = await run("ep-move");
    expect(r).toMatchObject({ status: "done", input_tokens: 1234, superseded: 1, asserted: 1, attempts: 1 });

    // Relay again: FactAsserted + FactSuperseded reach the projector.
    expect(await drainOutbox()).toBe(2);
    expect(await relay.pendingCount()).toBe(0);

    const now = await recall.handle(scopeFor(bankA.id), { bankId: bankA.id, query: "where does the subject live", limit: 5 });
    if (!now.ok) throw new Error("recall failed");
    expect(now.value.facts.map((f) => f.statement)).toEqual(["The Subject lives in Lisbon"]);
    expect(now.value.facts[0]?.supersedes).toBe("f-berlin");
    expect(now.value.facts[0]?.provenance.extractor?.version).toBe("t1+extract-v2");

    const march = await recall.handle(scopeFor(bankA.id), { bankId: bankA.id, query: "where does the subject live", limit: 5, asOf: new Date("2026-03-01T00:00:00Z") });
    if (!march.ok) throw new Error("recall failed");
    expect(march.value.facts.map((f) => f.id)).toEqual(["f-berlin"]);
  });

  it("redelivery and repeated worker passes never extract twice", async () => {
    const llm = new ScriptedLlmClient([{ candidates: [] }, { candidates: [] }]);
    const { pipeline, retain, runs } = build(llm);
    await retain("ep-1", "hello there");
    await runs.enqueue(asEpisodeId("ep-1"), bankA.id, tenant, new Date());
    await runs.enqueue(asEpisodeId("ep-1"), bankA.id, tenant, new Date());
    expect(await pipeline.processNext()).toBe("done");
    expect(await pipeline.processNext()).toBe("idle");
    expect(llm.calls).toHaveLength(1);
  });

  it("concurrent workers: only one claims a given episode", async () => {
    const { runs } = build(new ScriptedLlmClient([]));
    await runs.enqueue(asEpisodeId("ep-1"), bankA.id, tenant, new Date());
    const claims = await Promise.all(Array.from({ length: 5 }, () => runs.claimNext(new Date(), { staleAfterMs: 60_000, maxAttempts: 3 })));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("a stale running claim is retaken (up to the attempt cap, then swept dead); a late completer cannot clobber the new claim", async () => {
    const { runs } = build(new ScriptedLlmClient([]));
    const opts = { staleAfterMs: 60_000, maxAttempts: 2 };
    await runs.enqueue(asEpisodeId("ep-1"), bankA.id, tenant, new Date());
    const first = await runs.claimNext(new Date(), opts);
    expect(first).toBeDefined();
    expect(await runs.claimNext(new Date(), opts)).toBeUndefined();
    const later = new Date(Date.now() + 120_000);
    const second = await runs.claimNext(later, opts);
    expect(second?.attempts).toBe(2);
    // The first worker comes back late: its fail() is a no-op because the claim token changed.
    expect(await runs.fail(first!, "late", later, undefined)).toBe(false);
    expect((await runs.counts()).running).toBe(1);
    // Attempt cap reached: not retaken again; the sweep marks it dead instead.
    const evenLater = new Date(later.getTime() + 120_000);
    expect(await runs.claimNext(evenLater, opts)).toBeUndefined();
    expect(await runs.sweepStale(evenLater, opts)).toBe(1);
    expect((await runs.counts()).dead).toBe(1);
  });

  it("skips: bank without extractor, assistant-authored episode", async () => {
    const llm = new ScriptedLlmClient([]);
    const { pipeline, retain, run, runs } = build(llm);
    await retain("ep-assistant", "Here is a suggestion for you", t1, "assistant");
    await runs.enqueue(asEpisodeId("ep-assistant"), bankA.id, tenant, new Date());
    expect(await pipeline.processNext()).toBe("skipped");
    expect((await run("ep-assistant"))?.["reason"]).toBe("not_subject_authored");

    await new PgBankRepository(db.pool).update({ ...bankA, policy: { ...base.policy } });
    await retain("ep-user", "hello");
    await runs.enqueue(asEpisodeId("ep-user"), bankA.id, tenant, new Date());
    expect(await pipeline.processNext()).toBe("skipped");
    expect((await run("ep-user"))?.["reason"]).toBe("no_extractor_configured");
    expect(llm.calls).toHaveLength(0);
  });

  it("retryable failure backs off and retries; attempts exhausted -> dead", async () => {
    const llm = new ScriptedLlmClient([new LlmCallError("provider 503", true, { inputTokens: 10, outputTokens: 0, latencyMs: 5 }), new LlmCallError("provider 503", true)]);
    const { pipeline, retain, run, runs } = build(llm, { maxAttempts: 2, backoffMs: () => 0 });
    await retain("ep-1", "hello");
    await runs.enqueue(asEpisodeId("ep-1"), bankA.id, tenant, new Date());

    expect(await pipeline.processNext()).toBe("failed");
    let r = await run("ep-1");
    expect(r).toMatchObject({ status: "failed", attempts: 1, input_tokens: 10 });
    expect(String(r?.["error"])).toContain("provider 503");

    expect(await pipeline.processNext()).toBe("failed");
    r = await run("ep-1");
    expect(r).toMatchObject({ status: "dead", attempts: 2 });
    expect(await pipeline.processNext()).toBe("idle");

    expect(await runs.requeueFailed()).toBe(1);
    expect((await run("ep-1"))?.["status"]).toBe("pending");
  });

  it("a non-retryable model error dead-letters immediately; a transient one with backoff is not due yet", async () => {
    const llm = new ScriptedLlmClient([new LlmCallError("output truncated", false), new LlmCallError("timeout", true)]);
    const { pipeline, retain, run, runs } = build(llm, { backoffMs: () => 3_600_000 });
    await retain("ep-fatal", "a");
    await retain("ep-slow", "b", new Date(t1.getTime() + 1000));
    await runs.enqueue(asEpisodeId("ep-fatal"), bankA.id, tenant, new Date(0));
    await runs.enqueue(asEpisodeId("ep-slow"), bankA.id, tenant, new Date(1));
    expect(await pipeline.processNext()).toBe("failed");
    expect((await run("ep-fatal"))?.["status"]).toBe("dead");
    expect(await pipeline.processNext()).toBe("failed");
    expect((await run("ep-slow"))?.["status"]).toBe("failed");
    expect(await pipeline.processNext()).toBe("idle"); // in backoff, not due
    expect(await runs.counts()).toMatchObject({ dead: 1, failed: 1, pending: 0 });
  });

  it("a crash after the fact write does not duplicate facts on retry (write is idempotent per trigger)", async () => {
    const llm = new ScriptedLlmClient([
      { candidates: [{ statement: "The Subject lives in Lisbon", predicate: null, validFrom: null, sourceEpisodeIds: ["ep-1"], related: [], faithfulness: 1 }] },
      { candidates: [{ statement: "The Subject lives in Lisbon", predicate: null, validFrom: null, sourceEpisodeIds: ["ep-1"], related: [], faithfulness: 1 }] },
    ]);
    const { pipeline, retain, runs, facts } = build(llm, { staleClaimMs: 0 });
    await retain("ep-1", "I live in Lisbon");
    await runs.enqueue(asEpisodeId("ep-1"), bankA.id, tenant, new Date());
    expect(await pipeline.processNext()).toBe("done");
    // Simulate: the completion was lost and the claim went stale, so the worker retries.
    await db.pool.query("UPDATE extraction.runs SET status = 'running', claimed_at = now() - interval '1 hour' WHERE episode_id = 'ep-1'");
    expect(await pipeline.processNext()).toBe("done");
    expect(llm.calls).toHaveLength(2);
    expect((await facts.listCurrent(scopeFor(bankA.id))).map((f) => f.statement)).toEqual(["The Subject lives in Lisbon"]);
  });

  it("backfilled older episode: candidate contradicting the current fact becomes history, not a second current fact", async () => {
    const facts = new PgFactRepository(db.pool);
    await facts.insert(factFixture(bankA.id, "f-lisbon", "The Subject lives in Lisbon", t1));
    const llm = new ScriptedLlmClient([{ candidates: [{ statement: "The Subject lives in Berlin", predicate: null, validFrom: null, sourceEpisodeIds: ["ep-old"], related: [{ factId: "f-lisbon", relation: "updates" }], faithfulness: 1 }] }]);
    const { pipeline, retain, runs, run } = build(llm);
    await retain("ep-old", "I live in Berlin", t0); // imported 2026-01 conversation, processed after the Lisbon fact exists
    await runs.enqueue(asEpisodeId("ep-old"), bankA.id, tenant, new Date());
    expect(await pipeline.processNext()).toBe("done");
    expect(llm.calls[0]?.user).toContain('<fact id="f-lisbon"'); // current facts are shown even though the episode predates them
    expect((await run("ep-old"))?.["historical"]).toBe(1);
    expect((await facts.listCurrent(scopeFor(bankA.id))).map((f) => f.id)).toEqual(["f-lisbon"]);
    expect((await facts.listCurrent(scopeFor(bankA.id), new Date("2026-03-01T00:00:00Z"))).map((f) => f.statement)).toEqual(["The Subject lives in Berlin"]);
  });

  it("context passed to the extractor is the preceding episodes oldest-first plus current facts", async () => {
    const llm = new ScriptedLlmClient([{ candidates: [] }]);
    const { pipeline, retain, facts, runs } = build(llm);
    await facts.insert(factFixture(bankA.id, "f-1", "The Subject drinks espresso", t0));
    for (const [i, text] of ["first", "second", "third"].entries()) await retain(`ep-${i}`, text, new Date(t1.getTime() + i * 60_000));
    await runs.enqueue(asEpisodeId("ep-2"), bankA.id, tenant, new Date());
    expect(await pipeline.processNext()).toBe("done");
    const user = llm.calls[0]?.user ?? "";
    expect(user.indexOf("first")).toBeLessThan(user.indexOf("second"));
    expect(user.indexOf("second")).toBeLessThan(user.indexOf("third"));
    expect(user).toContain('<fact id="f-1"');
    expect(user).toContain('LAST episode (id "ep-2")');
  });
});
