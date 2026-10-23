/**
 * Compares the grader's verdicts from a `sanity.yaml` run with each case's `metadata.expectGraderPass`.
 * Exit code 1 if the frozen grader accepted an answer it must reject or vice versa.
 *
 *   node --import tsx eval/grader/check-sanity.ts eval/results/grader-sanity.json
 */
import { readFile } from "node:fs/promises";

interface ResultRow {
  success: boolean;
  testCase: { description?: string; metadata?: { expectGraderPass?: boolean } };
  gradingResult?: { reason?: string };
}

const file = process.argv[2];
if (!file) throw new Error("usage: check-sanity.ts <promptfoo output json>");
const rows = (JSON.parse(await readFile(file, "utf8")) as { results: { results: ResultRow[] } }).results.results;
let mismatches = 0;
for (const r of rows) {
  const expected = r.testCase.metadata?.expectGraderPass;
  if (typeof expected !== "boolean") throw new Error(`case "${r.testCase.description}" has no metadata.expectGraderPass`);
  const ok = r.success === expected;
  if (!ok) mismatches++;
  console.log(`${ok ? "ok  " : "BAD "} grader ${r.success ? "passed" : "failed"} (expected ${expected ? "pass" : "fail"}): ${r.testCase.description ?? "?"}${ok ? "" : `\n      ${r.gradingResult?.reason ?? ""}`}`);
}
console.log(mismatches === 0 ? `Grader sanity: all ${rows.length} verdicts as expected.` : `Grader sanity: ${mismatches} of ${rows.length} verdicts wrong.`);
process.exit(mismatches === 0 ? 0 : 1);
