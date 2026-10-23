import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asEpisodeId, asFactId, systemClock, type ModelRef } from "../../src/shared-kernel/index.js";
import { PgAuditLog, scopeAccessPolicy } from "../../src/governance/index.js";
import {
  looksLikeSecret,
  PgBankRepository,
  PgEpisodeRepository,
  PgFactRepository,
  PgOutboxRelay,
  PgUnitOfWork,
  WriteExtractedFactsHandler,
  type ExtractedCandidate,
  type WriteExtractedFactsInput,
} from "../../src/memory/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { bankFixture, episodeFixture, factFixture, scopeFor, tenant } from "../helpers/fixtures.js";

const extractor: ModelRef = { provider: "test", model: "scripted", version: "t1" };

describeWithDb("WriteExtractedFactsHandler", () => {
  let db: TestDb;
  let h: WriteExtractedFactsHandler;
  let facts: PgFactRepository;
  const bankA = bankFixture("bank-a");
  const t0 = new Date("2026-01-01T00:00:00Z");
  const t1 = new Date("2026-06-01T00:00:00Z");
  const trigger = asEpisodeId("ep-1");

  const candidate = (id: string, statement: string, extra: Partial<ExtractedCandidate> = {}): ExtractedCandidate => ({
    id: asFactId(id),
    statement,
    sourceEpisodeIds: [trigger],
    faithfulness: 0.9,
    related: [],
    ...extra,
  });
  const input = (candidates: ExtractedCandidate[], extra: Partial<WriteExtractedFactsInput> = {}): WriteExtractedFactsInput => ({
    bankId: bankA.id,
    extractor,
    triggerEpisodeId: trigger,
    defaultValidFrom: t1,
    candidates,
    ...extra,
  });
  const drainTypes = async () => {
    const types: string[] = [];
    await new PgOutboxRelay(db.pool).drainAll(async (evs) => {
      for (const e of evs) types.push(e.type);
    });
    return types;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    h = new WriteExtractedFactsHandler(new PgUnitOfWork(db.pool), scopeAccessPolicy, systemClock);
    facts = new PgFactRepository(db.pool);
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.truncateAll();
    await new PgBankRepository(db.pool).create(bankA);
    const episodes = new PgEpisodeRepository(db.pool);
    await episodes.append(episodeFixture(bankA.id, "ep-1", "I moved to Lisbon", t1));
    await episodes.append({ ...episodeFixture(bankA.id, "ep-tool", "The weather in Lisbon is sunny", t1), role: "tool", kind: "tool_result" });
  });

  it("asserts new facts, rejects duplicates / low faithfulness / unknown or non-Subject sources / secrets, audits once", async () => {
    const existing = factFixture(bankA.id, "f-coffee", "The Subject drinks espresso", t0);
    await facts.insert(existing);

    const r = await h.handle(
      scopeFor(bankA.id),
      input([
        candidate("c1", "The Subject lives in Lisbon"),
        candidate("c2", "The Subject likes espresso coffee", { related: [{ factId: existing.id, relation: "duplicate" }] }),
        candidate("c3", "The Subject might be left-handed", { faithfulness: 0.2 }),
        candidate("c4", "ghost source", { sourceEpisodeIds: [asEpisodeId("missing")] }),
        candidate("c5", "The weather in Lisbon is sunny", { sourceEpisodeIds: [asEpisodeId("ep-tool")] }),
        candidate("c6", "The Subject's API key is sk-live-abcdefghijklmnopqrstuvwxyz"),
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.alreadyApplied).toBe(false);
    expect(r.value.asserted).toEqual(["c1"]);
    expect(r.value.rejected.map((x) => x.reason).sort()).toEqual(["duplicate", "looks_like_secret", "low_faithfulness", "no_subject_source", "unknown_source_episode"]);
    expect(r.value.rejected.find((x) => x.reason === "looks_like_secret")?.statement).toBe("[redacted]");

    const stored = await facts.get(scopeFor(bankA.id), asFactId("c1"));
    expect(stored?.provenance.extractor).toEqual(extractor);
    expect(stored?.provenance.writerPrincipalId).toBe("alice");
    expect(stored?.provenance.faithfulness).toBe(0.9);
    expect(stored?.validity.validFrom).toEqual(t1);

    const audit = await new PgAuditLog(db.pool).list(tenant);
    expect(audit.map((a) => a.action)).toEqual(["extraction.applied"]);
    expect(audit[0]?.details).toMatchObject({ asserted: 1, rejected: 5, superseded: 0, triggerEpisodeId: "ep-1" });
    expect(JSON.stringify(audit[0]?.details)).not.toContain("sk-live");
    expect(await drainTypes()).toEqual(["memory.FactAsserted"]);
  });

  it("is idempotent per trigger episode: a second application writes nothing", async () => {
    const first = await h.handle(scopeFor(bankA.id), input([candidate("c1", "The Subject lives in Lisbon")]));
    expect(first.ok && first.value.asserted).toEqual(["c1"]);
    const second = await h.handle(scopeFor(bankA.id), input([candidate("c1-again", "The Subject lives in Lisbon")]));
    expect(second.ok && second.value.alreadyApplied).toBe(true);
    expect((await facts.listCurrent(scopeFor(bankA.id))).map((f) => f.id)).toEqual(["c1"]);
    expect((await new PgAuditLog(db.pool).list(tenant)).length).toBe(1);
  });

  it("a newer 'updates' candidate supersedes: old interval closed and linked, still believed about the past", async () => {
    const berlin = factFixture(bankA.id, "f-berlin", "The Subject lives in Berlin", t0);
    await facts.insert(berlin);

    const r = await h.handle(scopeFor(bankA.id), input([candidate("c-lisbon", "The Subject lives in Lisbon", { related: [{ factId: berlin.id, relation: "updates" }] })]));
    expect(r.ok && r.value.superseded).toEqual([{ oldFactId: "f-berlin", newFactId: "c-lisbon" }]);

    const old = await facts.get(scopeFor(bankA.id), berlin.id);
    expect(old?.validity.validTo).toEqual(t1);
    expect(old?.transaction.retractedAt).toBeUndefined();
    expect(old?.supersededBy).toBe("c-lisbon");
    expect((await facts.listCurrent(scopeFor(bankA.id), new Date("2026-10-01T00:00:00Z"))).map((f) => f.id)).toEqual(["c-lisbon"]);
    expect((await facts.listCurrent(scopeFor(bankA.id), new Date("2026-03-01T00:00:00Z"))).map((f) => f.id)).toEqual(["f-berlin"]);
    expect(await drainTypes()).toEqual(["memory.FactAsserted", "memory.FactSuperseded"]);
  });

  it("a newer 'contradicts' candidate invalidates the old fact: it was wrong, not outdated", async () => {
    const allergy = factFixture(bankA.id, "f-allergy", "The Subject is allergic to peanuts", t0);
    await facts.insert(allergy);

    const r = await h.handle(scopeFor(bankA.id), input([candidate("c-none", "The Subject has no food allergies", { related: [{ factId: allergy.id, relation: "contradicts" }] })]));
    expect(r.ok && r.value.invalidated).toEqual([{ oldFactId: "f-allergy", newFactId: "c-none" }]);

    const old = await facts.get(scopeFor(bankA.id), allergy.id);
    expect(old?.transaction.retractedAt).toBeDefined();
    expect(old?.invalidation?.reason).toBe("contradicted");
    // Not even believed about the past.
    expect((await facts.listCurrent(scopeFor(bankA.id), new Date("2026-03-01T00:00:00Z"))).map((f) => f.id)).toEqual([]);
    expect(await drainTypes()).toEqual(["memory.FactAsserted", "memory.FactInvalidated"]);
  });

  it("same-instant 'updates' is treated as a contradiction (no zero-length interval)", async () => {
    const vscode = factFixture(bankA.id, "f-vscode", "The Subject's editor is VS Code", t1);
    await facts.insert(vscode);
    const r = await h.handle(scopeFor(bankA.id), input([candidate("c-nvim", "The Subject's editor is neovim", { related: [{ factId: vscode.id, relation: "updates" }] })]));
    expect(r.ok && r.value.invalidated).toEqual([{ oldFactId: "f-vscode", newFactId: "c-nvim" }]);
    expect((await facts.get(scopeFor(bankA.id), vscode.id))?.transaction.retractedAt).toBeDefined();
  });

  it("an older contradicting candidate is recorded as history, not as current", async () => {
    const lisbon = factFixture(bankA.id, "f-lisbon", "The Subject lives in Lisbon", t1);
    await facts.insert(lisbon);

    const r = await h.handle(scopeFor(bankA.id), input([candidate("c-berlin", "The Subject lives in Berlin", { validFrom: t0, related: [{ factId: lisbon.id, relation: "contradicts" }] })]));
    expect(r.ok && r.value.historical).toEqual(["c-berlin"]);

    expect((await facts.listCurrent(scopeFor(bankA.id), new Date("2026-10-01T00:00:00Z"))).map((f) => f.id)).toEqual(["f-lisbon"]);
    expect((await facts.listCurrent(scopeFor(bankA.id), new Date("2026-03-01T00:00:00Z"))).map((f) => f.id)).toEqual(["c-berlin"]);
    expect((await facts.get(scopeFor(bankA.id), asFactId("c-berlin")))?.provenance.confirmation).toBe("disputed");
  });

  it("two candidates relating to the same fact in one batch: the first supersedes, the second is asserted", async () => {
    const berlin = factFixture(bankA.id, "f-berlin", "The Subject lives in Berlin", t0);
    await facts.insert(berlin);
    const r = await h.handle(
      scopeFor(bankA.id),
      input([
        candidate("c1", "The Subject lives in Lisbon", { related: [{ factId: berlin.id, relation: "updates" }] }),
        candidate("c2", "The Subject moved to Lisbon for the weather", { related: [{ factId: berlin.id, relation: "updates" }] }),
      ]),
    );
    expect(r.ok && [...r.value.asserted].sort()).toEqual(["c1", "c2"]);
    expect(r.ok && r.value.superseded).toEqual([{ oldFactId: "f-berlin", newFactId: "c1" }]);
    expect(r.ok && r.value.rejected).toEqual([]);
  });

  it("denies a scope without write and a bank in another tenant", async () => {
    expect((await h.handle(scopeFor(bankA.id, ["read"]), input([]))).ok).toBe(false);
    expect((await h.handle({ ...scopeFor(bankA.id), tenantId: "other" as typeof tenant }, input([]))).ok).toBe(false);
  });
});

it("looksLikeSecret catches common credential shapes and leaves ordinary facts alone", () => {
  for (const s of [
    "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    "the key is sk-ant-api03-abc",
    "AWS key AKIAIOSFODNN7EXAMPLE",
    "Google key AIzaSyA1234567890abcdefghijklmnopqrstuv",
    "card 4111 1111 1111 1111",
    "-----BEGIN RSA PRIVATE KEY-----",
    "password: hunter2!",
    "my password is hunter2",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop",
    "hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "token Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWpBQkNERUY0NTY3ODkw",
  ]) expect(looksLikeSecret(s), s).toBe(true);
  for (const s of [
    "The Subject lives in Lisbon",
    "The Subject's editor is neovim since 2026",
    "The Subject was born in 1989",
    "Order number 12345678",
    "The Subject's phone number is +30 210 1234 5678",
    "The repo is at github.com/blackpr/mem/tree/main/src/extraction/application",
    "The Subject pinned commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
    "The Subject's IBAN is GR16 0110 1250 0000 0001 2300 695",
    "The Subject uses Donaudampfschifffahrtsgesellschaftskapitaenswitwenrente as a test word",
    "The token budget is 5",
    "The secret is that they like pineapple pizza",
    "The Subject's user id is 1234567890123",
  ]) expect(looksLikeSecret(s), s).toBe(false);
});
