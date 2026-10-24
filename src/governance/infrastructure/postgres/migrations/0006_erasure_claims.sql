-- Erasure runs as a background job: the REST handler and the admin CLI only create the request
-- (state `requested`); a worker claims it and runs the workflow. The claim is infrastructure, not a
-- state: `claim_token` / `claimed_at` say which worker pass holds the row and since when, and a row
-- whose claim is older than ERASURE_STALE_MS is retaken by the next pass (the process died mid-purge).
-- `attempts` counts claims, so a request that keeps killing its worker ends `failed` instead of
-- looping forever. Terminal rows (receipted, failed) are never claimed. Every step a pass lands
-- refreshes `claimed_at` (a heartbeat), so a slow pass that is still progressing is not retaken.
-- The worker's poll scans the in-flight rows, which the partial unique index from 0004 already covers.

ALTER TABLE governance.erasure_requests
  ADD COLUMN claim_token text,
  ADD COLUMN claimed_at  timestamptz,
  ADD COLUMN attempts    integer NOT NULL DEFAULT 0;
