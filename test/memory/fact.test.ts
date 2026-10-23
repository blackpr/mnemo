import { describe, expect, it } from "vitest";
import { asBankId, asEpisodeId, asFactId, asPrincipalId } from "../../src/shared-kernel/index.js";
import { assertFact, invalidate, isCurrent, supersede, type NewFact } from "../../src/memory/domain/fact.js";
import { decideWrite } from "../../src/memory/domain/write-policy.js";
import { defaultBankPolicy } from "../../src/memory/domain/bank.js";

const bank = asBankId("bank-1");
const t0 = new Date("2026-01-01T00:00:00Z");
const t1 = new Date("2026-06-01T00:00:00Z");
const t2 = new Date("2026-10-01T00:00:00Z");

const candidate = (id: string, statement: string, validFrom: Date): NewFact => ({
  id: asFactId(id),
  bankId: bank,
  statement,
  validity: { validFrom },
  provenance: {
    sourceEpisodeIds: [asEpisodeId("ep-1")],
    writerPrincipalId: asPrincipalId("extractor"),
    confirmation: "asserted",
  },
});

describe("Fact invariants", () => {
  it("rejects a fact with no source episode (invariant 2)", () => {
    const r = assertFact({ ...candidate("f1", "uses neovim", t0), provenance: { ...candidate("f1", "", t0).provenance, sourceEpisodeIds: [] } }, t0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("NoProvenance");
  });

  it("rejects validFrom after validTo (invariant 4)", () => {
    const r = assertFact({ ...candidate("f1", "x", t1), validity: { validFrom: t1, validTo: t0 } }, t1);
    expect(r.ok).toBe(false);
  });

  it("supersession closes the old interval and links both ways without deleting (invariant 3)", () => {
    const a = assertFact(candidate("f1", "editor is vscode", t0), t0);
    const b = assertFact(candidate("f2", "editor is neovim", t1), t1);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const r = supersede(a.value, b.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.old.validity.validTo).toEqual(t1);
    expect(r.value.old.transaction.retractedAt).toBeUndefined(); // still believed, about the past
    expect(r.value.old.supersededBy).toBe(b.value.id);
    expect(r.value.replacement.supersedes).toBe(a.value.id);
    expect(isCurrent(r.value.old, t2)).toBe(false);
    expect(isCurrent(r.value.replacement, t2)).toBe(true);
    // Point-in-time query: at t0 + 1 day the old fact was the truth.
    expect(isCurrent(r.value.old, new Date("2026-01-02T00:00:00Z"))).toBe(true);
    expect(isCurrent(r.value.replacement, new Date("2026-01-02T00:00:00Z"))).toBe(false);
    // And it cannot be superseded twice.
    const c = assertFact(candidate("f3", "editor is emacs", t2), t2);
    if (!c.ok) throw new Error("setup");
    expect(supersede(r.value.old, c.value).ok).toBe(false);
  });

  it("refuses to supersede an already retracted fact", () => {
    const a = assertFact(candidate("f1", "x", t0), t0);
    const b = assertFact(candidate("f2", "y", t1), t1);
    if (!a.ok || !b.ok) throw new Error("setup");
    const inv = invalidate(a.value, "contradicted", t1);
    if (!inv.ok) throw new Error("setup");
    const r = supersede(inv.value, b.value);
    expect(r.ok).toBe(false);
  });
});

describe("WritePolicy ordering", () => {
  it("records a contradiction as supersession even when the texts are near-duplicates", () => {
    const existing = assertFact(candidate("f1", "lives in Berlin", t0), t0);
    if (!existing.ok) throw new Error("setup");
    const decision = decideWrite(
      candidate("f2", "lives in Lisbon", t1),
      [{ fact: existing.value, similarity: 0.97, contradicts: true, candidateIsNewer: true }],
      defaultBankPolicy,
    );
    expect(decision).toEqual({ action: "supersede", oldFactId: existing.value.id, mode: "supersede" });
  });

  it("rejects a plain near-duplicate", () => {
    const existing = assertFact(candidate("f1", "lives in Berlin", t0), t0);
    if (!existing.ok) throw new Error("setup");
    const decision = decideWrite(
      candidate("f2", "is living in Berlin", t1),
      [{ fact: existing.value, similarity: 0.97, contradicts: false, candidateIsNewer: true }],
      defaultBankPolicy,
    );
    expect(decision).toEqual({ action: "reject", reason: "duplicate" });
  });

  it("flags a dispute when the contradicting candidate is older than the stored fact", () => {
    const existing = assertFact(candidate("f1", "lives in Berlin", t1), t1);
    if (!existing.ok) throw new Error("setup");
    const decision = decideWrite(
      candidate("f2", "lives in Lisbon", t0),
      [{ fact: existing.value, similarity: 0.5, contradicts: true, candidateIsNewer: false }],
      defaultBankPolicy,
    );
    expect(decision.action).toBe("flag_dispute");
  });
});
