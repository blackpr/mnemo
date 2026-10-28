-- Prompt-cache accounting (extract-v3): tokens the provider served from or wrote to its prompt cache on the
-- recorded attempt. Both are subsets of input_tokens, which stays the nominal count, so existing sums are unchanged.
ALTER TABLE extraction.runs
  ADD COLUMN cached_input_tokens integer,
  ADD COLUMN cache_write_tokens integer;
