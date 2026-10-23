import { describe, expect, it } from "vitest";
import { HashingEmbedder } from "../../src/retrieval/index.js";

const cosine = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

describe("HashingEmbedder", () => {
  const e = new HashingEmbedder(128);

  it("is deterministic and unit-normalized", async () => {
    const [a] = await e.embed(["the user's editor is neovim"]);
    const [b] = await e.embed(["the user's editor is neovim"]);
    expect(a).toEqual(b);
    expect(Math.sqrt(a!.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
  });

  it("ranks lexical overlap above unrelated text", async () => {
    const [q, related, unrelated] = await e.embed(["which editor, neovim or vscode", "editor is neovim", "the dog is called Rex"]);
    expect(cosine(q!, related!)).toBeGreaterThan(cosine(q!, unrelated!));
  });

  it("handles empty text without NaN", async () => {
    const [v] = await e.embed([""]);
    expect(v!.some(Number.isNaN)).toBe(false);
    expect(Math.sqrt(v!.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
  });
});
