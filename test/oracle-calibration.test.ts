import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountingRunReference } from "../src/backtest/domain.js";
import { Q96 } from "../src/backtest/principal.js";
import { USDG } from "../src/constants.js";
import { evaluateOracleCalibrationMark } from "../src/oracle/evaluate.js";
import {
  oracleQuotePerRwaX18,
  poolQuotePerRwaX18,
  signedDeviationPpm,
} from "../src/oracle/math.js";
import type {
  OracleFeedMetadata,
  OracleRoundState,
  TokenRiskState,
} from "../src/risk/domain.js";
import type { CanonicalRangeReplayCheckpoint } from "../src/simulator/domain.js";

const rwa = "0x1111111111111111111111111111111111111111";
const timestamp = 1_700_000_000;

function feed(symbol: string): OracleFeedMetadata {
  return {
    address: (symbol === "USDG"
      ? "0x2222222222222222222222222222222222222222"
      : "0x3333333333333333333333333333333333333333"),
    baseAsset: symbol,
    decimals: 8,
    heartbeatSeconds: 60,
    marketHours: null,
    name: `${symbol} / USD`,
    productTypeCode: symbol === "USDG" ? "RefPrice" : "primaryTokenizedPrice",
    quoteAsset: "USD",
  };
}

function oracle(symbol: string, age = 10): OracleRoundState {
  return {
    answer: "100000000",
    answeredInRound: "10",
    codeHash: `0x${"11".repeat(32)}`,
    decimals: 8,
    description: `${symbol} / USD`,
    roundId: "10",
    startedAt: String(timestamp - age),
    updatedAt: String(timestamp - age),
  };
}

function run(): AccountingRunReference {
  return {
    blockHash: `0x${"22".repeat(32)}`,
    blockNumber: 100n,
    blockTimestamp: new Date(timestamp * 1_000).toISOString(),
    chainId: 4663,
    observedAt: new Date((timestamp + 1) * 1_000).toISOString(),
    runId: "1",
  };
}

function checkpoint(): CanonicalRangeReplayCheckpoint {
  return {
    pool: {
      feeGrowthGlobal0X128: 0n,
      feeGrowthGlobal1X128: 0n,
      liquidity: 1n,
      sqrtPriceX96: Q96,
      tick: 0,
    },
    run: run(),
  };
}

function token(): TokenRiskState {
  return {
    codeHash: `0x${"33".repeat(32)}`,
    effectiveAt: "0",
    newUIMultiplier: "1000000000000000000",
    oraclePaused: false,
    uiMultiplier: "1000000000000000000",
  };
}

describe("oracle calibration", () => {
  it("computes normalized pool, oracle, and signed deviation prices exactly", () => {
    assert.equal(poolQuotePerRwaX18({
      quoteDecimals: 6,
      quoteToken: USDG,
      rwaDecimals: 6,
      sqrtPriceX96: Q96,
      token0: USDG,
      token1: rwa,
    }), 1_000_000_000_000_000_000n);
    assert.equal(oracleQuotePerRwaX18({
      quoteAnswer: 100_000_000n,
      quoteFeedDecimals: 8,
      rwaAnswer: 20_000_000_000n,
      rwaFeedDecimals: 8,
    }), 200_000_000_000_000_000_000n);
    assert.equal(signedDeviationPpm(100n, 105n), 50_000n);
    assert.equal(signedDeviationPpm(100n, 95n), -50_000n);
  });

  it("accepts fresh multiplier-adjusted historical marks", () => {
    const mark = evaluateOracleCalibrationMark({
      checkpoint: checkpoint(),
      maxPriceAgeSeconds: 300,
      quoteDecimals: 6,
      quoteFeed: feed("USDG"),
      quoteOracle: oracle("USDG"),
      quoteToken: USDG,
      rwaDecimals: 6,
      rwaFeed: feed("NVDA"),
      rwaOracle: oracle("NVDA"),
      token: token(),
      tokenDecimals: 6,
      token0: USDG,
      token1: rwa,
    });
    assert.equal(mark.status, "valid");
    assert.deepEqual(mark.reasons, []);
    assert.equal(mark.poolPriceX18, "1000000000000000000");
    assert.equal(mark.oraclePriceX18, "1000000000000000000");
    assert.equal(mark.deviationPpm, "0");
    assert.equal(mark.rwaOracleAgeSeconds, 10);
  });

  it("retains but excludes stale, paused, or transitioning marks", () => {
    const unsafeToken = {
      ...token(),
      newUIMultiplier: "2000000000000000000",
      oraclePaused: true,
    };
    const mark = evaluateOracleCalibrationMark({
      checkpoint: checkpoint(),
      maxPriceAgeSeconds: 300,
      quoteDecimals: 6,
      quoteFeed: feed("USDG"),
      quoteOracle: oracle("USDG"),
      quoteToken: USDG,
      rwaDecimals: 6,
      rwaFeed: feed("NVDA"),
      rwaOracle: oracle("NVDA", 61),
      token: unsafeToken,
      tokenDecimals: 6,
      token0: USDG,
      token1: rwa,
    });
    assert.equal(mark.status, "excluded");
    assert(mark.reasons.includes("rwa_oracle_price_stale"));
    assert(mark.reasons.includes("oracle_paused"));
    assert(mark.reasons.includes("token_multiplier_transition"));
    assert.equal(mark.oraclePriceX18, "1000000000000000000");
  });
});
