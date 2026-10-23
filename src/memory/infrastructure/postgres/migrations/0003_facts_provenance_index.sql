-- Extraction idempotency lookup: facts produced while processing a given trigger episode.
CREATE INDEX facts_provenance_trigger_idx ON memory.facts (bank_id, (provenance ->> 'triggerEpisodeId'));
