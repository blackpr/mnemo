/**
 * Turns a promptfoo results file into the per-arm table from the plan's section 6 (accuracy overall
 * and per question type, read tokens, write tokens, latency, cost) as Markdown, plus the failed
 * answers with the grader's reason. Costs use the list price in eval/llm.ts; embedding tokens are
 * not metered by the REST attachment and are reported as not counted.
 *
 *   npm run eval:summary                          # reads eval/results/latest.json
 *   npm run eval:summary -- a.json b.json         # several files; arms merged by metadata.arm
 *
 * The cluster-robust confidence interval and minimum detectable difference (plan section 6) are
 * printed by `npm run eval:ci` (eval/stats/ci.ts).
 */
import { costUsd, PRICE_USD_PER_MTOK } from "../llm.js";
import { armOf, loadRows, typeOf, type Row } from "./rows.js";

const files = process.argv.slice(2);
const file = files.length > 0 ? files.join(", ") : "eval/results/latest.json";
const { rows, notRun } = await loadRows(files.length > 0 ? files : ["eval/results/latest.json"]);

const percentile = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
};
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}% (${n}/${d})`);

const arms = [...new Set(rows.map(armOf))].sort();
const types = [...new Set(rows.map(typeOf))].sort();

console.log(`Source: ${file} (${rows.length} answered results, ${arms.length} arm(s), ${new Set(rows.map((r) => String(r.vars?.conversationId ?? ""))).size} conversation(s)).`);
if (notRun.size > 0) console.log(`Not run (provider error, excluded from every row below): ${[...notRun].map(([a, n]) => `${a} ${n}`).join(", ")}.`);
console.log(`Prices: $${PRICE_USD_PER_MTOK.input}/M input, $${PRICE_USD_PER_MTOK.output}/M output (claude-opus-5-5); write cost counts input + output at list price (prompt-cached input is charged at full price here, an over-estimate for engines that cache). Embedding tokens: not priced.\n`);

const header = ["Measure", ...arms];
const table: string[][] = [];
const col = (f: (rs: Row[]) => string): string[] => arms.map((a) => f(rows.filter((r) => armOf(r) === a)));

table.push(["Questions answered", ...col((rs) => String(rs.length))]);
if (notRun.size > 0) table.push(["Questions not run (provider error)", ...arms.map((a) => String(notRun.get(a) ?? 0))]);
table.push(["Answers served from cache", ...col((rs) => String(rs.filter((r) => r.response?.cached).length))]);
table.push(["Extraction model (write path)", ...col((rs) => {
  const models = new Set(rs.map((r) => r.response?.metadata?.extractionModel).filter((m): m is string => typeof m === "string"));
  return models.size === 0 ? "none" : [...models].join(", ");
})]);
table.push(["Accuracy, overall", ...col((rs) => pct(rs.filter((r) => r.success).length, rs.length))]);
for (const t of types) table.push([`Accuracy, ${t}`, ...col((rs) => {
  const sub = rs.filter((r) => typeOf(r) === t);
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
table.push(["Write LLM calls / prompt-cached tokens (where the engine reports them)", ...col((rs) => {
  const banks = new Map<string, { calls: number; cached: number }>();
  for (const r of rs) {
    const m = r.response?.metadata ?? {};
    if (typeof m.bankId === "string" && typeof m.writeLlmCalls === "number") banks.set(m.bankId, { calls: num(m.writeLlmCalls), cached: num(m.writeCachedTokens) });
  }
  if (banks.size === 0) return "not reported";
  const v = [...banks.values()];
  return `${v.reduce((a, b) => a + b.calls, 0).toLocaleString()} / ${v.reduce((a, b) => a + b.cached, 0).toLocaleString()}`;
})]);
table.push(["Embedding tokens, total (where metered)", ...col((rs) => {
  const banks = new Map<string, number>();
  for (const r of rs) {
    const m = r.response?.metadata ?? {};
    if (typeof m.bankId === "string" && typeof m.embeddingTokens === "number") banks.set(m.bankId, num(m.embeddingTokens));
  }
  return banks.size === 0 ? "not metered" : [...banks.values()].reduce((a, b) => a + b, 0).toLocaleString();
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
  console.log(`- ${armOf(r)} ${q} [${typeOf(r)}]: ${(r.gradingResult?.reason ?? "").replace(/\s+/g, " ").slice(0, 220)}`);
}
