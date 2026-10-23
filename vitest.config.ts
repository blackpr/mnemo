import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "eval/**/*.test.ts"],
    // Database-backed suites share one Postgres; run files one at a time.
    fileParallelism: false,
  },
});
