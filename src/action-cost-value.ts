import { z } from "zod";
import { createHistoricalClient } from "./history/client.js";
import { ROBINHOOD_CHAIN_ID } from "./constants.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { log } from "./logger.js";
import { loadRpcHealthGateConfig } from "./rpc-health/config.js";
import { PostgresRpcHealthGate } from "./rpc-health/store.js";
import { loadRiskConfig } from "./risk/config.js";
import { ViemRiskChainReader } from "./risk/reader.js";
import { fetchFeedDirectory, selectOracleFeed } from "./risk/source.js";
import { collectActionCostValuation } from "./action-cost/valuation-collector.js";
import { PostgresActionCostValuationStore } from "./action-cost/valuation-store.js";

const environmentSchema = z.object({
  ACTION_COST_VALUATION_CONCURRENCY: z.coerce.number().int().positive().max(2).default(1),
  ACTION_COST_VALUATION_DELAY_MS: z.coerce.number().int().nonnegative().max(5_000).default(250),
  ACTION_COST_VALUATION_MAX_PRICE_AGE_SECONDS: z.coerce.number()
    .int().positive().default(86_400),
  DATABASE_URL: z.string().min(1),
});

interface CliOptions {
  readonly actionCostRunId?: string;
  readonly help: boolean;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let actionCostRunId: string | undefined;
  let help = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--action-cost-run": {
        if (actionCostRunId !== undefined) {
          throw new Error("--action-cost-run supplied twice");
        }
        const value = arguments_[index + 1];
        if (value === undefined || !/^[1-9]\d*$/u.test(value)) {
          throw new Error("--action-cost-run requires a positive integer");
        }
        actionCostRunId = value;
        index += 1;
        break;
      }
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return actionCostRunId === undefined ? { help } : { actionCostRunId, help };
}

function printHelp(): void {
  console.log(`Usage: npm run action-cost:value -- [options]

Converts exact historical native-token transaction fees into USDG raw units
using independent ETH/USD and USDG/USD Chainlink rounds read at each canonical
transaction block. Invalid, stale, unreadable, or noncanonical marks are
persisted as excluded and are never inferred.

Options:
  --action-cost-run ID  Value one action-cost run (default: newest run)
  -h, --help            Show this help

Environment:
  DATABASE_URL                       Required PostgreSQL database
  RH_INDEXER_RPC_URL                 Live node; isolated state uses RH_ARCHIVE_RPC_URL
  ACTION_COST_VALUATION_CONCURRENCY  Concurrent block marks, maximum 2 (default 1)
  ACTION_COST_VALUATION_DELAY_MS     Delay after each mark (default 250ms)
  ACTION_COST_VALUATION_MAX_PRICE_AGE_SECONDS
                                      Accounting ceiling (default 86400; feed
                                      heartbeat remains the tighter bound)
  CHAINLINK_ROBINHOOD_FEEDS_URL      Canonical feed directory
  RISK_MAX_PRICE_AGE_SECONDS         Maximum accepted oracle age
  RPC_HEALTH_GATE_ENABLED            Require healthy quorum state (default true)
`);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const environment = environmentSchema.parse(process.env);
  const indexer = loadIndexerConfig();
  const risk = loadRiskConfig();
  const gateConfig = loadRpcHealthGateConfig();
  const gate = new PostgresRpcHealthGate({
    cacheMs: gateConfig.cacheMs,
    connectionString: environment.DATABASE_URL,
    enabled: gateConfig.enabled,
    maxSampleAgeSeconds: gateConfig.maxSampleAgeSeconds,
  });
  const store = new PostgresActionCostValuationStore(environment.DATABASE_URL);
  const client = createHistoricalClient(indexer.rpcUrl, indexer.rpcTimeoutMs, {
    beforeRequest: async () => { await gate.assertBulkAllowed(); },
    retryCount: 0,
  });
  const reader = new ViemRiskChainReader(client);
  try {
    await gate.migrate();
    await store.migrate();
    await gate.assertBulkAllowed();
    const source = await store.loadSource(options.actionCostRunId);
    const [chainId, feedDirectory] = await Promise.all([
      reader.getChainId(),
      fetchFeedDirectory(risk.feedDirectoryUrl, risk.httpTimeoutMs),
    ]);
    if (chainId !== ROBINHOOD_CHAIN_ID || source.chainId !== ROBINHOOD_CHAIN_ID) {
      throw new Error(
        `Chain ID mismatch: expected ${ROBINHOOD_CHAIN_ID}, ` +
        `RPC ${chainId}, source ${source.chainId}`,
      );
    }
    const ethFeed = selectOracleFeed(feedDirectory.payload, "ETH");
    const quoteFeed = selectOracleFeed(feedDirectory.payload, "USDG");
    if (ethFeed === null) throw new Error("Canonical ETH/USD reference feed is unavailable");
    if (quoteFeed === null) {
      throw new Error("Canonical USDG/USD reference feed is unavailable");
    }
    const run = await collectActionCostValuation({
      concurrency: environment.ACTION_COST_VALUATION_CONCURRENCY,
      ethFeed,
      feedDirectory: feedDirectory.evidence,
      interMarkDelayMs: environment.ACTION_COST_VALUATION_DELAY_MS,
      maxPriceAgeSeconds: environment.ACTION_COST_VALUATION_MAX_PRICE_AGE_SECONDS,
      quoteFeed,
      reader,
      source,
    });
    const saved = await store.save(run);
    log("info", saved.created
      ? "action_cost_valuation_saved"
      : "action_cost_valuation_already_exists", {
      actionCostRunId: source.actionCostRunId,
      runId: saved.runId,
      summary: run.summary,
    });
    console.log(JSON.stringify({
      actionCostRunId: source.actionCostRunId,
      computedAt: run.computedAt,
      executionEligible: false,
      feedDirectory: run.feedDirectory,
      runId: saved.runId,
      summary: run.summary,
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
  } finally {
    await gate.close();
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "action_cost_valuation_failed", { error });
  process.exitCode = 1;
});
