import type { Result } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";
import { assertFact, supersede, type Fact, type FactError, type NewFact } from "./fact.js";

/**
 * ConflictResolver: executes the outcome the WritePolicy decided when a candidate conflicts
 * with an existing fact. Recency wins: a newer "updates" supersedes (closes the old interval),
 * a newer "contradicts" invalidates (see write-extracted-facts), an older candidate becomes
 * history. Nothing is overwritten. Pure: returns the facts to persist, performs no IO.
 */

/** Candidate is newer than the conflicting fact: it becomes current, the old one is closed and linked. */
export function supersedeWith(old: Fact, candidate: NewFact, now: Date): Result<{ readonly old: Fact; readonly replacement: Fact }, FactError> {
  const built = assertFact(candidate, now);
  if (!built.ok) return built;
  return supersede(old, built.value);
}

/**
 * Candidate is older than the conflicting fact (we learned late about an earlier state):
 * store it as history, valid only until the newer fact began, so point-in-time recall sees it
 * and current recall does not. Marked "disputed" so a human can review the ordering.
 */
export function recordAsHistorical(candidate: NewFact, conflicting: Fact, now: Date): Result<Fact, FactError> {
  const validFrom = candidate.validity.validFrom;
  const validTo = conflicting.validity.validFrom;
  if (validFrom.getTime() >= validTo.getTime()) {
    return err({ kind: "InvalidValidity", detail: "historical candidate must start before the conflicting fact" });
  }
  const closed: NewFact = {
    ...candidate,
    validity: { validFrom, validTo },
    provenance: { ...candidate.provenance, confirmation: "disputed" },
  };
  const built = assertFact(closed, now);
  return built.ok ? ok(built.value) : built;
}
