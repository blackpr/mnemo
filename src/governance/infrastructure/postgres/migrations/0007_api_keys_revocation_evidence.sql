-- Why a key was revoked, and by which erasure. Erasure revocation sets both (`revocation_reason = 'erasure'`,
-- `erasure_request_id` = the request whose `erasure.access_revoked` entry lists the principal); `admin revoke-key`
-- sets `revocation_reason = 'operator'`. The erasure re-count counts live keys carrying the request's id, so it is
-- independent of the grants and of any clock: "the keys this request revoked are still revoked".

ALTER TABLE governance.api_keys
  ADD COLUMN revocation_reason   text,
  ADD COLUMN erasure_request_id  text;

-- The re-count and the resumed purge look keys up by the request that revoked them.
CREATE INDEX api_keys_erasure_request_idx ON governance.api_keys (erasure_request_id) WHERE erasure_request_id IS NOT NULL;
