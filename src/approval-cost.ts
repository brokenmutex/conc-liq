import { z } from "zod";
import { JsonRpcActionCostReader } from "./action-cost/reader.js";
import { collectApprovalCostRun } from "./approval-cost/collector.js";
import { ViemApprovalCostReader } from "./approval-cost/reader.js";
import { PostgresApprovalCostStore } from "./approval-cost/store.js";
import { createHistoricalClient } from "./history/client.js";
import { NONFUNGIBLE_POSITION_MANAGER } from "./constants.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { log } from "./logger.js";
import { loadRpcHealthGateConfig } from "./rpc-health/config.js";
import { PostgresRpcHealthGate } from "./rpc-health/store.js";

const environmentSchema = z.object({
  APPROVAL_COST_DELAY_MS: z.coerce.number().int().nonnegative().max(5_000).default(250),
  APPROVAL_COST_INITIAL_CHUNK_SIZE: z.coerce.number().int().positive().default(5_000),
  APPROVAL_COST_MIN_CHUNK_SIZE: z.coerce.number().int().positive().default(100),
  DATABASE_URL: z.string().min(1),
  INDEXER_STREAM_KEY: z.string().min(1).default("robinhood-v3-rwa-usdg-v1"),
});

interface CliOptions {
  readonly help: boolean;
  readonly lookbackBlocks: number;
  readonly maxPerToken: number;
}

function positiveInteger(value: string | undefined, flag: string): number {
  if (value === undefined || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${flag} requires a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} is too large`);
  return parsed;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let help = false;
  let lookbackBlocks = 20_000;
  let maxPerToken = 10;
  let lookbackSupplied = false;
  let maxSupplied = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--lookback-blocks":
        if (lookbackSupplied) throw new Error("--lookback-blocks supplied twice");
        lookbackBlocks = positiveInteger(arguments_[index + 1], argument);
        lookbackSupplied = true;
        index += 1;
        break;
      case "--max-per-token":
        if (maxSupplied) throw new Error("--max-per-token supplied twice");
        maxPerToken = positiveInteger(arguments_[index + 1], argument);
        if (maxPerToken > 100) throw new Error("--max-per-token cannot exceed 100");
        maxSupplied = true;
        index += 1;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { help, lookbackBlocks, maxPerToken };
}

function printHelp(): void {
  console.log(`Usage: npm run approval-cost:snapshot -- [options]

Finds Approval events to the canonical Nonfungible Position Manager across the
monitored RWA/USDG token set, verifies transaction and receipt inclusion, and
checks block-pinned allowance state before and after each call. Only direct
zero-to-nonzero approve calls are comparable initial setup costs.

Options:
  --lookback-blocks N  Confirmed indexed window (default 20000)
  --max-per-token N    Recent candidate transactions per token (default 10)
  -h, --help           Show this help

Environment:
  DATABASE_URL                     Required PostgreSQL database
  RH_INDEXER_RPC_URL               Live node; isolated state uses RH_ARCHIVE_RPC_URL
  APPROVAL_COST_INITIAL_CHUNK_SIZE Approval log range (default 5000)
  APPROVAL_COST_MIN_CHUNK_SIZE     Smallest adaptive range (default 100)
  APPROVAL_COST_DELAY_MS           Delay after each candidate (default 250ms)
  RPC_HEALTH_GATE_ENABLED          Require healthy quorum state (default true)
`);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const environment = environmentSchema.parse(process.env);
  if (environment.APPROVAL_COST_MIN_CHUNK_SIZE >
      environment.APPROVAL_COST_INITIAL_CHUNK_SIZE) {
    throw new Error("Approval minimum chunk size exceeds initial chunk size");
  }
  const indexer = loadIndexerConfig();
  const gateConfig = loadRpcHealthGateConfig();
  const gate = new PostgresRpcHealthGate({
    cacheMs: gateConfig.cacheMs,
    connectionString: environment.DATABASE_URL,
    enabled: gateConfig.enabled,
    maxSampleAgeSeconds: gateConfig.maxSampleAgeSeconds,
  });
  const store = new PostgresApprovalCostStore(environment.DATABASE_URL);
  const client = createHistoricalClient(indexer.rpcUrl, indexer.rpcTimeoutMs, {
    beforeRequest: async () => { await gate.assertBulkAllowed(); },
    retryCount: 0,
  });
  const reader = new ViemApprovalCostReader(client);
  const receiptReader = new JsonRpcActionCostReader({
    gate,
    rpcUrl: indexer.rpcUrl,
    timeoutMs: indexer.rpcTimeoutMs,
  });
  try {
    await gate.assertReady();
    await store.assertReady();
    await gate.assertBulkAllowed();
    const source = await store.loadUniverse({
      lookbackBlocks: options.lookbackBlocks,
      positionManager: NONFUNGIBLE_POSITION_MANAGER,
      streamKey: environment.INDEXER_STREAM_KEY,
    });
    const run = await collectApprovalCostRun({
      initialChunkSize: environment.APPROVAL_COST_INITIAL_CHUNK_SIZE,
      interCandidateDelayMs: environment.APPROVAL_COST_DELAY_MS,
      maxPerToken: options.maxPerToken,
      minChunkSize: environment.APPROVAL_COST_MIN_CHUNK_SIZE,
      reader,
      receiptReader,
      source,
    });
    const saved = await store.save(run);
    log("info", saved.created
      ? "approval_cost_snapshot_saved"
      : "approval_cost_snapshot_already_exists", {
      eligibleCandidates: run.source.eligibleCandidates,
      runId: saved.runId,
      selectedCandidates: run.observations.length,
      summary: run.summary,
    });
    console.log(JSON.stringify({
      capturedAt: run.capturedAt,
      eligibleCandidates: run.source.eligibleCandidates,
      executionEligible: false,
      fromBlock: run.source.fromBlock,
      runId: saved.runId,
      selectedCandidates: run.observations.length,
      summary: run.summary,
      toBlock: run.source.toBlock,
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
  } finally {
    await gate.close();
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "approval_cost_snapshot_failed", { error });
  process.exitCode = 1;
});
