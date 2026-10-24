/**
 * Shared by the public-benchmark loaders (longmemeval.ts, locomo.ts): the corpus writer (same JSONL
 * and index.json shape as `eval/corpus/build.ts`, so the arms read a benchmark exactly like a Claude
 * Code corpus), the dataset timestamp parsers, session chunking, and a seeded sampler.
 *
 * The raw files are untrusted data: every loader parses them with zod and treats the content as
 * text to store, never as anything to execute or template.
 */
import mt19937 from "@stdlib/random-base-mt19937";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { approxTokens, type Turn } from "../corpus/normalize.js";
import type { CorpusEntry, CorpusIndex } from "../corpus/store.js";

/**
 * One corpus "turn" per benchmark session (or part of one): the natural unit both benchmarks are
 * annotated at, and what keeps arm B's and arm C's per-episode write cost bounded (each extraction
 * prompt carries the 12 most recent episodes and up to 200 facts, so thousands of 30-token turns
 * would cost far more than hundreds of session chunks). The extractor truncates an episode at 8,000
 * characters, so a session longer than that is split at turn boundaries into chunks under this size.
 */
export const MAX_CHUNK_CHARS = 7_000;

/** Groups consecutive rendered turns into chunks of at most `maxChars` (a single turn longer than that is its own chunk). */
export function chunkLines(lines: readonly string[], maxChars: number = MAX_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    const added = line.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && size + added > maxChars) {
      chunks.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + (current.length > 1 ? 1 : 0);
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

const MONTHS: Record<string, number> = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };

/** LongMemEval timestamps look like `2023/05/20 (Sat) 02:21`; read as UTC (the dataset carries no zone). */
export function parseLongMemEvalDate(s: string): string {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s+\([A-Za-z]{3}\)\s+(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`unrecognized LongMemEval date ${JSON.stringify(s)}`);
  const [, y, mo, d, h, mi] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))).toISOString();
}

/** LoCoMo session timestamps look like `1:56 pm on 8 May, 2023`; read as UTC (the dataset carries no zone). */
export function parseLocomoDate(s: string): string {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/i.exec(s.trim());
  if (!m) throw new Error(`unrecognized LoCoMo date ${JSON.stringify(s)}`);
  const [, hh, mm, ampm, d, monthName, y] = m;
  const month = MONTHS[(monthName as string).toLowerCase()];
  if (month === undefined) throw new Error(`unrecognized month in LoCoMo date ${JSON.stringify(s)}`);
  let hour = Number(hh) % 12;
  if ((ampm as string).toLowerCase() === "pm") hour += 12;
  return new Date(Date.UTC(Number(y), month, Number(d), hour, Number(mm))).toISOString();
}

/** Fisher–Yates with a seeded Mersenne Twister, so a recorded seed reproduces the subset exactly. */
export function seededShuffle<T>(xs: readonly T[], seed: number): T[] {
  const rand = mt19937.factory({ seed });
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand() % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Up to `n` items per group (groups keyed by `keyOf`), chosen by a seeded shuffle within each group; group order is the first-seen order. */
export function sampleStratified<T>(xs: readonly T[], keyOf: (x: T) => string, n: number, seed: number): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const x of xs) groups.set(keyOf(x), [...(groups.get(keyOf(x)) ?? []), x]);
  const out = new Map<string, T[]>();
  let i = 0;
  for (const [key, items] of groups) out.set(key, seededShuffle(items, seed + i++).slice(0, n));
  return out;
}

export interface CorpusConversation {
  readonly conversationId: string;
  /** Shown as the corpus index's `project` column. */
  readonly project: string;
  readonly turns: readonly Turn[];
}

/** Writes `<dir>/<conversationId>.jsonl` per conversation and `<dir>/index.json` in the shape `eval/corpus/store.ts` reads. */
export async function writeCorpus(dir: string, source: string, conversations: readonly CorpusConversation[]): Promise<CorpusIndex> {
  await mkdir(dir, { recursive: true });
  const entries: CorpusEntry[] = [];
  for (const c of conversations) {
    if (!/^[A-Za-z0-9_-]+$/.test(c.conversationId)) throw new Error(`invalid conversation id ${JSON.stringify(c.conversationId)}`);
    await writeFile(path.join(dir, `${c.conversationId}.jsonl`), c.turns.map((t) => JSON.stringify(t)).join("\n") + "\n");
    entries.push({
      conversationId: c.conversationId,
      project: c.project,
      turns: c.turns.length,
      userTurns: c.turns.filter((t) => t.role === "user").length,
      approxTokens: c.turns.reduce((n, t) => n + approxTokens(t.text), 0),
      startedAt: c.turns[0]?.occurredAt ?? "",
      endedAt: c.turns[c.turns.length - 1]?.occurredAt ?? "",
      redactedLines: 0,
      truncatedTurns: 0,
    });
  }
  const index: CorpusIndex = { builtAt: new Date().toISOString(), source, conversations: entries };
  await writeFile(path.join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
  return index;
}
