import type { BankId } from "../../shared-kernel/index.js";
import type { ErasableStore } from "../../governance/index.js";
import type { ExportStore } from "../ports/export-store.js";

/** The export ledger as a store the Erasure workflow can inventory, purge and re-check. */
export class ExportsErasableStore implements ErasableStore {
  constructor(private readonly exports: ExportStore) {}

  async count(bankId: BankId): Promise<Readonly<Record<string, number>>> {
    return { "portability.exports": await this.exports.countByBank(bankId) };
  }

  async purge(bankId: BankId): Promise<Readonly<Record<string, number>>> {
    return { "portability.exports": await this.exports.purgeBank(bankId) };
  }
}
