import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "eval/**/*.test.ts"],
    // Database-backed suites share one Postgres; run files one at a time.
    fileParallelism: false,
    // Bank isolation: every statement the application runs against the test database is checked (test/helpers/query-guard.ts).
    globalSetup: ["test/helpers/query-guard-global.ts"],
    setupFiles: ["test/helpers/query-guard-setup.ts"],
  },
});
