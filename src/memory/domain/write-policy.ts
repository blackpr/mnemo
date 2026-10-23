import type { Fact, NewFact } from "./fact.js";
import type { BankPolicy } from "./bank.js";

/**
 * WritePolicy: decides what a candidate fact becomes before it is stored.
 * Pure: takes similarity and contradiction judgements as inputs; performs no IO.
 *
 * Ordering matters (MemClaw finding, ARCHITECTURE.md 2.1): the contradiction check runs
 * BEFORE the near-duplicate gate, otherwise a contradictory fact that is textually similar
 * to an existing one gets rejected as a duplicate and the contradiction is never recorded.
 */

export type WriteDecision =
  | { readonly action: "assert" }
  | { readonly action: "supersede"; readonly oldFactId: Fact["id"] }
  | { readonly action: "reject"; readonly reason: "duplicate" | "low_faithfulness" | "empty" }
  | { readonly action: "flag_dispute"; readonly conflictingFactId: Fact["id"] };

export interface SimilarExisting {
  readonly fact: Fact;
  /** 0..1 similarity between candidate and this existing fact. */
  readonly similarity: number;
  /** Judgement from the extractor/LLM: does the candidate contradict this fact? */
  readonly contradicts: boolean;
  /** If contradicts, is the candidate more recent in world time than the existing fact? */
  readonly candidateIsNewer: boolean;
}

export function decideWrite(candidate: NewFact, similar: readonly SimilarExisting[], policy: BankPolicy): WriteDecision {
  if (candidate.statement.trim().length === 0) return { action: "reject", reason: "empty" };

  const faithfulness = candidate.provenance.faithfulness;
  if (candidate.provenance.extractor !== undefined && faithfulness !== undefined && faithfulness < policy.minFaithfulness) {
    return { action: "reject", reason: "low_faithfulness" };
  }

  // 1. Contradictions first.
  const contradiction = similar.find((s) => s.contradicts && s.fact.transaction.retractedAt === undefined);
  if (contradiction) {
    // Recency wins, with explicit invalidation of the older fact. Never silent overwrite.
    return contradiction.candidateIsNewer
      ? { action: "supersede", oldFactId: contradiction.fact.id }
      : { action: "flag_dispute", conflictingFactId: contradiction.fact.id };
  }

  // 2. Then the near-duplicate gate.
  const duplicate = similar.find((s) => !s.contradicts && s.similarity >= policy.dedupeThreshold && s.fact.transaction.retractedAt === undefined);
  if (duplicate) return { action: "reject", reason: "duplicate" };

  return { action: "assert" };
}
