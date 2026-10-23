/**
 * promptfoo test generator (`tests: file://questions/load.ts` in promptfooconfig.yaml): one test
 * case per question, each graded by `llm-rubric` with the frozen grader prompt and this question's
 * rubric (question, type, answer key). The arms read the question and its conversation id from vars.
 *
 * Env for subsets: EVAL_CONVERSATIONS (comma-separated ids), EVAL_MAX_CONVERSATIONS, EVAL_MAX_QUESTIONS,
 * EVAL_MAX_PER_CONVERSATION (spread a small run across conversations), EVAL_REQUIRE_AUDITED=1 (skip
 * questions a human has not checked yet; a smoke run allows them).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestCase } from "promptfoo";
import { parseQuestionsJsonl, QUESTION_TYPES, rubricFor, type Question } from "./schema.js";

const QUESTIONS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "questions.jsonl");

/**
 * Within each conversation, order questions round-robin over the types (one preference, one fact, one
 * decision, one temporal, one negative, then the second of each, ...), so a capped subset still covers
 * every category instead of taking whatever the drafter listed first. Conversation order is kept.
 */
export function interleaveTypes(all: readonly Question[]): Question[] {
  const byConversation = new Map<string, Question[]>();
  for (const q of all) byConversation.set(q.conversationId, [...(byConversation.get(q.conversationId) ?? []), q]);
  const out: Question[] = [];
  for (const questions of byConversation.values()) {
    const queues = QUESTION_TYPES.map((t) => questions.filter((q) => q.type === t));
    while (queues.some((qs) => qs.length > 0)) for (const qs of queues) if (qs.length > 0) out.push(qs.shift() as Question);
  }
  return out;
}

export function selectQuestions(all: readonly Question[], env: NodeJS.ProcessEnv = process.env): Question[] {
  const only = (env.EVAL_CONVERSATIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const maxConversations = env.EVAL_MAX_CONVERSATIONS ? Number(env.EVAL_MAX_CONVERSATIONS) : Infinity;
  const maxQuestions = env.EVAL_MAX_QUESTIONS ? Number(env.EVAL_MAX_QUESTIONS) : Infinity;
  const maxPerConversation = env.EVAL_MAX_PER_CONVERSATION ? Number(env.EVAL_MAX_PER_CONVERSATION) : Infinity;
  const requireAudited = env.EVAL_REQUIRE_AUDITED === "1";
  const perConversation = new Map<string, number>();
  const out: Question[] = [];
  for (const q of interleaveTypes(all)) {
    if (requireAudited && !q.audited) continue;
    if (only.length > 0 && !only.includes(q.conversationId)) continue;
    const taken = perConversation.get(q.conversationId);
    if (taken === undefined) {
      if (perConversation.size >= maxConversations) continue;
      perConversation.set(q.conversationId, 0);
    } else if (taken >= maxPerConversation) continue;
    perConversation.set(q.conversationId, (taken ?? 0) + 1);
    out.push(q);
    if (out.length >= maxQuestions) break;
  }
  return out;
}

/**
 * promptfoo renders an assertion's `value` as a nunjucks template with the test vars, so a question or
 * key containing `{{`, `{%` or `{#` (template syntax is common in coding transcripts) would be
 * substituted or break the assertion. The rubric therefore travels as a var: a rendered variable is
 * not parsed again. The arms read only the vars they need (`evalVars`), never `rubric`.
 */
export function toTestCase(q: Question): TestCase {
  return {
    description: `${q.id} [${q.type}]`,
    vars: { question: q.question, conversationId: q.conversationId, questionId: q.id, type: q.type, asOf: q.asOf ?? "", rubric: rubricFor(q) },
    assert: [{ type: "llm-rubric", value: "{{ rubric }}" }],
    metadata: { questionId: q.id, conversationId: q.conversationId, type: q.type, audited: q.audited },
  };
}

export default async function loadTests(): Promise<TestCase[]> {
  const questions = selectQuestions(parseQuestionsJsonl(await readFile(QUESTIONS_PATH, "utf8")));
  if (questions.length === 0) throw new Error("no questions selected (check questions.jsonl and the EVAL_* filters)");
  return questions.map(toTestCase);
}
