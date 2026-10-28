import type { Scope } from "../../shared-kernel/index.js";
import type { Episode, Fact } from "../../memory/index.js";

/**
 * CandidateFactSelector: which of the bank's current facts an extraction prompt shows for one
 * episode. The model can only relate a candidate ("updates", "contradicts", "duplicate") to a fact
 * it sees, so the selection decides whether supersession can fire; it must favour recall over
 * brevity for facts the episode may touch. `allCurrentFacts` shows everything (the extract-v2
 * behaviour); RelevanceCandidateSelector picks by similarity, shared entities and recency.
 */
export interface CandidateFactSelector {
  select(scope: Scope, trigger: Episode, recent: readonly Episode[], current: readonly Fact[]): Promise<readonly Fact[]>;
}

export const allCurrentFacts: CandidateFactSelector = { select: async (_scope, _trigger, _recent, current) => current };
