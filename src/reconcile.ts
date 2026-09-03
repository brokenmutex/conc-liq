import { z } from "zod";
import { createRobinhoodClient } from "./client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { log } from "./logger.js";
import { reconcileReplay } from "./replay/reconcile.js";
import { PostgresReplayStore } from "./replay/store.js";

const environmentSchema = z.object({
  RECONCILE_CONCURRENCY: z.coerce.number().int().positive().max(100).default(24),
});

function printHelp(): void {
  console.log(`Usage: npm run reconcile

Reconciles every derived pool, initialized tick, and core position at the
replay completion block against read-only on-chain calls.

Environment:
  DATABASE_URL             Required PostgreSQL database
  RH_INDEXER_RPC_URL       Private read RPC; falls back to RH_RPC_URL
  INDEXER_STREAM_KEY       Indexed/replayed stream
  RECONCILE_CONCURRENCY    Concurrent eth_call limit (default 24)
`);
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    printHelp();
    return;
  }
  if (arguments_.length > 0) {
    throw new Error(`Unknown argument: ${arguments_[0]}`);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const config = loadIndexerConfig();
  const reconcileConfig = environmentSchema.parse(process.env);
  const client = createRobinhoodClient(config.rpcUrl, config.rpcTimeoutMs);
  const store = new PostgresReplayStore(databaseUrl);
  try {
    await store.open(config.streamKey);
    const result = await reconcileReplay(client, store, config.streamKey, {
      concurrency: reconcileConfig.RECONCILE_CONCURRENCY,
    });
    log("info", "reconcile_run_complete", { ...result });
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "reconcile_failed", { error });
  process.exitCode = 1;
});
