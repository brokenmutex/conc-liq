import { createRobinhoodClient } from "./client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { log } from "./logger.js";
import { loadRiskConfig } from "./risk/config.js";
import { sanitizeRiskError } from "./risk/evaluate.js";
import { ViemRiskChainReader } from "./risk/reader.js";
import { collectRiskSnapshot } from "./risk/runner.js";
import { collectAndSaveRiskSnapshot, PostgresRiskStore } from "./risk/store.js";
import { calculateSafeHead } from "./tail/runner.js";

interface CliOptions {
  readonly blockNumber?: bigint;
  readonly help: boolean;
}

function requireValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let blockNumber: bigint | undefined;
  let help = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--block": {
        const value = requireValue(arguments_, index, argument);
        if (!/^\d+$/u.test(value)) {
          throw new Error("--block must be a nonnegative integer");
        }
        blockNumber = BigInt(value);
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
  return { blockNumber, help };
}

function printHelp(): void {
  console.log(`Usage: npm run risk:snapshot -- [options]

Options:
  --block NUMBER   Pin reads to an explicit block (default: confirmation-safe head)
  -h, --help       Show this help

Environment:
  DATABASE_URL                         Required PostgreSQL database
  RH_INDEXER_RPC_URL                   Private read RPC; falls back to RH_RPC_URL
  ROBINHOOD_ASSETS_URL                 Robinhood canonical asset registry
  ROBINHOOD_MARKET_POLICY_URL          Official Stock Tokens market policy
  CHAINLINK_ROBINHOOD_FEEDS_URL        Chainlink Robinhood feed directory
  RISK_MAX_PRICE_AGE_SECONDS           Strict price age ceiling (default 300)
`);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const indexerConfig = loadIndexerConfig();
  const riskConfig = loadRiskConfig();
  const client = createRobinhoodClient(indexerConfig.rpcUrl, indexerConfig.rpcTimeoutMs);
  const reader = new ViemRiskChainReader(client);
  const blockNumber = options.blockNumber ?? calculateSafeHead(
    await client.getBlockNumber(),
    indexerConfig.confirmationDepth,
  );
  const store = new PostgresRiskStore(databaseUrl);
  try {
    await store.migrate();
    const snapshot = await collectAndSaveRiskSnapshot({
      blockNumber,
      collect: () => collectRiskSnapshot({ blockNumber, config: riskConfig, reader }),
      store,
    });
    log("info", "risk_snapshot_saved", {
      assetCount: snapshot.assets.length,
      blockNumber: snapshot.blockNumber,
      executionEligible: snapshot.executionEligible,
      ineligibleAssets: snapshot.assets
        .filter((asset) => !asset.executionEligible)
        .map((asset) => asset.registry.symbol),
      reasons: snapshot.reasons,
    });
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "risk_snapshot_failed", { error: sanitizeRiskError(error) });
  process.exitCode = 1;
});
