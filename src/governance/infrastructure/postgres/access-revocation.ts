import type pg from "pg";
import type { BankId } from "../../../shared-kernel/index.js";
import { withTransaction } from "../../../platform/postgres/pool.js";
import type { ErasableStore } from "../../ports/repositories.js";

export const STORE_GRANTS = "governance.grants";
export const STORE_API_KEYS = "governance.api_keys";

/**
 * Governance's own store in the Erasure workflow: the access that targets the bank.
 *
 * - `governance.grants`: every grant on the bank is deleted. Whoever held read, write, admin or
 *   erase on it (the requesting principal included) holds nothing afterwards; the tombstone is
 *   reachable only through the admin CLI.
 * - `governance.api_keys`: the active keys of principals whose grants all target this bank are
 *   revoked (`revoked_at`), so no live credential is left over that existed only to reach the
 *   erased Subject. A principal that also holds grants on other banks keeps its keys: the deleted
 *   grant already cuts its path to this bank, and revoking would cut other Subjects' access too.
 *
 * Both counts are "what still targets the bank". The grants re-count is real evidence (the rows are
 * gone). The keys re-count is implied by it, not independent: once no grant on the bank exists, no key
 * can be "dedicated to the bank", so it reads zero whether or not the UPDATE ran. What the receipt
 * proves is zero grants; that the dedicated keys were revoked is checked by the tests and visible in
 * `revoked_at`. Keys are never deleted: `revoked_at` keeps the issue history, and a revoked key is
 * indistinguishable from an unknown one at the attachment.
 *
 * This store goes LAST in the workflow's list: a data store failing after it would leave the bank
 * frozen with nobody able to retry (the eraser's grant gone, its key revoked). Last, a data-store
 * failure leaves access intact for the retry; only a failure of this store itself, or of the
 * re-count, strands the request, and the way out is `admin grant --caps erase` then `erase-bank`.
 * The workflow audits the purge of this store as `erasure.access_revoked` (see `auditPurgeAs`).
 */
export class PgAccessRevocation implements ErasableStore {
  readonly auditPurgeAs = "erasure.access_revoked" as const;

  constructor(private readonly pool: pg.Pool) {}

  async count(bankId: BankId): Promise<Readonly<Record<string, number>>> {
    const { rows } = await this.pool.query<{ grants: string; keys: string }>(
      `SELECT (SELECT count(*) FROM governance.grants WHERE bank_id = $1)::text AS grants,
              (SELECT count(*) FROM governance.api_keys k WHERE k.revoked_at IS NULL AND ${DEDICATED_TO_BANK})::text AS keys`,
      [bankId],
    );
    return { [STORE_GRANTS]: Number(rows[0]?.grants ?? 0), [STORE_API_KEYS]: Number(rows[0]?.keys ?? 0) };
  }

  purge(bankId: BankId): Promise<Readonly<Record<string, number>>> {
    return withTransaction(this.pool, async (client) => {
      // Keys first: the predicate reads the grants that the next statement deletes.
      const keys = await client.query(`UPDATE governance.api_keys k SET revoked_at = now() WHERE k.revoked_at IS NULL AND ${DEDICATED_TO_BANK}`, [bankId]);
      const grants = await client.query("DELETE FROM governance.grants WHERE bank_id = $1", [bankId]);
      return { [STORE_GRANTS]: grants.rowCount ?? 0, [STORE_API_KEYS]: keys.rowCount ?? 0 };
    });
  }
}

/**
 * A key's principal holds a grant on the bank ($1) and no live grant elsewhere. Correlated on `k`. "Live"
 * mirrors ScopeResolver (an expired grant is no grant) and ignores grants on already-erased banks, so a
 * principal left over from earlier erasures does not keep a key alive through grants it cannot use.
 */
const DEDICATED_TO_BANK = `EXISTS (SELECT 1 FROM governance.grants g WHERE g.principal_id = k.principal_id AND g.bank_id = $1)
       AND NOT EXISTS (SELECT 1 FROM governance.grants g JOIN memory.banks b ON b.id = g.bank_id
                       WHERE g.principal_id = k.principal_id AND g.bank_id <> $1
                         AND (g.expires_at IS NULL OR g.expires_at > now()) AND b.status <> 'erased')`;
