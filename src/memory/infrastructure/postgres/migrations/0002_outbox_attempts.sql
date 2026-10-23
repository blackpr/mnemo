-- Delivery bookkeeping so one poison event cannot stall the relay forever.
-- failed_at set = dead-lettered: excluded from draining, kept for inspection and manual replay.
-- next_attempt_at implements exponential backoff so a transient outage does not burn through attempts.
ALTER TABLE memory.outbox
  ADD COLUMN attempts         integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error       text,
  ADD COLUMN next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN failed_at        timestamptz;

DROP INDEX memory.outbox_unpublished_idx;
CREATE INDEX outbox_unpublished_idx ON memory.outbox (next_attempt_at, id) WHERE published_at IS NULL AND failed_at IS NULL;
