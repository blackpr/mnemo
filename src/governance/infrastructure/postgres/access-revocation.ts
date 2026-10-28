import type pg from "pg";
import type { BankId } from "../../../shared-kernel/index.js";
import { withTransaction } from "../../../platform/postgres/pool.js";
import { crossBank } from "../../../platform/postgres/bank-isolation.js";
import type { ErasableStore, ErasureRecount, StorePurge } from "../../ports/repositories.js";

export const STORE_GRANTS = "governance.grants";
export const STORE_API_KEYS = "governance.api_keys";
/** Evidence key on the `governance.api_keys` deletion and the `erasure.access_revoked` audit entry: the principals whose keys were revoked. */
export const EVIDENCE_REVOKED_PRINCIPALS = "revokedPrincipals";

/**
 * Governance's own store in the Erasure workflow: the access that targets the bank.
 *
 * - `governance.grants`: every grant on the bank is deleted. Whoever held read, write, admin or
 *   erase on it (the requesting principal included) holds nothing afterwards; the tombstone is
 *   reachable only through the admin CLI.
 * - `governance.api_keys`: the active keys of principals whose grants all target this bank are
 *   revoked (`revoked_at`, `revocation_reason = 'erasure'`, `erasure_request_id`), so no live credential
 *   is left over that existed only to reach the erased Subject. A principal that also holds grants on other
 *   banks keeps its keys: the deleted grant already cuts its path to this bank, and revoking would cut other
 *   Subjects' access too. The purge reports the ids of the principals it revoked as evidence; the workflow
 *   records them on the request's deletion and on the `erasure.access_revoked` entry (ids only).
 *
 * The grants re-count is "what still targets the bank" (the rows are gone). The keys re-count, on a request that
 * recorded evidence, is independent of the grants and anchored to the recorded ids: the live keys that carry this
 * request's `erasure_request_id` (exactly the keys the purge revoked; the marker is written by the same UPDATE, so
 * no clock is compared, and a key revoked by a pass that died before saving is still found), plus one hit for every
 * recorded principal that has no key marked by this request at all (a marker stripped by hand looks like a key that was
 * never revoked). Zero means the keys this request revoked are still revoked and still say so, whatever the grants
 * say; the stateless count would read zero as soon as no grant was left, whether or not the UPDATE ran.
 * A key issued to one of those principals later is not what the receipt is about and is not counted. A request from
 * before evidence was recorded falls back to the stateless count. Keys are never deleted: `revoked_at` keeps the issue
 * history, and a revoked key is indistinguishable from an unknown one at the attachment.
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

  async count(bankId: BankId, after?: ErasureRecount): Promise<Readonly<Record<string, number>>> {
    const recorded = after?.deletions.find((d) => d.store === STORE_API_KEYS)?.evidence?.[EVIDENCE_REVOKED_PRINCIPALS];
    const { rows } = after !== undefined && recorded !== undefined
      ? await this.pool.query<{ grants: string; keys: string }>(
          `${crossBank("access.keys-count-recorded")}SELECT (SELECT count(*) FROM governance.grants WHERE bank_id = $1)::text AS grants,
                  ((SELECT count(*) FROM governance.api_keys k WHERE k.revoked_at IS NULL AND k.erasure_request_id = $2)
                   + (SELECT count(*) FROM unnest($3::text[]) AS recorded(principal_id)
                      WHERE NOT EXISTS (SELECT 1 FROM governance.api_keys k WHERE k.principal_id = recorded.principal_id AND k.erasure_request_id = $2)))::text AS keys`,
          [bankId, after.requestId, [...recorded]],
        )
      : await this.pool.query<{ grants: string; keys: string }>(
          `${crossBank("access.keys-count-dedicated")}SELECT (SELECT count(*) FROM governance.grants WHERE bank_id = $1)::text AS grants,
                  (SELECT count(*) FROM governance.api_keys k WHERE k.revoked_at IS NULL AND ${DEDICATED_TO_BANK})::text AS keys`,
          [bankId],
        );
    return { [STORE_GRANTS]: Number(rows[0]?.grants ?? 0), [STORE_API_KEYS]: Number(rows[0]?.keys ?? 0) };
  }

  purge(bankId: BankId, request: { readonly id: string }): Promise<Readonly<Record<string, StorePurge>>> {
    return withTransaction(this.pool, async (client) => {
      // Keys first: the predicate reads the grants that the next statement deletes.
      const keys = await client.query<{ principal_id: string }>(
        `${crossBank("access.revoke-dedicated-keys")}UPDATE governance.api_keys k SET revoked_at = now(), revocation_reason = 'erasure', erasure_request_id = $2
         WHERE k.revoked_at IS NULL AND ${DEDICATED_TO_BANK}
         RETURNING k.principal_id`,
        [bankId, request.id],
      );
      const grants = await client.query("DELETE FROM governance.grants WHERE bank_id = $1", [bankId]);
      // A resumed pass re-purges after a dead pass revoked but never saved: the evidence still names every principal this request revoked.
      const earlier = await client.query<{ principal_id: string }>(`${crossBank("access.principals-revoked-by-request")}SELECT DISTINCT principal_id FROM governance.api_keys WHERE erasure_request_id = $1`, [request.id]);
      const principals = [...new Set([...keys.rows, ...earlier.rows].map((r) => r.principal_id))].sort();
      return { [STORE_GRANTS]: grants.rowCount ?? 0, [STORE_API_KEYS]: { deleted: keys.rowCount ?? 0, evidence: { [EVIDENCE_REVOKED_PRINCIPALS]: principals } } };
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
