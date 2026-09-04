import type { CanonicalRangeReplayCheckpoint } from "../simulator/domain.js";
import type {
  OracleFeedMetadata,
  OracleRoundState,
  TokenRiskState,
} from "../risk/domain.js";
import { evaluateOracleRisk } from "../risk/evaluate.js";
import type { OracleCalibrationMark } from "./domain.js";
import {
  oracleQuotePerRwaX18,
  poolQuotePerRwaX18,
  signedDeviationPpm,
} from "./math.js";

function unixTimestamp(value: string): bigint {
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(`Invalid checkpoint timestamp ${value}`);
  }
  return BigInt(milliseconds / 1_000);
}

export function evaluateOracleCalibrationMark(input: {
  readonly checkpoint: CanonicalRangeReplayCheckpoint;
  readonly maxPriceAgeSeconds: number;
  readonly quoteDecimals: number;
  readonly quoteFeed: OracleFeedMetadata;
  readonly quoteOracle: OracleRoundState | null;
  readonly quoteOracleReadError?: string;
  readonly quoteToken: string;
  readonly rwaDecimals: number;
  readonly rwaFeed: OracleFeedMetadata;
  readonly rwaOracle: OracleRoundState | null;
  readonly rwaOracleReadError?: string;
  readonly token: TokenRiskState | null;
  readonly tokenDecimals: number | null;
  readonly tokenDecimalsReadError?: string;
  readonly token0: string;
  readonly token1: string;
  readonly tokenReadError?: string;
}): OracleCalibrationMark {
  const blockTimestamp = unixTimestamp(input.checkpoint.run.blockTimestamp);
  const rwaRisk = evaluateOracleRisk({
    blockTimestamp,
    feed: input.rwaFeed,
    maxPriceAgeSeconds: input.maxPriceAgeSeconds,
    readError: input.rwaOracleReadError,
    state: input.rwaOracle,
  });
  const quoteRisk = evaluateOracleRisk({
    blockTimestamp,
    feed: input.quoteFeed,
    maxPriceAgeSeconds: input.maxPriceAgeSeconds,
    readError: input.quoteOracleReadError,
    state: input.quoteOracle,
  });
  const reasons = [
    ...rwaRisk.reasons.map((reason) => `rwa_${reason}`),
    ...quoteRisk.reasons.map((reason) => `quote_${reason}`),
  ];
  if (input.token === null) {
    reasons.push("token_risk_read_failed");
  } else {
    if (BigInt(input.token.uiMultiplier) <= 0n) {
      reasons.push("ui_multiplier_nonpositive");
    }
    if (input.token.oraclePaused) reasons.push("oracle_paused");
    if (BigInt(input.token.newUIMultiplier) !== BigInt(input.token.uiMultiplier)) {
      reasons.push("token_multiplier_transition");
    }
  }
  if (input.tokenDecimals === null) {
    reasons.push("token_decimals_read_failed");
  } else if (input.tokenDecimals !== input.rwaDecimals) {
    reasons.push("registry_token_decimals_mismatch");
  }
  const poolPrice = poolQuotePerRwaX18({
    quoteDecimals: input.quoteDecimals,
    quoteToken: input.quoteToken,
    rwaDecimals: input.tokenDecimals ?? input.rwaDecimals,
    sqrtPriceX96: input.checkpoint.pool.sqrtPriceX96,
    token0: input.token0,
    token1: input.token1,
  });
  let oraclePrice: bigint | null = null;
  if (
    input.rwaOracle !== null && input.quoteOracle !== null &&
    BigInt(input.rwaOracle.answer) > 0n &&
    BigInt(input.quoteOracle.answer) > 0n
  ) {
    oraclePrice = oracleQuotePerRwaX18({
      quoteAnswer: BigInt(input.quoteOracle.answer),
      quoteFeedDecimals: input.quoteOracle.decimals,
      rwaAnswer: BigInt(input.rwaOracle.answer),
      rwaFeedDecimals: input.rwaOracle.decimals,
    });
  }
  const deviation = oraclePrice === null
    ? null
    : signedDeviationPpm(oraclePrice, poolPrice);
  const uniqueReasons = [...new Set(reasons)];
  return {
    accountingRunId: input.checkpoint.run.runId,
    blockNumber: input.checkpoint.run.blockNumber.toString(),
    blockTimestamp: input.checkpoint.run.blockTimestamp,
    deviationPpm: deviation?.toString() ?? null,
    oraclePriceX18: oraclePrice?.toString() ?? null,
    poolPriceX18: poolPrice.toString(),
    quoteOracle: input.quoteOracle,
    quoteOracleAgeSeconds: quoteRisk.priceAgeSeconds,
    quoteOracleReadError: input.quoteOracle === null
      ? input.quoteOracleReadError ?? "Oracle read failed"
      : null,
    reasons: uniqueReasons,
    rwaOracle: input.rwaOracle,
    rwaOracleAgeSeconds: rwaRisk.priceAgeSeconds,
    rwaOracleReadError: input.rwaOracle === null
      ? input.rwaOracleReadError ?? "Oracle read failed"
      : null,
    status: uniqueReasons.length === 0 ? "valid" : "excluded",
    token: input.token,
    tokenDecimals: input.tokenDecimals,
    tokenDecimalsReadError: input.tokenDecimals === null
      ? input.tokenDecimalsReadError ?? "Token decimals read failed"
      : null,
    tokenReadError: input.token === null
      ? input.tokenReadError ?? "Token risk read failed"
      : null,
  };
}
