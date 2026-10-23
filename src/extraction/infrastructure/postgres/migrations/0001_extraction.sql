-- Extraction context: work queue, idempotency record and write-path cost ledger. Schema owned by src/extraction.

CREATE SCHEMA IF NOT EXISTS extraction;

CREATE TABLE extraction.runs (
  episode_id       text PRIMARY KEY,
  bank_id          text NOT NULL,
  tenant_id        text NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'dead', 'skipped')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL,
  claimed_at       timestamptz,
  finished_at      timestamptz,
  extractor        jsonb,
  reason           text,
  error            text,
  input_tokens     integer,
  output_tokens    integer,
  latency_ms       integer,
  candidates       integer,
  asserted         integer,
  superseded       integer,
  invalidated      integer,
  historical       integer,
  rejected         integer
);
-- The worker's claim query: due rows in arrival order.
CREATE INDEX runs_due_idx ON extraction.runs (next_attempt_at, episode_id) WHERE status IN ('pending', 'failed', 'running');
CREATE INDEX runs_bank_status_idx ON extraction.runs (bank_id, status);
