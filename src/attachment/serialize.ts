import type { ErasureRequest } from "../governance/index.js";
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

/** An erasure request with its per-store evidence. Counts and digests only; there is no content left to leak. */
export function serializeErasure(r: ErasureRequest) {
  return {
    id: r.id,
    bankId: r.bankId,
    subjectId: r.subjectId,
    state: r.state,
    requestedBy: r.requestedBy,
    requestedAt: r.requestedAt.toISOString(),
    stores: [...new Set([...r.inventory, ...r.deletions, ...r.verifications].map((x) => x.store))].map((store) => ({
      store,
      countBefore: r.inventory.find((i) => i.store === store)?.countBefore ?? null,
      deleted: r.deletions.find((d) => d.store === store)?.deleted ?? null,
      hitsAfter: r.verifications.find((v) => v.store === store)?.hitsAfter ?? null,
    })),
    receipt: r.receipt
      ? {
          digest: r.receipt.digest,
          issuedAt: r.receipt.issuedAt.toISOString(),
          deletions: r.receipt.deletions.map((d) => ({ store: d.store, deleted: d.deleted, deletedAt: d.deletedAt.toISOString() })),
          stores: r.receipt.stores.map((s) => ({ store: s.store, hitsAfter: s.hitsAfter, checkedAt: s.checkedAt.toISOString() })),
        }
      : null,
    failure: r.failure ?? null,
  };
}
