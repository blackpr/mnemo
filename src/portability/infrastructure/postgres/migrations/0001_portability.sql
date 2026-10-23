-- Portability context: a record of every export taken from a bank. Schema owned by src/portability.
-- Metadata and a content digest only; the exported content itself is never stored here.

CREATE SCHEMA IF NOT EXISTS portability;

CREATE TABLE portability.exports (
  id               text PRIMARY KEY,
  tenant_id        text NOT NULL,
  bank_id          text NOT NULL REFERENCES memory.banks (id),
  principal_id     text NOT NULL,
  format           text NOT NULL CHECK (format IN ('jsonl', 'markdown', 'claude-paste', 'gemini-paste')),
  schema_version   text NOT NULL,
  fact_count       integer NOT NULL CHECK (fact_count >= 0),
  tombstone_count  integer NOT NULL CHECK (tombstone_count >= 0),
  bytes            bigint NOT NULL CHECK (bytes >= 0),
  content_sha256   text NOT NULL,
  produced_at      timestamptz NOT NULL
);
CREATE INDEX exports_bank_produced_idx ON portability.exports (bank_id, produced_at);
