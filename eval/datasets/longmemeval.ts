/**
 * LongMemEval-S (Wu et al. 2025, MIT; the authors' `longmemeval-cleaned` release, see SOURCES.md)
 * to our corpus and question formats. Pure: `convertLongMemEval` takes the parsed file and the
 * sampling options and returns conversations, questions and a manifest; `build.ts` does the IO.
 *
 * Shape of the benchmark: 500 questions, each with its own timestamped haystack of about 50
 * user-assistant chat sessions (about 115k tokens), of which one or a few are the evidence
 * sessions (`answer_session_ids`). Running every arm over a 115k-token haystack per question is far
 * outside this session's budget (arm A alone would be about 0.5 USD per question, the extracting
 * arms many times that), so the subset is built differently and that is the main caveat on the
 * numbers: the sampled questions are grouped into a few synthetic "users", and a user's history is
 * the union of the evidence sessions of all of that user's questions, ordered by the dataset's own
 * session timestamps. The other questions' sessions are the distractors. Every question keeps every
 * evidence session it needs, but the haystack is a fraction of LongMemEval-S's, so the task is easier
 * than the published benchmark and the per-question history is shared across the user's questions
 * (which is also what makes arms B, C and D affordable: one ingestion per user, not per question).
 *
 * Type mapping (ours ← theirs): fact ← single-session-user, single-session-assistant, multi-session;
 * preference ← single-session-preference; decision ← knowledge-update; temporal ← temporal-reasoning;
 * negative ← any question whose id ends in `_abs` (abstention; the dataset's answer already says the
 * information was never mentioned). The dataset's own type is kept in `datasetCategory`.
 * Temporal questions get `asOf` = the dataset's `question_date` (their answers depend on it).
 */
import { z } from "zod";
import { approxTokens, type Turn } from "../corpus/normalize.js";
import type { Question, QuestionType } from "../questions/schema.js";
import { chunkLines, parseLongMemEvalDate, seededShuffle, type CorpusConversation } from "./common.js";

export const LME_QUESTION_TYPES = ["single-session-user", "single-session-assistant", "single-session-preference", "temporal-reasoning", "knowledge-update", "multi-session"] as const;

const turnSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string(), has_answer: z.boolean().optional() });

export const lmeItemSchema = z.object({
  question_id: z.string().min(1),
  question_type: z.enum(LME_QUESTION_TYPES),
  question: z.string().min(1),
  answer: z.union([z.string(), z.number()]),
  question_date: z.string().min(1),
  haystack_session_ids: z.array(z.string().min(1)),
  haystack_dates: z.array(z.string().min(1)),
  haystack_sessions: z.array(z.array(turnSchema)),
  answer_session_ids: z.array(z.string().min(1)),
});
export type LmeItem = z.infer<typeof lmeItemSchema>;
export const lmeFileSchema = z.array(lmeItemSchema);

export const isAbstention = (q: Pick<LmeItem, "question_id">): boolean => q.question_id.endsWith("_abs");

export function ourTypeOf(q: Pick<LmeItem, "question_id" | "question_type">): QuestionType {
  if (isAbstention(q)) return "negative";
  switch (q.question_type) {
    case "single-session-user":
    case "single-session-assistant":
    case "multi-session":
      return "fact";
    case "single-session-preference":
      return "preference";
    case "knowledge-update":
      return "decision";
    case "temporal-reasoning":
      return "temporal";
  }
}

export const datasetCategoryOf = (q: Pick<LmeItem, "question_id" | "question_type">): string => (isAbstention(q) ? `abstention (${q.question_type})` : q.question_type);

export interface LmeOptions {
  /** Questions per our type (five types). */
  readonly perType: number;
  /** Synthetic users the sample is spread over (round-robin within each type: perType / users questions of each type per user when it divides, as even as possible otherwise). */
  readonly users: number;
  readonly seed: number;
  readonly maxChunkChars?: number;
}

export interface LmeManifest {
  readonly dataset: "longmemeval-s";
  readonly seed: number;
  readonly perType: number;
  readonly users: readonly { conversationId: string; questionIds: string[]; sessionIds: string[]; chunks: number; approxTokens: number }[];
  readonly byDatasetCategory: Record<string, number>;
}

interface EvidenceSession {
  readonly sessionId: string;
  readonly occurredAt: string;
  readonly turns: readonly z.infer<typeof turnSchema>[];
}

function evidenceSessions(q: LmeItem): EvidenceSession[] {
  const out: EvidenceSession[] = [];
  for (const sessionId of q.answer_session_ids) {
    const i = q.haystack_session_ids.indexOf(sessionId);
    if (i < 0) throw new Error(`${q.question_id}: evidence session ${sessionId} is not in its haystack`);
    const turns = q.haystack_sessions[i];
    const date = q.haystack_dates[i];
    if (!turns || !date) throw new Error(`${q.question_id}: haystack arrays are not aligned at ${i}`);
    out.push({ sessionId, occurredAt: parseLongMemEvalDate(date), turns });
  }
  return out;
}

/** Stratified by our type, round-robin over the dataset's own types inside `fact`, seeded. */
export function sampleLme(items: readonly LmeItem[], opts: LmeOptions): LmeItem[] {
  const byType = new Map<QuestionType, LmeItem[]>();
  for (const q of items) byType.set(ourTypeOf(q), [...(byType.get(ourTypeOf(q)) ?? []), q]);
  const out: LmeItem[] = [];
  let salt = 0;
  for (const type of ["preference", "fact", "decision", "temporal", "negative"] as const) {
    const pool = byType.get(type) ?? [];
    // Spread over the dataset's own types (fact has three, negative has several) before cutting to perType.
    const subPools = new Map<string, LmeItem[]>();
    for (const q of seededShuffle(pool, opts.seed + salt++)) subPools.set(q.question_type, [...(subPools.get(q.question_type) ?? []), q]);
    const queues = [...subPools.values()];
    const picked: LmeItem[] = [];
    while (picked.length < opts.perType && queues.some((qs) => qs.length > 0)) for (const qs of queues) if (picked.length < opts.perType && qs.length > 0) picked.push(qs.shift() as LmeItem);
    if (picked.length < opts.perType) throw new Error(`LongMemEval has only ${picked.length} questions of type ${type}; asked for ${opts.perType}`);
    out.push(...picked);
  }
  return out;
}

export function convertLongMemEval(items: readonly LmeItem[], opts: LmeOptions): { conversations: CorpusConversation[]; questions: Question[]; manifest: LmeManifest } {
  const sampled = sampleLme(items, opts);
  const userOf = new Map<string, number>();
  // Round-robin within each type so every user gets the same type mix.
  const counters = new Map<QuestionType, number>();
  for (const q of sampled) {
    const t = ourTypeOf(q);
    const k = counters.get(t) ?? 0;
    counters.set(t, k + 1);
    userOf.set(q.question_id, k % opts.users);
  }
  const conversations: CorpusConversation[] = [];
  const questions: Question[] = [];
  const manifestUsers: LmeManifest["users"][number][] = [];
  for (let u = 0; u < opts.users; u++) {
    const conversationId = `lmes${String(u + 1).padStart(2, "0")}`;
    const mine = sampled.filter((q) => userOf.get(q.question_id) === u);
    const sessions = new Map<string, EvidenceSession>();
    for (const q of mine) for (const s of evidenceSessions(q)) sessions.set(s.sessionId, s);
    const ordered = [...sessions.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.sessionId.localeCompare(b.sessionId));
    const turns: Turn[] = [];
    const chunkIndexesOf = new Map<string, number[]>();
    for (const s of ordered) {
      const lines = s.turns.map((t) => `${t.role}: ${t.content.trim()}`);
      const indexes: number[] = [];
      for (const chunk of chunkLines(lines, opts.maxChunkChars)) {
        indexes.push(turns.length);
        turns.push({ conversationId, turnIndex: turns.length, role: "user", text: chunk, occurredAt: s.occurredAt });
      }
      chunkIndexesOf.set(s.sessionId, indexes);
    }
    conversations.push({ conversationId, project: "longmemeval-s", turns });
    for (const q of mine) {
      const type = ourTypeOf(q);
      questions.push({
        id: `lme-${q.question_id}`,
        conversationId,
        question: q.question,
        answerKey: type === "negative" ? `${String(q.answer)} (The conversations do not contain this information; a confident specific answer is wrong.)` : String(q.answer),
        ...(type === "temporal" ? { asOf: parseLongMemEvalDate(q.question_date) } : {}),
        type,
        evidenceTurnIndexes: q.answer_session_ids.flatMap((sid) => chunkIndexesOf.get(sid) ?? []),
        audited: true,
        auditedBy: "dataset",
        datasetCategory: datasetCategoryOf(q),
        note: `LongMemEval-S ${q.question_id} (${q.question_type}); question_date ${q.question_date}`,
      });
    }
    manifestUsers.push({ conversationId, questionIds: mine.map((q) => q.question_id), sessionIds: ordered.map((s) => s.sessionId), chunks: turns.length, approxTokens: turns.reduce((n, t) => n + approxTokens(t.text), 0) });
  }
  const byDatasetCategory: Record<string, number> = {};
  for (const q of questions) byDatasetCategory[q.datasetCategory ?? "?"] = (byDatasetCategory[q.datasetCategory ?? "?"] ?? 0) + 1;
  return { conversations, questions, manifest: { dataset: "longmemeval-s", seed: opts.seed, perType: opts.perType, users: manifestUsers, byDatasetCategory } };
}
