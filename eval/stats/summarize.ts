/**
 * Turns a promptfoo results file into the per-arm table from the plan's section 6 (accuracy overall
 * and per question type, read tokens, write tokens, latency, cost) as Markdown, plus the failed
 * answers with the grader's reason. Costs use the list price in eval/llm.ts; embedding tokens are
 * not metered by the REST attachment and are reported as not counted.
 *
 *   npm run eval:summary            # reads eval/results/latest.json
 *
 * The cluster-robust confidence interval and minimum detectable difference (plan section 6) are
 * not computed here yet; with a handful of conversations they would not be meaningful.
 */
import { readFile } from "node:fs/promises";
import { costUsd, PRICE_USD_PER_MTOK } from "../llm.js";

interface Row {
  success: boolean;
  score: number;
  latencyMs?: number;
  provider?: { id?: string; label?: string };
  vars?: Record<string, unknown>;
  response?: { tokenUsage?: { prompt?: number; completion?: number; cached?: number }; metadata?: Record<string, unknown>; cached?: boolean; output?: unknown };
  gradingResult?: { reason?: string; tokensUsed?: { prompt?: number; completion?: number; total?: number } };
  testCase?: { description?: string; metadata?: Record<string, unknown> };
}

const file = process.argv[2] ?? "eval/results/latest.json";
const rows = (JSON.parse(await readFile(file, "utf8")) as { results: { results: Row[] } }).results.results;
if (rows.length === 0) throw new Error(`no results in ${file}`);

const percentile = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
};
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}% (${n}/${d})`);

/** The arm name the provider recorded (B-pgvector vs B-pgvector-raw share one YAML label), else the label. */
const armOf = (r: Row): string => String(r.response?.metadata?.arm ?? r.provider?.label ?? r.provider?.id ?? "?");
const arms = [...new Set(rows.map(armOf))].sort();
const types = [...new Set(rows.map((r) => String(r.testCase?.metadata?.type ?? r.vars?.type ?? "?")))].sort();

console.log(`Source: ${file} (${rows.length} results, ${arms.length} arm(s), ${new Set(rows.map((r) => String(r.vars?.conversationId ?? ""))).size} conversation(s)).`);
console.log(`Prices: $${PRICE_USD_PER_MTOK.input}/M input, $${PRICE_USD_PER_MTOK.output}/M output (claude-opus-5-5). Embedding tokens: not counted.\n`);

const header = ["Measure", ...arms];
const table: string[][] = [];
const col = (f: (rs: Row[]) => string): string[] => arms.map((a) => f(rows.filter((r) => armOf(r) === a)));

table.push(["Questions", ...col((rs) => String(rs.length))]);
table.push(["Answers served from cache", ...col((rs) => String(rs.filter((r) => r.response?.cached).length))]);
table.push(["Accuracy, overall", ...col((rs) => pct(rs.filter((r) => r.success).length, rs.length))]);
for (const t of types) table.push([`Accuracy, ${t}`, ...col((rs) => {
  const sub = rs.filter((r) => String(r.testCase?.metadata?.type ?? r.vars?.type) === t);
  return pct(sub.filter((r) => r.success).length, sub.length);
})]);
table.push(["Read tokens per question (prompt, mean, nominal)", ...col((rs) => Math.round(rs.reduce((n, r) => n + num(r.response?.tokenUsage?.prompt), 0) / Math.max(1, rs.length)).toLocaleString())]);
table.push(["Read tokens, total (prompt + completion, nominal)", ...col((rs) => rs.reduce((n, r) => n + num(r.response?.tokenUsage?.prompt) + num(r.response?.tokenUsage?.completion), 0).toLocaleString())]);
table.push(["Write tokens, total (extraction, per bank once)", ...col((rs) => {
  const banks = new Map<string, number>();
  for (const r of rs) {
    const m = r.response?.metadata ?? {};
    if (typeof m.bankId === "string") banks.set(m.bankId, num(m.writeInputTokens) + num(m.writeOutputTokens));
  }
  return banks.size === 0 ? "0 (no write path)" : [...banks.values()].reduce((a, b) => a + b, 0).toLocaleString();
})]);
table.push(["Grader tokens, total", ...col((rs) => rs.reduce((n, r) => n + num(r.gradingResult?.tokensUsed?.total), 0).toLocaleString())]);
table.push(["Answer latency p50 / p95 (ms, uncached)", ...col((rs) => {
  const xs = rs.filter((r) => !r.response?.cached).map((r) => num(r.response?.metadata?.answerLatencyMs));
  return xs.length === 0 ? "all cached" : `${percentile(xs, 50)} / ${percentile(xs, 95)}`;
})]);
table.push(["Retrieval latency p50 / p95 (ms)", ...col((rs) => {
  const xs = rs.map((r) => r.response?.metadata?.recallMs).filter((v): v is number => typeof v === "number");
  return xs.length === 0 ? "n/a" : `${percentile(xs, 50)} / ${percentile(xs, 95)}`;
})]);
table.push(["End-to-end latency p50 / p95 (ms, uncached)", ...col((rs) => {
  const xs = rs.filter((r) => !r.response?.cached).map((r) => num(r.latencyMs));
  return xs.length === 0 ? "all cached" : `${percentile(xs, 50)} / ${percentile(xs, 95)}`;
})]);
table.push(["Ingest seconds per turn (mean)", ...col((rs) => {
  const banks = new Map<string, { ms: number; turns: number }>();
  for (const r of rs) {
    const m = r.response?.metadata ?? {};
    if (typeof m.bankId === "string") banks.set(m.bankId, { ms: num(m.ingestMs), turns: num(m.conversationTurns) });
  }
  if (banks.size === 0) return "n/a";
  const ms = [...banks.values()].reduce((a, b) => a + b.ms, 0);
  const turns = [...banks.values()].reduce((a, b) => a + b.turns, 0);
  return (ms / 1000 / Math.max(1, turns)).toFixed(1);
})]);
// Arms report a cached answer's original tokens, so read cost is what the arm costs per run (nominal), not what this run spent.
table.push(["Read cost, total (USD, nominal; cache hits included)", ...col((rs) => `$${rs.reduce((n, r) => n + costUsd({ inputTokens: num(r.response?.tokenUsage?.prompt), outputTokens: num(r.response?.tokenUsage?.completion) }), 0).toFixed(3)}`)]);
table.push(["Write cost, total (USD)", ...col((rs) => {
  const banks = new Map<string, number>();
  for (const r of rs) {
    const m = r.response?.metadata ?? {};
    if (typeof m.bankId === "string") banks.set(m.bankId, costUsd({ inputTokens: num(m.writeInputTokens), outputTokens: num(m.writeOutputTokens) }));
  }
  return `$${[...banks.values()].reduce((a, b) => a + b, 0).toFixed(3)}`;
})]);
// promptfoo reports a cached grader call as prompt 0 / completion 0 / cached N, so this is what this run spent on grading.
table.push(["Grader cost, total (USD, uncached calls only)", ...col((rs) => `$${rs.reduce((n, r) => n + costUsd({ inputTokens: num(r.gradingResult?.tokensUsed?.prompt), outputTokens: num(r.gradingResult?.tokensUsed?.completion) }), 0).toFixed(3)}`)]);

const widths = header.map((_, i) => Math.max(header[i]?.length ?? 0, ...table.map((r) => r[i]?.length ?? 0)));
const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`;
console.log(line(header));
console.log(`| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`);
for (const r of table) console.log(line(r));

const failures = rows.filter((r) => !r.success);
console.log(`\nFailed answers (${failures.length}):`);
for (const r of failures) {
  const q = String(r.vars?.questionId ?? r.testCase?.description ?? "?");
  console.log(`- ${armOf(r)} ${q} [${String(r.testCase?.metadata?.type ?? "?")}]: ${(r.gradingResult?.reason ?? "").replace(/\s+/g, " ").slice(0, 220)}`);
}
