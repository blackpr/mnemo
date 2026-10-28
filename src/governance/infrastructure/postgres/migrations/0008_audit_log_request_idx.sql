-- `AuditLogStore.find` (verify-receipt and erasure tooling) looks an entry up by the request id its details name. Without an
-- index that scanned the tenant's whole log, which grows with every audited read. Partial: only entries that name a request
-- (the erasure entries); the lookup's `details->>'requestId' = $n` implies the predicate.
-- The migrator runs this inside a transaction, so the build holds a SHARE lock on the log and blocks every audited write until it
-- ends. On a large log, build it by hand first without blocking (`CREATE INDEX CONCURRENTLY audit_log_request_idx ON ...` with the
-- same definition, outside a transaction); IF NOT EXISTS then makes this migration a no-op. A failed CONCURRENTLY build leaves an
-- invalid index under the name (check `SELECT indisvalid FROM pg_index WHERE indexrelid = 'governance.audit_log_request_idx'::regclass`):
-- drop it and build again before migrating, or this migration would skip it.
CREATE INDEX IF NOT EXISTS audit_log_request_idx ON governance.audit_log (tenant_id, (details->>'requestId')) WHERE details->>'requestId' IS NOT NULL;
