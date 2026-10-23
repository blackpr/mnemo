import { describe, expect, it } from "vitest";
import { asBankId, asEpisodeId, asFactId, asPrincipalId } from "../../src/shared-kernel/index.js";
import { recordAsHistorical, supersedeWith, type NewFact } from "../../src/memory/index.js";
import { factFixture } from "../helpers/fixtures.js";

const bank = asBankId("b");
const t0 = new Date("2026-01-01T00:00:00Z");
const t1 = new Date("2026-06-01T00:00:00Z");
const candidate = (statement: string, validFrom: Date): NewFact => ({
  id: asFactId("new"),
  bankId: bank,
  statement,
  validity: { validFrom },
  provenance: { sourceEpisodeIds: [asEpisodeId("e")], writerPrincipalId: asPrincipalId("system:extractor"), confirmation: "asserted" },
});

describe("ConflictResolver", () => {
  it("supersedeWith closes the old fact at the candidate's validFrom and links both", () => {
    const old = factFixture(bank, "old", "lives in Berlin", t0);
    const r = supersedeWith(old, candidate("lives in Lisbon", t1), t1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.old.validity.validTo).toEqual(t1);
    expect(r.value.old.transaction.retractedAt).toBeUndefined();
    expect(r.value.old.supersededBy).toBe("new");
    expect(r.value.replacement.supersedes).toBe("old");
    expect(r.value.replacement.validity.validTo).toBeUndefined();
  });

  it("recordAsHistorical stores an older candidate closed at the conflicting fact's start, marked disputed", () => {
    const current = factFixture(bank, "cur", "lives in Lisbon", t1);
    const r = recordAsHistorical(candidate("lived in Berlin", t0), current, t1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.validity).toEqual({ validFrom: t0, validTo: t1 });
    expect(r.value.provenance.confirmation).toBe("disputed");
    expect(r.value.transaction.retractedAt).toBeUndefined();
  });

  it("recordAsHistorical refuses a candidate that does not start before the conflicting fact", () => {
    const current = factFixture(bank, "cur", "lives in Lisbon", t0);
    expect(recordAsHistorical(candidate("lived in Berlin", t1), current, t1).ok).toBe(false);
  });
});
