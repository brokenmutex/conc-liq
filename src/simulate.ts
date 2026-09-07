import { z } from "zod";
import { createHistoricalClient } from "./history/client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { log } from "./logger.js";
import { validateRangeSimulationSource } from "./simulator/canonical.js";
import { simulateStaticCenteredRanges } from "./simulator/evaluate.js";
import { PostgresRangeSimulationStore } from "./simulator/store.js";

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
});

interface CliOptions {
  readonly budgetQuote?: bigint;
  readonly costQuote?: bigint;
  readonly fee?: number;
  readonly fromRunId?: string;
  readonly halfWidths?: readonly number[];
  readonly help: boolean;
  readonly rwaSymbol?: string;
  readonly toRunId?: string;
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

function parseUsdRaw(value: string, flag: string, allowZero: boolean): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value);
  if (match === null) {
    throw new Error(`${flag} requires a nonnegative USDG amount with up to 6 decimals`);
  }
  const raw = BigInt(match[1]!) * 1_000_000n +
    BigInt((match[2] ?? "").padEnd(6, "0"));
  if (!allowZero && raw === 0n) throw new Error(`${flag} must be positive`);
  return raw;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let budgetQuote: bigint | undefined;
  let costQuote: bigint | undefined;
  let fee: number | undefined;
  let fromRunId: string | undefined;
  let halfWidths: number[] | undefined;
  let help = false;
  let rwaSymbol: string | undefined;
  let toRunId: string | undefined;
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
      case "--fee": {
        if (fee !== undefined) throw new Error("--fee supplied twice");
        const raw = value();
        if (!/^\d+$/.test(raw)) throw new Error("--fee requires an integer");
        fee = Number(raw);
        if (!Number.isSafeInteger(fee) || fee <= 0) {
          throw new Error("--fee requires a positive safe integer");
        }
        index += 1;
        break;
      }
      case "--budget-usdg":
        if (budgetQuote !== undefined) throw new Error("--budget-usdg supplied twice");
        budgetQuote = parseUsdRaw(value(), argument, false);
        index += 1;
        break;
      case "--cost-usdg":
        if (costQuote !== undefined) throw new Error("--cost-usdg supplied twice");
        costQuote = parseUsdRaw(value(), argument, true);
        index += 1;
        break;
      case "--half-widths": {
        if (halfWidths !== undefined) throw new Error("--half-widths supplied twice");
        const raw = value().split(",");
        if (raw.some((entry) => !/^[1-9]\d*$/.test(entry))) {
          throw new Error("--half-widths requires comma-separated positive integers");
        }
        halfWidths = raw.map(Number);
        if (halfWidths.some((width) => !Number.isSafeInteger(width))) {
          throw new Error("--half-widths values exceed safe integer range");
        }
        index += 1;
        break;
      }
      case "--from-run":
        if (fromRunId !== undefined) throw new Error("--from-run supplied twice");
        fromRunId = value();
        if (!/^[1-9]\d*$/.test(fromRunId)) {
          throw new Error("--from-run requires a positive run ID");
        }
        index += 1;
        break;
      case "--to-run":
        if (toRunId !== undefined) throw new Error("--to-run supplied twice");
        toRunId = value();
        if (!/^[1-9]\d*$/.test(toRunId)) {
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
  if ((fromRunId === undefined) !== (toRunId === undefined)) {
    throw new Error("--from-run and --to-run must be supplied together");
  }
  return {
    budgetQuote,
    costQuote,
    fee,
    fromRunId,
    halfWidths,
    help,
    rwaSymbol,
    toRunId,
  };
}

function printHelp(): void {
  console.log(`Usage: npm run range:simulate -- [options]

Compares static centered Uniswap V3 ranges over two exact accounting
checkpoints. Results are shadow-only and use pool-spot USDG valuation.

Required:
  --rwa SYMBOL           Canonical RWA symbol, for example NVDA
  --fee PIPS             Canonical V3 fee tier, for example 500
  --budget-usdg AMOUNT   Common starting budget in USDG display units
  --cost-usdg AMOUNT     Explicit total cost applied to every candidate
  --half-widths LIST     Comma-separated range half-widths in tick spacings

Optional:
  --from-run ID          Older checkpoint (requires --to-run)
  --to-run ID            Newer checkpoint (requires --from-run)
  -h, --help             Show this help

Environment:
  DATABASE_URL           Required PostgreSQL database
  RH_INDEXER_RPC_URL     Private RPC for checkpoint canonicality validation
`);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (
    options.rwaSymbol === undefined || options.fee === undefined ||
    options.budgetQuote === undefined || options.costQuote === undefined ||
    options.halfWidths === undefined
  ) {
    throw new Error(
      "--rwa, --fee, --budget-usdg, --cost-usdg, and --half-widths are required",
    );
  }
  const environment = environmentSchema.parse(process.env);
  const indexer = loadIndexerConfig();
  const client = createHistoricalClient(indexer.rpcUrl, indexer.rpcTimeoutMs);
  const store = new PostgresRangeSimulationStore(environment.DATABASE_URL);
  try {
    await store.assertReady();
    const source = await store.load({
      fee: options.fee,
      fromRunId: options.fromRunId,
      rwaSymbol: options.rwaSymbol,
      streamKey: indexer.streamKey,
      toRunId: options.toRunId,
    });
    const canonical = await validateRangeSimulationSource({ client, source });
    const simulation = simulateStaticCenteredRanges({
      budgetQuote: options.budgetQuote,
      costQuote: options.costQuote,
      halfWidths: options.halfWidths,
      source: canonical,
    });
    const saved = await store.save(simulation);
    log("info", saved.created
      ? "range_simulation_saved"
      : "range_simulation_already_exists", {
      completedCandidates: simulation.completedCandidates,
      excludedCandidates: simulation.excludedCandidates,
      fromRunId: simulation.from.runId,
      pool: `${simulation.rwaSymbol}/${simulation.fee}`,
      simulationRunId: saved.simulationRunId,
      toRunId: simulation.to.runId,
    });
    console.log(JSON.stringify(simulation, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value, 2));
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "range_simulation_failed", { error });
  process.exitCode = 1;
});
