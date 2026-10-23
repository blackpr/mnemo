/**
 * The slice of a promptfoo results file the statistics scripts read (summarize.ts, ci.ts), and how
 * rows are attributed to an arm, a question type and a conversation (the cluster).
 */
import { readFile } from "node:fs/promises";

export interface Row {
  success: boolean;
  score: number;
  /** Set by promptfoo when the provider call itself failed (the arm threw); such a row was not answered or graded. */
  error?: string;
  latencyMs?: number;
  provider?: { id?: string; label?: string };
  vars?: Record<string, unknown>;
  response?: { tokenUsage?: { prompt?: number; completion?: number; cached?: number }; metadata?: Record<string, unknown>; cached?: boolean; output?: unknown };
  gradingResult?: { reason?: string; tokensUsed?: { prompt?: number; completion?: number; total?: number } };
  testCase?: { description?: string; metadata?: Record<string, unknown> };
}

/** A row the arm actually answered (a provider error, e.g. an exhausted API account, is "not run", not "wrong"). */
export const answered = (r: Row): boolean => !r.error || typeof r.response?.output === "string";

/**
 * Rows from one or more results files, concatenated (arms from separate runs are merged by `armOf`).
 * Rows the provider failed on are dropped and counted in `notRun` per arm, so a partial run reports
 * what it measured instead of scoring outages as wrong answers.
 */
export async function loadRows(files: readonly string[]): Promise<{ rows: Row[]; notRun: Map<string, number> }> {
  const rows: Row[] = [];
  const notRun = new Map<string, number>();
  const seen = new Set<string>();
  let duplicates = 0;
  for (const file of files) {
    const all = (JSON.parse(await readFile(file, "utf8")) as { results: { results: Row[] } }).results.results;
    if (all.length === 0) throw new Error(`no results in ${file}`);
    for (const r of all) {
      if (!answered(r)) {
        notRun.set(armOf(r), (notRun.get(armOf(r)) ?? 0) + 1);
        continue;
      }
      // Several files usually overlap on arms A and B (e.g. latest.json plus a B-raw run); the first file wins per (arm, question).
      const key = `${armOf(r)}\u0000${questionOf(r)}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      rows.push(r);
    }
  }
  if (duplicates > 0) console.warn(`${duplicates} duplicate (arm, question) row(s) across the input files were skipped; the first file's row is kept`);
  if (rows.length === 0) throw new Error("every row is a provider error; nothing to summarize");
  return { rows, notRun };
}

/** The arm name the provider recorded (B-pgvector vs B-pgvector-raw share one YAML label), else the label. */
export const armOf = (r: Row): string => String(r.response?.metadata?.arm ?? r.provider?.label ?? r.provider?.id ?? "?");
export const typeOf = (r: Row): string => String(r.testCase?.metadata?.type ?? r.vars?.type ?? "?");
export const conversationOf = (r: Row): string => String(r.vars?.conversationId ?? r.testCase?.metadata?.conversationId ?? "?");
export const questionOf = (r: Row): string => String(r.vars?.questionId ?? r.testCase?.metadata?.questionId ?? r.testCase?.description ?? "?");
