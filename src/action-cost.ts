import { z } from "zod";
import { loadIndexerConfig } from "./indexer/config.js";
import { loadHistoryConfig } from "./history/client.js";
import { log } from "./logger.js";
import { evaluateActionCost, summarizeActionCosts } from "./action-cost/evaluate.js";
import { JsonRpcActionCostReader } from "./action-cost/reader.js";
import { PostgresActionCostStore } from "./action-cost/store.js";
import type { ActionCostObservation, ActionCostRun } from "./action-cost/domain.js";
import { loadRpcHealthGateConfig } from "./rpc-health/config.js";
import { PostgresRpcHealthGate } from "./rpc-health/store.js";

const environmentSchema = z.object({
  ACTION_COST_CONCURRENCY: z.coerce.number().int().positive().max(8).default(4),
  DATABASE_URL: z.string().min(1),
  INDEXER_STREAM_KEY: z.string().min(1).default("robinhood-v3-rwa-usdg-v1"),
});

interface CliOptions {
  readonly help: boolean;
  readonly lookbackBlocks: number;
  readonly maxPerClass: number;
}

function positiveInteger(value: string | undefined, flag: string): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} requires a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} is too large`);
  return parsed;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let help = false;
  let lookbackBlocks = 20_000;
  let lookbackSupplied = false;
  let maxPerClass = 25;
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
      case "--max-per-class":
        if (maxSupplied) throw new Error("--max-per-class supplied twice");
        maxPerClass = positiveInteger(arguments_[index + 1], argument);
        if (maxPerClass > 100) throw new Error("--max-per-class cannot exceed 100");
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
  return { help, lookbackBlocks, maxPerClass };
}

function printHelp(): void {
  console.log(`Usage: npm run action-cost:snapshot -- [options]

Samples successful, confirmation-safe transactions that touched monitored V3
pools and records exact receipt fees. Costs are attributed only to the whole
observed transaction action mix, never to an individual event.

Options:
  --lookback-blocks N   Recent indexed block window (default 20000)
  --max-per-class N     Most-recent transactions per action class (default 25)
  -h, --help            Show this help

Environment:
  DATABASE_URL             Required PostgreSQL database
  RH_INDEXER_RPC_URL       Live node; HISTORY_SOURCE=hypersync isolates history
  ACTION_COST_CONCURRENCY  Concurrent receipt batches, maximum 8 (default 4)
  RPC_HEALTH_GATE_ENABLED  Require healthy quorum state (default true)
`);
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await operation(values[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const environment = environmentSchema.parse(process.env);
  const indexer = loadIndexerConfig();
  const sourceProvider = loadHistoryConfig(indexer.rpcUrl).source;
  const gateConfig = loadRpcHealthGateConfig();
  const gate = new PostgresRpcHealthGate({
    cacheMs: gateConfig.cacheMs,
    connectionString: environment.DATABASE_URL,
    enabled: gateConfig.enabled,
    maxSampleAgeSeconds: gateConfig.maxSampleAgeSeconds,
  });
  const store = new PostgresActionCostStore(environment.DATABASE_URL);
  const reader = new JsonRpcActionCostReader({
    gate,
    rpcUrl: indexer.rpcUrl,
    timeoutMs: indexer.rpcTimeoutMs,
  });
  try {
    await gate.assertReady();
    await store.assertReady();
    await gate.assertBulkAllowed();
    const source = await store.loadSource({
      lookbackBlocks: options.lookbackBlocks,
      maxPerClass: options.maxPerClass,
      streamKey: environment.INDEXER_STREAM_KEY,
    });
    if (source.candidates.length === 0) {
      throw new Error("No indexed action-cost candidates exist in the selected window");
    }
    const capturedAt = new Date().toISOString();
    const observations: ActionCostObservation[] = await mapConcurrent(
      source.candidates,
      environment.ACTION_COST_CONCURRENCY,
      async (candidate) => ({ ...evaluateActionCost({
        candidate,
        observedAt: capturedAt,
        raw: await reader.read(candidate.transactionHash, candidate.blockNumber),
        streamKey: source.streamKey,
      }), sourceProvider }),
    );
    const run: ActionCostRun = {
      capturedAt,
      executionEligible: false,
      maxPerClass: options.maxPerClass,
      methodology: "stratified_canonical_receipt_cost_v1",
      observations,
      schemaVersion: 1,
      source,
      summary: summarizeActionCosts(observations),
    };
    const saved = await store.save(run);
    log("info", saved.created
      ? "action_cost_snapshot_saved"
      : "action_cost_snapshot_already_exists", {
      eligibleCandidates: source.eligibleCandidates,
      fromBlock: source.fromBlock,
      runId: saved.runId,
      selectedTransactions: observations.length,
      summary: run.summary,
      toBlock: source.toBlock,
    });
    console.log(JSON.stringify({
      capturedAt,
      executionEligible: false,
      fromBlock: source.fromBlock,
      runId: saved.runId,
      summary: run.summary,
      toBlock: source.toBlock,
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
  } finally {
    await gate.close();
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "action_cost_snapshot_failed", { error });
  process.exitCode = 1;
});
