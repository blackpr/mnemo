-- Retrieval settings: the few values the pgvector engine pins in the database rather than in the
-- environment. Today one entry pair: the embedding dimensionality the index column is typed to
-- (`pgvector.dimensions`) and the embedder id it was pinned for (`pgvector.embedder`).
--
-- The pin itself (DELETE of rows from other embedders, ALTER COLUMN embedding TYPE vector(N), the
-- HNSW index) is not a migration: migrations are plain SQL applied unconditionally at boot, and N
-- comes from the deployment (EMBEDDING_DIMENSIONS). It is `admin pin-dimensions`, an explicit,
-- idempotent operator step (src/retrieval/infrastructure/pgvector/pin-dimensions.ts); the server
-- reads this table at boot and refuses to start when its embedder does not match the pin.
CREATE TABLE retrieval.settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
