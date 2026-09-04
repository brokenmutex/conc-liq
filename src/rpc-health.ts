import { z } from "zod";
import { log } from "./logger.js";
import { loadRpcHealthMonitorConfig } from "./rpc-health/config.js";
import { runRpcHealthProbe } from "./rpc-health/probe.js";
import { PostgresRpcHealthStore } from "./rpc-health/store.js";

const environmentSchema = z.object({ DATABASE_URL: z.string().min(1) });

interface CliOptions {
  readonly help: boolean;
  readonly maxCycles?: number;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let help = false;
  let maxCycles: number | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--once":
        if (maxCycles !== undefined) throw new Error("Cycle limit supplied twice");
        maxCycles = 1;
        break;
      case "--max-cycles": {
        if (maxCycles !== undefined) throw new Error("Cycle limit supplied twice");
        const value = arguments_[index + 1];
        if (value === undefined || !/^[1-9]\d*$/.test(value)) {
          throw new Error("--max-cycles requires a positive integer");
        }
        maxCycles = Number(value);
        if (!Number.isSafeInteger(maxCycles)) {
          throw new Error("--max-cycles exceeds the safe integer range");
        }
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
  return { help, maxCycles };
}

function printHelp(): void {
  console.log(`Usage: npm run rpc:health -- [options]

Continuously compares the private Robinhood read node with an independent
reference quorum. It stores a fail-closed circuit state for bulk RPC workers.

Options:
  --once                Store one health sample and exit
  --max-cycles NUMBER   Stop after this many samples
  -h, --help            Show this help

Environment:
  DATABASE_URL                         Required PostgreSQL database
  RH_INDEXER_RPC_URL                   Private read node
  RPC_HEALTH_REFERENCE_URLS            Comma-separated independent read RPCs
  RPC_HEALTH_REFERENCE_QUORUM          Matching anchor hashes required (default 2)
  RPC_HEALTH_SOFT_LAG_BLOCKS            Degraded threshold (default 20)
  RPC_HEALTH_HARD_LAG_BLOCKS            Open threshold (default 100)
  RPC_HEALTH_RECOVERY_SAMPLES           Clean samples before healthy (default 12)
  RPC_HEALTH_POLL_INTERVAL_MS           Probe cadence (default 10000)
`);
}

async function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const environment = environmentSchema.parse(process.env);
  const config = loadRpcHealthMonitorConfig();
  const store = new PostgresRpcHealthStore(environment.DATABASE_URL);
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals): void => {
    log("info", "rpc_health_stop_requested", { signal });
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await store.migrate();
    let cycles = 0;
    while (!controller.signal.aborted) {
      const startedAt = Date.now();
      const previous = await store.latest();
      const evaluation = await runRpcHealthProbe({ config, previous });
      const sampleId = await store.save(evaluation);
      cycles += 1;
      log("info", "rpc_health_sample_saved", {
        allowBulk: evaluation.allowBulk,
        anchorBlock: evaluation.anchorBlock,
        consecutiveHealthy: evaluation.consecutiveHealthy,
        lagBlocks: evaluation.lagBlocks,
        lagSeconds: evaluation.lagSeconds,
        privateHead: evaluation.privateHead,
        privateLatencyMs: evaluation.privateLatencyMs,
        reasons: evaluation.reasons,
        referenceHead: evaluation.referenceHead,
        referenceHeadSpreadBlocks: evaluation.referenceHeadSpreadBlocks,
        sampleId,
        state: evaluation.state,
        warnings: evaluation.warnings,
      });
      if (options.maxCycles !== undefined && cycles >= options.maxCycles) return;
      await waitForDelay(
        Math.max(0, config.pollIntervalMs - (Date.now() - startedAt)),
        controller.signal,
      );
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "rpc_health_failed", { error });
  process.exitCode = 1;
});
