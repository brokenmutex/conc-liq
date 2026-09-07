import { z } from "zod";
import { validateAccountingRun } from "./backtest/canonical.js";
import {
  reconstructPrincipalSnapshot,
  type PrincipalSnapshot,
} from "./backtest/principal.js";
import {
  AccountingRunUnavailableError,
  PostgresPrincipalStore,
} from "./backtest/principal-store.js";
import { createHistoricalClient } from "./history/client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { log } from "./logger.js";

const environmentSchema = z.object({ DATABASE_URL: z.string().min(1) });

interface CliOptions {
  readonly allMissing: boolean;
  readonly help: boolean;
  readonly ifAvailable: boolean;
  readonly runId?: string;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let allMissing = false;
  let help = false;
  let ifAvailable = false;
  let runId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--all":
        if (allMissing) throw new Error("--all supplied twice");
        allMissing = true;
        break;
      case "--run": {
        if (runId !== undefined) throw new Error("--run supplied twice");
        const value = arguments_[index + 1];
        if (value === undefined || !/^[1-9]\d*$/.test(value)) {
          throw new Error("--run requires a positive accounting run ID");
        }
        runId = value;
        index += 1;
        break;
      }
      case "--if-available":
        if (ifAvailable) throw new Error("--if-available supplied twice");
        ifAvailable = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (allMissing && runId !== undefined) {
    throw new Error("--all and --run are mutually exclusive");
  }
  return { allMissing, help, ifAvailable, runId };
}

function printHelp(): void {
  console.log(`Usage: npm run principal:reconstruct -- [options]

Reconstructs exact, floor-rounded token principal for every active core
position in an immutable accounting checkpoint. Defaults to the newest run.

Options:
  --run ID               Reconstruct one accounting run
  --all                  Reconstruct every run missing schema version 1
  --if-available         Exit successfully when no accounting run exists
  -h, --help             Show this help

Environment:
  DATABASE_URL           Required PostgreSQL database
  RH_INDEXER_RPC_URL     Private RPC used to revalidate source block hashes
`);
}

function printable(snapshot: PrincipalSnapshot): unknown {
  return {
    computedAt: snapshot.computedAt,
    executionEligible: snapshot.executionEligible,
    methodology: snapshot.methodology,
    pools: snapshot.pools,
    run: snapshot.run,
    schemaVersion: snapshot.schemaVersion,
    streamKey: snapshot.streamKey,
    totals: snapshot.totals,
  };
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const environment = environmentSchema.parse(process.env);
  const indexer = loadIndexerConfig();
  const rpc = createHistoricalClient(indexer.rpcUrl, indexer.rpcTimeoutMs);
  const store = new PostgresPrincipalStore(environment.DATABASE_URL);
  try {
    await store.assertReady();
    let runIds: string[];
    try {
      runIds = await store.runIds({
        allMissing: options.allMissing,
        runId: options.runId,
        streamKey: indexer.streamKey,
      });
    } catch (error) {
      if (options.ifAvailable && error instanceof AccountingRunUnavailableError) {
        log("info", "principal_reconstruction_skipped", {
          reason: "accounting_run_unavailable",
        });
        return;
      }
      throw error;
    }
    if (runIds.length === 0) {
      log("info", "principal_reconstruction_up_to_date", {
        streamKey: indexer.streamKey,
      });
      return;
    }
    const chainId = await rpc.getChainId();
    const results = [];
    for (const runId of runIds) {
      const source = await store.load(runId);
      if (source.run.chainId !== chainId) {
        throw new Error(
          `Principal RPC chain ID ${chainId} does not match accounting source ` +
          `${source.run.chainId}`,
        );
      }
      const run = await validateAccountingRun(rpc, source.run);
      const snapshot = reconstructPrincipalSnapshot({ ...source, run });
      const saved = await store.save(snapshot);
      log("info", saved.created
        ? "principal_reconstruction_saved"
        : "principal_reconstruction_already_exists", {
        accountingRunId: run.runId,
        aboveRangePositions: snapshot.totals.aboveRangePositions,
        belowRangePositions: snapshot.totals.belowRangePositions,
        inRangePositions: snapshot.totals.inRangePositions,
        positionCount: snapshot.totals.positionCount,
        principalRunId: saved.principalRunId,
      });
      results.push(printable(snapshot));
    }
    console.log(JSON.stringify(results.length === 1 ? results[0] : results,
      (_, value: unknown) => typeof value === "bigint" ? value.toString() : value,
      2));
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "principal_reconstruction_failed", { error });
  process.exitCode = 1;
});
