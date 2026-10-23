-- Governance context: principals, grants, erasure, audit. Schema owned by src/governance.

CREATE SCHEMA IF NOT EXISTS governance;

CREATE TABLE governance.principals (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('human', 'agent', 'integration')),
  display_name  text NOT NULL
);

CREATE TABLE governance.grants (
  principal_id  text NOT NULL REFERENCES governance.principals (id),
  bank_id       text NOT NULL REFERENCES memory.banks (id),
  capabilities  text[] NOT NULL,
  granted_at    timestamptz NOT NULL,
  expires_at    timestamptz,
  PRIMARY KEY (principal_id, bank_id)
);

CREATE TABLE governance.erasure_requests (
  id             text PRIMARY KEY,
  tenant_id      text NOT NULL,
  bank_id        text NOT NULL,
  subject_id     text NOT NULL,
  requested_by   text NOT NULL,
  requested_at   timestamptz NOT NULL,
  state          text NOT NULL CHECK (state IN ('requested', 'inventoried', 'deleted', 'verified', 'receipted', 'failed')),
  inventory      jsonb NOT NULL DEFAULT '[]',
  verifications  jsonb NOT NULL DEFAULT '[]',
  receipt        jsonb,
  failure        text
);

-- Audit log: append-only, hash-chained. Never updated or deleted, not even during erasure
-- (entries hold ids and counts only, never memory content).
CREATE TABLE governance.audit_log (
  seq           bigint PRIMARY KEY,
  tenant_id     text NOT NULL,
  bank_id       text,
  principal_id  text NOT NULL,
  action        text NOT NULL,
  details       jsonb NOT NULL,
  at            timestamptz NOT NULL,
  prev_hash     text NOT NULL,
  hash          text NOT NULL
);
CREATE INDEX audit_log_tenant_at_idx ON governance.audit_log (tenant_id, at);

CREATE FUNCTION governance.audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'governance.audit_log is immutable' USING ERRCODE = 'restrict_violation';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON governance.audit_log
  FOR EACH ROW EXECUTE FUNCTION governance.audit_log_immutable();
