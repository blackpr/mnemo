-- API keys: the credential a Principal presents to the REST/MCP attachment.
-- Only the SHA-256 hash is stored. The plaintext token is shown once at issue time.

CREATE TABLE governance.api_keys (
  key_hash      text PRIMARY KEY,
  principal_id  text NOT NULL REFERENCES governance.principals (id),
  label         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX api_keys_principal_idx ON governance.api_keys (principal_id);
