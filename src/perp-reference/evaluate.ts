import {
  PERP_REFERENCE_METHOD,
  PERP_REFERENCE_SOURCE,
  type ExpectedPricingMode,
  type PerpMarketContextSource,
  type PerpReferenceQualityConfig,
  type PerpReferenceSnapshot,
} from "./domain.js";
import {
  deviationPpm,
  parseUnsignedDecimalX18,
  X18,
} from "./math.js";

const newYorkParts = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  month: "2-digit",
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
});

interface LocalTimeParts {
  readonly day: number;
  readonly hour: number;
  readonly month: number;
  readonly weekday: string;
  readonly year: number;
}

export function newYorkTimeParts(timestampMs: number): LocalTimeParts {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new Error("Timestamp must be a nonnegative safe integer");
  }
  const entries = Object.fromEntries(
    newYorkParts.formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekday = entries.weekday;
  if (weekday === undefined) throw new Error("New York weekday is unavailable");
  return {
    day: Number(entries.day),
    hour: Number(entries.hour),
    month: Number(entries.month),
    weekday,
    year: Number(entries.year),
  };
}

export function expectedPricingMode(timestampMs: number): ExpectedPricingMode {
  const local = newYorkTimeParts(timestampMs);
  const internal =
    (local.weekday === "Fri" && local.hour >= 20) ||
    local.weekday === "Sat" ||
    (local.weekday === "Sun" && local.hour < 20);
  return internal ? "scheduled_internal_weekend" : "external_session_expected";
}

function addReason(reasons: string[], condition: boolean, reason: string): void {
  if (!condition) reasons.push(reason);
}

export function evaluatePerpReference(input: {
  readonly coin: string;
  readonly dex: string;
  readonly observedAt: string;
  readonly quality: PerpReferenceQualityConfig;
  readonly source: PerpMarketContextSource;
}): PerpReferenceSnapshot {
  const observedTime = Date.parse(input.observedAt);
  if (!Number.isFinite(observedTime)) {
    throw new Error("Perp reference observation timestamp is invalid");
  }
  if (input.source.asset.name !== input.coin) {
    throw new Error("Perp reference asset does not match configured coin");
  }
  const oracle = parseUnsignedDecimalX18(
    input.source.context.oraclePrice,
    "perp oracle price",
  );
  const mark = parseUnsignedDecimalX18(
    input.source.context.markPrice,
    "perp mark price",
  );
  const mid = input.source.context.midPrice === null
    ? null
    : parseUnsignedDecimalX18(input.source.context.midPrice, "perp mid price");
  const impacts = input.source.context.impactPrices === null
    ? null
    : input.source.context.impactPrices.map((value, index) =>
      parseUnsignedDecimalX18(value, `perp impact price ${index}`)
    ) as [bigint, bigint];
  const dayNotional = parseUnsignedDecimalX18(
    input.source.context.dayNotionalVolume,
    "perp day notional volume",
  );
  const openInterest = parseUnsignedDecimalX18(
    input.source.context.openInterest,
    "perp open interest",
  );
  const openInterestNotional = openInterest * oracle / X18;
  const pricesPositive = oracle > 0n && mark > 0n && (mid === null || mid > 0n);
  const markDeviation = oracle === 0n ? null : deviationPpm(mark, oracle);
  const midDeviation = oracle === 0n || mid === null
    ? null
    : deviationPpm(mid, oracle);
  const impactPricesValid = impacts !== null &&
    impacts[0] > 0n && impacts[1] > 0n && impacts[0] <= impacts[1];
  const impactSpread = !impactPricesValid || mid === null || mid === 0n
    ? null
    : (impacts![1] - impacts![0]) * 1_000_000n / mid;
  const flags = {
    assetActive: !input.source.asset.isDelisted,
    dayVolumeSufficient: dayNotional >= input.quality.minDayNotionalUsdX18,
    impactPricesValid,
    impactSpreadBounded: impactSpread !== null &&
      impactSpread <= input.quality.maxImpactSpreadPpm,
    markOracleAligned: markDeviation !== null &&
      markDeviation <= input.quality.maxMarkOracleDeviationPpm,
    midOracleAligned: midDeviation !== null &&
      midDeviation <= input.quality.maxMidOracleDeviationPpm,
    openInterestSufficient:
      openInterestNotional >= input.quality.minOpenInterestNotionalUsdX18,
    pricesPositive,
  };
  const reasons: string[] = [];
  addReason(reasons, flags.assetActive, "perp_market_delisted");
  addReason(reasons, flags.pricesPositive, "perp_price_nonpositive");
  addReason(reasons, flags.impactPricesValid, "perp_impact_prices_invalid");
  addReason(reasons, flags.markOracleAligned, "perp_mark_oracle_deviation_high");
  addReason(reasons, flags.midOracleAligned, "perp_mid_oracle_deviation_high");
  addReason(reasons, flags.impactSpreadBounded, "perp_impact_spread_high");
  addReason(reasons, flags.dayVolumeSufficient, "perp_day_volume_low");
  addReason(reasons, flags.openInterestSufficient, "perp_open_interest_low");
  const qualityPass = reasons.length === 0;
  return {
    asset: input.source.asset,
    assetIndex: input.source.assetIndex,
    coin: input.coin,
    context: input.source.context,
    dex: input.dex,
    evidence: input.source.evidence,
    executionEligible: false,
    expectedPricingMode: expectedPricingMode(observedTime),
    flags,
    limitations: [
      "hip3_oracle_is_deployer_operated",
      "scheduled_closed_session_price_is_endogenous_to_perp_orderbook",
      "per_market_source_timestamp_unavailable_in_info_response",
      "stock_token_multiplier_and_usdg_basis_not_applied",
      "shadow_quality_does_not_authorize_execution",
    ],
    methodology: PERP_REFERENCE_METHOD,
    metrics: {
      dayNotionalUsdX18: dayNotional.toString(),
      impactSpreadPpm: impactSpread?.toString() ?? null,
      markOracleDeviationPpm: markDeviation?.toString() ?? null,
      midOracleDeviationPpm: midDeviation?.toString() ?? null,
      openInterestNotionalUsdX18: openInterestNotional.toString(),
      oraclePriceX18: oracle.toString(),
    },
    observedAt: input.observedAt,
    qualityPass,
    reasons,
    schemaVersion: 1,
    source: PERP_REFERENCE_SOURCE,
    status: qualityPass ? "observed" : "quality_rejected",
    thresholds: {
      maxImpactSpreadPpm: input.quality.maxImpactSpreadPpm.toString(),
      maxMarkOracleDeviationPpm:
        input.quality.maxMarkOracleDeviationPpm.toString(),
      maxMidOracleDeviationPpm:
        input.quality.maxMidOracleDeviationPpm.toString(),
      minDayNotionalUsdX18: input.quality.minDayNotionalUsdX18.toString(),
      minOpenInterestNotionalUsdX18:
        input.quality.minOpenInterestNotionalUsdX18.toString(),
    },
  };
}
