import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MigrationSource } from "./migrator.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "..");

/** Ordered list: memory first (banks are referenced by others), then governance, then retrieval. */
export const migrationSources: readonly MigrationSource[] = [
  { label: "memory", dir: resolve(src, "memory/infrastructure/postgres/migrations") },
  { label: "governance", dir: resolve(src, "governance/infrastructure/postgres/migrations") },
  { label: "retrieval", dir: resolve(src, "retrieval/infrastructure/pgvector/migrations") },
  { label: "extraction", dir: resolve(src, "extraction/infrastructure/postgres/migrations") },
];
