-- An empty or malformed engine name would make every erasure of the bank fail with engine_mismatch; Retrieval owns
-- the real names, this only refuses garbage. Separate from 0004 because 0004 was already applied where it was developed.
ALTER TABLE memory.banks ADD CONSTRAINT banks_engine_name CHECK (engine ~ '^[a-z][a-z0-9_-]*$');
