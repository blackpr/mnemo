import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asBankId, asPrincipalId, asTenantId, systemClock } from "../../src/shared-kernel/index.js";
import { generateApiKey, PgApiKeyStore, PgAuditLog, PgPrincipalRepository, ScopeResolver, verifyChain, type Principal } from "../../src/governance/index.js";
import { PgBankRepository } from "../../src/memory/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { bankFixture, tenant } from "../helpers/fixtures.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describeWithDb("Governance Postgres adapters", () => {
  let db: TestDb;
  const bankA = bankFixture("bank-a");
  const bankB = bankFixture("bank-b");
  const principal: Principal = {
    id: asPrincipalId("claude-code"),
    tenantId: tenant,
    kind: "agent",
    displayName: "Claude Code",
    grants: [{ bankId: bankA.id, capabilities: new Set(["read", "write"]), grantedAt: new Date("2026-01-01T00:00:00Z") }],
  };

  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.truncateAll();
    const banks = new PgBankRepository(db.pool);
    await banks.create(bankA);
    await banks.create(bankB);
    await new PgPrincipalRepository(db.pool).save(principal);
  });

  it("resolves a Scope from a valid API key and a granted bank", async () => {
    const key = generateApiKey();
    await new PgApiKeyStore(db.pool).issue(principal.id, key.hash, "test");
    const resolver = new ScopeResolver(new PgPrincipalRepository(db.pool), new PgBankRepository(db.pool), systemClock);

    const ok = await resolver.resolve(key.token, bankA.id);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.principalId).toBe(principal.id);
      expect(ok.value.bankId).toBe(bankA.id);
      expect([...ok.value.capabilities].sort()).toEqual(["read", "write"]);
    }

    const noGrant = await resolver.resolve(key.token, bankB.id);
    expect(noGrant).toEqual({ ok: false, error: { kind: "NoGrant", bankId: bankB.id, principalId: principal.id, tenantId: tenant } });
  });

  it("a grant on a bank owned by another tenant resolves to NoGrant", async () => {
    const t2 = asTenantId("t2");
    const foreign: Principal = { id: asPrincipalId("outsider"), tenantId: t2, kind: "agent", displayName: "outsider", grants: [{ bankId: bankA.id, capabilities: new Set(["read", "write", "admin"]), grantedAt: new Date() }] };
    await new PgPrincipalRepository(db.pool).save(foreign);
    const key = generateApiKey();
    await new PgApiKeyStore(db.pool).issue(foreign.id, key.hash, "t");
    const resolver = new ScopeResolver(new PgPrincipalRepository(db.pool), new PgBankRepository(db.pool), systemClock);
    const r = await resolver.resolve(key.token, bankA.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("NoGrant");
    expect((await resolver.resolve(key.token, asBankId("does-not-exist"))).ok).toBe(false);
  });

  it("treats missing, malformed, unknown and revoked keys identically", async () => {
    const key = generateApiKey();
    const keys = new PgApiKeyStore(db.pool);
    await keys.issue(principal.id, key.hash, "test");
    const resolver = new ScopeResolver(new PgPrincipalRepository(db.pool), new PgBankRepository(db.pool), systemClock);

    expect((await resolver.resolve(undefined, bankA.id)).ok).toBe(false);
    expect(await resolver.resolve("nope", bankA.id)).toEqual({ ok: false, error: { kind: "Unauthorized" } });
    expect(await resolver.resolve(generateApiKey().token, bankA.id)).toEqual({ ok: false, error: { kind: "Unauthorized" } });
    expect(await keys.revoke(key.hash)).toBe(true);
    expect(await keys.revoke(key.hash)).toBe(false);
    expect(await resolver.resolve(key.token, bankA.id)).toEqual({ ok: false, error: { kind: "Unauthorized" } });
  });

  it("ignores expired grants", async () => {
    const expired: Principal = { ...principal, grants: [{ ...principal.grants[0]!, expiresAt: new Date("2026-01-02T00:00:00Z") }] };
    await new PgPrincipalRepository(db.pool).save(expired);
    const key = generateApiKey();
    await new PgApiKeyStore(db.pool).issue(principal.id, key.hash, "test");
    const resolver = new ScopeResolver(new PgPrincipalRepository(db.pool), new PgBankRepository(db.pool), systemClock);
    expect((await resolver.resolve(key.token, bankA.id)).ok).toBe(false);
  });

  it("audit log persists a verifiable hash chain with nested multi-key details; the database refuses tampering", async () => {
    const audit = new PgAuditLog(db.pool);
    await audit.append({ tenantId: tenant, bankId: bankA.id, principalId: principal.id, action: "episode.recorded", details: { episodeId: "e1", zeta: 1, alpha: ["b", "a"] }, at: new Date("2026-10-23T10:00:00Z") });
    await audit.append({ tenantId: tenant, bankId: bankA.id, principalId: principal.id, action: "recall.served", details: { factIds: ["f1", "f2"], episodeIds: [] }, at: new Date("2026-10-23T10:01:00Z") });
    const entries = await audit.list(tenant);
    expect(entries.map((e) => e.seq)).toEqual([0, 1]);
    expect(verifyChain(entries, sha256)).toBeUndefined();
    await expect(db.pool.query("UPDATE governance.audit_log SET details = '{}' WHERE seq = 0")).rejects.toThrow(/immutable/);
    await expect(db.pool.query("DELETE FROM governance.audit_log")).rejects.toThrow(/immutable/);
  });

  it("chains are per tenant: a second tenant starts at seq 0 and both verify", async () => {
    const audit = new PgAuditLog(db.pool);
    const t2 = asTenantId("t2");
    await audit.append({ tenantId: tenant, principalId: principal.id, action: "recall.served", details: {}, at: new Date() });
    await audit.append({ tenantId: t2, principalId: asPrincipalId("p2"), action: "recall.served", details: {}, at: new Date() });
    await audit.append({ tenantId: t2, principalId: asPrincipalId("p2"), action: "recall.served", details: {}, at: new Date() });
    const a = await audit.list(tenant);
    const b = await audit.list(t2);
    expect(a.map((e) => e.seq)).toEqual([0]);
    expect(b.map((e) => e.seq)).toEqual([0, 1]);
    expect(verifyChain(a, sha256)).toBeUndefined();
    expect(verifyChain(b, sha256)).toBeUndefined();
  });

  it("concurrent appends never fork the chain", async () => {
    const audit = new PgAuditLog(db.pool);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        audit.append({ tenantId: tenant, principalId: principal.id, action: "recall.served", details: { i }, at: new Date() }),
      ),
    );
    const entries = await audit.list(tenant);
    expect(entries).toHaveLength(20);
    expect(verifyChain(entries, sha256)).toBeUndefined();
  });

  it("grants are replaced on save, not accumulated", async () => {
    const repo = new PgPrincipalRepository(db.pool);
    await repo.save({ ...principal, grants: [{ bankId: asBankId("bank-b"), capabilities: new Set(["read"]), grantedAt: new Date() }] });
    const got = await repo.get(principal.id);
    expect(got?.grants.map((g) => g.bankId)).toEqual(["bank-b"]);
  });
});
