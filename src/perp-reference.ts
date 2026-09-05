import { z } from "zod";
import { log } from "./logger.js";
import { loadPerpReferenceConfig } from "./perp-reference/config.js";
import { evaluatePerpReference } from "./perp-reference/evaluate.js";
import { fetchPerpCandles, fetchPerpMarketContext } from "./perp-reference/source.js";
import { PostgresPerpReferenceStore } from "./perp-reference/store.js";
import { assessPerpWeekends } from "./perp-reference/weekend.js";

const environmentSchema = z.object({ DATABASE_URL: z.string().min(1) });
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

interface CliOptions {
  readonly command: "backfill" | "snapshot";
  readonly days: number;
  readonly help: boolean;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let command: "backfill" | "snapshot" = "snapshot";
  let days = 120;
  let daysSeen = false;
  let help = false;
  let commandSeen = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "snapshot" || argument === "backfill") {
      if (commandSeen) throw new Error("Perp reference command supplied twice");
      command = argument;
      commandSeen = true;
      continue;
    }
    if (argument === "--days") {
      if (daysSeen) throw new Error("--days supplied twice");
      const value = arguments_[index + 1];
      if (value === undefined || !/^\d+$/u.test(value)) {
        throw new Error("--days requires an integer");
      }
      days = Number(value);
      if (!Number.isSafeInteger(days) || days < 7 || days > 180) {
        throw new Error("--days must be between 7 and 180");
      }
      daysSeen = true;
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (command !== "backfill" && daysSeen) {
    throw new Error("--days is only valid for backfill");
  }
  return { command, days, help };
}

function printHelp(): void {
  console.log(`Usage: npm run perp-reference -- [snapshot|backfill] [options]

Capture the trade[XYZ] HIP-3 NVDA perpetual as a shadow-only reference, or
assess completed hourly weekend sessions against the close of the first full
external-price hour. Neither command authorizes execution.

Options:
  --days DAYS   Backfill lookback, 7-180 days (default 120)
  -h, --help    Show this help

Environment:
  DATABASE_URL                                      Required PostgreSQL database
  HYPERLIQUID_INFO_URL                              Official info endpoint
  PERP_REFERENCE_DEX                                HIP-3 dex (default xyz)
  PERP_REFERENCE_COIN                               Market (default xyz:NVDA)
  PERP_REFERENCE_REQUEST_TIMEOUT_MS                 Request timeout (default 10000)
  PERP_REFERENCE_MAX_MARK_ORACLE_DEVIATION_PPM      Shadow quality threshold
  PERP_REFERENCE_MAX_MID_ORACLE_DEVIATION_PPM       Shadow quality threshold
  PERP_REFERENCE_MAX_IMPACT_SPREAD_PPM              Shadow quality threshold
  PERP_REFERENCE_MIN_DAY_NOTIONAL_USD                Shadow quality threshold
  PERP_REFERENCE_MIN_OPEN_INTEREST_NOTIONAL_USD      Shadow quality threshold
`);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const environment = environmentSchema.parse(process.env);
  const config = loadPerpReferenceConfig();
  const store = new PostgresPerpReferenceStore(environment.DATABASE_URL);
  try {
    await store.migrate();
    if (options.command === "snapshot") {
      const source = await fetchPerpMarketContext({
        coin: config.coin,
        dex: config.dex,
        timeoutMs: config.requestTimeoutMs,
        url: config.infoUrl,
      });
      const snapshot = evaluatePerpReference({
        coin: config.coin,
        dex: config.dex,
        observedAt: source.evidence.fetchedAt,
        quality: config.quality,
        source,
      });
      const saved = await store.saveSnapshot(snapshot);
      log("info", "perp_reference_shadow_saved", {
        expectedPricingMode: snapshot.expectedPricingMode,
        qualityPass: snapshot.qualityPass,
        runId: saved.runId,
        status: snapshot.status,
      });
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    const now = Date.now();
    const toTimeMs = Math.floor(now / HOUR_MS) * HOUR_MS - 1;
    const fromTimeMs = toTimeMs + 1 - options.days * DAY_MS;
    const source = await fetchPerpCandles({
      coin: config.coin,
      fromTimeMs,
      timeoutMs: config.requestTimeoutMs,
      toTimeMs,
      url: config.infoUrl,
    });
    const assessment = assessPerpWeekends({
      coin: config.coin,
      computedAt: new Date().toISOString(),
      dex: config.dex,
      source,
    });
    const saved = await store.saveAssessment({
      assessment,
      candles: source.candles,
    });
    log("info", saved.created
      ? "perp_weekend_assessment_saved"
      : "perp_weekend_assessment_already_exists", {
      completeSessions: assessment.summary.completeSessions,
      excludedSessions: assessment.summary.excludedSessions,
      runId: saved.runId,
    });
    console.log(JSON.stringify(assessment, null, 2));
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "perp_reference_failed", { error });
  process.exitCode = 1;
});
