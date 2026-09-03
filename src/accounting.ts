import { z } from "zod";
import { collectFeeAccountingSnapshot } from "./accounting/collector.js";
import { PostgresAccountingSourceStore } from "./accounting/source-store.js";
import { PostgresFeeAccountingStore } from "./accounting/store.js";
import { createRobinhoodClient } from "./client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { log } from "./logger.js";

const environmentSchema = z.object({
  ACCOUNTING_CONCURRENCY: z.coerce.number().int().positive().max(100).default(24),
  DATABASE_URL: z.string().min(1),
});

function printHelp(): void {
  console.log(`Usage: npm run accounting:snapshot

Captures exact Uniswap v3 core fee state at the current replay completion block.
Every pool, initialized tick, and replayed core position is reconciled through
block-pinned eth_call before the immutable accounting snapshot is committed.

Environment:
  DATABASE_URL             Required PostgreSQL database
  RH_INDEXER_RPC_URL       Private archive/read RPC; falls back to RH_RPC_URL
  INDEXER_STREAM_KEY       Indexed/replayed stream
  ACCOUNTING_CONCURRENCY   Concurrent eth_call limit (default 24)
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
  const environment = environmentSchema.parse(process.env);
  const indexer = loadIndexerConfig();
  const client = createRobinhoodClient(indexer.rpcUrl, indexer.rpcTimeoutMs);
  const sourceStore = new PostgresAccountingSourceStore(environment.DATABASE_URL);
  const accountingStore = new PostgresFeeAccountingStore(environment.DATABASE_URL);
  try {
    await accountingStore.migrate();
    const source = await sourceStore.snapshot(indexer.streamKey);
    log("info", "fee_accounting_source_loaded", {
      blockNumber: source.blockNumber,
      eventsApplied: source.eventsApplied,
      pools: source.pools.length,
      positions: source.positions.length,
      ticks: source.ticks.length,
    });
    const snapshot = await collectFeeAccountingSnapshot({
      client,
      concurrency: environment.ACCOUNTING_CONCURRENCY,
      source,
    });
    const runId = await accountingStore.save(snapshot);
    log("info", "fee_accounting_snapshot_saved", {
      blockHash: snapshot.blockHash,
      blockNumber: snapshot.blockNumber,
      pools: snapshot.pools.length,
      positions: snapshot.positions.length,
      runId,
      ticks: snapshot.ticks.length,
    });
  } finally {
    await sourceStore.close();
    await accountingStore.close();
  }
}

main().catch((error: unknown) => {
  log("error", "fee_accounting_failed", { error });
  process.exitCode = 1;
});
