import type { BankId, FactId, Provenance, Result, TransactionTime, Validity } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";

export type FactError =
  | { readonly kind: "NoProvenance" }
  | { readonly kind: "InvalidValidity"; readonly detail: string }
  | { readonly kind: "AlreadyRetracted"; readonly factId: FactId }
  | { readonly kind: "BankMismatch"; readonly expected: BankId; readonly actual: BankId }
  | { readonly kind: "SelfSupersession"; readonly factId: FactId };

export type InvalidationReason = "superseded" | "contradicted" | "disputed_by_subject" | "source_retracted" | "other";

/**
 * Fact: a durable, atomic statement believed about the Subject or their world.
 * Bi-temporal: Validity is world time; TransactionTime is when we believed it.
 * Supersession and invalidation close intervals and link; they never delete (invariant 3).
 */
export interface Fact {
  readonly id: FactId;
  readonly bankId: BankId;
  readonly statement: string;
  /** Optional structured form, e.g. { subject: "user", predicate: "prefers_editor", object: "neovim" } */
  readonly predicate?: { readonly subject: string; readonly predicate: string; readonly object: string };
  readonly validity: Validity;
  readonly transaction: TransactionTime;
  readonly provenance: Provenance;
  readonly supersedes?: FactId;
  readonly supersededBy?: FactId;
  readonly invalidation?: { readonly reason: InvalidationReason; readonly at: Date; readonly note?: string };
}

export interface NewFact {
  readonly id: FactId;
  readonly bankId: BankId;
  readonly statement: string;
  readonly predicate?: Fact["predicate"];
  readonly validity: Validity;
  readonly provenance: Provenance;
}

function checkValidity(v: Validity): Result<Validity, FactError> {
  if (v.validTo !== undefined && v.validFrom.getTime() > v.validTo.getTime()) {
    return err({ kind: "InvalidValidity", detail: "validFrom is after validTo" });
  }
  return ok(v);
}

/** Invariants 2 and 4 at construction time. */
export function assertFact(input: NewFact, recordedAt: Date): Result<Fact, FactError> {
  if (input.provenance.sourceEpisodeIds.length === 0) return err({ kind: "NoProvenance" });
  const validity = checkValidity(input.validity);
  if (!validity.ok) return validity;
  if (input.statement.trim().length === 0) {
    return err({ kind: "InvalidValidity", detail: "statement must not be empty" });
  }
  const fact: Fact = {
    id: input.id,
    bankId: input.bankId,
    statement: input.statement,
    validity: input.validity,
    transaction: { recordedAt },
    provenance: input.provenance,
    ...(input.predicate !== undefined ? { predicate: input.predicate } : {}),
  };
  return ok(Object.freeze(fact));
}

export const isCurrent = (f: Fact, at: Date = new Date()): boolean =>
  f.transaction.retractedAt === undefined &&
  f.validity.validFrom.getTime() <= at.getTime() &&
  (f.validity.validTo === undefined || f.validity.validTo.getTime() > at.getTime());

/**
 * Supersede `old` with `replacement`: closes old's validity at the replacement's validFrom,
 * retracts old at `now`, and links both ways. Returns the two updated facts. Nothing is deleted.
 */
export function supersede(
  old: Fact,
  replacement: Fact,
  now: Date,
): Result<{ readonly old: Fact; readonly replacement: Fact }, FactError> {
  if (old.id === replacement.id) return err({ kind: "SelfSupersession", factId: old.id });
  if (old.bankId !== replacement.bankId) return err({ kind: "BankMismatch", expected: old.bankId, actual: replacement.bankId });
  if (old.transaction.retractedAt !== undefined) return err({ kind: "AlreadyRetracted", factId: old.id });

  const closedValidity: Validity = {
    validFrom: old.validity.validFrom,
    validTo: old.validity.validTo ?? replacement.validity.validFrom,
  };
  const checked = checkValidity(closedValidity);
  if (!checked.ok) return checked;

  const closedOld: Fact = Object.freeze({
    ...old,
    validity: closedValidity,
    transaction: { recordedAt: old.transaction.recordedAt, retractedAt: now },
    supersededBy: replacement.id,
    invalidation: { reason: "superseded" as const, at: now },
  });
  const linkedReplacement: Fact = Object.freeze({ ...replacement, supersedes: old.id });
  return ok({ old: closedOld, replacement: linkedReplacement });
}

/** Mark a fact as no longer believed. Keeps the row; closes transaction time. */
export function invalidate(fact: Fact, reason: InvalidationReason, now: Date, note?: string): Result<Fact, FactError> {
  if (fact.transaction.retractedAt !== undefined) return err({ kind: "AlreadyRetracted", factId: fact.id });
  return ok(
    Object.freeze({
      ...fact,
      validity: { validFrom: fact.validity.validFrom, validTo: fact.validity.validTo ?? now },
      transaction: { recordedAt: fact.transaction.recordedAt, retractedAt: now },
      invalidation: { reason, at: now, ...(note !== undefined ? { note } : {}) },
    }),
  );
}

export function confirm(fact: Fact): Fact {
  return Object.freeze({ ...fact, provenance: { ...fact.provenance, confirmation: "confirmed" as const } });
}

export function dispute(fact: Fact): Fact {
  return Object.freeze({ ...fact, provenance: { ...fact.provenance, confirmation: "disputed" as const } });
}
