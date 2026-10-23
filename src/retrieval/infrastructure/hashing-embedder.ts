import type { Embedder } from "../ports/embedder.js";

/**
 * Deterministic bag-of-words embedder: each token is hashed to a dimension and a sign,
 * the vector is L2-normalized. No network, no model. Good enough for contract tests and
 * offline development (lexical overlap ranks correctly); not for production recall quality.
 */
export class HashingEmbedder implements Embedder {
  readonly id: string;

  constructor(readonly dimensions = 256) {
    this.id = `hashing-${dimensions}`;
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): readonly number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    const tokens = tokenize(text);
    for (const tok of tokens) {
      const h = fnv1a(tok);
      const idx = h % this.dimensions;
      const sign = (h >>> 31) & 1 ? -1 : 1;
      v[idx] = (v[idx] ?? 0) + sign;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (norm === 0) {
      v[0] = 1; // empty text: a fixed unit vector, so cosine distance is defined
      return v;
    }
    return v.map((x) => x / norm);
  }
}

const STOP = new Set(["the", "a", "an", "is", "are", "was", "were", "i", "my", "me", "do", "does", "of", "to", "in", "on", "and", "or", "which", "what", "use"]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOP.has(t));
}

/** 32-bit FNV-1a. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
