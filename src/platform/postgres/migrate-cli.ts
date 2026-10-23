import { createPool } from "./pool.js";
import { migrate } from "./migrator.js";
import { migrationSources } from "./migrations.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (see .env.example)");
  process.exit(1);
}

const pool = createPool(url, 2);
try {
  const applied = await migrate(pool, migrationSources);
  console.log(applied.length === 0 ? "No pending migrations." : `Applied:\n  ${applied.join("\n  ")}`);
} finally {
  await pool.end();
}
