/**
 * The question set schema. One line per question in `questions.jsonl`. A drafted question is
 * `audited: false` until the answer key has been checked against the transcript (`auditedBy` says
 * by whom); corrections and drops are logged in `answer-key-log.md`, never silently applied.
 */
import { z } from "zod";

export const QUESTION_TYPES = ["preference", "fact", "decision", "temporal", "negative"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const questionSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  question: z.string().min(1),
  /** For `negative`, the key states that the corpus holds no answer (and what exactly is missing). */
  answerKey: z.string().min(1),
  /** `temporal` only: the instant the question is asked about; arms pass it to recall, the grader expects the state at that time. */
  asOf: z.iso.datetime({ offset: true }).optional(),
  type: z.enum(QUESTION_TYPES),
  evidenceTurnIndexes: z.array(z.number().int().nonnegative()).default([]),
  audited: z.boolean(),
  /** Who settled the key: a model re-reading the transcript (stage 2) or a human. The plan wants a human audit; this keeps the two distinguishable. */
  auditedBy: z.enum(["model", "human"]).optional(),
  note: z.string().optional(),
});

export type Question = z.infer<typeof questionSchema>;

export function parseQuestionsJsonl(text: string): Question[] {
  const out: Question[] = [];
  const ids = new Set<string>();
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    const parsed = questionSchema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`questions.jsonl line ${i + 1}: ${parsed.error.message}`);
    if (ids.has(parsed.data.id)) throw new Error(`questions.jsonl line ${i + 1}: duplicate id ${parsed.data.id}`);
    ids.add(parsed.data.id);
    out.push(parsed.data);
  });
  return out;
}

/** The rubric the grader sees for one question (the frozen grader prompt wraps it). Shared by the eval and the grader sanity cases. */
export function rubricFor(q: Pick<Question, "question" | "type" | "answerKey" | "asOf">): string {
  const lines = [`Question: ${q.question}`, `Type: ${q.type}`];
  if (q.asOf) lines.push(`As of: ${q.asOf}`);
  lines.push(`Answer key: ${q.answerKey}`);
  return lines.join("\n");
}
