-- Erasure counts and deletes grants by bank; the primary key (principal_id, bank_id) does not serve that.
CREATE INDEX grants_bank_idx ON governance.grants (bank_id);
