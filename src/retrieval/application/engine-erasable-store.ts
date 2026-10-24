import type { BankId } from "../../shared-kernel/index.js";
import type { ErasableStore } from "../../governance/index.js";
import type { RetrievalEngine } from "../ports/retrieval-engine.js";

/** Any RetrievalEngine as a store the Erasure workflow can inventory, purge and re-check. Store name: `retrieval.<engine>`; `engine` lets the workflow match it against the bank's recorded engine. */
export class EngineErasableStore implements ErasableStore {
  private readonly store: string;
  readonly engine: string;

  constructor(private readonly retrieval: RetrievalEngine) {
    this.engine = retrieval.name;
    this.store = `retrieval.${retrieval.name}`;
  }

  async count(bankId: BankId): Promise<Readonly<Record<string, number>>> {
    return { [this.store]: await this.retrieval.countBank(bankId) };
  }

  async purge(bankId: BankId): Promise<Readonly<Record<string, number>>> {
    const { deleted, remaining } = await this.retrieval.purgeBank(bankId);
    if (remaining > 0) throw new Error(`${this.store}: ${remaining} row(s) remain after purge`);
    return { [this.store]: deleted };
  }
}
