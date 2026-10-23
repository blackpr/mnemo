import type { Fact, NewFact } from "./fact.js";
import type { BankPolicy } from "./bank.js";

/**
 * WritePolicy: decides what a candidate fact becomes before it is stored.
 * Pure: takes similarity and contradiction judgements as inputs; performs no IO.
 *
 * Ordering matters (MemClaw finding, ARCHITECTURE.md 2.1): the contradiction check runs
 * BEFORE the near-duplicate gate, otherwise a contradictory fact that is textually similar
 * to an existing one gets rejected as a duplicate and the contradiction is never recorded.
 *
 * Two kinds of conflict:
 *  - "updates": the world moved on (moved city, changed editor). The old fact stays true for
 *    its interval: supersede it (close validity, link).
 *  - "contradicts": the old fact was wrong, or the change happens at the same instant. Invalidate
 *    it (retract the belief) and assert the new one.
 */

export type ConflictRelation = "contradicts" | "updates";

export type WriteDecision =
  | { readonly action: "assert" }
  | { readonly action: "supersede"; readonly oldFactId: Fact["id"]; readonly mode: "supersede" | "invalidate" }
  | { readonly action: "reject"; readonly reason: "duplicate" | "low_faithfulness" | "empty" }
  | { readonly action: "flag_dispute"; readonly conflictingFactId: Fact["id"] };

export interface SimilarExisting {
  readonly fact: Fact;
  /** 0..1 similarity between candidate and this existing fact. */
  readonly similarity: number;
  /** Judgement from the extractor/LLM: does the candidate conflict with this fact? */
  readonly contradicts: boolean;
  /** How it conflicts; defaults to "updates" (supersession) when omitted. */
  readonly relation?: ConflictRelation;
  /** If contradicts, is the candidate at least as recent in world time as the existing fact? */
  readonly candidateIsNewer: boolean;
}

/** A fact that is retracted or already superseded is history; it never conflicts with new input. */
const isLive = (f: Fact): boolean => f.transaction.retractedAt === undefined && f.supersededBy === undefined;

export function decideWrite(candidate: NewFact, similar: readonly SimilarExisting[], policy: BankPolicy): WriteDecision {
  if (candidate.statement.trim().length === 0) return { action: "reject", reason: "empty" };

  const faithfulness = candidate.provenance.faithfulness;
  if (candidate.provenance.extractor !== undefined && faithfulness !== undefined && faithfulness < policy.minFaithfulness) {
    return { action: "reject", reason: "low_faithfulness" };
  }

  // 1. Contradictions first.
  const conflict = similar.find((s) => s.contradicts && isLive(s.fact));
  if (conflict) {
    // Recency wins, with explicit invalidation or supersession of the older fact. Never a silent overwrite.
    if (!conflict.candidateIsNewer) return { action: "flag_dispute", conflictingFactId: conflict.fact.id };
    return { action: "supersede", oldFactId: conflict.fact.id, mode: conflict.relation === "contradicts" ? "invalidate" : "supersede" };
  }

  // 2. Then the near-duplicate gate.
  const duplicate = similar.find((s) => !s.contradicts && s.similarity >= policy.dedupeThreshold && isLive(s.fact));
  if (duplicate) return { action: "reject", reason: "duplicate" };

  return { action: "assert" };
}
