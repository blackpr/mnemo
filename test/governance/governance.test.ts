import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asBankId, asPrincipalId, asSubjectId, asTenantId, type Scope } from "../../src/shared-kernel/index.js";
import { scopeAccessPolicy } from "../../src/governance/domain/access-policy.js";
import { appendEntry, verifyChain, type AuditEntry } from "../../src/governance/domain/audit-log.js";
import { issueReceipt, markDeleted, recordInventory, recordVerification, requestErasure } from "../../src/governance/domain/erasure-request.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const tenant = asTenantId("t1");
const bankA = asBankId("bank-a");
const bankB = asBankId("bank-b");
const alice = asPrincipalId("alice");

const scope = (bankId: typeof bankA, caps: Scope["capabilities"]): Scope => ({ tenantId: tenant, bankId, principalId: alice, capabilities: caps });

describe("AccessPolicy", () => {
  it("denies reads on a bank the scope is not bound to, even with admin", () => {
    const r = scopeAccessPolicy.canRead(scope(bankA, new Set(["admin"])), bankB);
    expect(r.ok).toBe(false);
  });
  it("denies write without the write capability", () => {
    expect(scopeAccessPolicy.canWrite(scope(bankA, new Set(["read"])), bankA).ok).toBe(false);
  });
  it("allows read with read capability on the bound bank", () => {
    expect(scopeAccessPolicy.canRead(scope(bankA, new Set(["read"])), bankA).ok).toBe(true);
  });
});

describe("ErasureRequest fails closed", () => {
  const base = requestErasure({ id: "er-1", tenantId: tenant, bankId: bankA, subjectId: asSubjectId("s1"), requestedBy: alice, requestedAt: new Date() });

  it("refuses a receipt when one store still has hits", () => {
    const inv = recordInventory(base, [{ store: "memory.facts", countBefore: 10 }, { store: "engine.hindsight", countBefore: 10 }]);
    if (!inv.ok) throw new Error("setup");
    const del = markDeleted(inv.value);
    if (!del.ok) throw new Error("setup");
    const ver = recordVerification(del.value, [
      { store: "memory.facts", hitsAfter: 0, checkedAt: new Date() },
      { store: "engine.hindsight", hitsAfter: 2, checkedAt: new Date() },
    ]);
    expect(ver.ok).toBe(false);
    if (!ver.ok) expect(ver.error).toEqual({ kind: "VerificationFailed", stores: ["engine.hindsight"] });
  });

  it("refuses a receipt when an inventoried store was never verified", () => {
    const inv = recordInventory(base, [{ store: "memory.facts", countBefore: 1 }, { store: "retrieval.pgvector", countBefore: 1 }]);
    if (!inv.ok) throw new Error("setup");
    const del = markDeleted(inv.value);
    if (!del.ok) throw new Error("setup");
    const ver = recordVerification(del.value, [{ store: "memory.facts", hitsAfter: 0, checkedAt: new Date() }]);
    expect(ver.ok).toBe(false);
  });

  it("issues a receipt with a digest when every store verifies to zero", () => {
    const inv = recordInventory(base, [{ store: "memory.facts", countBefore: 3 }]);
    if (!inv.ok) throw new Error("setup");
    const del = markDeleted(inv.value);
    if (!del.ok) throw new Error("setup");
    const ver = recordVerification(del.value, [{ store: "memory.facts", hitsAfter: 0, checkedAt: new Date() }]);
    if (!ver.ok) throw new Error("setup");
    const rec = issueReceipt(ver.value, new Date(), sha256);
    expect(rec.ok).toBe(true);
    if (rec.ok) expect(rec.value.receipt?.digest).toHaveLength(64);
  });

  it("rejects out-of-order transitions", () => {
    expect(markDeleted(base).ok).toBe(false);
  });
});

describe("AuditLog hash chain", () => {
  it("detects tampering", () => {
    const e0 = appendEntry(undefined, { tenantId: tenant, bankId: bankA, principalId: alice, action: "episode.recorded", details: { episodeId: "ep-1" }, at: new Date("2026-10-23T10:00:00Z") }, sha256);
    const e1 = appendEntry(e0, { tenantId: tenant, bankId: bankA, principalId: alice, action: "erasure.requested", details: { requestId: "er-1" }, at: new Date("2026-10-23T10:01:00Z") }, sha256);
    expect(verifyChain([e0, e1], sha256)).toBeUndefined();

    const tampered: AuditEntry = { ...e0, details: { episodeId: "ep-999" } };
    expect(verifyChain([tampered, e1], sha256)).toBe(0);
  });
});
