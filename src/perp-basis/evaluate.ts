import { USDG } from "../constants.js";
import {
  absolute,
  deviationPpm,
  parseUnsignedDecimalX18,
  signedPpm,
  X18,
} from "../perp-reference/math.js";
import {
  PERP_BASIS_METHOD,
  type PerpBasisAssessment,
  type PerpBasisConfig,
  type PerpBasisReferenceMode,
  type PerpBasisSource,
} from "./domain.js";

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function milliseconds(value: string, field: string): number {
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${field} is invalid`);
  return result;
}

function ageSeconds(nowMs: number, observedMs: number): number | null {
  if (observedMs > nowMs) return null;
  return Math.floor((nowMs - observedMs) / 1_000);
}

function scaleIntegerToX18(value: bigint, decimals: number): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Oracle decimals are outside the uint8 domain");
  }
  return decimals <= 18
    ? value * 10n ** BigInt(18 - decimals)
    : value / 10n ** BigInt(decimals - 18);
}

function median3(first: bigint, second: bigint, third: bigint): bigint {
  return [first, second, third].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  )[1]!;
}

function referenceMode(
  source: PerpBasisSource,
  primaryReferenceAvailable: boolean,
): PerpBasisReferenceMode {
  if (primaryReferenceAvailable) return "chainlink_primary_comparison";
  return source.perp.expectedPricingMode === "scheduled_internal_weekend"
    ? "perp_internal_weekend_candidate"
    : "perp_external_session_candidate";
}

export function evaluatePerpBasis(input: {
  readonly config: PerpBasisConfig;
  readonly evaluatedAt: string;
  readonly source: PerpBasisSource;
}): PerpBasisAssessment {
  const evaluatedMs = milliseconds(input.evaluatedAt, "Perp basis evaluation time");
  const blockMs = milliseconds(input.source.chain.blockTimestamp, "Block timestamp");
  const perpMs = milliseconds(input.source.perp.observedAt, "Perp observation time");
  const checkpointAge = ageSeconds(evaluatedMs, blockMs);
  const perpAge = ageSeconds(evaluatedMs, perpMs);
  const sourceSkew = Math.floor(Math.abs(blockMs - perpMs) / 1_000);
  const reasons: string[] = [];

  const canonicalProof = input.source.chain.canonical &&
    input.source.chain.canonicalBlockNumber === input.source.chain.blockNumber &&
    input.source.chain.canonicalExpectedHash !== null &&
    input.source.chain.canonicalObservedHash !== null &&
    same(input.source.chain.blockHash, input.source.chain.canonicalExpectedHash) &&
    same(input.source.chain.blockHash, input.source.chain.canonicalObservedHash);
  if (!canonicalProof) reasons.push("checkpoint_canonicality_unproven");
  if (checkpointAge === null) reasons.push("checkpoint_timestamp_future");
  else if (checkpointAge > input.config.maxSourceAgeSeconds) {
    reasons.push("checkpoint_stale");
  }
  if (perpAge === null) reasons.push("perp_timestamp_future");
  else if (perpAge > input.config.maxSourceAgeSeconds) reasons.push("perp_stale");
  if (sourceSkew > input.config.maxSourceSkewSeconds) {
    reasons.push("source_skew_high");
  }
  if (!input.source.perp.qualityPass) {
    reasons.push("perp_quality_rejected");
    reasons.push(...input.source.perp.reasons.map((reason) => `perp:${reason}`));
  }
  const perpUnderlying = input.source.perp.coin.split(":").at(-1)?.toUpperCase();
  if (perpUnderlying !== input.source.chain.rwaSymbol.toUpperCase()) {
    reasons.push("perp_rwa_symbol_mismatch");
  }

  const quoteInPool = same(input.source.chain.token0, USDG) !==
    same(input.source.chain.token1, USDG);
  const poolRwa = same(input.source.chain.token0, USDG)
    ? input.source.chain.token1
    : input.source.chain.token0;
  if (!quoteInPool || !same(poolRwa, input.source.chain.rwaAddress)) {
    reasons.push("pool_token_identity_mismatch");
  }
  if (!same(input.source.asset.registryAddress, input.source.chain.rwaAddress) ||
      !same(input.source.asset.tokenAddress, input.source.chain.rwaAddress)) {
    reasons.push("asset_token_identity_mismatch");
  }
  if (BigInt(input.source.chain.liquidity) <= 0n) reasons.push("pool_liquidity_zero");
  if (!input.source.chain.poolUnlocked) reasons.push("pool_locked");
  if (!input.source.asset.registryActive) reasons.push("registry_asset_inactive");
  if (!input.source.asset.tradingCapabilitiesComplete) {
    reasons.push("trading_capabilities_incomplete");
  } else if (!input.source.asset.tradingCapabilitiesTradable) {
    reasons.push("trading_not_tradable");
  }
  if (!input.source.asset.multiplierConsistent) {
    reasons.push("registry_multiplier_mismatch");
  }
  if (input.source.asset.corporateActionPending ||
      input.source.asset.pendingMultiplier !== null) {
    reasons.push("corporate_action_pending");
  }

  let multiplier: bigint | null = null;
  const token = input.source.asset.token;
  if (token === null) {
    reasons.push("token_state_missing");
  } else {
    multiplier = BigInt(token.uiMultiplierX18);
    let registryMultiplier: bigint | null = null;
    try {
      registryMultiplier = parseUnsignedDecimalX18(
        input.source.asset.currentMultiplier,
        "Registry multiplier",
      );
    } catch {
      reasons.push("registry_multiplier_invalid");
    }
    if (multiplier <= 0n) reasons.push("ui_multiplier_nonpositive");
    if (registryMultiplier !== null && registryMultiplier !== multiplier) {
      reasons.push("registry_multiplier_mismatch");
    }
    if (BigInt(token.newUiMultiplierX18) !== multiplier) {
      reasons.push("token_multiplier_transition");
    }
    if (token.oraclePaused) reasons.push("oracle_paused");
  }

  const perpOracle = BigInt(input.source.perp.oraclePriceX18);
  const perpMark = parseUnsignedDecimalX18(
    input.source.perp.markPrice,
    "Perp mark price",
  );
  const perpMid = input.source.perp.midPrice === null
    ? null
    : parseUnsignedDecimalX18(input.source.perp.midPrice, "Perp mid price");
  if (perpOracle <= 0n || perpMark <= 0n || perpMid === null || perpMid <= 0n) {
    reasons.push("perp_reference_prices_incomplete");
  }
  const perpReference = perpMid === null
    ? perpOracle
    : median3(perpOracle, perpMark, perpMid);

  let quoteAge: number | null = null;
  let usdgUsd: bigint | null = null;
  const quote = input.source.quoteOracle;
  if (quote === null) {
    reasons.push("quote_oracle_missing");
  } else {
    const quoteUpdatedMs = Number(BigInt(quote.updatedAt) * 1_000n);
    quoteAge = ageSeconds(evaluatedMs, quoteUpdatedMs);
    if (quote.baseAsset.toUpperCase() !== "USDG" ||
        quote.quoteAsset.toUpperCase() !== "USD") {
      reasons.push("quote_oracle_identity_mismatch");
    }
    const quoteAnswer = BigInt(quote.answer);
    if (quoteAnswer <= 0n) reasons.push("quote_oracle_answer_nonpositive");
    if (!quote.decimalsMatch) reasons.push("quote_oracle_decimals_mismatch");
    if (!quote.descriptionMatches) reasons.push("quote_oracle_description_mismatch");
    if (!quote.roundComplete || BigInt(quote.answeredInRound) < BigInt(quote.roundId)) {
      reasons.push("quote_oracle_round_incomplete");
    }
    if (!quote.timestampNotFuture || quoteAge === null) {
      reasons.push("quote_oracle_timestamp_future");
    } else {
      const maxQuoteAge = Math.min(
        quote.heartbeatSeconds,
        input.config.maxQuoteOracleAgeSeconds,
      );
      if (quoteAge > maxQuoteAge) reasons.push("quote_oracle_stale");
    }
    if (quoteAnswer > 0n) {
      usdgUsd = scaleIntegerToX18(quoteAnswer, quote.decimals);
      if (usdgUsd <= 0n) reasons.push("quote_oracle_scaled_nonpositive");
      if (deviationPpm(usdgUsd, X18) > input.config.maxQuoteDepegPpm) {
        reasons.push("quote_oracle_depeg_high");
      }
    }
  }

  const computedTokenUsd = multiplier === null || multiplier <= 0n
    ? null
    : perpReference * multiplier / X18;
  const tokenUsd = computedTokenUsd === null || computedTokenUsd <= 0n
    ? null
    : computedTokenUsd;
  const tokenUsdg = tokenUsd === null || usdgUsd === null || usdgUsd <= 0n
    ? null
    : tokenUsd * X18 / usdgUsd;
  const poolPrice = BigInt(input.source.chain.poolPriceX18);
  const poolPerpDeviation = tokenUsdg === null || tokenUsdg <= 0n
    ? null
    : signedPpm(poolPrice, tokenUsdg);
  if (poolPerpDeviation === null) {
    reasons.push("normalized_perp_reference_unavailable");
  } else if (absolute(poolPerpDeviation) > input.config.maxPoolDeviationPpm) {
    reasons.push("pool_perp_deviation_high");
  }
  const chainlinkPrice = input.source.chain.chainlinkOraclePriceX18 === null
    ? null
    : BigInt(input.source.chain.chainlinkOraclePriceX18);
  const chainlinkPerpDeviation = tokenUsdg === null || tokenUsdg <= 0n ||
      chainlinkPrice === null || chainlinkPrice <= 0n
    ? null
    : signedPpm(chainlinkPrice, tokenUsdg);

  const uniqueReasons = [...new Set(reasons)];
  const qualityPass = uniqueReasons.length === 0;
  const primaryReferenceAvailable = input.source.chain.poolStatus === "valid" &&
    canonicalProof && checkpointAge !== null &&
    checkpointAge <= input.config.maxSourceAgeSeconds;
  const primaryReferenceReasons = [...input.source.chain.poolReasons];
  if (!canonicalProof) primaryReferenceReasons.push("checkpoint_canonicality_unproven");
  if (checkpointAge === null) primaryReferenceReasons.push("checkpoint_timestamp_future");
  else if (checkpointAge > input.config.maxSourceAgeSeconds) {
    primaryReferenceReasons.push("checkpoint_stale");
  }
  const mode = referenceMode(input.source, primaryReferenceAvailable);
  return {
    evaluatedAt: input.evaluatedAt,
    executionEligible: false,
    fallbackCandidate: !primaryReferenceAvailable && qualityPass,
    limitations: [
      "perp_reference_is_not_an_independent_cash_equity_oracle",
      "scheduled_weekend_reference_is_endogenous_to_the_perp_orderbook",
      "usdg_conversion_accepts_only_the_published_heartbeat_and_depeg_bound",
      "sequencer_uptime_feed_is_unavailable",
      "shadow_candidate_does_not_authorize_execution",
    ],
    methodology: PERP_BASIS_METHOD,
    metrics: {
      chainlinkPerpDeviationPpm: chainlinkPerpDeviation?.toString() ?? null,
      chainlinkPriceX18: chainlinkPrice?.toString() ?? null,
      checkpointAgeSeconds: checkpointAge,
      multiplierX18: multiplier?.toString() ?? null,
      perpMarkUsdX18: perpMark.toString(),
      perpMidUsdX18: perpMid?.toString() ?? null,
      perpOracleUsdX18: perpOracle.toString(),
      perpReferenceUsdX18: perpReference.toString(),
      perpSnapshotAgeSeconds: perpAge,
      poolPerpDeviationPpm: poolPerpDeviation?.toString() ?? null,
      poolPriceX18: poolPrice.toString(),
      quoteOracleAgeSeconds: quoteAge,
      sourceSkewSeconds: sourceSkew,
      tokenReferenceUsdX18: tokenUsd?.toString() ?? null,
      tokenReferenceUsdgX18: tokenUsdg?.toString() ?? null,
      usdgUsdX18: usdgUsd?.toString() ?? null,
    },
    primaryReferenceAvailable,
    primaryReferenceReasons: primaryReferenceAvailable
      ? []
      : [...new Set(primaryReferenceReasons)],
    qualityPass,
    reasons: uniqueReasons,
    referenceMode: mode,
    schemaVersion: 1,
    source: input.source,
    status: qualityPass ? "observed" : "quality_rejected",
    thresholds: {
      maxPoolDeviationPpm: input.config.maxPoolDeviationPpm.toString(),
      maxQuoteDepegPpm: input.config.maxQuoteDepegPpm.toString(),
      maxQuoteOracleAgeSeconds: input.config.maxQuoteOracleAgeSeconds,
      maxSourceAgeSeconds: input.config.maxSourceAgeSeconds,
      maxSourceSkewSeconds: input.config.maxSourceSkewSeconds,
    },
  };
}
