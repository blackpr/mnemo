-- Memory context: system of record. Schema owned by src/memory.

CREATE SCHEMA IF NOT EXISTS memory;

CREATE TABLE memory.banks (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  subject_id  text NOT NULL,
  status      text NOT NULL CHECK (status IN ('active', 'frozen', 'erasing', 'erased')),
  policy      jsonb NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX banks_tenant_subject_idx ON memory.banks (tenant_id, subject_id);

-- Episodes: append-only. UPDATE is never allowed; DELETE only while the session flag
-- mem.erasure = 'on' is set by the Erasure workflow (Governance).
CREATE TABLE memory.episodes (
  id            text PRIMARY KEY,
  bank_id       text NOT NULL REFERENCES memory.banks (id),
  kind          text NOT NULL CHECK (kind IN ('conversation_turn', 'tool_result', 'imported_document', 'system_note')),
  source        text NOT NULL,
  role          text CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  text          text NOT NULL,
  occurred_at   timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL,
  recorded_by   text NOT NULL,
  external_ref  text,
  UNIQUE (bank_id, external_ref)
);
CREATE INDEX episodes_bank_occurred_idx ON memory.episodes (bank_id, occurred_at);

CREATE FUNCTION memory.episodes_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'memory.episodes is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('mem.erasure', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'memory.episodes rows may only be deleted during erasure' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER episodes_append_only
  BEFORE UPDATE OR DELETE ON memory.episodes
  FOR EACH ROW EXECUTE FUNCTION memory.episodes_append_only();

-- Facts: bi-temporal. valid_from/valid_to = world time; recorded_at/retracted_at = transaction time.
-- Supersession and invalidation close intervals and link; rows are only removed by erasure.
CREATE TABLE memory.facts (
  id                text PRIMARY KEY,
  bank_id           text NOT NULL REFERENCES memory.banks (id),
  statement         text NOT NULL,
  predicate         jsonb,
  valid_from        timestamptz NOT NULL,
  valid_to          timestamptz,
  recorded_at       timestamptz NOT NULL,
  retracted_at      timestamptz,
  provenance        jsonb NOT NULL,
  supersedes_id     text REFERENCES memory.facts (id),
  superseded_by_id  text REFERENCES memory.facts (id),
  invalidation      jsonb,
  CHECK (valid_to IS NULL OR valid_from <= valid_to),
  CHECK (retracted_at IS NULL OR recorded_at <= retracted_at),
  CHECK (jsonb_array_length(provenance -> 'sourceEpisodeIds') >= 1)
);
CREATE INDEX facts_bank_current_idx ON memory.facts (bank_id) WHERE retracted_at IS NULL;
CREATE INDEX facts_bank_validity_idx ON memory.facts (bank_id, valid_from, valid_to);

CREATE FUNCTION memory.facts_no_delete() RETURNS trigger AS $$
BEGIN
  IF current_setting('mem.erasure', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'memory.facts rows may only be deleted during erasure' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER facts_no_delete
  BEFORE DELETE ON memory.facts
  FOR EACH ROW EXECUTE FUNCTION memory.facts_no_delete();

-- Transactional outbox: events written in the same transaction as the state change.
CREATE TABLE memory.outbox (
  id            bigserial PRIMARY KEY,
  type          text NOT NULL,
  occurred_at   timestamptz NOT NULL,
  tenant_id     text NOT NULL,
  bank_id       text NOT NULL,
  payload       jsonb NOT NULL,
  published_at  timestamptz
);
CREATE INDEX outbox_unpublished_idx ON memory.outbox (id) WHERE published_at IS NULL;
