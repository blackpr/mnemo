-- Erasure workflow: per-store deletion records and one in-flight request per bank.
-- The table itself was created in 0001_governance; this adds what the workflow needs.

ALTER TABLE governance.erasure_requests
  ADD COLUMN deletions   jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now();

-- A second erasure for a bank while one is still running is refused by the database, not just
-- by the application: only receipted and failed requests are terminal.
CREATE UNIQUE INDEX erasure_requests_in_flight_idx ON governance.erasure_requests (bank_id)
  WHERE state NOT IN ('receipted', 'failed');
CREATE INDEX erasure_requests_bank_idx ON governance.erasure_requests (bank_id, requested_at);
