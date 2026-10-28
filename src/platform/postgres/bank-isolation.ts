/**
 * Bank isolation, the rule in one place.
 *
 * Every statement that reads, changes or deletes rows of a table below must pin itself to one bank (or, for
 * Governance's identity tables, to one tenant or one principal) by an equality on one of the listed columns in
 * its WHERE or JOIN condition: `bank_id = $1`, `id = ANY($2)`, `f.bank_id = e.bank_id` where `e` is already
 * pinned. This is the second line of defence behind Governance's AccessPolicy, which every application handler
 * applies first. A principal belongs to exactly one tenant, so a statement pinned to one principal cannot reach
 * another tenant's rows.
 *
 * The rule is checked, not trusted: `test/helpers/query-guard.ts` wraps the connection pool of every
 * database-backed test, parses each statement with the real Postgres parser (libpg-query) and fails the test run
 * on one that touches a table below without the pin. Production code pays nothing for the check; the only cost
 * here is a SQL comment on the statements listed in CROSS_BANK_STATEMENTS.
 */
export const SCOPED_TABLES: Readonly<Record<string, readonly string[]>> = {
  "memory.banks": ["id"],
  "memory.episodes": ["bank_id"],
  "memory.facts": ["bank_id"],
  "memory.outbox": ["bank_id"],
  "retrieval.pgvector_index": ["bank_id"],
  "extraction.runs": ["bank_id"],
  "portability.exports": ["bank_id"],
  "governance.erasure_requests": ["bank_id"],
  "governance.audit_log": ["tenant_id"],
  "governance.principals": ["tenant_id", "id"],
  "governance.grants": ["bank_id", "principal_id"],
  "governance.api_keys": ["principal_id"],
};

interface CrossBankEntry {
  /** The function that runs the statement. */
  readonly site: string;
  /** The scoped tables the statement may leave unpinned; every other table in it is still checked. */
  readonly tables: readonly string[];
  /** Why it may span banks. */
  readonly reason: string;
}

/**
 * The statements that span banks on purpose. Each one carries the tag `crossBank("<name>")` at the start of its SQL;
 * the guard matches the tag, so a statement can be reworded without touching this list. The tag exempts only the
 * entry's `tables`: any other scoped table in the same statement must still be pinned. An entry the test suite
 * never runs fails the run, and so does a tagged statement whose tables turn out to be pinned after all, so the list
 * stays exactly as long as it needs to be.
 *
 * To add one: add an entry here (function, tables, reason), put `${crossBank("<name>")}` in front of the SQL, and
 * make sure a test runs it.
 */
export const CROSS_BANK_STATEMENTS = {
  "outbox.claim": { site: "PgOutboxRelay.drainOnce", tables: ["memory.outbox"], reason: "the relay delivers every bank's due events; each event carries its own bank id" },
  "outbox.pending-count": { site: "PgOutboxRelay.pendingCount", tables: ["memory.outbox"], reason: "operator queue depth over all banks" },
  "outbox.dead-letter-count": { site: "PgOutboxRelay.deadLetterCount", tables: ["memory.outbox"], reason: "operator queue depth over all banks" },
  "outbox.requeue-dead-letters": { site: "PgOutboxRelay.requeueDeadLetters", tables: ["memory.outbox"], reason: "operator action over all banks" },
  "extraction.claim": { site: "PgExtractionRunStore.claimNext", tables: ["extraction.runs"], reason: "the worker takes the oldest due run of any bank; the claim carries its bank id" },
  "extraction.sweep-stale": { site: "PgExtractionRunStore.sweepStale", tables: ["extraction.runs"], reason: "worker housekeeping: stale claims of any bank" },
  "extraction.requeue-failed": { site: "PgExtractionRunStore.requeueFailed", tables: ["extraction.runs"], reason: "operator action over all banks" },
  "extraction.counts": { site: "PgExtractionRunStore.counts", tables: ["extraction.runs"], reason: "operator queue status over all banks" },
  "erasure.claim": { site: "PgErasureRequestRepository.claimNext", tables: ["governance.erasure_requests"], reason: "the worker takes the oldest in-flight request of any bank" },
  "erasure.get-by-id": { site: "PgErasureRequestRepository.get (no bank given)", tables: ["governance.erasure_requests"], reason: "operator and worker lookup by request id; REST passes the bank and tenant" },
  "access.keys-count-recorded": { site: "PgAccessRevocation.count", tables: ["governance.api_keys"], reason: "re-counts the keys this erasure request revoked, by request id and principal, after the bank's grants are gone" },
  "access.keys-count-dedicated": { site: "PgAccessRevocation.count", tables: ["governance.api_keys", "governance.grants", "memory.banks"], reason: "live keys of principals whose grants all target the bank: keyed through grants, not by a principal id" },
  "access.revoke-dedicated-keys": { site: "PgAccessRevocation.purge", tables: ["governance.api_keys", "governance.grants", "memory.banks"], reason: "revokes the keys of every principal dedicated to the bank being erased" },
  "access.principals-revoked-by-request": { site: "PgAccessRevocation.purge", tables: ["governance.api_keys"], reason: "evidence: principals whose keys carry this erasure request's id" },
  "api-keys.find-by-hash": { site: "PgPrincipalRepository.findByApiKeyHash", tables: ["governance.api_keys", "governance.principals"], reason: "authentication: the key is all there is before a scope exists" },
  "api-keys.revoke-by-hash": { site: "PgApiKeyStore.revoke", tables: ["governance.api_keys"], reason: "operator revocation by key" },
  "pgvector.foreign-embedders": { site: "PgvectorEngine.foreignEmbedders", tables: ["retrieval.pgvector_index"], reason: "boot and reindex check over the whole index" },
  "pin.foreign-rows": { site: "foreignRows (pin-dimensions)", tables: ["retrieval.pgvector_index"], reason: "admin pin: rows of other embedders over the whole index" },
  "pin.delete-foreign-rows": { site: "pinIndexDimensions", tables: ["retrieval.pgvector_index"], reason: "admin pin: deletes other embedders' rows over the whole index before the retype" },
  "pin.count-wrong-width": { site: "pinIndexDimensions", tables: ["retrieval.pgvector_index"], reason: "admin pin: refuses when any row has another width" },
} as const satisfies Record<string, CrossBankEntry>;

export type CrossBankStatement = keyof typeof CROSS_BANK_STATEMENTS;

/** The tag that marks a statement as an allowlisted cross-bank statement. Put it first in the SQL text. */
export function crossBank(name: CrossBankStatement): string {
  return `/* cross-bank: ${name} */ `;
}

/** Reads the tag back from a statement's text; undefined for an untagged statement. */
export function crossBankTagOf(sql: string): string | undefined {
  return /^\s*\/\* cross-bank: ([a-z0-9.-]+) \*\//.exec(sql)?.[1];
}
