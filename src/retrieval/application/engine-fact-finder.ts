import type { FactId, Scope } from "../../shared-kernel/index.js";
import type { FactFinder } from "../../memory/index.js";
import type { RetrievalEngine } from "../ports/retrieval-engine.js";

/** Adapts any RetrievalEngine to the FactFinder port that Memory's RecallHandler depends on. */
export class EngineFactFinder implements FactFinder {
  constructor(private readonly engine: RetrievalEngine) {}

  async find(scope: Scope, query: string, limit: number): Promise<readonly { readonly factId: FactId; readonly score: number }[]> {
    const hits = await this.engine.recall(scope, query, { limit });
    return hits.flatMap((h) => (h.factId !== undefined ? [{ factId: h.factId, score: h.score }] : []));
  }
}
