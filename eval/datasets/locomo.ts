/**
 * LoCoMo (Maharana et al. 2024, Snap Research, CC BY-NC 4.0; `locomo10.json`, see SOURCES.md) to
 * our corpus and question formats. Pure: `convertLocomo` takes the parsed file and the sampling
 * options; `build.ts` does the IO.
 *
 * Shape of the benchmark: 10 very long two-person conversations (19 to 32 dated sessions, 370 to
 * 690 turns each) with 1,986 questions in five categories. One corpus turn per session (speaker
 * names kept in the text, image shares rendered as their caption) at the dataset's session
 * timestamp; both speakers are the Subject, so every chunk has role `user`. A turn with a
 * `blip_caption` (an image share; some carry no `img_url`) is rendered with the caption appended.
 *
 * Category mapping (ours ← theirs, numbering as in the file): fact ← 4 single-hop and 3 open-domain;
 * decision ← 1 multi-hop (synthesis across sessions, the closest of our types to what the engines are
 * expected to win or lose on); temporal ← 2 temporal; negative ← 5 adversarial (the question
 * presupposes something that never happened; the file gives a plausible wrong answer as
 * `adversarial_answer`, which the key quotes as the answer to reject). The dataset category is kept
 * in `datasetCategory`, so the per-category breakdown does not depend on the mapping.
 */
import { z } from "zod";
import { approxTokens, type Turn } from "../corpus/normalize.js";
import type { Question, QuestionType } from "../questions/schema.js";
import { parseLocomoDate, sampleStratified, seededShuffle, type CorpusConversation } from "./common.js";

export const LOCOMO_CATEGORIES: Record<number, { name: string; type: QuestionType }> = {
  1: { name: "multi-hop", type: "decision" },
  2: { name: "temporal", type: "temporal" },
  3: { name: "open-domain", type: "fact" },
  4: { name: "single-hop", type: "fact" },
  5: { name: "adversarial", type: "negative" },
};

const dialogTurnSchema = z.object({
  speaker: z.string().min(1),
  dia_id: z.string().min(1),
  text: z.string(),
  img_url: z.array(z.string()).optional(),
  blip_caption: z.string().optional(),
});

const qaSchema = z.object({
  question: z.string().min(1),
  answer: z.union([z.string(), z.number()]).optional(),
  adversarial_answer: z.string().optional(),
  category: z.number().int().min(1).max(5),
  evidence: z.array(z.string()).default([]),
});

export const locomoItemSchema = z.object({
  sample_id: z.string().min(1),
  qa: z.array(qaSchema),
  /** `speaker_a`, `speaker_b`, `session_N` (turn arrays) and `session_N_date_time`; validated per key below. */
  conversation: z.record(z.string(), z.unknown()),
});
export type LocomoItem = z.infer<typeof locomoItemSchema>;
export const locomoFileSchema = z.array(locomoItemSchema);

export interface LocomoSession {
  readonly number: number;
  readonly occurredAt: string;
  readonly turns: readonly z.infer<typeof dialogTurnSchema>[];
}

export function sessionsOf(item: LocomoItem): LocomoSession[] {
  const out: LocomoSession[] = [];
  for (const [key, value] of Object.entries(item.conversation)) {
    const m = /^session_(\d+)$/.exec(key);
    if (!m) continue;
    const number = Number(m[1]);
    const date = item.conversation[`session_${number}_date_time`];
    if (typeof date !== "string") throw new Error(`${item.sample_id}: session_${number} has no date`);
    out.push({ number, occurredAt: parseLocomoDate(date), turns: z.array(dialogTurnSchema).parse(value) });
  }
  return out.sort((a, b) => a.number - b.number);
}

export function renderSession(s: LocomoSession): string {
  return s.turns
    .map((t) => {
      const caption = t.blip_caption?.trim();
      const text = t.text.trim();
      return `${t.speaker}: ${text}${caption ? ` [shares a photo: ${caption}]` : ""}`;
    })
    .join("\n");
}

export interface LocomoOptions {
  /** Conversations to keep (seeded sample of the 10). */
  readonly conversations: number;
  /** Questions per dataset category per conversation. */
  readonly perCategory: number;
  readonly seed: number;
}

export interface LocomoManifest {
  readonly dataset: "locomo";
  readonly seed: number;
  readonly perCategory: number;
  readonly conversations: readonly { conversationId: string; sampleId: string; sessions: number; approxTokens: number; questions: number }[];
  readonly byDatasetCategory: Record<string, number>;
}

const conversationIdOf = (sampleId: string): string => `locomo${sampleId.replace(/^conv-/, "")}`;

export function convertLocomo(items: readonly LocomoItem[], opts: LocomoOptions): { conversations: CorpusConversation[]; questions: Question[]; manifest: LocomoManifest } {
  const chosen = seededShuffle(items, opts.seed).slice(0, opts.conversations).sort((a, b) => a.sample_id.localeCompare(b.sample_id));
  const conversations: CorpusConversation[] = [];
  const questions: Question[] = [];
  const manifestConversations: LocomoManifest["conversations"][number][] = [];
  const byDatasetCategory: Record<string, number> = {};
  for (const item of chosen) {
    const conversationId = conversationIdOf(item.sample_id);
    if (!/^[A-Za-z0-9_-]+$/.test(conversationId) || conversationId.length > 12) throw new Error(`conversation id ${conversationId} is not usable as a bank id`);
    const sessions = sessionsOf(item);
    const turnIndexOfSession = new Map<number, number>();
    const turns: Turn[] = sessions.map((s, turnIndex) => {
      turnIndexOfSession.set(s.number, turnIndex);
      return { conversationId, turnIndex, role: "user", text: renderSession(s), occurredAt: s.occurredAt };
    });
    conversations.push({ conversationId, project: "locomo", turns });
    const sampled = sampleStratified(
      item.qa.map((qa, i) => ({ qa, i })),
      (x) => String(x.qa.category),
      opts.perCategory,
      opts.seed + Number(item.sample_id.replace(/\D/g, "")),
    );
    let n = 0;
    for (const category of [1, 2, 3, 4, 5]) {
      for (const { qa, i } of sampled.get(String(category)) ?? []) {
        const cat = LOCOMO_CATEGORIES[category];
        if (!cat) continue;
        const isNegative = cat.type === "negative";
        if (!isNegative && qa.answer === undefined) throw new Error(`${item.sample_id} qa ${i}: no answer`);
        const answerKey = isNegative
          ? `Not answerable: the conversation contains nothing that supports the premise of this question. The correct response says so${qa.adversarial_answer ? `; a plausible-sounding but wrong answer would be "${qa.adversarial_answer}"` : ""}.`
          : String(qa.answer);
        const evidenceTurnIndexes = [...new Set(qa.evidence.map((e) => Number(/^D(\d+):/.exec(e)?.[1])).filter((s) => Number.isFinite(s)).map((s) => turnIndexOfSession.get(s)).filter((t): t is number => t !== undefined))];
        questions.push({
          id: `locomo-${item.sample_id.replace(/^conv-/, "")}-q${i}`,
          conversationId,
          question: qa.question,
          answerKey,
          type: cat.type,
          evidenceTurnIndexes,
          audited: true,
          auditedBy: "dataset",
          datasetCategory: `${category} ${cat.name}`,
          note: `LoCoMo ${item.sample_id} qa[${i}] category ${category} (${cat.name}); evidence ${qa.evidence.join(", ")}`,
        });
        byDatasetCategory[`${category} ${cat.name}`] = (byDatasetCategory[`${category} ${cat.name}`] ?? 0) + 1;
        n++;
      }
    }
    manifestConversations.push({ conversationId, sampleId: item.sample_id, sessions: sessions.length, approxTokens: turns.reduce((a, t) => a + approxTokens(t.text), 0), questions: n });
  }
  return { conversations, questions, manifest: { dataset: "locomo", seed: opts.seed, perCategory: opts.perCategory, conversations: manifestConversations, byDatasetCategory } };
}
