-- The audit chain is per tenant (each tenant's first entry has seq 0), so the key must be too.
-- The old global PRIMARY KEY (seq) made the second tenant's first append fail.
ALTER TABLE governance.audit_log DROP CONSTRAINT audit_log_pkey;
ALTER TABLE governance.audit_log ADD PRIMARY KEY (tenant_id, seq);
