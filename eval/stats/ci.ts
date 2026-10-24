/**
 * Cluster-robust 95% confidence intervals by conversation and the minimum detectable difference
 * (plan section 6). promptfoo 0.120 reports no interval of any kind (checked 2026-10-23: nothing in
 * its dist mentions a confidence interval, a bootstrap or a standard error), so this is the one
 * piece of statistics the harness supplies itself. The estimators live in cluster.ts (unit-tested).
 *
 *   npm run eval:ci                                   # eval/results/latest.json
 *   npm run eval:ci -- eval/results/a.json eval/results/b.json   # several files; arms merged by metadata.arm
 *
 * Questions drawn from the same conversation share material and are not independent, so each
 * conversation is one cluster. With G = 4 conversations t_{3,0.975} = 3.18 and there are 256
 * distinct resamples: the intervals are wide because the evidence is thin, not because the arms are
 * close. The MDD is retrospective (from the observed SE); "significant" means the 95% interval
 * excludes zero, which can happen for a difference below that MDD.
 */
import { clusterRobust, pairedDifference, type Obs } from "./cluster.js";
import { armOf, conversationOf, loadRows, questionOf, typeOf, type Row } from "./rows.js";

const files = process.argv.slice(2);
const { rows, notRun } = await loadRows(files.length > 0 ? files : ["eval/results/latest.json"]);

const pp = (v: number): string => (Number.isFinite(v) ? `${(100 * v).toFixed(1)}` : "n/a");
const interval = (low: number, high: number): string => (Number.isFinite(low) && Number.isFinite(high) ? `[${pp(low)}, ${pp(high)}]` : "n/a");

const arms = [...new Set(rows.map(armOf))].sort();
const types = [...new Set(rows.map(typeOf))].sort();
const observations = (rs: readonly Row[]): Obs[] => rs.map((r) => ({ cluster: conversationOf(r), y: Number(r.success) }));

console.log(`Source: ${files.length > 0 ? files.join(", ") : "eval/results/latest.json"} (${rows.length} answered results, ${arms.length} arm(s), ${new Set(rows.map(conversationOf)).size} conversation(s) = clusters).`);
if (notRun.size > 0) console.log(`Not run (provider error, excluded): ${[...notRun].map(([a, n]) => `${a} ${n}`).join(", ")}.`);
console.log("Cluster-robust (by conversation) 95% intervals in percentage points; t critical value with G−1 degrees of freedom; cluster bootstrap percentile interval beside it.\n");

console.log("| Arm | Subset | n | G | Accuracy | SE | t | 95% CI (t) | 95% CI (cluster bootstrap) |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const arm of arms) {
  const rs = rows.filter((r) => armOf(r) === arm);
  const subsets: [string, Row[]][] = [["overall", rs], ...types.map((t): [string, Row[]] => [t, rs.filter((r) => typeOf(r) === t)])];
  for (const [name, sub] of subsets) {
    if (sub.length === 0) continue;
    const e = clusterRobust(observations(sub));
    console.log(`| ${arm} | ${name} | ${e.n} | ${e.clusters} | ${pp(e.mean)} | ${pp(e.se)} | ${Number.isFinite(e.tCritical) ? e.tCritical.toFixed(2) : "n/a"} | ${interval(e.low, e.high)} | ${interval(e.bootstrapLow, e.bootstrapHigh)} (${e.bootstrapResamples}) |`);
  }
}

console.log("\nPaired differences (X − Y on the questions both answered), the minimum detectable difference at 80% power (retrospective), and whether the interval excludes zero:\n");
console.log("| X | Y | Common questions | G | Difference | SE | 95% CI (t) | 95% CI (bootstrap) | MDD | Significant |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (let i = 0; i < arms.length; i++) {
  for (let j = i + 1; j < arms.length; j++) {
    const x = rows.filter((r) => armOf(r) === arms[i]);
    const yById = new Map(rows.filter((r) => armOf(r) === arms[j]).map((r) => [questionOf(r), r]));
    const paired: Obs[] = [];
    for (const rx of x) {
      const ry = yById.get(questionOf(rx));
      if (ry) paired.push({ cluster: conversationOf(rx), y: Number(rx.success) - Number(ry.success) });
    }
    if (paired.length === 0) {
      console.log(`| ${arms[i]} | ${arms[j]} | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a |`);
      continue;
    }
    const d = pairedDifference(paired);
    const band = !Number.isFinite(d.mdd) ? "" : Math.abs(d.mean) > d.mdd ? " (beyond MDD)" : " (within MDD)";
    console.log(`| ${arms[i]} | ${arms[j]} | ${paired.length} | ${d.clusters} | ${pp(d.mean)}${band} | ${pp(d.se)} | ${interval(d.low, d.high)} | ${interval(d.bootstrapLow, d.bootstrapHigh)} | ${pp(d.mdd)} | ${Number.isFinite(d.se) ? (d.significant ? "yes" : "no") : "n/a"} |`);
  }
}
console.log("\nPaired differences per question type (same estimator; the per-type numbers the public-benchmark write-up reports where an engine differs from pgvector by more than the MDD):\n");
console.log("| X | Y | Type | Common questions | G | Difference | 95% CI (t) | MDD | Significant |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (let i = 0; i < arms.length; i++) {
  for (let j = i + 1; j < arms.length; j++) {
    const yById = new Map(rows.filter((r) => armOf(r) === arms[j]).map((r) => [questionOf(r), r]));
    for (const t of types) {
      const paired: Obs[] = [];
      for (const rx of rows.filter((r) => armOf(r) === arms[i] && typeOf(r) === t)) {
        const ry = yById.get(questionOf(rx));
        if (ry) paired.push({ cluster: conversationOf(rx), y: Number(rx.success) - Number(ry.success) });
      }
      if (paired.length === 0) continue;
      const d = pairedDifference(paired);
      const band = !Number.isFinite(d.mdd) ? "" : Math.abs(d.mean) > d.mdd ? " (beyond MDD)" : " (within MDD)";
      console.log(`| ${arms[i]} | ${arms[j]} | ${t} | ${paired.length} | ${d.clusters} | ${pp(d.mean)}${band} | ${interval(d.low, d.high)} | ${pp(d.mdd)} | ${Number.isFinite(d.se) ? (d.significant ? "yes" : "no") : "n/a"} |`);
    }
  }
}
console.log("\nReading: the MDD is what this design could have detected with 80% power given the observed spread; a difference below it is noise unless its interval excludes zero (plan section 6). With G = 4 the t critical value is 3.18; the interval width is the finding.");
