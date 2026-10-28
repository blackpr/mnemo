import { describe, expect, it } from "vitest";
import { asBankId, asEpisodeId, asFactId } from "../../src/shared-kernel/index.js";
import { assertFact, type Fact } from "../../src/memory/index.js";
import type { RankedHit, RetrievalEngine } from "../../src/retrieval/index.js";
import { namedEntities, RelevanceCandidateSelector, sharedEntities, tokenSet } from "../../src/extraction/index.js";
import { alice, episodeFixture, factFixture, scopeFor } from "../helpers/fixtures.js";

const bank = asBankId("b");
const scope = scopeFor(bank);

/** An engine whose ranking is scripted: the candidate selector only needs `recall`. */
function engineReturning(ids: readonly string[] | Error, seen: { query?: string; limit?: number; includeEpisodes?: boolean } = {}): RetrievalEngine {
  const unused = () => Promise.reject(new Error("not used by the selector"));
  return {
    name: "scripted",
    recall: async (_scope, query, options) => {
      seen.query = query;
      seen.limit = options.limit;
      seen.includeEpisodes = options.includeEpisodes ?? false;
      if (ids instanceof Error) throw ids;
      const hits: RankedHit[] = ids.map((id, i) => ({ factId: asFactId(id), score: 1 - i / 100 }));
      return hits;
    },
    indexFact: unused,
    indexEpisode: unused,
    retractFact: unused,
    countBank: unused,
    purgeBank: unused,
    rebuild: unused,
  };
}

/** Like factFixture, with the trigger episode and recording time an extracted fact carries. */
const extracted = (id: string, statement: string, triggerEpisodeId: string, recordedAt: Date, validFrom = new Date("2026-01-01T00:00:00Z")): Fact => {
  const r = assertFact(
    { id: asFactId(id), bankId: bank, statement, validity: { validFrom }, provenance: { sourceEpisodeIds: [asEpisodeId(triggerEpisodeId)], triggerEpisodeId: asEpisodeId(triggerEpisodeId), writerPrincipalId: alice, confirmation: "asserted" } },
    recordedAt,
  );
  if (!r.ok) throw new Error("fixture");
  return r.value;
};

describe("RelevanceCandidateSelector", () => {
  const berlin = factFixture(bank, "f-berlin", "The Subject lives in Berlin");
  const coffee = factFixture(bank, "f-coffee", "The Subject drinks espresso every morning");
  const cat = factFixture(bank, "f-cat", "The Subject has a cat called Mina");
  const ferns = Array.from({ length: 5 }, (_, i) => factFixture(bank, `f-fern-${i}`, `The Subject owns ${i + 2} potted ferns`));
  const current = [berlin, coffee, cat, ...ferns];
  const quiet = { warn: () => undefined };
  const trigger = episodeFixture(bank, "e-1", "I moved to Lisbon last month, Berlin was too cold. Still drinking espresso though.");

  it("shows every fact, without an embedding call, when the bank has no more current facts than k", async () => {
    const seen: { query?: string } = {};
    const out = await new RelevanceCandidateSelector(engineReturning(["f-cat"], seen), { topK: 20 }).select(scope, trigger, [], current);
    expect(out).toEqual(current);
    expect(seen.query).toBeUndefined();
  });

  it("takes the engine's top-k facts (facts only, episode text as the query) and keeps the bank's order", async () => {
    const seen: { query?: string; limit?: number; includeEpisodes?: boolean } = {};
    const out = await new RelevanceCandidateSelector(engineReturning(["f-fern-3", "f-coffee"], seen), { topK: 2, recentFacts: 0, maxQueryChars: 30 }).select(scope, trigger, [], current);
    expect(seen).toEqual({ query: trigger.text.slice(0, 30), limit: 4, includeEpisodes: false }); // over-fetch 2k
    // f-berlin comes in through the entity match, in bank order; f-cat and the other ferns are left out.
    expect(out.map((f) => f.id)).toEqual(["f-berlin", "f-coffee", "f-fern-3"]);
  });

  it("a fact beyond k by similarity is still a candidate when the episode mentions an entity from its statement, whatever the episode's case", async () => {
    const lower = episodeFixture(bank, "e-2", "i moved to lisbon last month, berlin was too cold");
    const out = await new RelevanceCandidateSelector(engineReturning(["f-fern-0"]), { topK: 1, recentFacts: 0 }).select(scope, lower, [], current);
    expect(out.map((f) => f.id)).toEqual(["f-berlin", "f-fern-0"]);
  });

  it("facts extracted from the context episodes and the most recently recorded facts are always shown (the index may not hold them yet)", async () => {
    const t = (s: number) => new Date(2026, 5, 1, 0, 0, s);
    const fromPrev = extracted("f-prev", "The Subject started a pottery course", "e-prev", t(1));
    const newest = extracted("f-newest", "The Subject prefers oat milk", "e-other", t(9));
    const older = extracted("f-older", "The Subject runs on Sundays", "e-old", t(2));
    const all = [...current, fromPrev, newest, older];
    const prev = episodeFixture(bank, "e-prev", "I signed up for a pottery course");
    const out = await new RelevanceCandidateSelector(engineReturning(["f-fern-0"]), { topK: 1, recentFacts: 1, maxCandidates: 10 }).select(scope, trigger, [prev], all);
    expect(out.map((f) => f.id)).toEqual(["f-berlin", "f-fern-0", "f-prev", "f-newest"]);
  });

  it("entity additions are capped at 2k by the number of shared entities; short all-caps tokens are not entities", async () => {
    const tech = Array.from({ length: 10 }, (_, i) => factFixture(bank, `f-tech-${i}`, `The Subject uses Postgres${i === 0 ? " and Lisbon" : ""} for project ${i}`));
    const ep = episodeFixture(bank, "e-3", "Switching the Lisbon project from Postgres to the JSON API");
    const out = await new RelevanceCandidateSelector(engineReturning(["f-fern-0"]), { topK: 1, recentFacts: 0 }).select(scope, ep, [], [...current, ...tech]);
    expect(out.map((f) => f.id)).toEqual(["f-fern-0", "f-tech-0", "f-tech-1"]); // cap 2: f-tech-0 (two shared entities) first, then one more; Berlin is not mentioned
    expect(namedEntities("The Subject uses the JSON API in USD and TypeScript")).toEqual(new Set(["TypeScript"]));
  });

  it("falls back to the newest k facts, with one warning, when the engine fails or returns no current fact; rejects a non-positive k", async () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    const none = await new RelevanceCandidateSelector(engineReturning([]), { topK: 2, recentFacts: 0, warn }).select(scope, trigger, [], current);
    expect(none.map((f) => f.id)).toEqual(["f-berlin", "f-fern-3", "f-fern-4"]);
    const stale = await new RelevanceCandidateSelector(engineReturning(["f-gone", "f-superseded"]), { topK: 2, recentFacts: 0, warn }).select(scope, trigger, [], current);
    expect(stale.map((f) => f.id)).toEqual(["f-berlin", "f-fern-3", "f-fern-4"]);
    const failed = await new RelevanceCandidateSelector(engineReturning(new Error("embedder down")), { topK: 2, recentFacts: 0, warn }).select(scope, trigger, [], current);
    expect(failed.map((f) => f.id)).toEqual(["f-berlin", "f-fern-3", "f-fern-4"]);
    expect(warnings).toHaveLength(3); // one per call
    expect(warnings[2]).toMatch(/embedder down/);
    const mixed = await new RelevanceCandidateSelector(engineReturning(["f-gone", "f-cat"]), { topK: 1, recentFacts: 0, ...quiet }).select(scope, trigger, [], current);
    expect(mixed.map((f) => f.id)).toEqual(["f-berlin", "f-cat"]); // the non-current hit does not count against k
    expect(() => new RelevanceCandidateSelector(engineReturning([]), { topK: 0 })).toThrow(/positive/);
  });

  it("a short reply is matched with the preceding turn: query and entities come from both", async () => {
    const seen: { query?: string } = {};
    const question = { ...episodeFixture(bank, "e-q", "Are you still living in Berlin?"), role: "assistant" as const };
    const reply = episodeFixture(bank, "e-r", "No, Porto now");
    const out = await new RelevanceCandidateSelector(engineReturning(["f-fern-1"], seen), { topK: 1, recentFacts: 0 }).select(scope, reply, [question], current);
    expect(seen.query).toBe("Are you still living in Berlin?\nNo, Porto now");
    expect(out.map((f) => f.id)).toEqual(["f-berlin", "f-fern-1"]);
  });

  it("the selection is cut by rank, not by date: similarity hits survive a flood of context-episode facts", async () => {
    const t = (s: number) => new Date(2026, 5, 1, 0, 0, s);
    const flood = Array.from({ length: 30 }, (_, i) => extracted(`f-ctx-${i}`, `The Subject mentioned detail number ${i}`, "e-prev", t(i + 1), new Date(2026, 5, 2)));
    const prev = episodeFixture(bank, "e-prev", "a long session");
    const all = [...current, ...flood];
    // Rank: the similarity hit, one context fact (capped at k, newest first), then the Berlin entity match. A date-ordered cut would have kept the newest flood facts instead.
    expect((await new RelevanceCandidateSelector(engineReturning(["f-cat"]), { topK: 1, recentFacts: 0, maxCandidates: 2 }).select(scope, trigger, [prev], all)).map((f) => f.id)).toEqual(["f-cat", "f-ctx-29"]);
    expect((await new RelevanceCandidateSelector(engineReturning(["f-cat"]), { topK: 1, recentFacts: 0, maxCandidates: 3 }).select(scope, trigger, [prev], all)).map((f) => f.id)).toEqual(["f-berlin", "f-cat", "f-ctx-29"]);
  });

  it("namedEntities and sharedEntities: capitalized words of three letters or more, minus sentence starters, boilerplate and contractions; whole-word, case-insensitive lookup", () => {
    expect([...namedEntities("Yesterday I met Ana in Porto. The Subject's cat Mina is fine. OK thanks! I'm off to Lisbon-Cascais")].sort()).toEqual(["Ana", "Lisbon-Cascais", "Mina", "Porto"]);
    expect(namedEntities("ok thanks, that worked").size).toBe(0);
    expect(sharedEntities("The Subject lives in Lisbon with Mina", tokenSet("mina and i are in LISBON-cascais now"))).toBe(2);
    expect(sharedEntities("The Subject lives in Lisbon", tokenSet("I like lisbonese food"))).toBe(0);
    expect(sharedEntities("The Subject lives in Αθήνα", tokenSet("μετακόμισα στην ΑΘΗΝΑ"))).toBe(1);
    expect(sharedEntities("The Subject lives in Αθήνα", tokenSet("αθηνα"))).toBe(1);
  });
});
