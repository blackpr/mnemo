import type { BankId, EpisodeId, FactId, ModelRef, PrincipalId, SubjectId } from "../../shared-kernel/index.js";
import type { Fact, InvalidationReason } from "../../memory/index.js";

/**
 * BankExport v1: the portable, lossless form of a Bank's facts. Pure data, built from Facts.
 * Every fact appears once: as a `fact` record while still believed (current or closed by
 * supersession), or as a `tombstone` once retracted. Nothing is dropped, so an export is a
 * faithful copy of the system of record, and ordering is total so two exports of the same
 * state are byte-identical (the header's `exportedAt` is the only moving part).
 * The wire shape is fixed by `schema/bank-export.v1.json`; change both together.
 */
export const BANK_EXPORT_SCHEMA = "bank-export.v1" as const;

export interface ExportHeader {
  readonly record: "header";
  readonly schema: typeof BANK_EXPORT_SCHEMA;
  readonly bankId: BankId;
  readonly subjectId: SubjectId;
  readonly exportedAt: string;
  readonly counts: { readonly facts: number; readonly tombstones: number };
}

export interface ExportProvenance {
  readonly sourceEpisodeIds: readonly EpisodeId[];
  readonly writerPrincipalId: PrincipalId;
  readonly extractor: ModelRef | null;
  readonly triggerEpisodeId: EpisodeId | null;
  readonly confirmation: "asserted" | "confirmed" | "disputed";
  readonly faithfulness: number | null;
}

interface FactFields {
  readonly id: FactId;
  readonly statement: string;
  readonly predicate: { readonly subject: string; readonly predicate: string; readonly object: string } | null;
  readonly topic: string;
  readonly validity: { readonly validFrom: string; readonly validTo: string | null };
  readonly transaction: { readonly recordedAt: string; readonly retractedAt: string | null };
  readonly provenance: ExportProvenance;
  readonly supersedes: FactId | null;
  readonly supersededBy: FactId | null;
}

export interface ExportFact extends FactFields {
  readonly record: "fact";
  readonly transaction: { readonly recordedAt: string; readonly retractedAt: null };
}

/** A retracted fact. Content is kept (retraction is a change of belief, not erasure); the record type lets importers skip it cheaply. */
export interface ExportTombstone extends FactFields {
  readonly record: "tombstone";
  readonly transaction: { readonly recordedAt: string; readonly retractedAt: string };
  readonly invalidation: { readonly reason: InvalidationReason; readonly at: string; readonly note: string | null };
}

export type ExportRecord = ExportHeader | ExportFact | ExportTombstone;

export interface BankExport {
  readonly header: ExportHeader;
  readonly records: readonly (ExportFact | ExportTombstone)[];
}

export const GENERAL_TOPIC = "General";

/**
 * Facts carry no explicit topic; the structured predicate is the closest thing to one.
 * "prefers_editor" becomes "Prefers editor". Facts without a predicate are "General".
 */
export function topicOf(fact: Pick<Fact, "predicate">): string {
  const p = fact.predicate?.predicate.trim();
  if (!p) return GENERAL_TOPIC;
  const words = p.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Total order: world time, then when we learned it, then id. Independent of repository ordering. */
export function compareFacts(a: Fact, b: Fact): number {
  return (
    a.validity.validFrom.getTime() - b.validity.validFrom.getTime() ||
    a.transaction.recordedAt.getTime() - b.transaction.recordedAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function buildBankExport(input: { readonly bankId: BankId; readonly subjectId: SubjectId; readonly facts: readonly Fact[]; readonly exportedAt: Date }): BankExport {
  const records = [...input.facts].sort(compareFacts).map(toRecord);
  const tombstones = records.filter((r) => r.record === "tombstone").length;
  return {
    header: {
      record: "header",
      schema: BANK_EXPORT_SCHEMA,
      bankId: input.bankId,
      subjectId: input.subjectId,
      exportedAt: input.exportedAt.toISOString(),
      counts: { facts: records.length - tombstones, tombstones },
    },
    records,
  };
}

/** Stored jsonb does not preserve key order; rebuild nested objects so the bytes are stable. */
function toRecord(f: Fact): ExportFact | ExportTombstone {
  const p = f.predicate;
  const x = f.provenance.extractor;
  const fields: FactFields = {
    id: f.id,
    statement: f.statement,
    predicate: p ? { subject: p.subject, predicate: p.predicate, object: p.object } : null,
    topic: topicOf(f),
    validity: { validFrom: f.validity.validFrom.toISOString(), validTo: f.validity.validTo?.toISOString() ?? null },
    transaction: { recordedAt: f.transaction.recordedAt.toISOString(), retractedAt: f.transaction.retractedAt?.toISOString() ?? null },
    provenance: {
      sourceEpisodeIds: f.provenance.sourceEpisodeIds,
      writerPrincipalId: f.provenance.writerPrincipalId,
      extractor: x ? { provider: x.provider, model: x.model, version: x.version } : null,
      triggerEpisodeId: f.provenance.triggerEpisodeId ?? null,
      confirmation: f.provenance.confirmation,
      faithfulness: f.provenance.faithfulness ?? null,
    },
    supersedes: f.supersedes ?? null,
    supersededBy: f.supersededBy ?? null,
  };
  if (f.transaction.retractedAt === undefined) {
    return { record: "fact", ...fields, transaction: { recordedAt: fields.transaction.recordedAt, retractedAt: null } };
  }
  return {
    record: "tombstone",
    ...fields,
    transaction: { recordedAt: fields.transaction.recordedAt, retractedAt: f.transaction.retractedAt.toISOString() },
    invalidation: {
      reason: f.invalidation?.reason ?? "other",
      at: (f.invalidation?.at ?? f.transaction.retractedAt).toISOString(),
      note: f.invalidation?.note ?? null,
    },
  };
}
