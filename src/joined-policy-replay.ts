import { parseJoinedPolicyCli, loadJoinedPolicyEnvironment } from "./joined-policy/config.js";
import { replayJoinedReferencePolicies } from "./joined-policy/evaluate.js";
import {
  JoinedPolicyReplaySourceUnavailableError,
  PostgresJoinedPolicyReplayStore,
} from "./joined-policy/store.js";
import { log } from "./logger.js";

function printHelp(): void {
  console.log(`Usage: npm run joined-policy:replay -- [required options]

Replays range policies over quality-passing synchronized pool/reference marks.
Chainlink is selected while the primary mark is available; a normalized perp
mark is selected only from a passing fallback candidate. The command makes no
RPC calls and requires a stored measured entry/rebalance/exit cost model.

Required:
  --rwa SYMBOL                              Canonical RWA symbol
  --fee PIPS                                Canonical V3 fee tier
  --budget-usdg AMOUNT                      Scenario budget
  --half-widths LIST                        Comma-separated half-width spacings
  --trigger-percent INTEGER                 Recenter distance, 1..100% of half-width
  --lookback COUNT                          Passing joined checkpoints, 2..256
  --min-passing-checkpoints COUNT           Required selected checkpoint count
  --min-window-hours HOURS                  Required elapsed historical window
  --min-weekend-fallback-checkpoints COUNT  Required internal-weekend perp marks
  --min-external-fallback-checkpoints COUNT Required external-session perp marks

Environment:
  DATABASE_URL                              Required PostgreSQL database
  INDEXER_STREAM_KEY                        Canonical event stream

The two fallback minimums may be explicitly zero for diagnostic replays. Every
result remains execution_eligible=false and is never a live policy approval.
`);
}

async function main(): Promise<void> {
  const options = parseJoinedPolicyCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (
    options.rwaSymbol === undefined || options.fee === undefined ||
    options.budgetQuote === undefined || options.halfWidths === undefined ||
    options.triggerPercent === undefined || options.lookback === undefined ||
    options.minPassingCheckpoints === undefined ||
    options.minWindowHours === undefined ||
    options.minWeekendFallbackCheckpoints === undefined ||
    options.minExternalFallbackCheckpoints === undefined
  ) {
    throw new Error("All joined replay policy and evidence options are required; use --help");
  }
  if (options.minPassingCheckpoints > options.lookback) {
    throw new Error("--min-passing-checkpoints cannot exceed --lookback");
  }
  const environment = loadJoinedPolicyEnvironment();
  const store = new PostgresJoinedPolicyReplayStore(environment.databaseUrl);
  try {
    await store.assertReady();
    const source = await store.load({
      fee: options.fee,
      lookback: options.lookback,
      rwaSymbol: options.rwaSymbol,
      streamKey: environment.streamKey,
    });
    const replay = replayJoinedReferencePolicies({
      budgetQuote: options.budgetQuote,
      halfWidths: options.halfWidths,
      requirements: {
        minExternalFallbackCheckpoints: options.minExternalFallbackCheckpoints,
        minPassingCheckpoints: options.minPassingCheckpoints,
        minWeekendFallbackCheckpoints: options.minWeekendFallbackCheckpoints,
        minWindowHours: options.minWindowHours,
      },
      source,
      triggerPercent: options.triggerPercent,
    });
    const saved = await store.save(replay);
    log("info", saved.created ? "joined_policy_replay_saved" : "joined_policy_replay_exists", {
      completedCandidates: replay.completedCandidates,
      excludedCandidates: replay.excludedCandidates,
      policySetHash: replay.policySetHash,
      replayRunId: saved.replayRunId,
      selectedCheckpoints: replay.evidence.selectedCheckpoints,
      windowHours: replay.evidence.windowHours,
    });
    console.log(JSON.stringify({ replayRunId: saved.replayRunId, ...replay }, null, 2));
  } catch (error) {
    if (error instanceof JoinedPolicyReplaySourceUnavailableError) {
      log("warn", "joined_policy_replay_source_unavailable", { error: error.message });
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "joined_policy_replay_failed", { error });
  process.exitCode = 1;
});
