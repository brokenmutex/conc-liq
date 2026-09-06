import { z } from "zod";
import { collectFeeAccountingSnapshot } from "./accounting/collector.js";
import { PostgresAccountingSourceStore } from "./accounting/source-store.js";
import { PostgresFeeAccountingStore } from "./accounting/store.js";
import { createHistoricalClient, loadHistoryConfig } from "./history/client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { log } from "./logger.js";
import { loadRpcHealthGateConfig } from "./rpc-health/config.js";
import { PostgresRpcHealthGate } from "./rpc-health/store.js";

const environmentSchema = z.object({
  ACCOUNTING_CONCURRENCY: z.coerce.number().int().positive().max(100).default(4),
  ACCOUNTING_MAX_STATE_READS: z.coerce.number().int().positive().max(1_000_000).default(500),
  DATABASE_URL: z.string().min(1),
});

function printHelp(): void {
  console.log(`Usage: npm run accounting:snapshot -- [options]

Captures exact Uniswap v3 core fee state at the current replay completion block.
Every pool, initialized tick, and replayed core position is reconciled through
block-pinned eth_call before the immutable accounting snapshot is committed.

Options:
  --if-new-source          Skip RPC reads if this exact source is already stored
  -h, --help               Show this help

Environment:
  DATABASE_URL             Required PostgreSQL database
  RH_INDEXER_RPC_URL       Live node; use RH_ARCHIVE_RPC_URL for isolated historical state
  INDEXER_STREAM_KEY       Indexed/replayed stream
  ACCOUNTING_CONCURRENCY   Concurrent eth_call limit (default 4)
  ACCOUNTING_FULL_SNAPSHOT_ENABLED  Explicit opt-in for full snapshots (default false)
  ACCOUNTING_MAX_STATE_READS       Maximum planned state reads per snapshot (default 500)
  RPC_HEALTH_GATE_ENABLED  Require healthy quorum state (default true)
`);
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    printHelp();
    return;
  }
  const ifNewSource = arguments_.includes("--if-new-source");
  const unknown = arguments_.find((argument) => argument !== "--if-new-source");
  if (unknown !== undefined) {
    throw new Error(`Unknown argument: ${unknown}`);
  }
  if (arguments_.filter((argument) => argument === "--if-new-source").length > 1) {
    throw new Error("--if-new-source may only be supplied once");
  }
  const fullSnapshotEnabled = z.enum(["true", "false"]).default("false")
    .parse(process.env.ACCOUNTING_FULL_SNAPSHOT_ENABLED) === "true";
  if (!fullSnapshotEnabled) {
    if (!ifNewSource) throw new Error("Full fee accounting is disabled: ACCOUNTING_FULL_SNAPSHOT_ENABLED must be true");
    log("warn", "fee_accounting_snapshot_unavailable", {
      reason: "full_snapshot_disabled", executionEligible: false,
    });
    return;
  }
  const environment = environmentSchema.parse(process.env);
  const indexer = loadIndexerConfig();
  const history = loadHistoryConfig(indexer.rpcUrl);
  if (history.source !== "legacy" && !history.archiveUrl) {
    if (!ifNewSource) throw new Error("Historical state unavailable: RH_ARCHIVE_RPC_URL is required");
    log("warn", "fee_accounting_snapshot_unavailable", {
      reason: "archive_rpc_not_configured", executionEligible: false,
    });
    return;
  }
  const healthConfig = loadRpcHealthGateConfig();
  const healthGate = new PostgresRpcHealthGate({
    cacheMs: healthConfig.cacheMs,
    connectionString: environment.DATABASE_URL,
    enabled: healthConfig.enabled,
    maxSampleAgeSeconds: healthConfig.maxSampleAgeSeconds,
  });
  const client = createHistoricalClient(
    indexer.rpcUrl,
    indexer.rpcTimeoutMs,
    {
      beforeRequest: () => healthGate.assertBulkAllowed().then(() => {}),
      retryCount: 0,
    },
  );
  const sourceStore = new PostgresAccountingSourceStore(environment.DATABASE_URL);
  const accountingStore = new PostgresFeeAccountingStore(environment.DATABASE_URL);
  try {
    await healthGate.migrate();
    await accountingStore.migrate();
    const source = await sourceStore.snapshot(indexer.streamKey);
    log("info", "fee_accounting_source_loaded", {
      blockNumber: source.blockNumber,
      eventsApplied: source.eventsApplied,
      pools: source.pools.length,
      positions: source.positions.length,
      ticks: source.ticks.length,
    });
    if (ifNewSource) {
      const existingRunId = await accountingStore.findRunId({
        blockHash: source.blockHash,
        blockNumber: source.blockNumber,
        schemaVersion: 1,
        streamKey: source.streamKey,
      });
      if (existingRunId !== null) {
        log("info", "fee_accounting_snapshot_skipped", {
          blockHash: source.blockHash,
          blockNumber: source.blockNumber,
          reason: "source_already_captured",
          runId: existingRunId,
        });
        return;
      }
    }
    await healthGate.assertBulkAllowed();
    const snapshot = await collectFeeAccountingSnapshot({
      beforeRpc: () => healthGate.assertBulkAllowed().then(() => {}),
      client,
      concurrency: environment.ACCOUNTING_CONCURRENCY,
      maxStateReads: environment.ACCOUNTING_MAX_STATE_READS,
      source,
    });
    const saved = await accountingStore.save(snapshot);
    log("info", saved.created
      ? "fee_accounting_snapshot_saved"
      : "fee_accounting_snapshot_race_skipped", {
      blockHash: snapshot.blockHash,
      blockNumber: snapshot.blockNumber,
      pools: snapshot.pools.length,
      positions: snapshot.positions.length,
      runId: saved.runId,
      ticks: snapshot.ticks.length,
    });
  } finally {
    await healthGate.close();
    await sourceStore.close();
    await accountingStore.close();
  }
}

main().catch((error: unknown) => {
  log("error", "fee_accounting_failed", { error });
  process.exitCode = 1;
});
