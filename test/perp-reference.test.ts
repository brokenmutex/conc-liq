import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  PerpCandle,
  PerpCandleSource,
  PerpMarketContextSource,
  PerpReferenceEvidence,
} from "../src/perp-reference/domain.js";
import {
  evaluatePerpReference,
  expectedPricingMode,
} from "../src/perp-reference/evaluate.js";
import { parseUnsignedDecimalX18 } from "../src/perp-reference/math.js";
import { parseCandles, parseMarketContext } from "../src/perp-reference/source.js";
import { assessPerpWeekends } from "../src/perp-reference/weekend.js";

const evidence: PerpReferenceEvidence = {
  fetchedAt: "2026-09-05T13:00:00.000Z",
  request: { dex: "xyz", type: "metaAndAssetCtxs" },
  sha256: `sha256:${"ab".repeat(32)}`,
  url: "https://api.hyperliquid.xyz/info",
};

function source(): PerpMarketContextSource {
  return {
    asset: {
      isDelisted: false,
      marginMode: null,
      maxLeverage: 20,
      name: "xyz:NVDA",
      onlyIsolated: false,
      szDecimals: 3,
    },
    assetIndex: 2,
    context: {
      dayBaseVolume: "135957.286",
      dayNotionalVolume: "31478182.02",
      funding: "0.00000625",
      impactPrices: ["230.737", "230.759"],
      markPrice: "230.73",
      midPrice: "230.745",
      openInterest: "533730.854",
      oraclePrice: "230.65",
      premium: "0.0004248862",
      previousDayPrice: "230.39",
    },
    evidence,
  };
}

const quality = {
  maxImpactSpreadPpm: 10_000n,
  maxMarkOracleDeviationPpm: 5_000n,
  maxMidOracleDeviationPpm: 10_000n,
  minDayNotionalUsdX18: parseUnsignedDecimalX18("1000000", "minimum volume"),
  minOpenInterestNotionalUsdX18:
    parseUnsignedDecimalX18("5000000", "minimum open interest"),
};

function candle(input: {
  readonly close?: string;
  readonly high?: string;
  readonly low?: string;
  readonly open?: string;
  readonly openTimeMs: number;
  readonly trades?: number;
  readonly volume?: string;
}): PerpCandle {
  const open = input.open ?? "100";
  const close = input.close ?? open;
  const high = input.high ?? (BigInt(close) > BigInt(open) ? close : open);
  const low = input.low ?? (BigInt(close) < BigInt(open) ? close : open);
  const normalized = (value: string) => parseUnsignedDecimalX18(value, "price").toString();
  return {
    closePriceX18: normalized(close),
    closeTimeMs: input.openTimeMs + 3_600_000 - 1,
    highPriceX18: normalized(high),
    interval: "1h",
    lowPriceX18: normalized(low),
    openPriceX18: normalized(open),
    openTimeMs: input.openTimeMs,
    raw: {
      close,
      closeTimeMs: input.openTimeMs + 3_600_000 - 1,
      high,
      interval: "1h",
      low,
      open,
      openTimeMs: input.openTimeMs,
      symbol: "xyz:NVDA",
      tradeCount: input.trades ?? 10,
      volume: input.volume ?? "1",
    },
    tradeCount: String(input.trades ?? 10),
    volumeX18: normalized(input.volume ?? "1"),
  };
}

describe("Hyperliquid HIP-3 shadow reference", () => {
  it("classifies the scheduled New York weekend without treating it as authorization", () => {
    assert.equal(
      expectedPricingMode(Date.parse("2026-09-05T12:00:00.000Z")),
      "scheduled_internal_weekend",
    );
    assert.equal(
      expectedPricingMode(Date.parse("2026-09-07T00:00:00.000Z")),
      "external_session_expected",
    );
    const snapshot = evaluatePerpReference({
      coin: "xyz:NVDA",
      dex: "xyz",
      observedAt: "2026-09-05T13:00:00.000Z",
      quality,
      source: source(),
    });
    assert.equal(snapshot.status, "observed");
    assert.equal(snapshot.qualityPass, true);
    assert.equal(snapshot.executionEligible, false);
    assert.equal(snapshot.expectedPricingMode, "scheduled_internal_weekend");
    assert.equal(snapshot.metrics.impactSpreadPpm, "95");
    assert(BigInt(snapshot.metrics.openInterestNotionalUsdX18) >
      parseUnsignedDecimalX18("123000000", "comparison"));
  });

  it("rejects thin or structurally incomplete market context", () => {
    const base = source();
    const snapshot = evaluatePerpReference({
      coin: "xyz:NVDA",
      dex: "xyz",
      observedAt: "2026-09-05T13:00:00.000Z",
      quality,
      source: {
        ...base,
        context: {
          ...base.context,
          dayNotionalVolume: "1",
          impactPrices: null,
          midPrice: null,
          openInterest: "1",
        },
      },
    });
    assert.equal(snapshot.status, "quality_rejected");
    assert(snapshot.reasons.includes("perp_impact_prices_invalid"));
    assert(snapshot.reasons.includes("perp_day_volume_low"));
    assert(snapshot.reasons.includes("perp_open_interest_low"));
    assert.equal(snapshot.executionEligible, false);
  });

  it("selects the exact configured market from the paired API arrays", () => {
    const parsed = parseMarketContext([
      { universe: [
        { name: "xyz:TSLA", szDecimals: 3, maxLeverage: 20 },
        { name: "xyz:NVDA", szDecimals: 3, maxLeverage: 20 },
      ] },
      [
        {
          dayBaseVlm: "1", dayNtlVlm: "1", funding: "0",
          impactPxs: ["1", "1"], markPx: "1", midPx: "1",
          openInterest: "1", oraclePx: "1", premium: "0", prevDayPx: "1",
        },
        {
          dayBaseVlm: "2", dayNtlVlm: "2", funding: "0",
          impactPxs: ["230", "231"], markPx: "230", midPx: "230",
          openInterest: "2", oraclePx: "230", premium: "0", prevDayPx: "229",
        },
      ],
    ], "xyz:NVDA", evidence);
    assert.equal(parsed.assetIndex, 1);
    assert.equal(parsed.context.oraclePrice, "230");
  });
});

describe("perp weekend assessment", () => {
  it("measures a complete Friday-close to Sunday-reopen session", () => {
    const hour = 3_600_000;
    const internalStart = Date.parse("2026-09-05T00:00:00.000Z");
    const candles: PerpCandle[] = [candle({
      close: "100",
      openTimeMs: internalStart - hour,
    })];
    for (let index = 0; index < 48; index += 1) {
      candles.push(candle({
        close: index === 47 ? "102" : "101",
        high: index === 47 ? "102" : "101",
        low: "100",
        open: index === 0 ? "100" : "101",
        openTimeMs: internalStart + index * hour,
      }));
    }
    candles.push(candle({
      close: "101",
      high: "102",
      low: "101",
      open: "102",
      openTimeMs: internalStart + 48 * hour,
    }));
    const candleSource: PerpCandleSource = {
      candles,
      evidence,
      fromTimeMs: candles[0]!.openTimeMs,
      interval: "1h",
      toTimeMs: candles.at(-1)!.closeTimeMs,
    };
    const assessment = assessPerpWeekends({
      coin: "xyz:NVDA",
      computedAt: "2026-09-07T02:00:00.000Z",
      dex: "xyz",
      source: candleSource,
    });
    assert.deepEqual(assessment.summary, {
      completeSessions: 1,
      directionCorrectPpm: "1000000",
      excludedSessions: 0,
      maxAbsReopenGapPpm: "9803",
      medianAbsReopenGapPpm: "9803",
      p90AbsReopenGapPpm: "9803",
      sessions: 1,
    });
    assert.equal(assessment.sessions[0]?.weekendMovePpm, "20000");
    assert.equal(assessment.executionEligible, false);
  });

  it("excludes an in-progress weekend instead of treating it as evidence", () => {
    const raw = [{
      T: Date.parse("2026-09-05T00:59:59.999Z"),
      c: "100",
      h: "100",
      i: "1h",
      l: "100",
      n: 1,
      o: "100",
      s: "xyz:NVDA",
      t: Date.parse("2026-09-05T00:00:00.000Z"),
      v: "1",
    }];
    const source = parseCandles({
      coin: "xyz:NVDA",
      evidence,
      fromTimeMs: raw[0]!.t,
      toTimeMs: raw[0]!.T,
      value: raw,
    });
    const assessment = assessPerpWeekends({
      coin: "xyz:NVDA",
      computedAt: "2026-09-05T01:01:00.000Z",
      dex: "xyz",
      source,
    });
    assert.equal(assessment.summary.completeSessions, 0);
    assert.equal(assessment.summary.excludedSessions, 1);
    assert(assessment.sessions[0]?.reasons.includes("weekend_session_end_missing"));
  });

  it("records a wholly missing scheduled weekend as excluded", () => {
    const previous = candle({
      close: "100",
      openTimeMs: Date.parse("2026-09-04T23:00:00.000Z"),
    });
    const reopen = candle({
      close: "101",
      openTimeMs: Date.parse("2026-09-07T00:00:00.000Z"),
    });
    const source: PerpCandleSource = {
      candles: [previous, reopen],
      evidence,
      fromTimeMs: previous.openTimeMs,
      interval: "1h",
      toTimeMs: reopen.closeTimeMs,
    };
    const assessment = assessPerpWeekends({
      coin: "xyz:NVDA",
      computedAt: "2026-09-07T02:00:00.000Z",
      dex: "xyz",
      source,
    });
    assert.equal(assessment.summary.completeSessions, 0);
    assert.equal(assessment.summary.excludedSessions, 1);
    assert.equal(assessment.sessions[0]?.candleCount, 0);
    assert.equal(assessment.sessions[0]?.weekendClosePriceX18, null);
    assert(assessment.sessions[0]?.reasons.includes("weekend_candle_gap"));
  });
});
