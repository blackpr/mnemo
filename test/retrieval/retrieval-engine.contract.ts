import { expect, it } from "vitest";
import { asBankId } from "../../src/shared-kernel/index.js";
import type { RetrievalEngine } from "../../src/retrieval/index.js";
import { episodeFixture, factFixture, fromArray, scopeFor } from "../helpers/fixtures.js";

/**
 * Contract every RetrievalEngine adapter must satisfy (pgvector, Hindsight, Honcho).
 * Call inside a describe() that provides a fresh engine per test via `make()`.
 * Engines hold derived state: nothing here touches memory.* tables. Hits are expected best first: an
 * engine whose store returns approximate order (pgvector's relaxed iterative scans) sorts them itself.
 */
export function retrievalEngineContract(make: () => Promise<RetrievalEngine> | RetrievalEngine): void {
  const bankA = asBankId("bank-a");
  const bankB = asBankId("bank-b");

  it("indexes a fact and recalls it by a paraphrase as the top hit", async () => {
    const engine = await make();
    await engine.indexFact(factFixture(bankA, "f1", "the user's editor is neovim"));
    await engine.indexFact(factFixture(bankA, "f2", "the user's dog is called Rex"));
    await engine.indexFact(factFixture(bankA, "f3", "the team deploys on fridays"));
    const hits = await engine.recall(scopeFor(bankA), "which editor does the user prefer, neovim or vscode?", { limit: 3 });
    expect(hits[0]?.factId).toBe("f1");
  });

  it("stops returning a fact after retractFact", async () => {
    const engine = await make();
    const f = factFixture(bankA, "f1", "the user's editor is neovim");
    await engine.indexFact(f);
    await engine.retractFact(f.id);
    const hits = await engine.recall(scopeFor(bankA), "editor neovim", { limit: 5 });
    expect(hits.find((h) => h.factId === "f1")).toBeUndefined();
  });

  it("respects asOf for point-in-time recall", async () => {
    const engine = await make();
    const old = factFixture(bankA, "f-old", "the user lives in Berlin", new Date("2026-01-01T00:00:00Z"));
    const closedOld = { ...old, validity: { validFrom: old.validity.validFrom, validTo: new Date("2026-06-01T00:00:00Z") } };
    const current = factFixture(bankA, "f-new", "the user lives in Lisbon", new Date("2026-06-01T00:00:00Z"));
    await engine.indexFact(closedOld);
    await engine.indexFact(current);

    const march = await engine.recall(scopeFor(bankA), "where does the user live", { limit: 5, asOf: new Date("2026-03-01T00:00:00Z") });
    expect(march.map((h) => h.factId)).toEqual(["f-old"]);

    const october = await engine.recall(scopeFor(bankA), "where does the user live", { limit: 5, asOf: new Date("2026-10-01T00:00:00Z") });
    expect(october.map((h) => h.factId)).toEqual(["f-new"]);
  });

  it("never returns hits from another bank", async () => {
    const engine = await make();
    await engine.indexFact(factFixture(bankB, "fb", "bank B secret: the password hint is tulip"));
    await engine.indexFact(factFixture(bankA, "fa", "bank A fact: likes espresso"));
    const hits = await engine.recall(scopeFor(bankA), "password hint tulip secret", { limit: 10 });
    expect(hits.every((h) => h.factId === "fa")).toBe(true);
  });

  it("erasure: countBank inventories the bank, purgeBank leaves zero remaining, recall returns nothing, other banks untouched", async () => {
    const engine = await make();
    await engine.indexFact(factFixture(bankA, "f1", "the user's editor is neovim"));
    await engine.indexEpisode(episodeFixture(bankA, "e1", "I switched to neovim last week"));
    await engine.indexFact(factFixture(bankB, "fb", "untouched bank B fact"));
    expect(await engine.countBank(bankA)).toBe(2);
    expect(await engine.countBank(bankB)).toBe(1);

    const result = await engine.purgeBank(bankA);
    expect(result.deleted).toBe(2);
    expect(result.remaining).toBe(0);
    expect(await engine.countBank(bankA)).toBe(0);
    expect(await engine.recall(scopeFor(bankA), "neovim editor", { limit: 10, includeEpisodes: true })).toEqual([]);
    expect(await engine.countBank(bankB)).toBe(1);
    expect((await engine.recall(scopeFor(bankB), "bank B fact", { limit: 10 })).length).toBe(1);
    // Purging an empty bank is a no-op that still proves zero.
    expect(await engine.purgeBank(bankA)).toEqual({ deleted: 0, remaining: 0 });
  });

  it("rebuild restores recall from the system of record", async () => {
    const engine = await make();
    const f = factFixture(bankA, "f1", "the user's editor is neovim");
    const e = episodeFixture(bankA, "e1", "I switched to neovim last week");
    await engine.rebuild(bankA, fromArray([f]), fromArray([e]));
    const hits = await engine.recall(scopeFor(bankA), "neovim editor", { limit: 10, includeEpisodes: true });
    expect(hits.map((h) => h.factId ?? h.episodeId).sort()).toEqual(["e1", "f1"]);
  });

  it("returns episodes only when asked", async () => {
    const engine = await make();
    await engine.indexEpisode(episodeFixture(bankA, "e1", "I switched to neovim last week"));
    expect(await engine.recall(scopeFor(bankA), "neovim", { limit: 5 })).toEqual([]);
    const withEpisodes = await engine.recall(scopeFor(bankA), "neovim", { limit: 5, includeEpisodes: true });
    expect(withEpisodes[0]?.episodeId).toBe("e1");
  });
}
