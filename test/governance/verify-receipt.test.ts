import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asEpisodeId, asPrincipalId, asSubjectId, systemClock, type BankId, type Scope } from "../../src/shared-kernel/index.js";
import { PgAuditLog, PgErasureRequestRepository, receiptPayload, VerifyReceiptHandler, scopeAccessPolicy, type AuditLogStore, type ErasableStore, type ReceiptVerification } from "../../src/governance/index.js";
import { sha256 } from "../../src/platform/hash.js";
import { generateApiKey, PgApiKeyStore, PgPrincipalRepository } from "../../src/governance/index.js";
import { PgBankRepository, PgUnitOfWork, RecordEpisodeHandler } from "../../src/memory/index.js";
import { EngineErasableStore, HashingEmbedder, PgvectorEngine } from "../../src/retrieval/index.js";
import { PgExportStore } from "../../src/portability/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { eraseNow, erasureDeps } from "../helpers/erasure.js";
import { alice, bankFixture, scopeFor, tenant } from "../helpers/fixtures.js";

describeWithDb("VerifyReceipt", () => {
  let db: TestDb;
  let deps: ReturnType<typeof erasureDeps>;
  let requests: PgErasureRequestRepository;
  const bankA = bankFixture("bank-a");
  const eraser = (bankId: BankId): Scope => ({ tenantId: tenant, bankId, principalId: alice, capabilities: new Set(["erase"]) });
  const verifier = (stores: readonly ErasableStore[] = deps.stores, audit: AuditLogStore = new PgAuditLog(db.pool)) => new VerifyReceiptHandler(requests, audit, deps.bank, stores, sha256);
  const verify = async (id: string, stores?: readonly ErasableStore[], audit?: AuditLogStore): Promise<ReceiptVerification> => {
    const r = await verifier(stores, audit).handle(id);
    if (!r.ok) throw new Error(r.error.kind);
    return r.value;
  };
  const erase = async (bankId: BankId = bankA.id, stores: readonly ErasableStore[] = deps.stores) => {
    const r = await eraseNow({ ...deps, stores }, eraser(bankId), bankId);
    if (!r.ok) throw new Error(r.error.kind);
    return r.value;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    deps = erasureDeps(db.pool, new PgvectorEngine(db.pool, new HashingEmbedder(256)));
    requests = new PgErasureRequestRepository(db.pool);
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.truncateAll();
    await new PgBankRepository(db.pool).create(bankA);
    const r = await new RecordEpisodeHandler(new PgUnitOfWork(db.pool), scopeAccessPolicy, systemClock).handle(scopeFor(bankA.id), { id: asEpisodeId(randomUUID()), bankId: bankA.id, kind: "conversation_turn", source: "test", role: "user", text: "I moved to Lisbon", occurredAt: new Date() });
    if (!r.ok) throw new Error(r.error.kind);
  });

  it("passes for a receipted request whose stores all still report zero, and fails when any store has data again or the receipt was tampered with", async () => {
    const receipted = await erase();
    const v = await verify(receipted.id);
    expect(v).toMatchObject({ requestId: receipted.id, bankId: bankA.id, tenantId: tenant, subjectId: bankA.subjectId, digest: receipted.receipt?.digest, digestValid: true, bound: true, chained: true, chainIntact: true, bankStatus: "erased", bankErased: true, ok: true });
    expect(v.chainBrokenAt).toBeUndefined();
    expect(v.stores.map((s) => s.store).sort()).toEqual(receipted.receipt!.stores.map((s) => s.store).sort());
    expect(v.stores.every((s) => s.ok && s.receipted === 0 && s.now === 0 && s.note === undefined)).toBe(true);

    // Data reappears in one store (an export ledger row for the erased bank): that store and the whole check fail, the digest still verifies.
    await new PgExportStore(db.pool).record({ id: randomUUID(), tenantId: tenant, bankId: bankA.id, principalId: alice, format: "jsonl", schemaVersion: "v1", factCount: 0, tombstoneCount: 0, bytes: 1, contentSha256: "x", producedAt: new Date() });
    const dirty = await verify(receipted.id);
    expect(dirty).toMatchObject({ ok: false, digestValid: true, bound: true, chained: true });
    expect(dirty.stores.find((s) => s.store === "portability.exports")).toEqual({ store: "portability.exports", receipted: 0, now: 1, ok: false });
    expect(dirty.stores.filter((s) => !s.ok).map((s) => s.store)).toEqual(["portability.exports"]);
    await db.pool.query("DELETE FROM portability.exports WHERE bank_id = $1", [bankA.id]);

    // A covered field altered in the stored receipt (a store's zero turned into a hit): digest invalid, that store fails, the rest still pass.
    await db.pool.query("UPDATE governance.erasure_requests SET receipt = jsonb_set(receipt, '{stores,0,hitsAfter}', '5') WHERE id = $1", [receipted.id]);
    const tampered = await verify(receipted.id);
    expect(tampered).toMatchObject({ ok: false, digestValid: false, bound: true, chained: true });
    expect(tampered.stores.filter((s) => !s.ok)).toEqual([{ store: receipted.receipt!.stores[0]!.store, receipted: 5, now: 0, ok: false }]);

    // A valid receipt recomputed over altered content (whoever can write the row can redo the unkeyed hash): the audit chain is what catches it.
    const forged = { ...receipted.receipt!, subjectId: asSubjectId("someone-else") };
    await db.pool.query("UPDATE governance.erasure_requests SET receipt = $2 WHERE id = $1", [receipted.id, JSON.stringify({ ...forged, digest: sha256(receiptPayload(forged)) })]);
    const forgedV = await verify(receipted.id);
    expect(forgedV).toMatchObject({ ok: false, digestValid: true, bound: false, chained: false });

    // A genuine receipt copied onto another request's row: internally consistent and chained for its own request, but not bound to this row.
    const receiptedB = await (async () => {
      const bankB = bankFixture("bank-b");
      await new PgBankRepository(db.pool).create(bankB);
      return erase(bankB.id);
    })();
    await db.pool.query("UPDATE governance.erasure_requests SET receipt = $2 WHERE id = $1", [receiptedB.id, JSON.stringify(receipted.receipt)]);
    expect(await verify(receiptedB.id)).toMatchObject({ ok: false, digestValid: true, bound: false, chained: false });
  });

  it("a store wired today that the receipt predates must be empty; a receipted store nobody answers for cannot pass", async () => {
    const receipted = await erase();
    const empty: ErasableStore = { count: async () => ({ "engine.later": 0 }), purge: async () => ({ "engine.later": 0 }) };
    const holding: ErasableStore = { count: async () => ({ "engine.later": 3 }), purge: async () => ({ "engine.later": 0 }) };
    const withEmpty = await verify(receipted.id, [...deps.stores, empty]);
    expect(withEmpty.ok).toBe(true);
    expect(withEmpty.stores.find((s) => s.store === "engine.later")).toEqual({ store: "engine.later", receipted: undefined, now: 0, ok: true, note: "not_in_receipt" });
    const withHolding = await verify(receipted.id, [...deps.stores, holding]);
    expect(withHolding.ok).toBe(false);
    expect(withHolding.stores.find((s) => s.store === "engine.later")).toEqual({ store: "engine.later", receipted: undefined, now: 3, ok: false, note: "not_in_receipt" });

    // Without the retrieval adapter wired, the receipted retrieval store cannot be re-queried: fail, not a silent pass.
    const partial = await verify(receipted.id, deps.stores.filter((s) => !(s instanceof EngineErasableStore)));
    expect(partial.ok).toBe(false);
    expect(partial.stores.find((s) => s.store === "retrieval.pgvector")).toEqual({ store: "retrieval.pgvector", receipted: 0, now: undefined, ok: false, note: "not_requeried" });

    // An adapter that cannot count proves nothing: its names stay not_requeried (fail), the others are still checked.
    const broken: ErasableStore = { count: async () => { throw new Error("engine unreachable"); }, purge: async () => ({}) };
    const withBroken = await verify(receipted.id, [...deps.stores.filter((s) => !(s instanceof EngineErasableStore)), broken]);
    expect(withBroken.ok).toBe(false);
    expect(withBroken.stores.find((s) => s.store === "retrieval.pgvector")?.note).toBe("not_requeried");
    expect(withBroken.stores.find((s) => s.store === "memory.facts")).toEqual({ store: "memory.facts", receipted: 0, now: 0, ok: true });

    // Two adapters answering for one name are summed: a zero from the second cannot hide a hit from the first.
    const dup = { count: async () => ({ "retrieval.pgvector": 2 }), purge: async () => ({}) } satisfies ErasableStore;
    const summed = await verify(receipted.id, [...deps.stores, dup]);
    expect(summed.ok).toBe(false);
    expect(summed.stores.find((s) => s.store === "retrieval.pgvector")).toEqual({ store: "retrieval.pgvector", receipted: 0, now: 2, ok: false });
  });

  it("the whole audit chain must verify, and the bank must be the erased tombstone", async () => {
    const receipted = await erase();
    // The table forbids UPDATE and DELETE, so a tampered chain is simulated at the store: one entry missing, one altered.
    const real = new PgAuditLog(db.pool);
    const missing: AuditLogStore = { ...real, append: real.append.bind(real), find: real.find.bind(real), list: async (t, o) => (await real.list(t, o)).filter((e) => e.seq !== 1) };
    const gap = await verify(receipted.id, undefined, missing);
    expect(gap).toMatchObject({ ok: false, chained: true, chainIntact: false, chainBrokenAt: 2, digestValid: true, bound: true, bankErased: true });
    const altered: AuditLogStore = { ...missing, list: async (t, o) => (await real.list(t, o)).map((e) => (e.seq === 0 ? { ...e, details: { ...e.details, subjectId: "someone-else" } } : e)) };
    expect(await verify(receipted.id, undefined, altered)).toMatchObject({ ok: false, chainIntact: false, chainBrokenAt: 0 });

    // A bank row that is not the tombstone fails: un-erased by hand, or gone.
    await db.pool.query("UPDATE memory.banks SET status = 'active' WHERE id = $1", [bankA.id]);
    expect(await verify(receipted.id)).toMatchObject({ ok: false, bankStatus: "active", bankErased: false, chainIntact: true });
    await db.pool.query("UPDATE memory.banks SET status = 'erased' WHERE id = $1", [bankA.id]);
    expect((await verify(receipted.id)).ok).toBe(true);
    await db.pool.query("DELETE FROM memory.banks WHERE id = $1", [bankA.id]);
    expect(await verify(receipted.id)).toMatchObject({ ok: false, bankStatus: "missing", bankErased: false });
  });

  it("the keys re-count is independent of the grants: a revoked principal's key made live again fails, a key issued to it later does not; a receipt without evidence falls back to the stateless count", async () => {
    const principals = new PgPrincipalRepository(db.pool);
    const keys = new PgApiKeyStore(db.pool);
    await principals.save({ id: asPrincipalId("dedicated"), tenantId: tenant, kind: "agent", displayName: "dedicated", grants: [{ bankId: bankA.id, capabilities: new Set(["read"]), grantedAt: new Date() }] });
    const k = generateApiKey();
    await keys.issue(asPrincipalId("dedicated"), k.hash, "t");
    const receipted = await erase();
    expect(receipted.deletions.find((d) => d.store === "governance.api_keys")).toMatchObject({ deleted: 1, evidence: { revokedPrincipals: ["dedicated"] } });
    expect((await verify(receipted.id)).stores.find((s) => s.store === "governance.api_keys")).toEqual({ store: "governance.api_keys", receipted: 0, now: 0, ok: true });

    // Grants are gone either way; only the recorded principal ids let the re-count see the resurrected key (a stateless count reads zero here).
    await db.pool.query("UPDATE governance.api_keys SET revoked_at = NULL WHERE key_hash = $1", [k.hash]);
    const resurrected = await verify(receipted.id);
    expect(resurrected.ok).toBe(false);
    expect(resurrected.stores.find((s) => s.store === "governance.api_keys")).toEqual({ store: "governance.api_keys", receipted: 0, now: 1, ok: false });
    expect(resurrected.stores.find((s) => s.store === "governance.grants")).toEqual({ store: "governance.grants", receipted: 0, now: 0, ok: true });
    await db.pool.query("UPDATE governance.api_keys SET revoked_at = now() WHERE key_hash = $1", [k.hash]);

    // The principal id is reused later for another bank with a new key: not revoked by this request, not what the receipt is about.
    const later = generateApiKey();
    await keys.issue(asPrincipalId("dedicated"), later.hash, "later");
    expect((await verify(receipted.id)).ok).toBe(true);
    expect((await db.pool.query("SELECT revocation_reason, erasure_request_id FROM governance.api_keys WHERE key_hash = $1", [k.hash])).rows[0]).toEqual({ revocation_reason: "erasure", erasure_request_id: receipted.id });
    expect((await db.pool.query("SELECT revocation_reason, erasure_request_id FROM governance.api_keys WHERE key_hash = $1", [later.hash])).rows[0]).toEqual({ revocation_reason: null, erasure_request_id: null });

    // A marker stripped by hand (the key un-revoked and its request id cleared): the receipted principal has no key marked by this
    // request any more, which counts as a hit, so the recorded ids are what the check is anchored to.
    await db.pool.query("UPDATE governance.api_keys SET revoked_at = NULL, erasure_request_id = NULL, revocation_reason = NULL WHERE key_hash = $1", [k.hash]);
    expect((await verify(receipted.id)).stores.find((s) => s.store === "governance.api_keys")).toEqual({ store: "governance.api_keys", receipted: 0, now: 1, ok: false });
    await db.pool.query("UPDATE governance.api_keys SET revoked_at = now(), erasure_request_id = $2, revocation_reason = 'erasure' WHERE key_hash = $1", [k.hash, receipted.id]);
    expect((await verify(receipted.id)).ok).toBe(true);

    // A receipt recorded before evidence existed (no `evidence` on the keys deletion) is re-counted the old way: keys dedicated to the bank, zero once the grants are gone.
    const access = deps.stores.find((s) => s.auditPurgeAs === "erasure.access_revoked")!;
    const legacy = receipted.receipt!.deletions.map(({ evidence: _evidence, ...d }) => d);
    await db.pool.query("UPDATE governance.api_keys SET revoked_at = NULL WHERE key_hash = $1", [k.hash]);
    expect(await access.count(bankA.id, { requestId: receipted.id, deletions: legacy })).toEqual({ "governance.grants": 0, "governance.api_keys": 0 });
    expect(await access.count(bankA.id, { requestId: receipted.id, deletions: receipted.receipt!.deletions })).toEqual({ "governance.grants": 0, "governance.api_keys": 1 });
  });

  it("unknown ids and requests without a receipt are errors, not failures", async () => {
    expect(await verifier().handle("00000000-0000-4000-8000-000000000000")).toEqual({ ok: false, error: { kind: "ErasureNotFound", requestId: "00000000-0000-4000-8000-000000000000" } });
    const broken: ErasableStore = { count: async () => ({ "engine.broken": 1 }), purge: async () => { throw new Error("down"); } };
    const failed = await erase(bankA.id, [...deps.stores, broken]);
    expect(failed.state).toBe("failed");
    const id = failed.id;
    expect(await verifier().handle(id)).toEqual({ ok: false, error: { kind: "NoReceipt", requestId: id, state: "failed" } });
    // A row that claims `receipted` without a receipt is corruption, reported as its own error.
    await db.pool.query("UPDATE governance.erasure_requests SET state = 'receipted', receipt = NULL WHERE id = $1", [id]);
    expect(await verifier().handle(id)).toEqual({ ok: false, error: { kind: "ReceiptMissing", requestId: id } });
  });
});
