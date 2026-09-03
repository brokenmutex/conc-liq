import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { PostgresSnapshotStore } from "./storage/postgres.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.databaseUrl === undefined) {
    throw new Error("DATABASE_URL is required for db:migrate");
  }

  const store = new PostgresSnapshotStore(config.databaseUrl);
  try {
    await store.migrate();
    log("info", "database_migrated");
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "database_migration_failed", { error });
  process.exitCode = 1;
});
