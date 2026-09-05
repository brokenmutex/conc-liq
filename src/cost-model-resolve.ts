import { z } from "zod";
import { resolveGuardedCostModel } from "./cost-model/evaluate.js";
import { PostgresGuardedCostModelStore } from "./cost-model/store.js";
import { log } from "./logger.js";

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  INDEXER_STREAM_KEY: z.string().min(1).default("robinhood-v3-rwa-usdg-v1"),
});

interface CliOptions {
  readonly actionAssessmentRunId?: string;
  readonly approvalValuationRunId?: string;
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

function runId(input: string, flag: string): string {
  if (!/^[1-9]\d*$/u.test(input)) throw new Error(`${flag} requires a positive integer`);
  return input;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let actionAssessmentRunId: string | undefined;
  let approvalValuationRunId: string | undefined;
  let fee: number | undefined;
  let help = false;
  let rwaSymbol: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--rwa":
        if (rwaSymbol !== undefined) throw new Error("--rwa supplied twice");
        rwaSymbol = value(arguments_, index, argument).toUpperCase();
        if (!/^[A-Z0-9]{1,16}$/u.test(rwaSymbol)) {
          throw new Error("--rwa requires a canonical symbol");
        }
        index += 1;
        break;
      case "--fee": {
        if (fee !== undefined) throw new Error("--fee supplied twice");
        const raw = value(arguments_, index, argument);
        if (!/^[1-9]\d*$/u.test(raw)) throw new Error("--fee requires a positive integer");
        fee = Number(raw);
        if (!Number.isSafeInteger(fee) || fee > 1_000_000) {
          throw new Error("--fee is outside the V3 fee domain");
        }
        index += 1;
        break;
      }
      case "--action-assessment-run":
        if (actionAssessmentRunId !== undefined) {
          throw new Error("--action-assessment-run supplied twice");
        }
        actionAssessmentRunId = runId(value(arguments_, index, argument), argument);
        index += 1;
        break;
      case "--approval-valuation-run":
        if (approvalValuationRunId !== undefined) {
          throw new Error("--approval-valuation-run supplied twice");
        }
        approvalValuationRunId = runId(value(arguments_, index, argument), argument);
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
  return {
    actionAssessmentRunId,
    approvalValuationRunId,
    fee,
    help,
    rwaSymbol,
  };
}

function printHelp(): void {
  console.log(`Usage: npm run cost-model:resolve -- [options]

Resolves a pool-specific measured entry cost as the sum of P90 direct initial
mint, RWA approval, and USDG approval observations. Missing components remain
unavailable. Rebalance cost remains unavailable until its exact execution path
and comparable component sample are defined.

Required:
  --rwa SYMBOL                   Canonical RWA symbol
  --fee PIPS                     Canonical V3 fee tier

Optional:
  --action-assessment-run ID     Pin call assessment (default newest)
  --approval-valuation-run ID    Pin approval valuation (default newest)
  -h, --help                     Show this help
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
  const store = new PostgresGuardedCostModelStore(environment.DATABASE_URL);
  try {
    await store.migrate();
    const input = await store.load({
      actionAssessmentRunId: options.actionAssessmentRunId,
      approvalValuationRunId: options.approvalValuationRunId,
      fee: options.fee,
      rwaSymbol: options.rwaSymbol,
      streamKey: environment.INDEXER_STREAM_KEY,
    });
    const model = resolveGuardedCostModel(input);
    const saved = await store.save(model);
    log("info", saved.created
      ? "guarded_cost_model_saved"
      : "guarded_cost_model_already_exists", {
      entryCostQuoteRaw: model.entryCostQuoteRaw,
      modelId: saved.modelId,
      pool: `${model.source.rwaSymbol}/${model.source.fee}`,
      reasons: model.reasons,
      status: model.status,
      warnings: model.warnings,
    });
    console.log(JSON.stringify({
      ...model,
      modelId: saved.modelId,
    }, (_key, entry: unknown) => typeof entry === "bigint" ? entry.toString() : entry, 2));
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "guarded_cost_model_failed", { error });
  process.exitCode = 1;
});
