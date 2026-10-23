import type { Scope } from "../../shared-kernel/index.js";
import type { MemoryFinder, MemoryFinderOptions, MemoryHit } from "../../memory/index.js";
import type { RetrievalEngine } from "../ports/retrieval-engine.js";

/** Adapts any RetrievalEngine to the MemoryFinder port that Memory's RecallHandler depends on. */
export class EngineMemoryFinder implements MemoryFinder {
  constructor(private readonly engine: RetrievalEngine) {}

  async find(scope: Scope, query: string, options: MemoryFinderOptions): Promise<readonly MemoryHit[]> {
    const hits = await this.engine.recall(scope, query, options);
    return hits.map((h) => ({
      score: h.score,
      ...(h.factId !== undefined ? { factId: h.factId } : {}),
      ...(h.episodeId !== undefined ? { episodeId: h.episodeId } : {}),
    }));
  }
}
