import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asEpisodeId, systemClock, type ModelRef } from "../../src/shared-kernel/index.js";
import { PgAuditLog, scopeAccessPolicy } from "../../src/governance/index.js";
import { PgBankRepository, PgEpisodeRepository, PgFactRepository, PgOutboxRelay, PgUnitOfWork, RecallHandler, RecordEpisodeHandler, WriteExtractedFactsHandler, type Bank } from "../../src/memory/index.js";
import { EngineMemoryFinder, HashingEmbedder, IndexingProjector, PgvectorEngine } from "../../src/retrieval/index.js";
import { LlmCallError, LlmExtractor, PgExtractionRunStore, RelevanceCandidateSelector, RetainPipeline, type Extractor } from "../../src/extraction/index.js";
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

  const build = (llm: ScriptedLlmClient, opts: { extractorFor?: () => Extractor; backoffMs?: (n: number) => number; maxAttempts?: number; staleClaimMs?: number; candidateFacts?: number } = {}) => {
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
      candidates: new RelevanceCandidateSelector(engine, { topK: opts.candidateFacts ?? 20, warn: () => undefined }),
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
      { candidates: [{ statement: "The Subject lives in Lisbon", validFrom: "2026-06-01T00:00:00Z", sourceEpisodeIds: ["ep-move"], related: [{ factId: "f-berlin", relation: "updates" }], faithfulness: 1 }] },
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
    expect(r).toMatchObject({ status: "done", input_tokens: 1234, cached_input_tokens: 0, superseded: 1, asserted: 1, attempts: 1 });

    // Relay again: FactAsserted + FactSuperseded reach the projector.
    expect(await drainOutbox()).toBe(2);
    expect(await relay.pendingCount()).toBe(0);

    const now = await recall.handle(scopeFor(bankA.id), { bankId: bankA.id, query: "where does the subject live", limit: 5 });
    if (!now.ok) throw new Error("recall failed");
    expect(now.value.facts.map((f) => f.statement)).toEqual(["The Subject lives in Lisbon"]);
    expect(now.value.facts[0]?.supersedes).toBe("f-berlin");
    expect(now.value.facts[0]?.provenance.extractor?.version).toBe("t1+extract-v3");

    const march = await recall.handle(scopeFor(bankA.id), { bankId: bankA.id, query: "where does the subject live", limit: 5, asOf: new Date("2026-03-01T00:00:00Z") });
    if (!march.ok) throw new Error("recall failed");
    expect(march.value.facts.map((f) => f.id)).toEqual(["f-berlin"]);
  });

  it("redelivery and repeated worker passes never extract twice", async () => {
    const llm = new ScriptedLlmClient([{ candidates: [] }, { candidates: [] }]);
    const { pipeline, retain, runs } = build(llm);
    await retain("ep-1", "hello there, I am back from my trip");
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

  it("skips: bank without extractor, assistant-authored episode, episodes that cannot carry facts (triage)", async () => {
    const llm = new ScriptedLlmClient([]);
    const { pipeline, retain, run, runs } = build(llm);
    await retain("ep-assistant", "Here is a suggestion for you", t1, "assistant");
    await runs.enqueue(asEpisodeId("ep-assistant"), bankA.id, tenant, new Date());
    expect(await pipeline.processNext()).toBe("skipped");
    expect((await run("ep-assistant"))?.["reason"]).toBe("not_subject_authored");

    await retain("ep-ok", "ok thanks", new Date(t1.getTime() + 1000));
    await runs.enqueue(asEpisodeId("ep-ok"), bankA.id, tenant, new Date());
    expect(await pipeline.processNext()).toBe("skipped");
    expect((await run("ep-ok"))?.["reason"]).toBe("no_extractable_content:acknowledgement");
    await retain("ep-code", "```ts\nconst x = 1;\n```", new Date(t1.getTime() + 2000));
    await runs.enqueue(asEpisodeId("ep-code"), bankA.id, tenant, new Date());
    expect(await pipeline.processNext()).toBe("skipped");
    expect((await run("ep-code"))?.["reason"]).toBe("no_extractable_content:code_only");

    await new PgBankRepository(db.pool).update({ ...bankA, policy: { ...base.policy } });
    await retain("ep-user", "hello, I want to tell you about my week");
    await runs.enqueue(asEpisodeId("ep-user"), bankA.id, tenant, new Date());
    expect(await pipeline.processNext()).toBe("skipped");
    expect((await run("ep-user"))?.["reason"]).toBe("no_extractor_configured");
    expect(llm.calls).toHaveLength(0);
  });

  it("retryable failure backs off and retries; attempts exhausted -> dead", async () => {
    const llm = new ScriptedLlmClient([new LlmCallError("provider 503", true, { inputTokens: 10, outputTokens: 0, latencyMs: 5 }), new LlmCallError("provider 503", true)]);
    const { pipeline, retain, run, runs } = build(llm, { maxAttempts: 2, backoffMs: () => 0 });
    await retain("ep-1", "hello there, I am back from my trip");
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
    await retain("ep-fatal", "I started learning the cello");
    await retain("ep-slow", "I started learning the viola", new Date(t1.getTime() + 1000));
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
      { candidates: [{ statement: "The Subject lives in Lisbon", validFrom: null, sourceEpisodeIds: ["ep-1"], related: [], faithfulness: 1 }] },
      { candidates: [{ statement: "The Subject lives in Lisbon", validFrom: null, sourceEpisodeIds: ["ep-1"], related: [], faithfulness: 1 }] },
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
    const llm = new ScriptedLlmClient([{ candidates: [{ statement: "The Subject lives in Berlin", validFrom: null, sourceEpisodeIds: ["ep-old"], related: [{ factId: "f-lisbon", relation: "updates" }], faithfulness: 1 }] }]);
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
    for (const [i, text] of ["first I went to Porto", "second I went to Braga", "third I went to Faro"].entries()) await retain(`ep-${i}`, text, new Date(t1.getTime() + i * 60_000));
    await runs.enqueue(asEpisodeId("ep-2"), bankA.id, tenant, new Date());
    expect(await pipeline.processNext()).toBe("done");
    const user = llm.calls[0]?.user ?? "";
    expect(user.indexOf("Porto")).toBeLessThan(user.indexOf("Braga"));
    expect(user.indexOf("Braga")).toBeLessThan(user.indexOf("Faro"));
    expect(user).toContain('<fact id="f-1"');
    expect(user).toContain('LAST episode (id "ep-2")');
  });

  it("supersession fires when the contradicted fact is only reachable through the candidate selection (not the whole bank)", async () => {
    const facts = new PgFactRepository(db.pool);
    const llm = new ScriptedLlmClient([
      { candidates: [{ statement: "The Subject lives in Lisbon", validFrom: "2026-06-01T00:00:00Z", sourceEpisodeIds: ["ep-move"], related: [{ factId: "f-berlin", relation: "updates" }], faithfulness: 1 }] },
    ]);
    const { drainOutbox, pipeline, retain, run, engine } = build(llm, { candidateFacts: 5 });
    // 40 unrelated current facts plus the one the episode contradicts; every fact indexed, as the projector would.
    const berlin = factFixture(bankA.id, "f-berlin", "The Subject lives in Berlin", t0);
    const filler = Array.from({ length: 40 }, (_, i) => factFixture(bankA.id, `f-${i}`, `The Subject owns ${i + 2} potted ferns on the balcony`, new Date(t0.getTime() + (i + 1) * 60_000)));
    for (const f of [berlin, ...filler]) {
      await facts.insert(f);
      await engine.indexFact(f);
    }
    expect((await retain("ep-move", "I moved to Lisbon last month, Berlin was too cold.")).ok).toBe(true);
    await drainOutbox();
    expect(await pipeline.drain()).toBe(1);
    const user = llm.calls[0]?.user ?? "";
    expect(user).toContain('<fact id="f-berlin"');
    expect((user.match(/<fact id=/g) ?? []).length).toBeLessThanOrEqual(11); // top 5 by similarity, 5 most recent, entity matches: not 41
    expect(await run("ep-move")).toMatchObject({ status: "done", superseded: 1 });
    expect((await facts.listCurrent(scopeFor(bankA.id))).map((f) => f.statement)).toContain("The Subject lives in Lisbon");
    expect((await facts.listCurrent(scopeFor(bankA.id))).map((f) => f.id)).not.toContain("f-berlin");
  });

  it("a fact extracted from the previous episode is a candidate for the next one before the relay has indexed it (back-to-back worker passes)", async () => {
    const facts = new PgFactRepository(db.pool);
    const llm = new ScriptedLlmClient([
      { candidates: [{ statement: "The Subject lives in Berlin", validFrom: null, sourceEpisodeIds: ["ep-1"], related: [], faithfulness: 1 }] },
      // The second response relates to whatever id the first extraction gave the Berlin fact, read from the prompt it was shown.
      ({ user }: { user: string }) => {
        const berlin = /<fact id="([^"]+)"[^>]*>The Subject lives in Berlin</.exec(user)?.[1] ?? "not-shown";
        return { candidates: [{ statement: "The Subject lives in Lisbon", validFrom: "2026-06-02T00:00:00Z", sourceEpisodeIds: ["ep-2"], related: [{ factId: berlin, relation: "updates" }], faithfulness: 1 }] };
      },
    ]);
    const { pipeline, retain, runs, engine } = build(llm, { candidateFacts: 3 });
    const filler = Array.from({ length: 20 }, (_, i) => factFixture(bankA.id, `f-${i}`, `The Subject owns ${i + 2} potted ferns on the balcony`, new Date(t0.getTime() + (i + 1) * 60_000)));
    for (const f of filler) {
      await facts.insert(f);
      await engine.indexFact(f);
    }
    await retain("ep-1", "I live in Berlin these days", t1);
    await retain("ep-2", "I just moved to Lisbon", new Date(t1.getTime() + 60_000));
    await runs.enqueue(asEpisodeId("ep-1"), bankA.id, tenant, new Date(0));
    await runs.enqueue(asEpisodeId("ep-2"), bankA.id, tenant, new Date(1));
    expect(await pipeline.processNext()).toBe("done");
    const berlinId = (await facts.listCurrent(scopeFor(bankA.id))).find((f) => f.statement.includes("Berlin"))?.id;
    expect(berlinId).toBeDefined();
    // The relay has not run: the Berlin fact is in the system of record but not in the engine.
    expect(await pipeline.processNext()).toBe("done");
    expect(llm.calls[1]?.user).toContain(`<fact id="${berlinId}"`);
    const now = (await facts.listCurrent(scopeFor(bankA.id))).map((f) => f.statement);
    expect(now).toContain("The Subject lives in Lisbon");
    expect(now).not.toContain("The Subject lives in Berlin");
  });

  it("a terse reply to an assistant question still reaches the model (triage reads the preceding turn)", async () => {
    const llm = new ScriptedLlmClient([{ candidates: [] }]);
    const { pipeline, retain, runs, run } = build(llm);
    await retain("ep-q", "Do you still live in Berlin?", t1, "assistant");
    await retain("ep-a", "nope", new Date(t1.getTime() + 1000));
    await runs.enqueue(asEpisodeId("ep-a"), bankA.id, tenant, new Date());
    expect(await pipeline.processNext()).toBe("done");
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.user).toContain("Do you still live in Berlin?");
    expect((await run("ep-a"))?.["status"]).toBe("done");
  });
});
