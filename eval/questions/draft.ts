/**
 * Drafts candidate questions over the corpus with the answering model and writes them to
 * `questions.jsonl` with `audited: false`. A human audits the keys (see answer-key-log.md); the
 * script never overwrites an existing file unless --force is given, so audit marks survive.
 *
 *   npm run eval:draft-questions [-- --force]
 *
 * Env: EVAL_DRAFT_CONVERSATIONS (default 8), EVAL_DRAFT_TOTAL (default 40). Conversations are
 * chosen round-robin across projects, mid-sized ones first, so the set spans more than one topic.
 */
import { generateText, Output } from "ai";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { approxTokens } from "../corpus/normalize.js";
import { loadConversation, readIndex, renderTurn, type CorpusEntry } from "../corpus/store.js";
import { costUsd, languageModel, LLM_TIMEOUT_MS } from "../llm.js";
import { QUESTION_TYPES, type Question } from "./schema.js";

export const QUESTIONS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "questions.jsonl");

const MIN_TOKENS = 2_000;
const MAX_TOKENS = 60_000;
const MIN_TURNS = 8;

const draftSchema = z.object({
  questions: z.array(
    z.object({
      type: z.enum(QUESTION_TYPES),
      question: z.string(),
      answerKey: z.string(),
      evidenceTurnIndexes: z.array(z.number().int()),
      asOf: z.string().nullable(),
      rationale: z.string(),
    }),
  ),
});

const SYSTEM = `You write evaluation questions for a personal memory system. You get one conversation between a user and a coding assistant, as numbered turns with timestamps. Draft questions the user might later ask an assistant that remembers this conversation.

Question types:
- preference: how the user likes things done (style, tools, workflow rules they stated).
- fact: a stable fact about the user, their project, tools or environment that they stated or confirmed.
- decision: what they chose, especially after considering alternatives or changing course.
- temporal: what was true at a given time, where the state changed during the conversation. Set asOf to an ISO timestamp strictly between the old and the new state, and make the answer key the state at that time (also say what it changed to later).
- negative: a plausible question in the same domain whose answer is NOT in the conversation. The answer key must start with "Not in the conversation:" and say what is missing. The correct response for such a question is to say the information is not available.

Rules:
- Every question must be answerable from this conversation alone, and phrased the way the user would ask later, without reference to "the transcript" or turn numbers (for example "What did I decide about X?", "Which port does my Y server use?").
- Prefer things the user said or explicitly confirmed over things only the assistant said; a question about the assistant's own behaviour is not wanted.
- The answer key is one short, specific sentence with the concrete value (name, number, date, option).
- Do not ask about secrets, credentials, private file paths, or trivia nobody would ask later.
- Cite the evidence turn indexes for every question (empty for negative).
- Mix: at least one negative; at least one temporal when the conversation contains a real state change (otherwise none); the rest spread over preference, fact and decision.`;

function pickConversations(entries: readonly CorpusEntry[], n: number): CorpusEntry[] {
  const eligible = entries.filter((e) => e.approxTokens >= MIN_TOKENS && e.approxTokens <= MAX_TOKENS && e.turns >= MIN_TURNS);
  const byProject = new Map<string, CorpusEntry[]>();
  for (const e of eligible) byProject.set(e.project, [...(byProject.get(e.project) ?? []), e]);
  for (const list of byProject.values()) list.sort((a, b) => b.approxTokens - a.approxTokens);
  const projects = [...byProject.keys()].sort();
  const picked: CorpusEntry[] = [];
  while (picked.length < n) {
    let progressed = false;
    for (const p of projects) {
      const next = byProject.get(p)?.shift();
      if (!next) continue;
      picked.push(next);
      progressed = true;
      if (picked.length === n) break;
    }
    if (!progressed) break;
  }
  return picked;
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  if (!force && (await access(QUESTIONS_PATH).then(() => true, () => false))) {
    throw new Error(`${QUESTIONS_PATH} exists; it may hold audit marks. Pass --force to overwrite it.`);
  }
  const wanted = Number(process.env.EVAL_DRAFT_TOTAL ?? 40);
  const conversations = pickConversations((await readIndex()).conversations, Number(process.env.EVAL_DRAFT_CONVERSATIONS ?? 8));
  if (conversations.length === 0) throw new Error("no eligible conversations in the corpus index");
  const perConversation = Math.ceil(wanted / conversations.length);
  const model = languageModel();
  const usage = { inputTokens: 0, outputTokens: 0 };
  const out: Question[] = [];

  for (const entry of conversations) {
    const turns = await loadConversation(entry.conversationId);
    const transcript = turns.map(renderTurn).join("\n\n");
    const result = await generateText({
      model,
      instructions: SYSTEM,
      prompt: `Draft exactly ${perConversation} questions for the conversation below (about ${approxTokens(transcript)} tokens, ${turns.length} turns, ${turns[0]?.occurredAt ?? "?"} to ${turns[turns.length - 1]?.occurredAt ?? "?"}).\n\n<conversation>\n${transcript}\n</conversation>`,
      output: Output.object({ schema: draftSchema, name: "question_draft" }),
      maxOutputTokens: 6_000,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    usage.inputTokens += result.usage.inputTokens ?? 0;
    usage.outputTokens += result.usage.outputTokens ?? 0;
    const drafted = result.output.questions;
    drafted.forEach((d, i) => {
      const asOf = d.asOf && !Number.isNaN(Date.parse(d.asOf)) ? new Date(d.asOf).toISOString() : undefined;
      const q: Question = {
        id: `${entry.conversationId.slice(0, 8)}-${String(i + 1).padStart(2, "0")}`,
        conversationId: entry.conversationId,
        question: d.question.trim(),
        answerKey: d.answerKey.trim(),
        type: d.type,
        evidenceTurnIndexes: d.evidenceTurnIndexes.filter((n) => n >= 0 && n < turns.length),
        audited: false,
        note: d.rationale.trim(),
        ...(asOf !== undefined ? { asOf } : {}),
      };
      out.push(q);
    });
    const byType = Object.fromEntries(QUESTION_TYPES.map((t) => [t, drafted.filter((d) => d.type === t).length]));
    console.log(`${entry.conversationId.slice(0, 8)} (${entry.project}, ~${entry.approxTokens} tokens): ${drafted.length} question(s) ${JSON.stringify(byType)}`);
  }

  await writeFile(QUESTIONS_PATH, out.map((q) => JSON.stringify(q)).join("\n") + "\n");
  const byType = Object.fromEntries(QUESTION_TYPES.map((t) => [t, out.filter((q) => q.type === t).length]));
  console.log(`Wrote ${out.length} candidate question(s) over ${conversations.length} conversation(s) to ${QUESTIONS_PATH}, all audited: false. By type: ${JSON.stringify(byType)}`);
  console.log(`Drafting spend: ${usage.inputTokens} input + ${usage.outputTokens} output tokens, about $${costUsd(usage).toFixed(3)}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
