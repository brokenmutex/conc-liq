import pg from "pg";
import { log } from "./logger.js";
import { migrateDatabase } from "./storage/migrations.js";
import { sanitizeRiskError } from "./risk/evaluate.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--baseline") || args.length > 1) throw new Error("Usage: db:migrate [--baseline]");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for db:migrate");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const client = await pool.connect();
    try {
      const versions = await migrateDatabase(client, { baseline: args.includes("--baseline") });
      log("info", "database_migrated", { versions });
    } finally { client.release(); }
  } finally { await pool.end(); }
}

main().catch((error: unknown) => {
  log("error", "database_migration_failed", { message: sanitizeRiskError(error) });
  process.exitCode = 1;
});
