import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { CROSS_BANK_STATEMENTS } from "../../src/platform/postgres/bank-isolation.js";

declare module "vitest" {
  export interface ProvidedContext {
    queryGuardDir: string;
  }
}

interface FileSummary {
  checked: number;
  distinct: string[];
  testStatements: number;
  tags: Record<string, number>;
}

/**
 * vitest `globalSetup` for the query guard: a directory the test files report into, and at the end of the run a
 * summary plus the allowlist check. An entry in CROSS_BANK_STATEMENTS that no test ran fails the run, so the list
 * cannot keep entries for statements that no longer exist. The check needs the whole suite: it is skipped when
 * the run is filtered to some files or test names, sharded, limited to changed or related files, or when no
 * database-backed test ran. (A `.only` left in a test file is not detected; it fails on unexercised entries.)
 */
export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), "mem-query-guard-"));
  project.provide("queryGuardDir", dir);
  return () => {
    const files = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as FileSummary);
    rmSync(dir, { recursive: true, force: true });
    const checked = files.reduce((n, f) => n + f.checked, 0);
    const distinct = new Set(files.flatMap((f) => f.distinct));
    const testStatements = files.reduce((n, f) => n + f.testStatements, 0);
    const tags = new Map<string, number>();
    for (const f of files) for (const [t, n] of Object.entries(f.tags)) tags.set(t, (tags.get(t) ?? 0) + n);
    const allowlisted = [...tags.values()].reduce((a, b) => a + b, 0);
    if (checked === 0) return;
    console.log(
      `\nquery guard: ${checked} application statements checked (${distinct.size} distinct), ${allowlisted} of them allowlisted cross-bank ` +
        `(${tags.size} of ${Object.keys(CROSS_BANK_STATEMENTS).length} entries exercised); ${testStatements} statements from test files not checked`,
    );
    // `filenamePattern` is vitest-internal (set from CLI path filters); the others are resolved config.
    const config = project.vitest.config as { shard?: unknown; changed?: unknown; related?: unknown[] };
    const filtered =
      ((project.vitest as unknown as { filenamePattern?: string[] }).filenamePattern?.length ?? 0) > 0 ||
      !!project.config.testNamePattern ||
      !!config.shard ||
      !!config.changed ||
      (config.related?.length ?? 0) > 0;
    if (filtered) return;
    const unused = Object.keys(CROSS_BANK_STATEMENTS).filter((name) => !tags.has(name));
    if (unused.length > 0) {
      console.error(`query guard: allowlist entries no test exercised (remove them, or add a test that runs the statement):\n  ${unused.join("\n  ")}`);
      process.exitCode = 1;
    }
  };
}
