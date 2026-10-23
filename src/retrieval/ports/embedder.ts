/**
 * Embedder: turns text into vectors for the pgvector engine.
 * `id` is recorded on every indexed row so a change of embedder is detectable and
 * the index can be rebuilt. Implementations: HashingEmbedder (deterministic, offline,
 * for tests and local dev), provider-backed embedders (OpenAI, Gemini, Ollama) later.
 */
export interface Embedder {
  readonly id: string; // e.g. "hashing-256", "openai/text-embedding-3-small"
  /** Known up front for the hashing embedder and when requested explicitly; otherwise set after the first call. */
  readonly dimensions: number | undefined;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}
