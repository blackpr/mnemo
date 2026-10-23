import type { BankId } from "../../shared-kernel/index.js";
import type { ErasableStore } from "../../governance/index.js";
import type { ExtractionRunStore } from "../ports/run-store.js";

/** The extraction ledger as a store the Erasure workflow can inventory, purge and re-check. */
export class ExtractionErasableStore implements ErasableStore {
  constructor(private readonly runs: ExtractionRunStore) {}

  async count(bankId: BankId): Promise<Readonly<Record<string, number>>> {
    return { "extraction.runs": await this.runs.countByBank(bankId) };
  }

  async purge(bankId: BankId): Promise<Readonly<Record<string, number>>> {
    return { "extraction.runs": await this.runs.purgeBank(bankId) };
  }
}
