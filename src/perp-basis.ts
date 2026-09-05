import { z } from "zod";
import { log } from "./logger.js";
import { loadPerpBasisConfig } from "./perp-basis/config.js";
import { evaluatePerpBasis } from "./perp-basis/evaluate.js";
import { PostgresPerpBasisStore } from "./perp-basis/store.js";
import { loadPerpReferenceConfig } from "./perp-reference/config.js";

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  INDEXER_STREAM_KEY: z.string().min(1).default("robinhood-v3-rwa-usdg-v1"),
});

interface CliOptions {
  readonly fee?: number;
  readonly help: boolean;
  readonly rwaSymbol?: string;
}

function value(arguments_: readonly string[], index: number, flag: string): string {
  const result = arguments_[index + 1];
  if (result === undefined || result.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return result;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let fee: number | undefined;
  let help = false;
  let rwaSymbol: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--rwa") {
      if (rwaSymbol !== undefined) throw new Error("--rwa supplied twice");
      rwaSymbol = value(arguments_, index, argument).toUpperCase();
      if (!/^[A-Z0-9]{1,16}$/u.test(rwaSymbol)) {
        throw new Error("--rwa requires a canonical symbol");
      }
      index += 1;
    } else if (argument === "--fee") {
      if (fee !== undefined) throw new Error("--fee supplied twice");
      const raw = value(arguments_, index, argument);
      if (!/^[1-9]\d*$/u.test(raw)) throw new Error("--fee must be positive");
      fee = Number(raw);
      if (!Number.isSafeInteger(fee) || fee > 1_000_000) {
        throw new Error("--fee is outside the V3 fee domain");
      }
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { fee, help, rwaSymbol };
}

function printHelp(): void {
  console.log(`Usage: npm run perp-basis -- --rwa SYMBOL --fee PIPS

Combines the latest canonical strategy checkpoint with the latest shadow HIP-3
snapshot. It multiplier-adjusts the underlying-share reference, converts USD
through heartbeat-bounded USDG/USD evidence, and compares it with pool spot.
The result is always execution-ineligible.

Environment:
  DATABASE_URL       Required PostgreSQL database
  INDEXER_STREAM_KEY Strategy checkpoint stream
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
  const basisConfig = loadPerpBasisConfig();
  const perpConfig = loadPerpReferenceConfig();
  const store = new PostgresPerpBasisStore(environment.DATABASE_URL);
  try {
    await store.migrate();
    const source = await store.loadLatest({
      coin: perpConfig.coin,
      dex: perpConfig.dex,
      fee: options.fee,
      rwaSymbol: options.rwaSymbol,
      streamKey: environment.INDEXER_STREAM_KEY,
    });
    const assessment = evaluatePerpBasis({
      config: basisConfig,
      evaluatedAt: new Date().toISOString(),
      source,
    });
    const saved = await store.save(assessment);
    log("info", saved.created ? "perp_pool_basis_saved" : "perp_pool_basis_exists", {
      fallbackCandidate: assessment.fallbackCandidate,
      pool: `${options.rwaSymbol}/${options.fee}`,
      qualityPass: assessment.qualityPass,
      referenceMode: assessment.referenceMode,
      runId: saved.runId,
    });
    console.log(JSON.stringify(assessment, null, 2));
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "perp_pool_basis_failed", { error });
  process.exitCode = 1;
});
