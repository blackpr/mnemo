import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, inject } from "vitest";
import { formatViolation, guardLog } from "./query-guard.js";

/**
 * Per test file (vitest `setupFiles`): hands what the query guard saw to the global teardown, which checks the
 * allowlist across the whole run, and fails this file if any of its statements broke the rule (also when the code
 * under test caught the rejected query and carried on).
 */
afterAll(() => {
  if (guardLog.checked + guardLog.testStatements > 0) {
    const summary = { checked: guardLog.checked, distinct: [...guardLog.distinct], testStatements: guardLog.testStatements, tags: Object.fromEntries(guardLog.tags) };
    writeFileSync(join(inject("queryGuardDir"), `${randomUUID()}.json`), JSON.stringify(summary));
  }
  if (guardLog.violations.length > 0) throw new Error(guardLog.violations.map(formatViolation).join("\n\n"));
});
