import type { BankId, FactId, Result, Scope } from "../../shared-kernel/index.js";
import { ok } from "../../shared-kernel/index.js";
import type { AccessDenied, AccessPolicy } from "../../governance/index.js";
import type { Fact } from "../domain/fact.js";
import type { FactRepository } from "../ports/repositories.js";

/**
 * Port owned by Memory for what it needs from Retrieval: ranked fact ids for a query.
 * The engine's own text is never returned to callers; facts are re-read through the
 * FactRepository under the caller's Scope so Governance applies on every path.
 */
export interface FactFinder {
  find(scope: Scope, query: string, limit: number): Promise<readonly { readonly factId: FactId; readonly score: number }[]>;
}

export interface RecallResult {
  readonly facts: readonly (Fact & { readonly score: number })[];
}

export class RecallHandler {
  constructor(
    private readonly finder: FactFinder,
    private readonly facts: FactRepository,
    private readonly access: AccessPolicy,
  ) {}

  async handle(scope: Scope, bankId: BankId, query: string, limit = 10): Promise<Result<RecallResult, AccessDenied>> {
    const allowed = this.access.canRead(scope, bankId);
    if (!allowed.ok) return allowed;

    const hits = await this.finder.find(scope, query, limit);
    const byId = new Map(hits.map((h) => [h.factId, h.score] as const));
    const facts = await this.facts.getMany(scope, [...byId.keys()]);
    const scored = facts
      .map((f) => ({ ...f, score: byId.get(f.id) ?? 0 }))
      .sort((a, b) => b.score - a.score);
    return ok({ facts: scored });
  }
}
