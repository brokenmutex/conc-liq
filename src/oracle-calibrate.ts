import { z } from "zod";
import { createHistoricalClient } from "./history/client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { log } from "./logger.js";
import { collectOracleCalibration } from "./oracle/collector.js";
import { PostgresOracleCalibrationStore } from "./oracle/store.js";
import { selectCanonicalAssets } from "./registry.js";
import { loadRiskConfig } from "./risk/config.js";
import { ViemRiskChainReader } from "./risk/reader.js";
import {
  fetchFeedDirectory,
  fetchRegistrySource,
  selectOracleFeed,
} from "./risk/source.js";
import { validateRangePolicyReplaySource } from "./simulator/replay-canonical.js";
import { PostgresRangePolicyReplayStore } from "./simulator/replay-store.js";

const environmentSchema = z.object({ DATABASE_URL: z.string().min(1) });

interface CliOptions {
  readonly fee?: number;
  readonly firstRunId?: string;
  readonly help: boolean;
  readonly lastRunId?: string;
  readonly lookback: number;
  readonly rwaSymbol?: string;
}

function requireValue(
  arguments_: readonly string[],
  index: number,
  flag: string,
): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} requires a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} is too large`);
  return parsed;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let fee: number | undefined;
  let firstRunId: string | undefined;
  let help = false;
  let lastRunId: string | undefined;
  let lookback = 6;
  let lookbackSupplied = false;
  let rwaSymbol: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const value = () => requireValue(arguments_, index, argument);
    switch (argument) {
      case "--rwa":
        if (rwaSymbol !== undefined) throw new Error("--rwa supplied twice");
        rwaSymbol = value().toUpperCase();
        if (!/^[A-Z0-9]{1,16}$/.test(rwaSymbol)) {
          throw new Error("--rwa requires a canonical asset symbol");
        }
        index += 1;
        break;
      case "--fee":
        if (fee !== undefined) throw new Error("--fee supplied twice");
        fee = positiveInteger(value(), argument);
        index += 1;
        break;
      case "--lookback":
        if (lookbackSupplied) throw new Error("--lookback supplied twice");
        lookback = positiveInteger(value(), argument);
        if (lookback < 2 || lookback > 64) {
          throw new Error("--lookback must be between 2 and 64");
        }
        lookbackSupplied = true;
        index += 1;
        break;
      case "--from-run":
        if (firstRunId !== undefined) throw new Error("--from-run supplied twice");
        firstRunId = value();
        if (!/^[1-9]\d*$/.test(firstRunId)) {
          throw new Error("--from-run requires a positive run ID");
        }
        index += 1;
        break;
      case "--to-run":
        if (lastRunId !== undefined) throw new Error("--to-run supplied twice");
        lastRunId = value();
        if (!/^[1-9]\d*$/.test(lastRunId)) {
          throw new Error("--to-run requires a positive run ID");
        }
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
  if ((firstRunId === undefined) !== (lastRunId === undefined)) {
    throw new Error("--from-run and --to-run must be supplied together");
  }
  if (firstRunId !== undefined && lookbackSupplied) {
    throw new Error("--lookback cannot be combined with explicit run endpoints");
  }
  return { fee, firstRunId, help, lastRunId, lookback, rwaSymbol };
}

function printHelp(): void {
  console.log(`Usage: npm run oracle:calibrate -- [options]

Captures historical, block-pinned Chainlink and Robinhood token state for a
pool and compares multiplier-adjusted oracle value with its V3 spot price.

Required:
  --rwa SYMBOL       Canonical RWA symbol, for example NVDA
  --fee PIPS         Canonical V3 fee tier, for example 500

Optional:
  --lookback COUNT   Newest checkpoints (default 6; max 64)
  --from-run ID      First checkpoint (requires --to-run)
  --to-run ID        Last checkpoint; includes intervening runs
  -h, --help         Show this help

Environment:
  DATABASE_URL                       Required PostgreSQL database
  RH_INDEXER_RPC_URL                 Live node; isolated state uses RH_ARCHIVE_RPC_URL
  CHAINLINK_ROBINHOOD_FEEDS_URL      Canonical feed directory
  ROBINHOOD_ASSETS_URL               Canonical asset registry
  RISK_MAX_PRICE_AGE_SECONDS         Maximum valid historical mark age
`);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.rwaSymbol === undefined || options.fee === undefined) {
    throw new Error("--rwa and --fee are required");
  }
  const environment = environmentSchema.parse(process.env);
  const indexer = loadIndexerConfig();
  const risk = loadRiskConfig();
  const client = createHistoricalClient(indexer.rpcUrl, indexer.rpcTimeoutMs);
  const reader = new ViemRiskChainReader(client);
  const sourceStore = new PostgresRangePolicyReplayStore(environment.DATABASE_URL);
  const calibrationStore = new PostgresOracleCalibrationStore(
    environment.DATABASE_URL,
  );
  try {
    await calibrationStore.migrate();
    const [source, registrySource, feedSource] = await Promise.all([
      sourceStore.load({
        fee: options.fee,
        firstRunId: options.firstRunId,
        lastRunId: options.lastRunId,
        lookback: options.lookback,
        rwaSymbol: options.rwaSymbol,
        streamKey: indexer.streamKey,
      }),
      fetchRegistrySource(risk.assetsUrl, risk.httpTimeoutMs),
      fetchFeedDirectory(risk.feedDirectoryUrl, risk.httpTimeoutMs),
    ]);
    const canonical = await validateRangePolicyReplaySource({ client, source });
    const registryAsset = selectCanonicalAssets(
      registrySource.payload,
      [options.rwaSymbol],
    )[0]!;
    const rwaFeed = selectOracleFeed(feedSource.payload, options.rwaSymbol);
    const quoteFeed = selectOracleFeed(feedSource.payload, "USDG");
    if (rwaFeed === null) {
      throw new Error(`Canonical ${options.rwaSymbol}/USD oracle feed is unavailable`);
    }
    if (quoteFeed === null) {
      throw new Error("Canonical USDG/USD oracle feed is unavailable");
    }
    const calibration = await collectOracleCalibration({
      feedDirectory: feedSource.evidence,
      maxPriceAgeSeconds: risk.maxPriceAgeSeconds,
      quoteFeed,
      reader,
      registry: registrySource.evidence,
      registryAsset,
      rwaFeed,
      source: canonical,
    });
    const saved = await calibrationStore.save(calibration);
    log("info", saved.created
      ? "range_oracle_calibration_saved"
      : "range_oracle_calibration_already_exists", {
      calibrationRunId: saved.calibrationRunId,
      excludedMarks: calibration.excludedMarks,
      firstRunId: calibration.first.runId,
      lastRunId: calibration.last.runId,
      pool: `${calibration.rwaSymbol}/${calibration.fee}`,
      validMarks: calibration.validMarks,
    });
    console.log(JSON.stringify(calibration, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value, 2));
  } finally {
    await Promise.all([sourceStore.close(), calibrationStore.close()]);
  }
}

main().catch((error: unknown) => {
  log("error", "range_oracle_calibration_failed", { error });
  process.exitCode = 1;
});
