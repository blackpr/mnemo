import { describe, expect, it } from "vitest";
import { interleaveTypes, selectQuestions, toTestCase } from "./load.js";
import { parseQuestionsJsonl, rubricFor, type Question } from "./schema.js";

const q = (id: string, conversationId: string, type: Question["type"], extra: Partial<Question> = {}): Question => ({ id, conversationId, type, question: `Q ${id}`, answerKey: `A ${id}`, evidenceTurnIndexes: [], audited: false, ...extra });

const set: Question[] = [
  q("c1-1", "c1", "fact"),
  q("c1-2", "c1", "fact"),
  q("c1-3", "c1", "decision"),
  q("c1-4", "c1", "negative"),
  q("c1-5", "c1", "temporal", { asOf: "2026-06-15T00:00:00.000Z", audited: true }),
  q("c2-1", "c2", "preference"),
  q("c2-2", "c2", "negative"),
  q("c3-1", "c3", "fact"),
];

describe("question selection", () => {
  it("interleaves types within a conversation and keeps conversation order", () => {
    expect(interleaveTypes(set).map((x) => x.id)).toEqual(["c1-1", "c1-3", "c1-5", "c1-4", "c1-2", "c2-1", "c2-2", "c3-1"]);
  });

  it("caps per conversation and overall, so a small run still covers every type", () => {
    expect(selectQuestions(set, { EVAL_MAX_PER_CONVERSATION: "3", EVAL_MAX_CONVERSATIONS: "2" }).map((x) => x.id)).toEqual(["c1-1", "c1-3", "c1-5", "c2-1", "c2-2"]);
    expect(selectQuestions(set, { EVAL_MAX_QUESTIONS: "2" }).map((x) => x.id)).toEqual(["c1-1", "c1-3"]);
    expect(selectQuestions(set, { EVAL_CONVERSATIONS: "c3" }).map((x) => x.id)).toEqual(["c3-1"]);
    expect(selectQuestions(set, { EVAL_REQUIRE_AUDITED: "1" }).map((x) => x.id)).toEqual(["c1-5"]);
  });

  it("builds a promptfoo test with the rubric as a var (template syntax in a key must survive rendering)", () => {
    const t = toTestCase(set[4] as Question);
    expect(t.vars).toEqual({ question: "Q c1-5", conversationId: "c1", questionId: "c1-5", type: "temporal", asOf: "2026-06-15T00:00:00.000Z", rubric: "Question: Q c1-5\nType: temporal\nAs of: 2026-06-15T00:00:00.000Z\nAnswer key: A c1-5" });
    expect(t.assert).toEqual([{ type: "llm-rubric", value: "{{ rubric }}" }]);
    expect(rubricFor(set[0] as Question)).toBe("Question: Q c1-1\nType: fact\nAnswer key: A c1-1");
    const templated = toTestCase(q("c9-1", "c9", "fact", { answerKey: "The layout uses {{ page.title }} and {% if %} blocks" }));
    expect(templated.vars?.rubric).toContain("{{ page.title }} and {% if %}");
    expect(templated.assert?.[0]).toEqual({ type: "llm-rubric", value: "{{ rubric }}" });
  });

  it("rejects malformed or duplicate question lines", () => {
    expect(() => parseQuestionsJsonl('{"id":"x"}')).toThrow(/line 1/);
    const line = JSON.stringify(set[0]);
    expect(() => parseQuestionsJsonl(`${line}\n${line}`)).toThrow(/duplicate id/);
    expect(parseQuestionsJsonl(line)).toHaveLength(1);
  });
});
