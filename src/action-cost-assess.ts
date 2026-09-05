import { z } from "zod";
import { NONFUNGIBLE_POSITION_MANAGER } from "./constants.js";
import { log } from "./logger.js";
import { assessActionCostCall, summarizeActionCostCalls } from "./action-cost/comparability.js";
import type { ActionCostCallAssessmentRun } from "./action-cost/comparability-domain.js";
import { PostgresActionCostCallStore } from "./action-cost/comparability-store.js";

const environmentSchema = z.object({ DATABASE_URL: z.string().min(1) });

interface CliOptions {
  readonly help: boolean;
  readonly valuationRunId?: string;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let help = false;
  let valuationRunId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--valuation-run": {
        if (valuationRunId !== undefined) throw new Error("--valuation-run supplied twice");
        const value = arguments_[index + 1];
        if (value === undefined || !/^[1-9]\d*$/u.test(value)) {
          throw new Error("--valuation-run requires a positive integer");
        }
        valuationRunId = value;
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
  return valuationRunId === undefined ? { help } : { help, valuationRunId };
}

function printHelp(): void {
  console.log(`Usage: npm run action-cost:assess -- [options]

Classifies valued pool-touching transactions by exact canonical Position
Manager destination and top-level selector. Direct known calls are comparable,
multicalls remain opaque, and all other contracts/selectors are excluded.

Options:
  --valuation-run ID  Assess one valuation run (default: newest run)
  -h, --help           Show this help
`);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const environment = environmentSchema.parse(process.env);
  const store = new PostgresActionCostCallStore(environment.DATABASE_URL);
  try {
    await store.migrate();
    const source = await store.loadSource(options.valuationRunId);
    const assessments = source.marks.map((mark) =>
      assessActionCostCall(mark, NONFUNGIBLE_POSITION_MANAGER)
    );
    const run: ActionCostCallAssessmentRun = {
      assessments,
      computedAt: new Date().toISOString(),
      executionEligible: false,
      methodology: "position_manager_selector_comparability_v1",
      positionManager: NONFUNGIBLE_POSITION_MANAGER,
      schemaVersion: 1,
      source,
      summary: summarizeActionCostCalls(assessments),
    };
    const saved = await store.save(run);
    log("info", saved.created
      ? "action_cost_call_assessment_saved"
      : "action_cost_call_assessment_already_exists", {
      runId: saved.runId,
      summary: run.summary,
      valuationRunId: source.valuationRunId,
    });
    console.log(JSON.stringify({
      computedAt: run.computedAt,
      executionEligible: false,
      runId: saved.runId,
      summary: run.summary,
      valuationRunId: source.valuationRunId,
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "action_cost_call_assessment_failed", { error });
  process.exitCode = 1;
});
