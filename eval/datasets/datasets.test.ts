import { describe, expect, it } from "vitest";
import { chunkLines, parseLocomoDate, parseLongMemEvalDate, sampleStratified, seededShuffle } from "./common.js";
import { convertLocomo, locomoFileSchema, renderSession, sessionsOf } from "./locomo.js";
import { convertLongMemEval, lmeFileSchema, ourTypeOf, sampleLme, type LmeItem } from "./longmemeval.js";

describe("timestamps", () => {
  it("reads LongMemEval and LoCoMo dates as UTC instants", () => {
    expect(parseLongMemEvalDate("2023/05/20 (Sat) 02:21")).toBe("2023-05-20T02:21:00.000Z");
    expect(parseLocomoDate("1:56 pm on 8 May, 2023")).toBe("2023-05-08T13:56:00.000Z");
    expect(parseLocomoDate("12:10 am on 25 December, 2022")).toBe("2022-12-25T00:10:00.000Z");
    expect(() => parseLongMemEvalDate("May 20 2023")).toThrow(/unrecognized/);
    expect(() => parseLocomoDate("8 May 2023")).toThrow(/unrecognized/);
  });
});

describe("chunking and sampling", () => {
  it("groups consecutive lines under the limit and never splits a line", () => {
    expect(chunkLines(["aaaa", "bbbb", "cccc"], 9)).toEqual(["aaaa\nbbbb", "cccc"]);
    expect(chunkLines(["x".repeat(20), "y"], 9)).toEqual(["x".repeat(20), "y"]);
    expect(chunkLines([], 9)).toEqual([]);
  });

  it("is deterministic for a seed and stratifies per group", () => {
    const xs = Array.from({ length: 20 }, (_, i) => ({ i, g: i % 2 === 0 ? "even" : "odd" }));
    expect(seededShuffle(xs, 7)).toEqual(seededShuffle(xs, 7));
    expect(seededShuffle(xs, 7)).not.toEqual(seededShuffle(xs, 8));
    const s = sampleStratified(xs, (x) => x.g, 3, 1);
    expect([...s.keys()]).toEqual(["even", "odd"]);
    expect(s.get("even")?.length).toBe(3);
    expect(s.get("even")?.every((x) => x.g === "even")).toBe(true);
  });
});

const lmeItem = (id: string, type: LmeItem["question_type"], extra: Partial<LmeItem> = {}): LmeItem => ({
  question_id: id,
  question_type: type,
  question: `Q ${id}`,
  answer: `A ${id}`,
  question_date: "2023/06/01 (Thu) 10:00",
  haystack_session_ids: [`s-${id}`, `d-${id}`],
  haystack_dates: ["2023/05/20 (Sat) 02:21", "2023/05/21 (Sun) 03:00"],
  haystack_sessions: [
    [
      { role: "user", content: `evidence for ${id}`, has_answer: true },
      { role: "assistant", content: "ok" },
    ],
    [{ role: "user", content: "distractor" }],
  ],
  answer_session_ids: [`s-${id}`],
  ...extra,
});

describe("LongMemEval conversion", () => {
  it("maps the dataset's types onto ours, abstention first", () => {
    expect(ourTypeOf({ question_id: "a", question_type: "single-session-user" })).toBe("fact");
    expect(ourTypeOf({ question_id: "a", question_type: "multi-session" })).toBe("fact");
    expect(ourTypeOf({ question_id: "a", question_type: "single-session-preference" })).toBe("preference");
    expect(ourTypeOf({ question_id: "a", question_type: "knowledge-update" })).toBe("decision");
    expect(ourTypeOf({ question_id: "a", question_type: "temporal-reasoning" })).toBe("temporal");
    expect(ourTypeOf({ question_id: "a_abs", question_type: "knowledge-update" })).toBe("negative");
  });

  it("builds one history per synthetic user from the evidence sessions only, keeps the dataset timestamps and marks temporal questions with asOf", () => {
    const items: LmeItem[] = [];
    for (const [type, n] of [["single-session-user", 3], ["single-session-assistant", 3], ["multi-session", 3], ["single-session-preference", 3], ["knowledge-update", 3], ["temporal-reasoning", 3]] as const) for (let i = 0; i < n; i++) items.push(lmeItem(`${type}-${i}`, type));
    for (let i = 0; i < 3; i++) items.push(lmeItem(`abs-${i}_abs`, "single-session-user", { answer: "You did not mention this information." }));
    expect(lmeFileSchema.parse(items)).toHaveLength(items.length);
    const { conversations, questions, manifest } = convertLongMemEval(items, { perType: 2, users: 2, seed: 1 });
    expect(conversations.map((c) => c.conversationId)).toEqual(["lmes01", "lmes02"]);
    expect(questions).toHaveLength(10);
    for (const c of conversations) {
      expect(questions.filter((q) => q.conversationId === c.conversationId)).toHaveLength(5);
      // Only evidence sessions are in the history; the distractor session of each question is not.
      expect(c.turns.every((t) => !t.text.includes("distractor"))).toBe(true);
      expect(c.turns.every((t) => t.role === "user" && t.occurredAt === "2023-05-20T02:21:00.000Z")).toBe(true);
      expect(c.turns.map((t) => t.turnIndex)).toEqual(c.turns.map((_, i) => i));
    }
    const temporal = questions.filter((q) => q.type === "temporal");
    expect(temporal).toHaveLength(2);
    expect(temporal.every((q) => q.asOf === "2023-06-01T10:00:00.000Z")).toBe(true);
    expect(questions.filter((q) => q.type !== "temporal").every((q) => q.asOf === undefined)).toBe(true);
    const negative = questions.filter((q) => q.type === "negative");
    expect(negative).toHaveLength(2);
    expect(negative.every((q) => q.answerKey.includes("do not contain this information") && q.datasetCategory?.startsWith("abstention"))).toBe(true);
    expect(questions.every((q) => q.audited && q.auditedBy === "dataset" && q.evidenceTurnIndexes.length === 1)).toBe(true);
    // The evidence turn index points at the chunk holding that question's evidence session.
    for (const q of questions) {
      const c = conversations.find((x) => x.conversationId === q.conversationId);
      expect(c?.turns[q.evidenceTurnIndexes[0] as number]?.text).toContain(`evidence for ${q.id.replace(/^lme-/, "")}`);
    }
    expect(manifest.users.map((u) => u.questionIds.length)).toEqual([5, 5]);
    // Same seed, same subset.
    expect(sampleLme(items, { perType: 2, users: 2, seed: 1 }).map((q) => q.question_id)).toEqual(sampleLme(items, { perType: 2, users: 2, seed: 1 }).map((q) => q.question_id));
  });

  it("refuses a type the dataset cannot fill", () => {
    const items = [lmeItem("k0", "knowledge-update")];
    expect(() => convertLongMemEval(items, { perType: 1, users: 1, seed: 1 })).toThrow(/only 0 questions of type preference/);
  });

  it("refuses an evidence session missing from the haystack", () => {
    const bad = lmeItem("x", "temporal-reasoning", { answer_session_ids: ["nope"] });
    expect(() => convertLongMemEval([bad, lmeItem("p", "single-session-preference"), lmeItem("f", "single-session-user"), lmeItem("k", "knowledge-update"), lmeItem("n_abs", "multi-session")], { perType: 1, users: 1, seed: 1 })).toThrow(/not in its haystack/);
  });
});

const locomoItem = (sampleId: string) => ({
  sample_id: sampleId,
  conversation: {
    speaker_a: "Ann",
    speaker_b: "Bob",
    session_1_date_time: "1:56 pm on 8 May, 2023",
    session_1: [
      { speaker: "Ann", dia_id: "D1:1", text: "I adopted a dog." },
      { speaker: "Bob", dia_id: "D1:2", text: "Nice!", img_url: ["http://example/x.jpg"], blip_caption: "a dog on a sofa" },
    ],
    session_2_date_time: "9:05 am on 10 June, 2023",
    session_2: [{ speaker: "Ann", dia_id: "D2:1", text: "The dog is called Rex." }],
  },
  qa: [
    { question: "What is the dog called?", answer: "Rex", evidence: ["D2:1"], category: 4 },
    { question: "When did Ann adopt a dog?", answer: "8 May 2023", evidence: ["D1:1"], category: 2 },
    { question: "What would Ann do with a dog?", answer: "walk it", evidence: ["D1:1", "D2:1"], category: 3 },
    { question: "Why did Ann name the dog after her cat?", adversarial_answer: "they looked alike", evidence: ["D2:1"], category: 5 },
    { question: "Which pet came first?", answer: "the dog", evidence: ["D1:1", "D2:1"], category: 1 },
  ],
});

describe("LoCoMo conversion", () => {
  it("renders one chunk per session with speaker names, captions and the session timestamp", () => {
    const item = locomoFileSchema.parse([locomoItem("conv-7")])[0]!;
    const sessions = sessionsOf(item);
    expect(sessions.map((s) => s.occurredAt)).toEqual(["2023-05-08T13:56:00.000Z", "2023-06-10T09:05:00.000Z"]);
    expect(renderSession(sessions[0]!)).toBe("Ann: I adopted a dog.\nBob: Nice! [shares a photo: a dog on a sofa]");
  });

  it("maps categories, writes the adversarial key as not answerable and points evidence at session chunks", () => {
    const { conversations, questions, manifest } = convertLocomo(locomoFileSchema.parse([locomoItem("conv-7"), locomoItem("conv-8")]), { conversations: 1, perCategory: 1, seed: 3 });
    expect(conversations).toHaveLength(1);
    const c = conversations[0]!;
    expect(c.conversationId).toMatch(/^locomo[78]$/);
    expect(c.turns).toHaveLength(2);
    expect(c.turns.every((t) => t.role === "user")).toBe(true);
    expect(questions).toHaveLength(5);
    const byCategory = Object.fromEntries(questions.map((q) => [q.datasetCategory, q]));
    expect(byCategory["4 single-hop"]?.type).toBe("fact");
    expect(byCategory["3 open-domain"]?.type).toBe("fact");
    expect(byCategory["1 multi-hop"]?.type).toBe("decision");
    expect(byCategory["2 temporal"]?.type).toBe("temporal");
    expect(byCategory["5 adversarial"]?.type).toBe("negative");
    expect(byCategory["5 adversarial"]?.answerKey).toContain("they looked alike");
    expect(byCategory["5 adversarial"]?.answerKey).toMatch(/^Not answerable/);
    expect(byCategory["4 single-hop"]?.evidenceTurnIndexes).toEqual([1]);
    expect(byCategory["1 multi-hop"]?.evidenceTurnIndexes).toEqual([0, 1]);
    expect(questions.every((q) => q.audited && q.auditedBy === "dataset" && q.asOf === undefined)).toBe(true);
    expect(manifest.conversations[0]?.sessions).toBe(2);
  });
});
