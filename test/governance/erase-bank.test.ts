import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asBankId, asEpisodeId, asFactId, asPrincipalId, asTenantId, systemClock, type BankId, type Scope } from "../../src/shared-kernel/index.js";
import {
  AbandonErasureHandler,
  EraseBankHandler,
  ErasureClaimLostError,
  ErasureInFlightError,
  ErasureNotInFlightError,
  ErasureWorker,
  generateApiKey,
  GetErasureHandler,
  PgAccessRevocation,
  PgApiKeyStore,
  PgAuditLog,
  PgErasureRequestRepository,
  PgErasureUnitOfWork,
  PgPrincipalRepository,
  markDeleted,
  recordDeletion,
  recordInventory,
  recordVerification,
  requestErasure,
  ScopeResolver,
  scopeAccessPolicy,
  verifyChain,
  verifyReceipt,
  type AuditLogStore,
  type ErasableStore,
  type ErasureBankGateway,
  type ErasureUnitOfWork,
} from "../../src/governance/index.js";
import { sha256 } from "../../src/platform/hash.js";
import { AssertFactHandler, PgBankRepository, PgEpisodeRepository, PgFactRepository, PgMemoryErasure, PgOutboxRelay, PgUnitOfWork, RecallHandler, RecordEpisodeHandler, switchEngine } from "../../src/memory/index.js";
import { EngineErasableStore, EngineMemoryFinder, HashingEmbedder, IndexingProjector, PgvectorEngine } from "../../src/retrieval/index.js";
import { ExtractionErasableStore, PgExtractionRunStore } from "../../src/extraction/index.js";
import { ExportsErasableStore, PgExportStore } from "../../src/portability/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { alice, bankFixture, scopeFor, tenant } from "../helpers/fixtures.js";

/** Rows per table for one bank, straight from SQL: the proof the receipt is supposed to carry. Table names are test constants, never input. */
async function rowsFor(db: TestDb, bankId: BankId): Promise<Record<string, number>> {
  const tables = ["memory.facts", "memory.episodes", "memory.outbox", "retrieval.pgvector_index", "extraction.runs", "portability.exports", "governance.grants"];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t} WHERE bank_id = $1`, [bankId]);
    out[t] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

describeWithDb("EraseBank", () => {
  let db: TestDb;
  const bankA = bankFixture("bank-a");
  const bankB = bankFixture("bank-b");
  const eraser = (bankId: BankId, caps: Scope["capabilities"] = new Set(["erase"])): Scope => ({ tenantId: tenant, bankId, principalId: alice, capabilities: caps });

  let engine: PgvectorEngine;
  let audit: PgAuditLog;
  let requests: PgErasureRequestRepository;
  let uow: PgErasureUnitOfWork;
  let memory: PgMemoryErasure;
  let stores: ErasableStore[];
  let recall: RecallHandler;
  /** Plaintext API keys by principal id: `agent-<bank>` holds read+write+erase on its bank only; `shared` holds read+write on both; `lapsed` holds A plus an expired grant on B. */
  const apiKeys = new Map<string, string>();
  const activeKeys = async (principalId: string) => Number((await db.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM governance.api_keys WHERE principal_id = $1 AND revoked_at IS NULL", [principalId])).rows[0]!.n);

  const banksLookup = { tenantOf: (bankId: BankId) => new PgBankRepository(db.pool).tenantOf(bankId) };
  type Wiring = { stores?: readonly ErasableStore[]; uow?: ErasureUnitOfWork; bank?: ErasureBankGateway; staleAfterMs?: number; maxAttempts?: number };
  /** Enqueues only (what the REST handler and admin erase-bank do). */
  const handler = (opts: Wiring = {}) => new EraseBankHandler(scopeAccessPolicy, opts.bank ?? memory, opts.uow ?? uow, opts.stores ?? stores, systemClock, randomUUID);
  /** The server's loop: claims requested rows and runs the workflow. */
  const worker = (opts: Wiring = {}) => new ErasureWorker(requests, opts.bank ?? memory, opts.uow ?? uow, opts.stores ?? stores, systemClock, sha256, { staleAfterMs: opts.staleAfterMs ?? 60_000, maxAttempts: opts.maxAttempts ?? 3 });
  /** Request, run the worker until idle, read the request back: one erasure end to end. */
  const erase = async (scope: Scope, bankId: BankId, opts: Wiring = {}) => {
    const r = await handler(opts).handle(scope, bankId);
    if (!r.ok) return r;
    await worker(opts).drain();
    const stored = await requests.get(r.value.id);
    if (!stored) throw new Error("request vanished");
    return { ok: true as const, value: stored };
  };
  /** Drive a claimed request by hand through the domain functions, as a worker pass would, and stop (as if the process died) once `until` is reached. */
  const driveTo = async (claim: NonNullable<Awaited<ReturnType<typeof requests.claimNext>>>, until: "inventoried" | "deleted" | "verified" | "tombstoned", withStores: readonly ErasableStore[] = stores) => {
    const bankId = claim.request.bankId;
    await memory.beginErasure(bankId);
    const inventory = [];
    for (const store of withStores) for (const [name, countBefore] of Object.entries(await store.count(bankId))) inventory.push({ store: name, countBefore });
    let request = unwrap(recordInventory(claim.request, inventory));
    await requests.save(request, { claimToken: claim.token });
    if (until === "inventoried") return request;
    for (const store of withStores) {
      for (const [name, p] of Object.entries(await store.purge(bankId, { id: request.id }))) {
        const { deleted, evidence } = typeof p === "number" ? { deleted: p, evidence: undefined } : p;
        request = unwrap(recordDeletion(request, { store: name, deleted, deletedAt: new Date(), ...(evidence ? { evidence } : {}) }));
      }
      await requests.save(request, { claimToken: claim.token });
    }
    request = unwrap(markDeleted(request));
    await requests.save(request, { claimToken: claim.token });
    if (until === "deleted") return request;
    const verifications = [];
    for (const store of withStores) for (const [name, hitsAfter] of Object.entries(await store.count(bankId, { requestId: request.id, deletions: request.deletions }))) verifications.push({ store: name, hitsAfter, checkedAt: new Date() });
    request = unwrap(recordVerification(request, verifications));
    await requests.save(request, { claimToken: claim.token });
    if (until === "verified") return request;
    await memory.completeErasure(bankId);
    return request;
  };
  const unwrap = <T,>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`setup: ${JSON.stringify(r.error)}`);
    return r.value;
  };
  const backdateClaim = (id: string) => db.pool.query("UPDATE governance.erasure_requests SET claimed_at = claimed_at - interval '1 hour' WHERE id = $1", [id]);
  const erasureActions = async (bankId: BankId) => (await audit.list(tenant)).filter((e) => e.bankId === bankId && e.action.startsWith("erasure.")).map((e) => e.action);
  const FULL_RUN = ["erasure.requested", "erasure.access_revoked", "erasure.deleted", "erasure.verified", "erasure.receipt_issued"];
  const claimOf = async (id: string) => (await db.pool.query<{ claim_token: string | null; claimed_at: Date | null; attempts: number }>("SELECT claim_token, claimed_at, attempts FROM governance.erasure_requests WHERE id = $1", [id])).rows[0]!;
  const requestsOf = async (bankId: BankId) => (await db.pool.query<{ id: string }>("SELECT id FROM governance.erasure_requests WHERE bank_id = $1 ORDER BY requested_at, id", [bankId])).rows.map((r) => r.id);

  /** Retain two episodes and assert a fact in the bank, index them, leave an extraction run and an export record. */
  async function populate(bankId: BankId): Promise<void> {
    const uow = new PgUnitOfWork(db.pool);
    const scope = scopeFor(bankId);
    const record = new RecordEpisodeHandler(uow, scopeAccessPolicy, systemClock);
    const ids = [];
    for (const text of [`${bankId}: I moved to Lisbon last spring`, `${bankId}: my editor is neovim`]) {
      const r = await record.handle(scope, { id: asEpisodeId(randomUUID()), bankId, kind: "conversation_turn", source: "test", role: "user", text, occurredAt: new Date("2026-05-01T00:00:00Z") });
      if (!r.ok) throw new Error(r.error.kind);
      ids.push(r.value.episodeId);
    }
    const fact = await new AssertFactHandler(uow, scopeAccessPolicy, systemClock).handle(scope, { id: asFactId(randomUUID()), bankId, statement: `${bankId}: the user lives in Lisbon`, sourceEpisodeIds: [ids[0]!] });
    if (!fact.ok) throw new Error(fact.error.kind);
    await new PgExtractionRunStore(db.pool).enqueue(ids[1]!, bankId, tenant, new Date());
    await new PgExportStore(db.pool).record({ id: randomUUID(), tenantId: tenant, bankId, principalId: alice, format: "jsonl", schemaVersion: "v1", factCount: 1, tombstoneCount: 0, bytes: 10, contentSha256: "x", producedAt: new Date() });
  }

  beforeAll(async () => {
    db = await setupTestDb();
    engine = new PgvectorEngine(db.pool, new HashingEmbedder(256));
    audit = new PgAuditLog(db.pool);
    requests = new PgErasureRequestRepository(db.pool);
    uow = new PgErasureUnitOfWork(db.pool);
    memory = new PgMemoryErasure(db.pool);
    stores = [memory, new EngineErasableStore(engine), new ExtractionErasableStore(new PgExtractionRunStore(db.pool)), new ExportsErasableStore(new PgExportStore(db.pool)), new PgAccessRevocation(db.pool)];
    recall = new RecallHandler(new EngineMemoryFinder(engine), new PgFactRepository(db.pool), new PgEpisodeRepository(db.pool), scopeAccessPolicy, audit, systemClock);
  });
  afterAll(async () => db.close());

  beforeEach(async () => {
    await db.truncateAll();
    const banks = new PgBankRepository(db.pool);
    await banks.create(bankA);
    await banks.create(bankB);
    await populate(bankA.id);
    await populate(bankB.id);
    const principals = new PgPrincipalRepository(db.pool);
    const keys = new PgApiKeyStore(db.pool);
    const grant = (bankId: BankId, expiresAt?: Date) => ({ bankId, capabilities: new Set(["read", "write", "erase"] as const), grantedAt: new Date(), ...(expiresAt ? { expiresAt } : {}) });
    for (const [id, grants] of [
      [`agent-${bankA.id}`, [grant(bankA.id)]],
      [`agent-${bankB.id}`, [grant(bankB.id)]],
      ["shared", [grant(bankA.id), grant(bankB.id)]],
      ["lapsed", [grant(bankA.id), grant(bankB.id, new Date("2026-01-02T00:00:00Z"))]],
    ] as const) {
      await principals.save({ id: asPrincipalId(id), tenantId: tenant, kind: "agent", displayName: id, grants: [...grants] });
      const key = generateApiKey();
      await keys.issue(asPrincipalId(id), key.hash, "test");
      apiKeys.set(id, key.token);
    }
    const relay = new PgOutboxRelay(db.pool);
    const projector = new IndexingProjector(engine, new PgFactRepository(db.pool), new PgEpisodeRepository(db.pool));
    await relay.drainAll((events) => projector.handle(events));
  });

  it("erases one bank completely, leaves the other untouched, and issues a receipt the audit chain carries", async () => {
    const before = await rowsFor(db, bankA.id);
    expect(before).toEqual({ "memory.facts": 1, "memory.episodes": 2, "memory.outbox": 3, "retrieval.pgvector_index": 3, "extraction.runs": 1, "portability.exports": 1, "governance.grants": 3 });
    const beforeB = await rowsFor(db, bankB.id);
    const auditBefore = (await audit.list(tenant)).length;

    // The handler only enqueues: the request is `requested`, the bank is still active, nothing is deleted, and the audit
    // chain already carries `erasure.requested` (written before any destructive step, in the same transaction as the row).
    const queued = await handler().handle(eraser(bankA.id), bankA.id);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.value.state).toBe("requested");
    expect(await rowsFor(db, bankA.id)).toEqual(before);
    expect((await new PgBankRepository(db.pool).get(bankA.id))?.status).toBe("active");
    expect((await audit.list(tenant)).filter((e) => e.action.startsWith("erasure.")).map((e) => e.action)).toEqual(["erasure.requested"]);
    expect(await claimOf(queued.value.id)).toEqual({ claim_token: null, claimed_at: null, attempts: 0 });

    // One worker pass claims it and runs the workflow to the receipt; a second pass finds nothing to do.
    const w = worker();
    expect(await w.processNext()).toBe("receipted");
    expect(await w.processNext()).toBe("idle");
    const request = (await requests.get(queued.value.id))!;
    expect(await claimOf(request.id)).toEqual({ claim_token: expect.any(String), claimed_at: expect.any(Date), attempts: 1 });
    expect(request.state).toBe("receipted");
    expect(request.failure).toBeUndefined();
    expect(Object.fromEntries(request.inventory.map((i) => [i.store, i.countBefore]))).toEqual({
      "memory.facts": 1, "memory.episodes": 2, "memory.outbox": 3, "retrieval.pgvector": 3, "extraction.runs": 1, "portability.exports": 1,
      // Access: the three grants on A and the keys of the two principals with no live grant elsewhere (an expired one does not count).
      "governance.grants": 3, "governance.api_keys": 2,
    });
    expect(Object.fromEntries(request.deletions.map((d) => [d.store, d.deleted]))).toEqual(Object.fromEntries(request.inventory.map((i) => [i.store, i.countBefore])));
    expect(request.verifications.every((v) => v.hitsAfter === 0)).toBe(true);
    expect(request.verifications.map((v) => v.store).sort()).toEqual(request.inventory.map((i) => i.store).sort());

    // The system of record and every derived store hold nothing for the bank; the other bank is exactly as it was.
    expect(await rowsFor(db, bankA.id)).toEqual({ "memory.facts": 0, "memory.episodes": 0, "memory.outbox": 0, "retrieval.pgvector_index": 0, "extraction.runs": 0, "portability.exports": 0, "governance.grants": 0 });
    expect(await rowsFor(db, bankB.id)).toEqual(beforeB);

    // Access is gone with the data: the dedicated agent's key is revoked (401 at the attachment), the shared principal
    // keeps its key but has no grant on A any more (403), and nothing changed for bank B's agent.
    const resolver = new ScopeResolver(new PgPrincipalRepository(db.pool), banksLookup, systemClock);
    expect(await activeKeys(`agent-${bankA.id}`)).toBe(0);
    expect(await activeKeys("lapsed")).toBe(0);
    expect(await activeKeys("shared")).toBe(1);
    expect(await activeKeys(`agent-${bankB.id}`)).toBe(1);
    expect((await resolver.resolve(apiKeys.get(`agent-${bankA.id}`), bankA.id))).toEqual({ ok: false, error: { kind: "Unauthorized" } });
    expect((await resolver.resolve(apiKeys.get("shared"), bankA.id))).toMatchObject({ ok: false, error: { kind: "NoGrant", bankId: bankA.id, principalId: "shared" } });
    expect((await resolver.resolve(apiKeys.get("shared"), bankB.id)).ok).toBe(true);
    expect((await resolver.resolve(apiKeys.get(`agent-${bankB.id}`), bankB.id)).ok).toBe(true);
    expect((await db.pool.query<{ principal_id: string; bank_id: string }>("SELECT principal_id, bank_id FROM governance.grants ORDER BY 1")).rows).toEqual([
      { principal_id: `agent-${bankB.id}`, bank_id: bankB.id },
      { principal_id: "lapsed", bank_id: bankB.id },
      { principal_id: "shared", bank_id: bankB.id },
    ]);
    const recalled = await recall.handle(scopeFor(bankA.id, ["read"]), { bankId: bankA.id, query: "where does the user live, Lisbon?", includeEpisodes: true, limit: 10 });
    expect(recalled.ok && recalled.value).toEqual({ facts: [], episodes: [] });
    const recalledB = await recall.handle(scopeFor(bankB.id, ["read"]), { bankId: bankB.id, query: "where does the user live, Lisbon?", includeEpisodes: true, limit: 10 });
    expect(recalledB.ok && recalledB.value.facts.length).toBe(1);

    // The bank is a tombstone: the row stays, writes are refused, the id cannot be re-created.
    const banks = new PgBankRepository(db.pool);
    expect((await banks.get(bankA.id))?.status).toBe("erased");
    expect((await banks.get(bankB.id))?.status).toBe("active");
    const write = await new RecordEpisodeHandler(new PgUnitOfWork(db.pool), scopeAccessPolicy, systemClock).handle(scopeFor(bankA.id), { id: asEpisodeId(randomUUID()), bankId: bankA.id, kind: "conversation_turn", source: "test", text: "after", occurredAt: new Date() });
    expect(write).toEqual({ ok: false, error: { kind: "BankNotWritable" } });
    await expect(banks.create(bankA)).rejects.toThrow();

    // Receipt: persisted, verifiable, and its digest is in the audit chain, which still verifies and never lost an entry.
    const stored = await requests.get(request.id);
    expect(stored).toEqual(request);
    expect(stored?.receipt && verifyReceipt(stored.receipt, sha256)).toBe(true);
    expect(stored?.receipt?.digest).toMatch(/^[0-9a-f]{64}$/);
    const entries = await audit.list(tenant);
    expect(entries.length).toBeGreaterThan(auditBefore);
    expect(verifyChain(entries, sha256)).toBeUndefined();
    const erasureEntries = entries.filter((e) => e.action.startsWith("erasure."));
    expect(erasureEntries.map((e) => e.action)).toEqual(["erasure.requested", "erasure.access_revoked", "erasure.deleted", "erasure.verified", "erasure.receipt_issued"]);
    expect(erasureEntries[0]?.details).toEqual({ requestId: request.id, subjectId: bankA.subjectId });
    // The revoked principals are on the audit entry and on the request's deletion (ids only), and each revoked key says why and by which request.
    expect(erasureEntries[1]?.details).toEqual({ requestId: request.id, "deleted.governance.grants": 3, "deleted.governance.api_keys": 2, "governance.api_keys.revokedPrincipals": [`agent-${bankA.id}`, "lapsed"] });
    expect(request.deletions.find((d) => d.store === "governance.api_keys")?.evidence).toEqual({ revokedPrincipals: [`agent-${bankA.id}`, "lapsed"] });
    expect(request.deletions.find((d) => d.store === "governance.grants")?.evidence).toBeUndefined();
    expect((await db.pool.query("SELECT principal_id, revocation_reason, erasure_request_id FROM governance.api_keys WHERE revoked_at IS NOT NULL ORDER BY 1")).rows).toEqual([
      { principal_id: `agent-${bankA.id}`, revocation_reason: "erasure", erasure_request_id: request.id },
      { principal_id: "lapsed", revocation_reason: "erasure", erasure_request_id: request.id },
    ]);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM governance.api_keys WHERE revoked_at IS NULL AND revocation_reason IS NOT NULL")).rows[0]?.n).toBe(0);
    expect(JSON.stringify(entries)).not.toContain("mem_");
    expect(erasureEntries[2]?.details).toMatchObject({ requestId: request.id, "deleted.memory.facts": 1, "deleted.memory.episodes": 2, "deleted.retrieval.pgvector": 3, "deleted.governance.grants": 3, "deleted.governance.api_keys": 2 });
    expect(erasureEntries[4]?.details["digest"]).toBe(request.receipt?.digest);
    expect(request.receipt).toMatchObject({ tenantId: tenant, bankId: bankA.id, subjectId: bankA.subjectId });
    expect(request.receipt?.deletions).toEqual(request.deletions);
    // A receipt with any signed field altered no longer verifies.
    expect(verifyReceipt({ ...stored!.receipt!, bankId: bankB.id }, sha256)).toBe(false);
    // The evidence is covered by the digest too: a receipt whose revoked principals were edited no longer verifies.
    const edited = stored!.receipt!.deletions.map((d) => (d.store === "governance.api_keys" ? { ...d, evidence: { revokedPrincipals: ["lapsed"] } } : d));
    expect(verifyReceipt({ ...stored!.receipt!, deletions: edited }, sha256)).toBe(false);
    expect(JSON.stringify(entries)).not.toContain("Lisbon");
    // The audit entry was written before the first deletion.
    expect(entries.findIndex((e) => e.action === "erasure.requested")).toBe(auditBefore);

    // An erased bank can be erased again: a fresh pass proves zero and issues a new receipt.
    const again = await erase(eraser(bankA.id), bankA.id);
    expect(again.ok && again.value.state).toBe("receipted");
    expect(again.ok && again.value.inventory.every((i) => i.countBefore === 0)).toBe(true);
    expect(await requestsOf(bankA.id)).toEqual([request.id, again.ok ? again.value.id : ""]);
  });

  it("a store that fails to purge leaves the request failed, records what earlier stores deleted, issues no receipt, and keeps the bank frozen", async () => {
    const broken: ErasableStore = {
      count: async () => ({ "engine.broken": 4 }),
      purge: async () => {
        throw new Error("engine unreachable");
      },
    };
    const r = await erase(eraser(bankA.id), bankA.id, { stores: [memory, broken, ...stores.slice(1)] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("failed");
    // Step and error kind only: the store's message (which may echo content) never leaves the process log.
    expect(r.value.failure).toBe("purge of store 2 of 6 failed (Error)");
    expect(r.value.receipt).toBeUndefined();
    expect(Object.fromEntries(r.value.deletions.map((d) => [d.store, d.deleted]))).toEqual({ "memory.facts": 1, "memory.episodes": 2, "memory.outbox": 3 });
    expect(r.value.inventory.map((i) => i.store)).toContain("engine.broken");
    // A failed request is terminal: the worker never claims it again.
    expect(await worker().processNext()).toBe("idle");

    // Memory went (it ran first), pgvector did not (it ran after the failure point), bank B is intact.
    const rows = await rowsFor(db, bankA.id);
    expect(rows["memory.facts"]).toBe(0);
    expect(rows["retrieval.pgvector_index"]).toBe(3);
    expect((await rowsFor(db, bankB.id))["memory.facts"]).toBe(1);
    expect((await new PgBankRepository(db.pool).get(bankA.id))?.status).toBe("erasing");

    const erasureEntries = (await audit.list(tenant)).filter((e) => e.action.startsWith("erasure."));
    expect(erasureEntries.map((e) => e.action)).toEqual(["erasure.requested", "erasure.failed"]);
    // The audit chain gets the error kind, never the store's message (an external engine's error could echo content).
    expect(erasureEntries[1]?.details).toEqual({ requestId: r.value.id, kind: "Error" });
    expect(JSON.stringify(erasureEntries)).not.toContain("unreachable");

    // Access was not touched (its store runs last), so the dedicated eraser can still retry with the scope its own grant resolves to.
    expect((await rowsFor(db, bankA.id))["governance.grants"]).toBe(3);
    const resolver = new ScopeResolver(new PgPrincipalRepository(db.pool), banksLookup, systemClock);
    const resolved = await resolver.resolve(apiKeys.get(`agent-${bankA.id}`), bankA.id);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // The failed request is terminal: a retry with healthy stores finishes the job and receipts.
    const retry = await erase(resolved.value, bankA.id);
    expect(retry.ok && retry.value.state).toBe("receipted");
    expect(retry.ok && retry.value.requestedBy).toBe(`agent-${bankA.id}`);
    expect(await activeKeys(`agent-${bankA.id}`)).toBe(0);
    expect(await rowsFor(db, bankA.id)).toEqual({ "memory.facts": 0, "memory.episodes": 0, "memory.outbox": 0, "retrieval.pgvector_index": 0, "extraction.runs": 0, "portability.exports": 0, "governance.grants": 0 });
    expect((await new PgBankRepository(db.pool).get(bankA.id))?.status).toBe("erased");
  });

  it("a store that still reports data after purge fails verification closed: no receipt, hits recorded", async () => {
    const sticky: ErasableStore = { count: async () => ({ "engine.sticky": 2 }), purge: async () => ({ "engine.sticky": 2 }) };
    // Appended after the access store only to provoke a re-count failure; production lists keep the access store last.
    const r = await erase(eraser(bankA.id), bankA.id, { stores: [...stores, sticky] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("failed");
    expect(r.value.failure).toBe("verification failed: engine.sticky still report data");
    expect(r.value.receipt).toBeUndefined();
    expect(r.value.verifications.find((v) => v.store === "engine.sticky")?.hitsAfter).toBe(2);
    expect(r.value.verifications.find((v) => v.store === "memory.facts")?.hitsAfter).toBe(0);
    expect((await new PgBankRepository(db.pool).get(bankA.id))?.status).toBe("erasing");
    // A re-count failure comes after the access store ran: the grants are gone, so a retry needs an operator to grant `erase` again.
    expect((await rowsFor(db, bankA.id))["governance.grants"]).toBe(0);
    expect(await activeKeys(`agent-${bankA.id}`)).toBe(0);
    const erasureEntries = (await audit.list(tenant)).filter((e) => e.action.startsWith("erasure."));
    expect(erasureEntries.map((e) => e.action)).toEqual(["erasure.requested", "erasure.access_revoked", "erasure.deleted", "erasure.failed"]);
    expect(erasureEntries[3]?.details).toEqual({ requestId: r.value.id, kind: "VerificationFailed", stores: ["engine.sticky"] });
  });

  it("if the audit entry cannot be written, the request is not even recorded, nothing is deleted and the bank is not frozen", async () => {
    const deaf: AuditLogStore = {
      append: async () => {
        throw new Error("audit store down");
      },
      list: async () => [],
      find: async () => undefined,
    };
    const deafUow: ErasureUnitOfWork = { run: (work) => uow.run((tx) => work({ requests: tx.requests, audit: deaf })) };
    const before = await rowsFor(db, bankA.id);
    await expect(handler({ uow: deafUow }).handle(eraser(bankA.id), bankA.id)).rejects.toThrow("audit store down");
    expect(await requestsOf(bankA.id)).toEqual([]);
    expect(await rowsFor(db, bankA.id)).toEqual(before);
    expect((await new PgBankRepository(db.pool).get(bankA.id))?.status).toBe("active");
    // The bank is not blocked for a later, healthy attempt.
    expect((await handler().handle(eraser(bankA.id), bankA.id)).ok).toBe(true);
  });

  it("a write that started before the freeze cannot survive the receipt: the freeze waits for it", async () => {
    // A writer holds the bank row FOR SHARE inside its transaction; beginErasure's FOR UPDATE blocks until it commits.
    const writer = await db.pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT * FROM memory.banks WHERE id = $1 FOR SHARE", [bankA.id]);
      // Enqueueing never touches the bank row, so it does not wait; the worker's freeze does.
      const queued = await handler().handle(eraser(bankA.id), bankA.id);
      if (!queued.ok) throw new Error("setup");
      let erasureDone = false;
      const erasure = worker().processNext().then((outcome) => {
        erasureDone = true;
        return outcome;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(erasureDone).toBe(false);
      // Any row the writer adds now is inserted before the freeze and so is in the inventory.
      await writer.query("SET LOCAL mem.erasure = 'on'");
      await writer.query("INSERT INTO memory.episodes (id, bank_id, kind, source, text, occurred_at, recorded_at, recorded_by) VALUES ($1, $2, 'system_note', 'late', 'late write', now(), now(), 'alice')", [randomUUID(), bankA.id]);
      await writer.query("COMMIT");
      expect(await erasure).toBe("receipted");
      const r = (await requests.get(queued.value.id))!;
      expect(r.state).toBe("receipted");
      expect(r.inventory.find((i) => i.store === "memory.episodes")?.countBefore).toBe(3);
      expect((await rowsFor(db, bankA.id))["memory.episodes"]).toBe(0);
    } finally {
      writer.release();
    }
  });

  it("refuses a second erasure while one is in flight, at the database", async () => {
    const inFlight = requestErasure({ id: randomUUID(), tenantId: tenant, bankId: bankA.id, subjectId: bankA.subjectId, requestedBy: alice, requestedAt: new Date() });
    await requests.create(inFlight);
    await expect(requests.create({ ...inFlight, id: randomUUID() })).rejects.toBeInstanceOf(ErasureInFlightError);
    // Another worker pass holds it (a fresh claim): this one's worker leaves it alone.
    const held = await requests.claimNext({ staleAfterMs: 60_000 });
    expect(held?.request.id).toBe(inFlight.id);
    expect(await worker().processNext()).toBe("idle");
    const before = await rowsFor(db, bankA.id);
    const r = await handler().handle(eraser(bankA.id), bankA.id);
    expect(r).toEqual({ ok: false, error: { kind: "ErasureInFlight", bankId: bankA.id } });
    expect(await rowsFor(db, bankA.id)).toEqual(before);
    expect((await audit.list(tenant)).some((e) => e.action.startsWith("erasure."))).toBe(false);
    // Another bank is not blocked, and draining it does not touch the held request.
    const other = await erase(eraser(bankB.id), bankB.id);
    expect(other.ok && other.value.state).toBe("receipted");
    expect((await requests.get(inFlight.id))?.state).toBe("requested");

    // Recovery: an operator abandons the stuck request (audited, nothing deleted), then a new erasure succeeds.
    const abandon = new AbandonErasureHandler(scopeAccessPolicy, requests, uow, systemClock);
    expect((await abandon.handle(eraser(bankA.id, new Set(["read"])), bankA.id, inFlight.id, "x")).ok).toBe(false);
    expect(await abandon.handle(eraser(bankB.id), bankB.id, inFlight.id, "x")).toEqual({ ok: false, error: { kind: "ErasureNotFound", requestId: inFlight.id } });
    // A request that changed moments ago is presumed still running.
    const fresh = await abandon.handle(eraser(bankA.id), bankA.id, inFlight.id, "x");
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.error.kind).toBe("ErasureStillRunning");
    const abandoned = await abandon.handle(eraser(bankA.id), bankA.id, inFlight.id, "worker died", { force: true });
    expect(abandoned.ok && abandoned.value.state).toBe("failed");
    expect(abandoned.ok && abandoned.value.failure).toBe("abandoned while requested: worker died");
    expect(await abandon.handle(eraser(bankA.id), bankA.id, inFlight.id, "again")).toEqual({ ok: false, error: { kind: "ErasureTerminal", state: "failed" } });
    expect(await rowsFor(db, bankA.id)).toEqual(before);
    expect((await audit.list(tenant)).filter((e) => e.bankId === bankA.id && e.action.startsWith("erasure.")).map((e) => [e.action, e.details["kind"]])).toEqual([["erasure.failed", "Abandoned"]]);
    const retry = await erase(eraser(bankA.id), bankA.id);
    expect(retry.ok && retry.value.state).toBe("receipted");
  });

  it("a pass that died mid-purge is retaken once its claim is stale and finished from where it stopped; a fresh or heartbeating claim is left alone", async () => {
    // Pass 1 runs to `inventoried` with Memory purged and saved, purges pgvector but dies before saving it: nothing else lands, its claim stays on the row.
    const queued = await handler().handle(eraser(bankA.id), bankA.id);
    if (!queued.ok) throw new Error("setup");
    const pass1 = await requests.claimNext({ staleAfterMs: 60_000 });
    if (!pass1) throw new Error("setup");
    let partial = await driveTo(pass1, "inventoried");
    for (const [name, n] of Object.entries(await memory.purge(bankA.id))) partial = unwrap(recordDeletion(partial, { store: name, deleted: n, deletedAt: new Date() }));
    await requests.save(partial, { claimToken: pass1.token });
    expect(await stores[1]!.purge(bankA.id, { id: queued.value.id })).toEqual({ "retrieval.pgvector": 3 });
    expect((await rowsFor(db, bankA.id))["retrieval.pgvector_index"]).toBe(0);

    // While the claim is fresh, no other pass touches it (a slow pass is not a dead one).
    expect(await worker().processNext()).toBe("idle");
    expect((await requests.get(queued.value.id))?.state).toBe("inventoried");
    // A save with the live token is a heartbeat: an old claim that just landed a step is not stale either.
    await backdateClaim(queued.value.id);
    await requests.save(partial, { claimToken: pass1.token });
    expect(await requests.claimNext({ staleAfterMs: 60_000 })).toBeUndefined();

    // Once it is stale, the next pass retakes it: Memory (already recorded) is not purged or counted twice, pgvector (purged
    // but never saved) is purged again and records 0 against its countBefore of 3, the other stores are purged, verification
    // and the receipt follow, and the row records the second claim.
    await backdateClaim(queued.value.id);
    expect(await worker().processNext()).toBe("receipted");
    const done = (await requests.get(queued.value.id))!;
    expect(done.state).toBe("receipted");
    expect(await claimOf(done.id)).toMatchObject({ attempts: 2 });
    expect((await claimOf(done.id)).claim_token).not.toBe(pass1.token);
    expect(done.deletions.map((d) => d.store)).toEqual(done.inventory.map((i) => i.store));
    expect(Object.fromEntries(done.deletions.map((d) => [d.store, d.deleted]))).toEqual({ ...Object.fromEntries(done.inventory.map((i) => [i.store, i.countBefore])), "retrieval.pgvector": 0 });
    expect(done.inventory.find((i) => i.store === "retrieval.pgvector")?.countBefore).toBe(3);
    expect(await rowsFor(db, bankA.id)).toEqual({ "memory.facts": 0, "memory.episodes": 0, "memory.outbox": 0, "retrieval.pgvector_index": 0, "extraction.runs": 0, "portability.exports": 0, "governance.grants": 0 });
    expect((await new PgBankRepository(db.pool).get(bankA.id))?.status).toBe("erased");
    expect(await erasureActions(bankA.id)).toEqual(FULL_RUN);
    expect(verifyChain(await audit.list(tenant), sha256)).toBeUndefined();

    // The dead pass wakes up and tries to save: its claim is gone, the retaker's row is untouched.
    await expect(requests.save(partial, { claimToken: pass1.token })).rejects.toBeInstanceOf(ErasureNotInFlightError);
  });

  it("a re-purge of the access store (a pass died after revoking, before saving) revokes nothing more but still names every principal this request revoked", async () => {
    const queued = await handler().handle(eraser(bankA.id), bankA.id);
    if (!queued.ok) throw new Error("setup");
    const access = stores[stores.length - 1]!;
    const first = await access.purge(bankA.id, { id: queued.value.id });
    expect(first).toEqual({ "governance.grants": 3, "governance.api_keys": { deleted: 2, evidence: { revokedPrincipals: [`agent-${bankA.id}`, "lapsed"] } } });
    const again = await access.purge(bankA.id, { id: queued.value.id });
    expect(again).toEqual({ "governance.grants": 0, "governance.api_keys": { deleted: 0, evidence: { revokedPrincipals: [`agent-${bankA.id}`, "lapsed"] } } });
    // Another request's purge would not claim them: the marker is per request.
    expect(await access.purge(bankA.id, { id: randomUUID() })).toEqual({ "governance.grants": 0, "governance.api_keys": { deleted: 0, evidence: { revokedPrincipals: [] } } });
  });

  it("a pass that died at `deleted`, or at `verified` after the tombstone, is finished by the next pass without repeating a step", async () => {
    const a = await handler().handle(eraser(bankA.id), bankA.id);
    const b = await handler().handle(eraser(bankB.id), bankB.id);
    if (!a.ok || !b.ok) throw new Error("setup");
    const passA = await requests.claimNext({ staleAfterMs: 60_000 });
    const passB = await requests.claimNext({ staleAfterMs: 60_000 });
    if (!passA || !passB) throw new Error("setup");
    await driveTo(passA, "deleted");
    await driveTo(passB, "tombstoned");
    expect((await new PgBankRepository(db.pool).get(bankB.id))?.status).toBe("erased");
    await backdateClaim(a.value.id);
    await backdateClaim(b.value.id);
    const w = worker();
    expect(await w.processNext()).toBe("receipted");
    expect(await w.processNext()).toBe("receipted");
    expect(await w.processNext()).toBe("idle");
    for (const [bank, queued] of [[bankA, a.value], [bankB, b.value]] as const) {
      const done = (await requests.get(queued.id))!;
      expect(done.state).toBe("receipted");
      expect(done.verifications.every((v) => v.hitsAfter === 0)).toBe(true);
      expect(Object.fromEntries(done.deletions.map((d) => [d.store, d.deleted]))).toEqual(Object.fromEntries(done.inventory.map((i) => [i.store, i.countBefore])));
      expect((await new PgBankRepository(db.pool).get(bank.id))?.status).toBe("erased");
      // The hand-driven pass wrote no audit entries past `requested` (a real pass writes them with its saves); the resumed pass wrote only the steps it ran.
      expect(await erasureActions(bank.id)).toEqual(bank === bankA ? ["erasure.requested", "erasure.verified", "erasure.receipt_issued"] : ["erasure.requested", "erasure.receipt_issued"]);
    }
    expect(verifyChain(await audit.list(tenant), sha256)).toBeUndefined();
  });

  it("a pass that is retaken while running stops as `lost` without marking anything, whether its next save or its failure save loses; drain goes on", async () => {
    // A store that, while purging, lets another pass retake the request (the claim went stale under it): the pass's next save is refused.
    const thief = (throwAfter: boolean): ErasableStore => ({
      count: async () => ({ "engine.thief": 0 }),
      purge: async (bankId) => {
        const id = (await db.pool.query<{ id: string }>("SELECT id FROM governance.erasure_requests WHERE bank_id = $1 AND state NOT IN ('receipted', 'failed')", [bankId])).rows[0]!.id;
        await backdateClaim(id);
        expect((await requests.claimNext({ staleAfterMs: 60_000 }))?.request.id).toBe(id);
        if (throwAfter) throw new Error("engine down after the retake");
        return { "engine.thief": 0 };
      },
    });
    const a = await handler().handle(eraser(bankA.id), bankA.id);
    if (!a.ok) throw new Error("setup");
    const quiet = worker({ stores: [memory, thief(false), ...stores.slice(1)] });
    expect(await quiet.processNext()).toBe("lost");
    expect((await requests.get(a.value.id))?.state).toBe("inventoried");
    expect(await erasureActions(bankA.id)).toEqual(["erasure.requested"]);

    const b = await handler().handle(eraser(bankB.id), bankB.id);
    if (!b.ok) throw new Error("setup");
    // Nothing else is claimable (A is held by the thief's retake), so drain processes B only, and the lost pass does not make it throw.
    const loud = worker({ stores: [memory, thief(true), ...stores.slice(1)] });
    expect(await loud.drain()).toBe(1);
    expect((await requests.get(b.value.id))?.state).toBe("inventoried");
    expect(await erasureActions(bankB.id)).toEqual(["erasure.requested"]);

    // The retakers (here: later passes with healthy stores) finish both.
    await backdateClaim(a.value.id);
    await backdateClaim(b.value.id);
    const healthy = worker({ stores: [memory, { count: async () => ({ "engine.thief": 0 }), purge: async () => ({ "engine.thief": 0 }) }, ...stores.slice(1)] });
    expect(await healthy.drain()).toBe(2);
    expect((await requests.get(a.value.id))?.state).toBe("receipted");
    expect((await requests.get(b.value.id))?.state).toBe("receipted");
    expect(verifyChain(await audit.list(tenant), sha256)).toBeUndefined();
  });

  it("a stopping worker hands its row back at the next step and claims nothing more; the next pass resumes at once", async () => {
    const a = await handler().handle(eraser(bankA.id), bankA.id);
    const b = await handler().handle(eraser(bankB.id), bankB.id);
    if (!a.ok || !b.ok) throw new Error("setup");
    let w: ErasureWorker;
    // Memory purges, then the shutdown signal arrives: the pass releases before the next store.
    const stopper: ErasableStore = { count: async () => ({ "engine.stopper": 0 }), purge: async () => { w.stop(); return { "engine.stopper": 0 }; } };
    w = worker({ stores: [memory, stopper, ...stores.slice(1)] });
    expect(await w.drain()).toBe(0);
    const released = (await requests.get(a.value.id))!;
    expect(released.state).toBe("inventoried");
    expect(released.deletions.map((d) => d.store)).toEqual(["memory.facts", "memory.episodes", "memory.outbox", "engine.stopper"]);
    expect(await claimOf(a.value.id)).toEqual({ claim_token: null, claimed_at: null, attempts: 0 });
    expect((await requests.get(b.value.id))?.state).toBe("requested");
    expect(await claimOf(b.value.id)).toMatchObject({ claim_token: null });
    expect(await w.processNext()).toBe("idle");
    // A fresh worker (the restarted server) picks it up without waiting for the stale window.
    const next = worker({ stores: [memory, { count: async () => ({ "engine.stopper": 0 }), purge: async () => ({ "engine.stopper": 0 }) }, ...stores.slice(1)] });
    expect(await next.drain()).toBe(2);
    expect((await requests.get(a.value.id))?.state).toBe("receipted");
    expect(await claimOf(a.value.id)).toMatchObject({ attempts: 1 });
    expect((await requests.get(b.value.id))?.state).toBe("receipted");
    expect(await erasureActions(bankA.id)).toEqual(FULL_RUN);
  });

  it("a pass that died during the freeze is retaken from `requested`; a request that keeps killing its worker ends failed after the attempt limit, and a late save of a lost claim is refused", async () => {
    // A claim older than the stale window on a still-`requested` row: the retaker starts over (freeze, inventory, ...).
    const queued = await handler().handle(eraser(bankA.id), bankA.id);
    if (!queued.ok) throw new Error("setup");
    const dead = await requests.claimNext({ staleAfterMs: 60_000 });
    await backdateClaim(queued.value.id);
    expect(await worker().processNext()).toBe("receipted");
    expect((await requests.get(queued.value.id))?.state).toBe("receipted");
    expect(await claimOf(queued.value.id)).toMatchObject({ attempts: 2 });
    // The dead pass's late step: the row is terminal now.
    await expect(requests.save(dead!.request, { claimToken: dead!.token })).rejects.toBeInstanceOf(ErasureNotInFlightError);

    // Bank B: two passes died (stale claims), the third retake is over the limit: the worker marks the request failed with a
    // `StaleClaim` entry instead of trying again, and the bank stays frozen for a new request.
    const queuedB = await handler().handle(eraser(bankB.id), bankB.id);
    if (!queuedB.ok) throw new Error("setup");
    const first = await requests.claimNext({ staleAfterMs: 60_000 });
    await db.pool.query("UPDATE governance.erasure_requests SET attempts = 2, claimed_at = claimed_at - interval '1 hour' WHERE id = $1", [queuedB.value.id]);
    // Meanwhile a live retake happened: the first pass's save is refused as a lost claim (the row is still in flight).
    const second = await requests.claimNext({ staleAfterMs: 60_000 });
    expect(second?.request.id).toBe(queuedB.value.id);
    await expect(requests.save(first!.request, { claimToken: first!.token })).rejects.toBeInstanceOf(ErasureClaimLostError);
    await db.pool.query("UPDATE governance.erasure_requests SET claimed_at = claimed_at - interval '1 hour' WHERE id = $1", [queuedB.value.id]);
    expect(await worker({ maxAttempts: 3 }).processNext()).toBe("failed");
    const failed = (await requests.get(queuedB.value.id))!;
    expect(failed.state).toBe("failed");
    expect(failed.failure).toBe("abandoned by the worker after 3 stale claim(s) while requested");
    expect(await claimOf(failed.id)).toMatchObject({ attempts: 4 });
    expect((await audit.list(tenant)).filter((e) => e.bankId === bankB.id && e.action.startsWith("erasure.")).map((e) => [e.action, e.details["kind"]])).toEqual([["erasure.requested", undefined], ["erasure.failed", "StaleClaim"]]);
    expect((await rowsFor(db, bankB.id))["memory.facts"]).toBe(1);
    // A new request finishes the job.
    const retry = await erase(eraser(bankB.id), bankB.id);
    expect(retry.ok && retry.value.state).toBe("receipted");
  });

  it("two workers draining at once process each request exactly once", async () => {
    const a = await handler().handle(eraser(bankA.id), bankA.id);
    const b = await handler().handle(eraser(bankB.id), bankB.id);
    if (!a.ok || !b.ok) throw new Error("setup");
    const [n1, n2] = await Promise.all([worker().drain(), worker().drain()]);
    expect(n1 + n2).toBe(2);
    expect((await requests.get(a.value.id))?.state).toBe("receipted");
    expect((await requests.get(b.value.id))?.state).toBe("receipted");
    const entries = await audit.list(tenant);
    expect(verifyChain(entries, sha256)).toBeUndefined();
    for (const bank of [bankA, bankB]) {
      expect(entries.filter((e) => e.bankId === bank.id && e.action.startsWith("erasure.")).map((e) => e.action)).toEqual(["erasure.requested", "erasure.access_revoked", "erasure.deleted", "erasure.verified", "erasure.receipt_issued"]);
    }
  });

  it("a late step of an abandoned workflow cannot resurrect the request", async () => {
    // Simulate: the workflow has reached `inventoried`, the operator abandons, the workflow's next save arrives.
    const inFlight = requestErasure({ id: randomUUID(), tenantId: tenant, bankId: bankA.id, subjectId: bankA.subjectId, requestedBy: alice, requestedAt: new Date() });
    await requests.create(inFlight);
    // Backdate the row so it is stale under the default grace period. (`updated_at` is written with Postgres
    // now() while the handler compares against the Node clock; a zero grace period would flake on clock order.)
    await db.pool.query("UPDATE governance.erasure_requests SET updated_at = now() - interval '1 hour' WHERE id = $1", [inFlight.id]);
    const abandon = new AbandonErasureHandler(scopeAccessPolicy, requests, uow, systemClock);
    expect((await abandon.handle(eraser(bankA.id), bankA.id, inFlight.id, "gone")).ok).toBe(true);
    const late = recordInventory(inFlight, [{ store: "memory.facts", countBefore: 1 }]);
    if (!late.ok) throw new Error("setup");
    await expect(requests.save(late.value)).rejects.toBeInstanceOf(ErasureNotInFlightError);
    expect((await requests.get(inFlight.id))?.state).toBe("failed");
    // Repository reads are bank- and tenant-scoped when asked.
    expect(await requests.get(inFlight.id, { bankId: bankB.id, tenantId: tenant })).toBeUndefined();
    expect(await requests.get(inFlight.id, { bankId: bankA.id, tenantId: asTenantId("t2") })).toBeUndefined();
  });

  it("status reads need erase on the request's own bank; other banks and tenants see not-found", async () => {
    const r = await erase(eraser(bankA.id), bankA.id);
    if (!r.ok) throw new Error("setup");
    const get = new GetErasureHandler(scopeAccessPolicy, requests);
    expect((await get.handle(eraser(bankA.id), bankA.id, r.value.id)).ok).toBe(true);
    expect((await get.handle(eraser(bankA.id, new Set(["read", "write"])), bankA.id, r.value.id)).ok).toBe(false);
    expect(await get.handle(eraser(bankB.id), bankB.id, r.value.id)).toEqual({ ok: false, error: { kind: "ErasureNotFound", requestId: r.value.id } });
    expect(await get.handle({ ...eraser(bankA.id), tenantId: asTenantId("t2") }, bankA.id, r.value.id)).toEqual({ ok: false, error: { kind: "ErasureNotFound", requestId: r.value.id } });
    expect(await get.handle(eraser(bankA.id), bankA.id, randomUUID())).toMatchObject({ ok: false });
  });

  it("requires the erase capability (admin implies it), the bank must exist and belong to the scope's tenant; denials touch nothing", async () => {
    const before = await rowsFor(db, bankA.id);
    const denied = await handler().handle(eraser(bankA.id, new Set(["read", "write"])), bankA.id);
    expect(denied).toEqual({ ok: false, error: { kind: "AccessDenied", bankId: bankA.id, required: "erase" } });
    const crossBank = await handler().handle(eraser(bankB.id), bankA.id);
    expect(crossBank.ok).toBe(false);
    const foreignTenant = await handler().handle({ ...eraser(bankA.id), tenantId: asTenantId("t2") }, bankA.id);
    expect(foreignTenant).toEqual({ ok: false, error: { kind: "AccessDenied", bankId: bankA.id, required: "erase" } });
    const ghost = asBankId("ghost");
    expect(await handler().handle(eraser(ghost), ghost)).toEqual({ ok: false, error: { kind: "BankNotFound" } });
    expect(await rowsFor(db, bankA.id)).toEqual(before);
    expect(await requestsOf(bankA.id)).toEqual([]);

    const asAdmin = await erase(eraser(bankA.id, new Set(["admin"])), bankA.id);
    expect(asAdmin.ok && asAdmin.value.state).toBe("receipted");
    expect(asAdmin.ok && asAdmin.value.requestedBy).toBe(asPrincipalId("alice"));
  });

  it("refuses a bank whose recorded engine no wired store purges, before anything is written; the engine is re-checked under the freeze", async () => {
    const banks = new PgBankRepository(db.pool);
    expect(await memory.describe(bankA.id)).toEqual({ tenantId: tenant, subjectId: bankA.subjectId, engine: "pgvector", status: "active" });
    await banks.update(switchEngine((await banks.get(bankA.id))!, "honcho"));
    const before = await rowsFor(db, bankA.id);
    const r = await handler().handle(eraser(bankA.id), bankA.id);
    expect(r).toEqual({ ok: false, error: { kind: "EngineMismatch", bankEngine: "honcho", serverEngines: ["pgvector"] } });
    expect(await requestsOf(bankA.id)).toEqual([]);
    expect(await rowsFor(db, bankA.id)).toEqual(before);
    expect((await banks.get(bankA.id))?.status).toBe("active");
    expect((await audit.list(tenant)).some((e) => e.action.startsWith("erasure."))).toBe(false);

    // The bank moves between the pre-check and the freeze (a concurrent reindex): the freeze's locked re-read catches it and the request fails.
    await banks.update(switchEngine((await banks.get(bankA.id))!, "pgvector"));
    const racing = { ...memory, describe: memory.describe.bind(memory), completeErasure: memory.completeErasure.bind(memory), count: memory.count.bind(memory), purge: memory.purge.bind(memory),
      beginErasure: async (id: BankId) => { await banks.update(switchEngine((await banks.get(id))!, "honcho")); return memory.beginErasure(id); } };
    const raced = await erase(eraser(bankA.id), bankA.id, { bank: racing });
    expect(raced.ok && raced.value.state).toBe("failed");
    expect(raced.ok && raced.value.failure).toBe("freeze failed (EngineMismatch)");
    expect(raced.ok && raced.value.deletions).toEqual([]);
    expect((await rowsFor(db, bankA.id))["memory.facts"]).toBe(1);
    expect((await audit.list(tenant)).filter((e) => e.action.startsWith("erasure.")).map((e) => [e.action, e.details["kind"]])).toEqual([["erasure.requested", undefined], ["erasure.failed", "EngineMismatch"]]);

    // A process whose wired engine store is the one the bank records is accepted: the engine name comes from the store itself, never from a parallel setting.
    const honcho: ErasableStore = { engine: "honcho", count: async () => ({ "retrieval.honcho": 0 }), purge: async () => ({ "retrieval.honcho": 0 }) };
    const ok = await erase(eraser(bankA.id), bankA.id, { stores: [memory, honcho, ...stores.slice(2)] });
    expect(ok.ok && ok.value.state).toBe("receipted");
    expect(ok.ok && ok.value.inventory.map((i) => i.store)).toContain("retrieval.honcho");
  });

  it("the append-only triggers still refuse deletes outside the erasure transaction", async () => {
    await expect(db.pool.query("DELETE FROM memory.facts WHERE bank_id = $1", [bankA.id])).rejects.toThrow(/only be deleted during erasure/);
    await expect(db.pool.query("DELETE FROM memory.episodes WHERE bank_id = $1", [bankA.id])).rejects.toThrow(/only be deleted during erasure/);
    expect((await rowsFor(db, bankA.id))["memory.facts"]).toBe(1);
  });
});
