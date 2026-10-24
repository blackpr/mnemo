import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asBankId, asEpisodeId, asFactId, asPrincipalId, asTenantId, systemClock, type BankId, type Scope } from "../../src/shared-kernel/index.js";
import {
  AbandonErasureHandler,
  EraseBankHandler,
  ErasureInFlightError,
  ErasureNotInFlightError,
  generateApiKey,
  GetErasureHandler,
  PgAccessRevocation,
  PgApiKeyStore,
  PgAuditLog,
  PgErasureRequestRepository,
  PgErasureUnitOfWork,
  PgPrincipalRepository,
  recordInventory,
  requestErasure,
  ScopeResolver,
  scopeAccessPolicy,
  verifyChain,
  verifyReceipt,
  type AuditLogStore,
  type ErasableStore,
  type ErasureUnitOfWork,
} from "../../src/governance/index.js";
import { sha256 } from "../../src/platform/hash.js";
import { AssertFactHandler, PgBankRepository, PgEpisodeRepository, PgFactRepository, PgMemoryErasure, PgOutboxRelay, PgUnitOfWork, RecallHandler, RecordEpisodeHandler } from "../../src/memory/index.js";
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
  const handler = (opts: { stores?: readonly ErasableStore[]; uow?: ErasureUnitOfWork } = {}) =>
    new EraseBankHandler(scopeAccessPolicy, memory, opts.uow ?? uow, opts.stores ?? stores, systemClock, randomUUID, sha256);
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

    const r = await handler().handle(eraser(bankA.id), bankA.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const request = r.value;
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
    expect(stored).toEqual({ ...request, updatedAt: expect.any(Date) });
    expect(stored?.receipt && verifyReceipt(stored.receipt, sha256)).toBe(true);
    expect(stored?.receipt?.digest).toMatch(/^[0-9a-f]{64}$/);
    const entries = await audit.list(tenant);
    expect(entries.length).toBeGreaterThan(auditBefore);
    expect(verifyChain(entries, sha256)).toBeUndefined();
    const erasureEntries = entries.filter((e) => e.action.startsWith("erasure."));
    expect(erasureEntries.map((e) => e.action)).toEqual(["erasure.requested", "erasure.access_revoked", "erasure.deleted", "erasure.verified", "erasure.receipt_issued"]);
    expect(erasureEntries[0]?.details).toEqual({ requestId: request.id, subjectId: bankA.subjectId });
    expect(erasureEntries[1]?.details).toEqual({ requestId: request.id, "deleted.governance.grants": 3, "deleted.governance.api_keys": 2 });
    expect(erasureEntries[2]?.details).toMatchObject({ requestId: request.id, "deleted.memory.facts": 1, "deleted.memory.episodes": 2, "deleted.retrieval.pgvector": 3, "deleted.governance.grants": 3, "deleted.governance.api_keys": 2 });
    expect(erasureEntries[4]?.details["digest"]).toBe(request.receipt?.digest);
    expect(request.receipt).toMatchObject({ tenantId: tenant, bankId: bankA.id, subjectId: bankA.subjectId });
    expect(request.receipt?.deletions).toEqual(request.deletions);
    // A receipt with any signed field altered no longer verifies.
    expect(verifyReceipt({ ...stored!.receipt!, bankId: bankB.id }, sha256)).toBe(false);
    expect(JSON.stringify(entries)).not.toContain("Lisbon");
    // The audit entry was written before the first deletion.
    expect(entries.findIndex((e) => e.action === "erasure.requested")).toBe(auditBefore);

    // An erased bank can be erased again: a fresh pass proves zero and issues a new receipt.
    const again = await handler().handle(eraser(bankA.id), bankA.id);
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
    const r = await handler({ stores: [memory, broken, ...stores.slice(1)] }).handle(eraser(bankA.id), bankA.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("failed");
    // Step and error kind only: the store's message (which may echo content) never leaves the process log.
    expect(r.value.failure).toBe("purge of store 2 of 6 failed (Error)");
    expect(r.value.receipt).toBeUndefined();
    expect(Object.fromEntries(r.value.deletions.map((d) => [d.store, d.deleted]))).toEqual({ "memory.facts": 1, "memory.episodes": 2, "memory.outbox": 3 });
    expect(r.value.inventory.map((i) => i.store)).toContain("engine.broken");
    expect(await requests.get(r.value.id)).toEqual({ ...r.value, updatedAt: expect.any(Date) });

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
    const retry = await handler().handle(resolved.value, bankA.id);
    expect(retry.ok && retry.value.state).toBe("receipted");
    expect(retry.ok && retry.value.requestedBy).toBe(`agent-${bankA.id}`);
    expect(await activeKeys(`agent-${bankA.id}`)).toBe(0);
    expect(await rowsFor(db, bankA.id)).toEqual({ "memory.facts": 0, "memory.episodes": 0, "memory.outbox": 0, "retrieval.pgvector_index": 0, "extraction.runs": 0, "portability.exports": 0, "governance.grants": 0 });
    expect((await new PgBankRepository(db.pool).get(bankA.id))?.status).toBe("erased");
  });

  it("a store that still reports data after purge fails verification closed: no receipt, hits recorded", async () => {
    const sticky: ErasableStore = { count: async () => ({ "engine.sticky": 2 }), purge: async () => ({ "engine.sticky": 2 }) };
    // Appended after the access store only to provoke a re-count failure; production lists keep the access store last.
    const r = await handler({ stores: [...stores, sticky] }).handle(eraser(bankA.id), bankA.id);
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
      let erasureDone = false;
      const erasure = handler().handle(eraser(bankA.id), bankA.id).then((r) => {
        erasureDone = true;
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(erasureDone).toBe(false);
      // Any row the writer adds now is inserted before the freeze and so is in the inventory.
      await writer.query("SET LOCAL mem.erasure = 'on'");
      await writer.query("INSERT INTO memory.episodes (id, bank_id, kind, source, text, occurred_at, recorded_at, recorded_by) VALUES ($1, $2, 'system_note', 'late', 'late write', now(), now(), 'alice')", [randomUUID(), bankA.id]);
      await writer.query("COMMIT");
      const r = await erasure;
      expect(r.ok && r.value.state).toBe("receipted");
      expect(r.ok && r.value.inventory.find((i) => i.store === "memory.episodes")?.countBefore).toBe(3);
      expect((await rowsFor(db, bankA.id))["memory.episodes"]).toBe(0);
    } finally {
      writer.release();
    }
  });

  it("refuses a second erasure while one is in flight, at the database", async () => {
    const inFlight = requestErasure({ id: randomUUID(), tenantId: tenant, bankId: bankA.id, subjectId: bankA.subjectId, requestedBy: alice, requestedAt: new Date() });
    await requests.create(inFlight);
    await expect(requests.create({ ...inFlight, id: randomUUID() })).rejects.toBeInstanceOf(ErasureInFlightError);
    const before = await rowsFor(db, bankA.id);
    const r = await handler().handle(eraser(bankA.id), bankA.id);
    expect(r).toEqual({ ok: false, error: { kind: "ErasureInFlight", bankId: bankA.id } });
    expect(await rowsFor(db, bankA.id)).toEqual(before);
    expect((await audit.list(tenant)).some((e) => e.action.startsWith("erasure."))).toBe(false);
    // Another bank is not blocked.
    const other = await handler().handle(eraser(bankB.id), bankB.id);
    expect(other.ok && other.value.state).toBe("receipted");

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
    const retry = await handler().handle(eraser(bankA.id), bankA.id);
    expect(retry.ok && retry.value.state).toBe("receipted");
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
    const r = await handler().handle(eraser(bankA.id), bankA.id);
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

    const asAdmin = await handler().handle(eraser(bankA.id, new Set(["admin"])), bankA.id);
    expect(asAdmin.ok && asAdmin.value.state).toBe("receipted");
    expect(asAdmin.ok && asAdmin.value.requestedBy).toBe(asPrincipalId("alice"));
  });

  it("the append-only triggers still refuse deletes outside the erasure transaction", async () => {
    await expect(db.pool.query("DELETE FROM memory.facts WHERE bank_id = $1", [bankA.id])).rejects.toThrow(/only be deleted during erasure/);
    await expect(db.pool.query("DELETE FROM memory.episodes WHERE bank_id = $1", [bankA.id])).rejects.toThrow(/only be deleted during erasure/);
    expect((await rowsFor(db, bankA.id))["memory.facts"]).toBe(1);
  });
});
