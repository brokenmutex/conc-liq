import { z } from "zod";
import { collectApprovalCostValuation } from "./approval-cost/valuation-collector.js";
import { PostgresApprovalCostValuationStore } from "./approval-cost/valuation-store.js";
import { createHistoricalClient } from "./history/client.js";
import { ROBINHOOD_CHAIN_ID } from "./constants.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { log } from "./logger.js";
import { loadRpcHealthGateConfig } from "./rpc-health/config.js";
import { PostgresRpcHealthGate } from "./rpc-health/store.js";
import { loadRiskConfig } from "./risk/config.js";
import { ViemRiskChainReader } from "./risk/reader.js";
import { fetchFeedDirectory, selectOracleFeed } from "./risk/source.js";

const environmentSchema = z.object({
  APPROVAL_COST_VALUATION_DELAY_MS: z.coerce.number()
    .int().nonnegative().max(5_000).default(250),
  APPROVAL_COST_VALUATION_MAX_PRICE_AGE_SECONDS: z.coerce.number()
    .int().positive().default(86_400),
  DATABASE_URL: z.string().min(1),
});

interface CliOptions {
  readonly approvalCostRunId?: string;
  readonly help: boolean;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let approvalCostRunId: string | undefined;
  let help = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--approval-cost-run": {
        if (approvalCostRunId !== undefined) {
          throw new Error("--approval-cost-run supplied twice");
        }
        const value = arguments_[index + 1];
        if (value === undefined || !/^[1-9]\d*$/u.test(value)) {
          throw new Error("--approval-cost-run requires a positive integer");
        }
        approvalCostRunId = value;
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
  return approvalCostRunId === undefined ? { help } : { approvalCostRunId, help };
}

function printHelp(): void {
  console.log(`Usage: npm run approval-cost:value -- [options]

Converts proven direct initial approval fees into USDG raw units using
independent ETH/USD and USDG/USD Chainlink rounds at each canonical transaction
block. Excluded approval shapes retain their reasons without oracle reads.

Options:
  --approval-cost-run ID  Value one approval run (default: newest run)
  -h, --help               Show this help
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
  const store = new PostgresApprovalCostValuationStore(environment.DATABASE_URL);
  const client = createHistoricalClient(indexer.rpcUrl, indexer.rpcTimeoutMs, {
    beforeRequest: async () => { await gate.assertBulkAllowed(); },
    retryCount: 0,
  });
  const reader = new ViemRiskChainReader(client);
  try {
    await gate.assertReady();
    await store.assertReady();
    await gate.assertBulkAllowed();
    const source = await store.loadSource(options.approvalCostRunId);
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
    const run = await collectApprovalCostValuation({
      ethFeed,
      feedDirectory: feedDirectory.evidence,
      interMarkDelayMs: environment.APPROVAL_COST_VALUATION_DELAY_MS,
      maxPriceAgeSeconds: environment.APPROVAL_COST_VALUATION_MAX_PRICE_AGE_SECONDS,
      quoteFeed,
      reader,
      source,
    });
    const saved = await store.save(run);
    log("info", saved.created
      ? "approval_cost_valuation_saved"
      : "approval_cost_valuation_already_exists", {
      approvalCostRunId: source.approvalCostRunId,
      runId: saved.runId,
      summary: run.summary,
    });
    console.log(JSON.stringify({
      approvalCostRunId: source.approvalCostRunId,
      computedAt: run.computedAt,
      executionEligible: false,
      runId: saved.runId,
      summary: run.summary,
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
  } finally {
    await gate.close();
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "approval_cost_valuation_failed", { error });
  process.exitCode = 1;
});
