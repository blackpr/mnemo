-- Retrieval context, pgvector engine. Derived state only: rebuildable from memory.facts/episodes.
-- No foreign keys to memory.* on purpose, so the engine can be dropped and rebuilt independently.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS retrieval;

-- The embedding column starts without a fixed dimension: the embedder was chosen in the spike.
-- `admin pin-dimensions` (not a migration; see 0002_settings.sql) types it to vector(N) and adds the HNSW index.
CREATE TABLE retrieval.pgvector_index (
  bank_id     text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('fact', 'episode')),
  ref_id      text NOT NULL,
  text        text NOT NULL,
  embedding   vector NOT NULL,
  embedder    text NOT NULL,
  valid_from  timestamptz,
  valid_to    timestamptz,
  retracted   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (kind, ref_id)
);
CREATE INDEX pgvector_index_bank_idx ON retrieval.pgvector_index (bank_id, kind) WHERE NOT retracted;
