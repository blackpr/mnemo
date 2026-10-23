import type { Episode, Fact } from "../memory/index.js";

/** Wire shapes shared by every attachment (REST, MCP). Dates as ISO strings, absent optionals as null. */
export function serializeFact(f: Fact) {
  return {
    id: f.id,
    bankId: f.bankId,
    statement: f.statement,
    predicate: f.predicate ?? null,
    validity: { validFrom: f.validity.validFrom.toISOString(), validTo: f.validity.validTo?.toISOString() ?? null },
    transaction: { recordedAt: f.transaction.recordedAt.toISOString(), retractedAt: f.transaction.retractedAt?.toISOString() ?? null },
    provenance: f.provenance,
    supersedes: f.supersedes ?? null,
    supersededBy: f.supersededBy ?? null,
    invalidation: f.invalidation ? { ...f.invalidation, at: f.invalidation.at.toISOString() } : null,
  };
}

export function serializeEpisode(e: Episode) {
  return {
    id: e.id,
    bankId: e.bankId,
    kind: e.kind,
    source: e.source,
    role: e.role ?? null,
    text: e.text,
    occurredAt: e.occurredAt.toISOString(),
    recordedAt: e.recordedAt.toISOString(),
    recordedBy: e.recordedBy,
    externalRef: e.externalRef ?? null,
  };
}

export type SerializedFact = ReturnType<typeof serializeFact>;
export type SerializedEpisode = ReturnType<typeof serializeEpisode>;
