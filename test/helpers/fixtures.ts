import {
  asBankId,
  asEpisodeId,
  asFactId,
  asPrincipalId,
  asSubjectId,
  asTenantId,
  type BankId,
  type Capability,
  type Scope,
} from "../../src/shared-kernel/index.js";
import { assertFact, createBank, createEpisode, type Bank, type Episode, type Fact } from "../../src/memory/index.js";

export const tenant = asTenantId("t1");
export const alice = asPrincipalId("alice");

export const scopeFor = (bankId: BankId, caps: readonly Capability[] = ["read", "write"]): Scope => ({
  tenantId: tenant,
  bankId,
  principalId: alice,
  capabilities: new Set(caps),
});

export const bankFixture = (id: string, subject = `subject-${id}`): Bank => createBank(asBankId(id), tenant, asSubjectId(subject), new Date("2026-01-01T00:00:00Z"));

export const episodeFixture = (bankId: BankId, id: string, text: string, occurredAt = new Date("2026-02-01T00:00:00Z"), externalRef?: string): Episode =>
  createEpisode(
    { id: asEpisodeId(id), bankId, kind: "conversation_turn", source: "test", role: "user", text, occurredAt, ...(externalRef !== undefined ? { externalRef } : {}) },
    alice,
    new Date("2026-02-01T00:00:01Z"),
  );

export const factFixture = (bankId: BankId, id: string, statement: string, validFrom = new Date("2026-02-01T00:00:00Z"), episodeId = "ep-1"): Fact => {
  const r = assertFact(
    {
      id: asFactId(id),
      bankId,
      statement,
      validity: { validFrom },
      provenance: { sourceEpisodeIds: [asEpisodeId(episodeId)], writerPrincipalId: alice, confirmation: "asserted" },
    },
    validFrom,
  );
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.error)}`);
  return r.value;
};

export async function* fromArray<T>(items: readonly T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}
