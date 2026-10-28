import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asEpisodeId, asFactId, asPrincipalId, asTenantId, type BankId, type Scope, type TenantId } from "../../src/shared-kernel/index.js";
import { PgBankRepository, PgEpisodeRepository, PgFactRepository, PgMemoryErasure, PgOutbox, type Bank, type Fact } from "../../src/memory/index.js";
import { HashingEmbedder, PgvectorEngine } from "../../src/retrieval/index.js";
import { PgExtractionRunStore } from "../../src/extraction/index.js";
import { PgExportStore } from "../../src/portability/index.js";
import { PgAccessRevocation, PgApiKeyStore, PgAuditLog, PgErasureRequestRepository, PgPrincipalRepository, fail, requestErasure, type ErasureRequest } from "../../src/governance/index.js";
import { SCOPED_TABLES } from "../../src/platform/postgres/bank-isolation.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { alice, bankFixture, episodeFixture, factFixture, fromArray, scopeFor } from "../helpers/fixtures.js";

/**
 * Bank isolation, proven per repository: bank A (tenant t1) and bank B (tenant t2) both hold a row in every scoped
 * table; each test calls every read and write method of one context's stores for bank B and checks that it saw
 * nothing of bank A and that bank A's rows, in every scoped table, are byte for byte what they were.
 * The query guard checks the same statements' SQL (test/helpers/query-guard.ts); this checks their effect.
 */
describeWithDb("bank isolation: every store called for bank B neither sees nor changes bank A", () => {
  const t1 = asTenantId("t1");
  const t2 = asTenantId("t2");
  const bankA = bankFixture("bank-a");
  const bankB: Bank = { ...bankFixture("bank-b"), tenantId: t2 };
  const scopeB: Scope = { ...scopeFor(bankB.id), tenantId: t2 };
  const at = new Date("2026-03-01T00:00:00Z");
  const embedder = new HashingEmbedder(64);

  let db: TestDb;
  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.truncateAll();
    await seed(bankA, t1, "a");
    await seed(bankB, t2, "b");
  });

  const factOf = (bankId: BankId, s: string): Fact => {
    const f = factFixture(bankId, `f-${s}`, `bank ${s} fact: the user's editor is ${s === "a" ? "neovim" : "helix"}`, new Date("2026-02-01T00:00:00Z"), `ep-${s}`);
    return { ...f, provenance: { ...f.provenance, triggerEpisodeId: asEpisodeId(`ep-${s}`) } };
  };
  const requestOf = (bank: Bank, s: string): ErasureRequest =>
    requestErasure({ id: `er-${s}`, tenantId: bank.tenantId, bankId: bank.id, subjectId: bank.subjectId, requestedBy: asPrincipalId(`agent-${s}`), requestedAt: new Date(`2026-03-0${s === "a" ? 1 : 2}T00:00:00Z`) });

  async function seed(bank: Bank, tenantId: TenantId, s: string): Promise<void> {
    await new PgBankRepository(db.pool).create(bank);
    const episode = episodeFixture(bank.id, `ep-${s}`, `bank ${s} episode: I switched editors`);
    await new PgEpisodeRepository(db.pool).append(episode);
    await new PgFactRepository(db.pool).insert(factOf(bank.id, s));
    await new PgOutbox(db.pool).publish([{ type: "memory.EpisodeRecorded", occurredAt: at, tenantId, bankId: bank.id, payload: { episodeId: episode.id } }]);
    const engine = new PgvectorEngine(db.pool, embedder);
    await engine.indexFact(factOf(bank.id, s));
    await engine.indexEpisode(episode);
    await new PgExtractionRunStore(db.pool).enqueue(episode.id, bank.id, tenantId, at);
    await new PgExportStore(db.pool).record({ id: `x-${s}`, tenantId, bankId: bank.id, principalId: alice, format: "jsonl", schemaVersion: "1", factCount: 1, tombstoneCount: 0, bytes: 10, contentSha256: `sha-${s}`, producedAt: at });
    await new PgPrincipalRepository(db.pool).save({ id: asPrincipalId(`agent-${s}`), tenantId, kind: "agent", displayName: `agent ${s}`, grants: [{ bankId: bank.id, capabilities: new Set(["read", "erase"]), grantedAt: at }] });
    await new PgApiKeyStore(db.pool).issue(asPrincipalId(`agent-${s}`), `hash-${s}`, `key ${s}`);
    await new PgAuditLog(db.pool).append({ tenantId, bankId: bank.id, principalId: asPrincipalId(`agent-${s}`), action: "erasure.requested", details: { requestId: `er-${s}` }, at });
    await new PgErasureRequestRepository(db.pool).create(requestOf(bank, s));
  }

  /** Bank A's rows in every scoped table, keyed by table. */
  async function bankARows(): Promise<Record<string, unknown[]>> {
    const where: Record<string, string> = {
      "memory.banks": "id = 'bank-a'",
      "governance.principals": "tenant_id = 't1'",
      "governance.api_keys": "principal_id = 'agent-a'",
      "governance.audit_log": "tenant_id = 't1'",
    };
    const out: Record<string, unknown[]> = {};
    for (const table of Object.keys(SCOPED_TABLES)) {
      const { rows } = await db.pool.query<{ r: unknown }>(`SELECT to_jsonb(t) AS r FROM ${table} t WHERE ${where[table] ?? "bank_id = 'bank-a'"} ORDER BY t::text`);
      out[table] = rows.map((x) => x.r);
    }
    return out;
  }

  it("seeds a row for each bank in every scoped table", async () => {
    const a = await bankARows();
    for (const [table, rows] of Object.entries(a)) expect(rows.length, table).toBeGreaterThan(0);
    for (const table of Object.keys(SCOPED_TABLES)) {
      const { rows } = await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
      expect(Number(rows[0]!.n), table).toBeGreaterThan(a[table]!.length);
    }
  });

  it("memory: banks, episodes, facts, outbox and Memory's erasure store", async () => {
    const before = await bankARows();
    const banks = new PgBankRepository(db.pool);
    const episodes = new PgEpisodeRepository(db.pool);
    const facts = new PgFactRepository(db.pool);

    expect((await banks.get(bankB.id))?.id).toBe("bank-b");
    expect(await banks.tenantOf(bankB.id)).toBe("t2");
    await banks.update({ ...bankB, policy: { ...bankB.policy } });
    // Bank A's row under bank B's tenant is not found: the update is refused, not applied.
    await expect(banks.update({ ...bankA, tenantId: t2 })).rejects.toThrow(/not found/);

    expect(await episodes.get(scopeB, asEpisodeId("ep-a"))).toBeUndefined();
    expect((await episodes.getMany(scopeB, [asEpisodeId("ep-a"), asEpisodeId("ep-b")])).map((e) => e.id)).toEqual(["ep-b"]);
    expect((await episodes.listRecent(scopeB, 10, new Date("2030-01-01T00:00:00Z"))).map((e) => e.id)).toEqual(["ep-b"]);
    expect((await episodes.listByBank(scopeB)).map((e) => e.id)).toEqual(["ep-b"]);
    await expect(episodes.append(episodeFixture(bankB.id, "ep-a", "same id, other bank"))).rejects.toThrow();

    expect(await facts.get(scopeB, asFactId("f-a"))).toBeUndefined();
    expect(await facts.get(scopeB, asFactId("f-a"), { forUpdate: true })).toBeUndefined();
    expect((await facts.getMany(scopeB, [asFactId("f-a"), asFactId("f-b")])).map((f) => f.id)).toEqual(["f-b"]);
    expect((await facts.listAll(scopeB)).map((f) => f.id)).toEqual(["f-b"]);
    expect((await facts.listCurrent(scopeB, new Date("2030-01-01T00:00:00Z"))).map((f) => f.id)).toEqual(["f-b"]);
    expect(await facts.existsForTrigger(scopeB, asEpisodeId("ep-a"), alice)).toBe(false);
    expect(await facts.existsForTrigger(scopeB, asEpisodeId("ep-b"), alice)).toBe(true);
    // Bank A's fact presented as bank B's: not found, nothing written.
    await expect(facts.update({ ...factOf(bankA.id, "a"), bankId: bankB.id, statement: "overwritten" })).rejects.toThrow(/not found in bank bank-b/);
    await facts.update({ ...factOf(bankB.id, "b"), statement: "bank b fact, edited" });
    await expect(facts.insert({ ...factOf(bankA.id, "a"), bankId: bankB.id })).rejects.toThrow();
    await new PgOutbox(db.pool).publish([{ type: "memory.FactAsserted", occurredAt: at, tenantId: t2, bankId: bankB.id, payload: { factId: "f-b" } }]);

    const erasure = new PgMemoryErasure(db.pool);
    expect(await erasure.describe(bankB.id)).toMatchObject({ tenantId: "t2" });
    expect(await erasure.count(bankB.id)).toEqual({ "memory.facts": 1, "memory.episodes": 1, "memory.outbox": 2 });
    await erasure.beginErasure(bankB.id);
    expect(await erasure.purge(bankB.id)).toEqual({ "memory.facts": 1, "memory.episodes": 1, "memory.outbox": 2 });
    await erasure.completeErasure(bankB.id);
    expect(await erasure.count(bankB.id)).toEqual({ "memory.facts": 0, "memory.episodes": 0, "memory.outbox": 0 });

    expect(await bankARows()).toEqual(before);
  });

  it("retrieval: the pgvector index", async () => {
    const before = await bankARows();
    const engine = new PgvectorEngine(db.pool, embedder);

    const hits = await engine.recall(scopeB, "bank a fact: the user's editor is neovim", { limit: 10, includeEpisodes: true });
    expect(hits.map((h) => h.factId ?? h.episodeId).sort()).toEqual(["ep-b", "f-b"]);
    await engine.retractFact(bankB.id, asFactId("f-a"));
    await expect(engine.indexFact({ ...factOf(bankA.id, "a"), bankId: bankB.id })).rejects.toThrow(/already indexed for another bank/);
    expect(await engine.countBank(bankB.id)).toBe(2);
    expect(await engine.staleRowCount(bankB.id)).toBe(0);
    await engine.rebuild(bankB.id, fromArray([factOf(bankB.id, "b")]), fromArray([]));
    expect(await engine.purgeBank(bankB.id)).toEqual({ deleted: 2, remaining: 0 });

    expect(await bankARows()).toEqual(before);
  });

  it("extraction: the run ledger, including a claim forged with bank A's episode and bank B's id", async () => {
    const runs = new PgExtractionRunStore(db.pool);
    // The oldest due run is bank A's (same time, lower id); a real claim on it, then a forged one naming bank B.
    const claimA = await runs.claimNext(at, { staleAfterMs: 60_000, maxAttempts: 3 });
    expect(claimA?.bankId).toBe("bank-a");
    const before = await bankARows();
    const forged = { ...claimA!, bankId: bankB.id, tenantId: t2 };
    const usage = { inputTokens: 1, outputTokens: 1, latencyMs: 1 };
    expect(await runs.complete(forged, { provider: "test", model: "m", version: "1" }, { usage, candidates: 0, asserted: 0, superseded: 0, invalidated: 0, historical: 0, rejected: 0 }, at)).toBe(false);
    expect(await runs.fail(forged, "x", at, undefined, usage)).toBe(false);
    await runs.skip(forged, "x", at);

    expect(await runs.countByBank(bankB.id)).toBe(1);
    expect((await runs.summaryByBank(bankB.id)).counts).toEqual({ pending: 1, running: 0, done: 0, failed: 0, dead: 0, skipped: 0 });
    expect(await runs.purgeBank(bankB.id)).toBe(1);

    expect(await bankARows()).toEqual(before);
  });

  it("portability: the export ledger", async () => {
    const before = await bankARows();
    const exports = new PgExportStore(db.pool);
    expect((await exports.listByBank(scopeB)).map((x) => x.id)).toEqual(["x-b"]);
    // Bank A's id under bank B's tenant: nothing.
    expect(await exports.listByBank({ ...scopeB, bankId: bankA.id })).toEqual([]);
    expect(await exports.countByBank(bankB.id)).toBe(1);
    expect(await exports.purgeBank(bankB.id)).toBe(1);
    expect(await bankARows()).toEqual(before);
  });

  it("governance: principals, grants, keys, the audit log and the erasure store", async () => {
    const before = await bankARows();
    const principals = new PgPrincipalRepository(db.pool);
    const audit = new PgAuditLog(db.pool);

    expect((await principals.get(asPrincipalId("agent-b")))?.grants.map((g) => g.bankId)).toEqual(["bank-b"]);
    expect((await principals.findByApiKeyHash("hash-b"))?.id).toBe("agent-b");
    await principals.save({ id: asPrincipalId("agent-b"), tenantId: t2, kind: "agent", displayName: "agent b, renamed", grants: [{ bankId: bankB.id, capabilities: new Set(["read"]), grantedAt: at }] });
    // Bank A's principal id saved for tenant t2: refused, so it is neither renamed nor handed bank B's grants.
    await expect(principals.save({ id: asPrincipalId("agent-a"), tenantId: t2, kind: "agent", displayName: "hijacked", grants: [{ bankId: bankB.id, capabilities: new Set(["read"]), grantedAt: at }] })).rejects.toThrow(/another tenant/);
    const keys = new PgApiKeyStore(db.pool);
    expect(await keys.revoke("hash-b")).toBe(true);
    // A live key for agent-b again, so the erasure purge below has a key of bank B to revoke.
    await keys.issue(asPrincipalId("agent-b"), "hash-b2", "key b2");

    expect((await audit.list(t2)).map((e) => e.details.requestId)).toEqual(["er-b"]);
    expect(await audit.find(t2, { action: "erasure.requested", requestId: "er-a" })).toBeUndefined();
    await audit.append({ tenantId: t2, bankId: bankB.id, principalId: asPrincipalId("agent-b"), action: "access.denied", details: {}, at });

    const access = new PgAccessRevocation(db.pool);
    expect(await access.count(bankB.id)).toEqual({ "governance.grants": 1, "governance.api_keys": 1 });
    const purged = await access.purge(bankB.id, { id: "er-b" });
    expect(purged["governance.api_keys"]).toEqual({ deleted: 1, evidence: { revokedPrincipals: ["agent-b"] } });
    expect(await access.count(bankB.id)).toEqual({ "governance.grants": 0, "governance.api_keys": 0 });

    expect(await bankARows()).toEqual(before);
  });

  it("governance: an erasure request of bank A cannot be read, saved or released under bank B", async () => {
    const requests = new PgErasureRequestRepository(db.pool);
    const claim = await requests.claimNext({ staleAfterMs: 60_000 });
    expect(claim?.request.bankId).toBe("bank-a");
    const before = await bankARows();

    expect(await requests.get("er-a", { bankId: bankB.id, tenantId: t2 })).toBeUndefined();
    expect((await requests.get("er-b", { bankId: bankB.id, tenantId: t2 }))?.bankId).toBe("bank-b");
    const forged = { ...claim!.request, bankId: bankB.id };
    await expect(requests.save(fail(forged, "forged"), { claimToken: claim!.token })).rejects.toThrow(/not found/);
    await requests.release({ ...claim!, request: forged });
    await requests.save(fail(requestOf(bankB, "b"), "bank b's own"));

    expect(await bankARows()).toEqual(before);
  });
});
