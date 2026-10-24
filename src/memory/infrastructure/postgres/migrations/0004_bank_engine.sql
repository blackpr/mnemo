-- Which retrieval engine holds a bank's derived index (pgvector, hindsight, honcho). Recorded when the
-- bank is created (the server's ENGINE) and changed only by `admin reindex` when it moves the bank to
-- another engine, so erasure purges the engine that actually holds the bank and refuses when the
-- running engine differs. Existing banks are backfilled with 'pgvector', the default engine; a deployment that
-- ran with ENGINE=hindsight or honcho before this migration must set the column once (the server warns at boot
-- about banks whose engine is not its own): UPDATE memory.banks SET engine = '<engine>' WHERE status <> 'erased'.
ALTER TABLE memory.banks ADD COLUMN engine text NOT NULL DEFAULT 'pgvector';
ALTER TABLE memory.banks ALTER COLUMN engine DROP DEFAULT;
