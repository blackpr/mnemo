import type { Bank, BankPolicy, BankStatus } from "../../domain/bank.js";
import type { Episode, EpisodeKind } from "../../domain/episode.js";
import type { Fact, InvalidationReason } from "../../domain/fact.js";
import type { BankId, EpisodeId, FactId, PrincipalId, Provenance, SubjectId, TenantId } from "../../../shared-kernel/index.js";

/** Row shapes as returned by pg (timestamptz -> Date, jsonb -> parsed object). */

export interface BankRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  status: BankStatus;
  policy: BankPolicy;
  created_at: Date;
}

export const toBank = (r: BankRow): Bank =>
  Object.freeze({
    id: r.id as BankId,
    tenantId: r.tenant_id as TenantId,
    subjectId: r.subject_id as SubjectId,
    status: r.status,
    policy: r.policy,
    createdAt: r.created_at,
  });

export interface EpisodeRow {
  id: string;
  bank_id: string;
  kind: EpisodeKind;
  source: string;
  role: NonNullable<Episode["role"]> | null;
  text: string;
  occurred_at: Date;
  recorded_at: Date;
  recorded_by: string;
  external_ref: string | null;
}

export const toEpisode = (r: EpisodeRow): Episode =>
  Object.freeze({
    id: r.id as EpisodeId,
    bankId: r.bank_id as BankId,
    kind: r.kind,
    source: r.source,
    text: r.text,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    recordedBy: r.recorded_by as PrincipalId,
    ...(r.role !== null ? { role: r.role } : {}),
    ...(r.external_ref !== null ? { externalRef: r.external_ref } : {}),
  });

export interface FactRow {
  id: string;
  bank_id: string;
  statement: string;
  predicate: NonNullable<Fact["predicate"]> | null;
  valid_from: Date;
  valid_to: Date | null;
  recorded_at: Date;
  retracted_at: Date | null;
  provenance: Provenance;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  invalidation: { reason: InvalidationReason; at: string; note?: string } | null;
}

export const toFact = (r: FactRow): Fact =>
  Object.freeze({
    id: r.id as FactId,
    bankId: r.bank_id as BankId,
    statement: r.statement,
    validity: { validFrom: r.valid_from, ...(r.valid_to !== null ? { validTo: r.valid_to } : {}) },
    transaction: { recordedAt: r.recorded_at, ...(r.retracted_at !== null ? { retractedAt: r.retracted_at } : {}) },
    provenance: r.provenance,
    ...(r.predicate !== null ? { predicate: r.predicate } : {}),
    ...(r.supersedes_id !== null ? { supersedes: r.supersedes_id as FactId } : {}),
    ...(r.superseded_by_id !== null ? { supersededBy: r.superseded_by_id as FactId } : {}),
    ...(r.invalidation !== null
      ? {
          invalidation: {
            reason: r.invalidation.reason,
            at: new Date(r.invalidation.at),
            ...(r.invalidation.note !== undefined ? { note: r.invalidation.note } : {}),
          },
        }
      : {}),
  });

export const factToParams = (f: Fact): unknown[] => [
  f.id,
  f.bankId,
  f.statement,
  f.predicate ?? null,
  f.validity.validFrom,
  f.validity.validTo ?? null,
  f.transaction.recordedAt,
  f.transaction.retractedAt ?? null,
  JSON.stringify(f.provenance),
  f.supersedes ?? null,
  f.supersededBy ?? null,
  f.invalidation ? JSON.stringify(f.invalidation) : null,
];
