import {
  PERP_REFERENCE_SOURCE,
  PERP_WEEKEND_METHOD,
  type PerpCandle,
  type PerpCandleSource,
  type PerpWeekendAssessment,
  type WeekendSessionAssessment,
} from "./domain.js";
import { expectedPricingMode, newYorkTimeParts } from "./evaluate.js";
import { absolute, percentile, signedPpm } from "./math.js";

const HOUR_MS = 60 * 60 * 1_000;

function fridayKey(timestampMs: number): string {
  const local = newYorkTimeParts(timestampMs);
  let offset = 0;
  if (local.weekday === "Sat") offset = 1;
  if (local.weekday === "Sun") offset = 2;
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day - offset));
  return date.toISOString().slice(0, 10);
}

function sign(value: bigint): -1 | 0 | 1 {
  return value < 0n ? -1 : value > 0n ? 1 : 0;
}

interface WeekendWindow {
  readonly endOpenMs: number;
  readonly startOpenMs: number;
}

function weekendWindow(timestampMs: number): WeekendWindow {
  const key = fridayKey(timestampMs);
  let startOpenMs = timestampMs;
  let endOpenMs = timestampMs;
  while (
    expectedPricingMode(startOpenMs - HOUR_MS) === "scheduled_internal_weekend" &&
    fridayKey(startOpenMs - HOUR_MS) === key
  ) {
    startOpenMs -= HOUR_MS;
  }
  while (
    expectedPricingMode(endOpenMs + HOUR_MS) === "scheduled_internal_weekend" &&
    fridayKey(endOpenMs + HOUR_MS) === key
  ) {
    endOpenMs += HOUR_MS;
  }
  return { endOpenMs, startOpenMs };
}

function sessionAssessment(
  sessionKey: string,
  entries: readonly PerpCandle[],
  byOpenTime: ReadonlyMap<number, PerpCandle>,
  window: WeekendWindow,
): WeekendSessionAssessment {
  const last = entries.at(-1) ?? null;
  const previous = byOpenTime.get(window.startOpenMs - HOUR_MS) ?? null;
  const next = byOpenTime.get(window.endOpenMs + HOUR_MS) ?? null;
  const nextLocal = next === null ? null : newYorkTimeParts(next.openTimeMs);
  const reasons: string[] = [];
  if (!byOpenTime.has(window.startOpenMs)) {
    reasons.push("weekend_session_start_missing");
  }
  if (!byOpenTime.has(window.endOpenMs)) {
    reasons.push("weekend_session_end_missing");
  }
  if (
    previous === null ||
    previous.closeTimeMs + 1 !== window.startOpenMs ||
    expectedPricingMode(previous.openTimeMs) === "scheduled_internal_weekend"
  ) {
    reasons.push("preceding_external_candle_missing");
  }
  if (
    next === null ||
    next.openTimeMs !== window.endOpenMs + HOUR_MS ||
    nextLocal?.weekday !== "Sun" ||
    nextLocal.hour !== 20
  ) {
    reasons.push("reopen_candle_missing");
  }
  for (
    let openTimeMs = window.startOpenMs;
    openTimeMs <= window.endOpenMs;
    openTimeMs += HOUR_MS
  ) {
    if (!byOpenTime.has(openTimeMs)) {
      reasons.push("weekend_candle_gap");
      break;
    }
  }
  const externalClose = previous === null ? null : BigInt(previous.closePriceX18);
  const weekendClose = last === null ? null : BigInt(last.closePriceX18);
  // Candle opens are mechanically continuous with the preceding trade and do
  // not measure the external-session repricing. Use the close of the first
  // complete external-pricing hour instead.
  const reopen = next === null ? null : BigInt(next.closePriceX18);
  const highs = entries.map((entry) => BigInt(entry.highPriceX18));
  const lows = entries.map((entry) => BigInt(entry.lowPriceX18));
  const high = highs.length === 0
    ? null
    : highs.reduce((left, right) => left > right ? left : right);
  const low = lows.length === 0
    ? null
    : lows.reduce((left, right) => left < right ? left : right);
  const complete = reasons.length === 0 && externalClose !== null &&
    weekendClose !== null && reopen !== null && high !== null && low !== null;
  const weekendMove = complete ? signedPpm(weekendClose!, externalClose!) : null;
  const reopenMove = complete ? signedPpm(reopen!, externalClose!) : null;
  return {
    baseVolumeX18: entries.reduce(
      (total, entry) => total + BigInt(entry.volumeX18),
      0n,
    ).toString(),
    candleCount: entries.length,
    directionCorrect: !complete || weekendMove === 0n || reopenMove === 0n
      ? null
      : sign(weekendMove!) === sign(reopenMove!),
    externalClosePriceX18: externalClose?.toString() ?? null,
    internalEndMs: window.endOpenMs + HOUR_MS - 1,
    internalStartMs: window.startOpenMs,
    maxDownExcursionPpm: complete
      ? signedPpm(low!, externalClose!).toString()
      : null,
    maxUpExcursionPpm: complete
      ? signedPpm(high!, externalClose!).toString()
      : null,
    reasons,
    reopenGapPpm: complete ? signedPpm(reopen!, weekendClose!).toString() : null,
    reopenPriceX18: reopen?.toString() ?? null,
    reopenTimeMs: next?.closeTimeMs ?? null,
    sessionKey,
    status: complete ? "complete" : "excluded",
    tradeCount: entries.reduce(
      (total, entry) => total + BigInt(entry.tradeCount),
      0n,
    ).toString(),
    weekendClosePriceX18: weekendClose?.toString() ?? null,
    weekendMovePpm: weekendMove?.toString() ?? null,
  };
}

export function assessPerpWeekends(input: {
  readonly coin: string;
  readonly computedAt: string;
  readonly dex: string;
  readonly source: PerpCandleSource;
}): PerpWeekendAssessment {
  if (!Number.isFinite(Date.parse(input.computedAt))) {
    throw new Error("Weekend assessment timestamp is invalid");
  }
  if (input.source.candles.length >= 5_000) {
    throw new Error("Hyperliquid candle response hit the 5000-row API ceiling");
  }
  const groups = new Map<string, {
    entries: PerpCandle[];
    window: WeekendWindow;
  }>();
  const firstHour = Math.ceil(input.source.fromTimeMs / HOUR_MS) * HOUR_MS;
  for (
    let openTimeMs = firstHour;
    openTimeMs + HOUR_MS - 1 <= input.source.toTimeMs;
    openTimeMs += HOUR_MS
  ) {
    if (expectedPricingMode(openTimeMs) !== "scheduled_internal_weekend") continue;
    const key = fridayKey(openTimeMs);
    if (!groups.has(key)) {
      groups.set(key, { entries: [], window: weekendWindow(openTimeMs) });
    }
  }
  for (const candle of input.source.candles) {
    if (expectedPricingMode(candle.openTimeMs) !== "scheduled_internal_weekend") {
      continue;
    }
    const key = fridayKey(candle.openTimeMs);
    const group = groups.get(key) ?? {
      entries: [],
      window: weekendWindow(candle.openTimeMs),
    };
    group.entries.push(candle);
    groups.set(key, group);
  }
  const byOpenTime = new Map(input.source.candles.map((entry) =>
    [entry.openTimeMs, entry] as const
  ));
  const sessions = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => sessionAssessment(
      key,
      group.entries,
      byOpenTime,
      group.window,
    ));
  const complete = sessions.filter((entry) => entry.status === "complete");
  const gaps = complete.map((entry) => absolute(BigInt(entry.reopenGapPpm!)));
  const withDirection = complete.filter((entry) => entry.directionCorrect !== null);
  const correct = withDirection.filter((entry) => entry.directionCorrect).length;
  return {
    assumptions: [
      "scheduled_internal_window_is_friday_20_to_sunday_20_america_new_york",
      "preceding_hour_close_proxies_last_external_price",
      "sunday_20_hour_close_proxies_first_full_external_pricing_hour",
      "hourly_candles_are_trade_derived_and_not_fundamental_oracle_truth",
      "holidays_and_unscheduled_external_feed_gaps_are_not_classified",
      "assessment_is_shadow_only_and_does_not_authorize_execution",
    ],
    candleCount: input.source.candles.length,
    coin: input.coin,
    computedAt: input.computedAt,
    dex: input.dex,
    evidence: input.source.evidence,
    executionEligible: false,
    fromTimeMs: input.source.fromTimeMs,
    interval: input.source.interval,
    methodology: PERP_WEEKEND_METHOD,
    schemaVersion: 1,
    sessions,
    source: PERP_REFERENCE_SOURCE,
    summary: {
      completeSessions: complete.length,
      directionCorrectPpm: withDirection.length === 0
        ? null
        : (BigInt(correct) * 1_000_000n / BigInt(withDirection.length)).toString(),
      excludedSessions: sessions.length - complete.length,
      maxAbsReopenGapPpm: percentile(gaps, 100)?.toString() ?? null,
      medianAbsReopenGapPpm: percentile(gaps, 50)?.toString() ?? null,
      p90AbsReopenGapPpm: percentile(gaps, 90)?.toString() ?? null,
      sessions: sessions.length,
    },
    toTimeMs: input.source.toTimeMs,
  };
}
