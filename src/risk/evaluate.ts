import { parseUnits } from "viem";
import type { CanonicalAsset, TradingCapabilities } from "../domain.js";
import type {
  AssetRiskSnapshot,
  OracleFeedMetadata,
  OracleRiskSnapshot,
  OracleRoundState,
  TokenRiskState,
} from "./domain.js";

const REQUIRED_TRADING_SESSIONS = ["market", "extended", "overnight"] as const;
const TRADABLE = "TRADING_STATUS_TRADABLE";

export function sanitizeRiskError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .replace(/https?:\/\/\S+/gu, "[redacted-url]")
    .replace(/\s+/gu, " ")
    .slice(0, 2_000);
}

function tradingCapabilityFlags(capabilities: TradingCapabilities | null): {
  readonly complete: boolean;
  readonly tradable: boolean;
} {
  const sessions = REQUIRED_TRADING_SESSIONS.map((session) => capabilities?.[session]);
  const complete = sessions.every((session) => session !== undefined);
  const tradable = complete && sessions.every(
    (session) => session?.fractional === TRADABLE && session.whole === TRADABLE,
  );
  return { complete, tradable };
}

function parseRegistryMultiplier(value: string): bigint | null {
  try {
    return parseUnits(value, 18);
  } catch {
    return null;
  }
}

function oracleDescriptionMatches(
  description: string,
  feed: OracleFeedMetadata,
): boolean {
  const normalize = (value: string): string => value.replace(/\s+/gu, "").toUpperCase();
  const actual = normalize(description);
  const quote = feed.quoteAsset.toUpperCase();
  const base = feed.baseAsset.toUpperCase();
  return actual === normalize(feed.name) ||
    actual === `${base}/${quote}` ||
    actual === `RH${base}/${quote}` ||
    actual === `ROBINHOOD${base}/${quote}`;
}

export function evaluateOracleRisk(input: {
  readonly blockTimestamp: bigint;
  readonly feed: OracleFeedMetadata;
  readonly maxPriceAgeSeconds: number;
  readonly readError?: string;
  readonly state: OracleRoundState | null;
}): OracleRiskSnapshot {
  const maxAgeSeconds = Math.min(
    input.feed.heartbeatSeconds,
    input.maxPriceAgeSeconds,
  );
  if (input.state === null) {
    return {
      executionEligible: false,
      feed: input.feed,
      flags: null,
      maxAgeSeconds,
      priceAgeSeconds: null,
      readError: input.readError ?? "Oracle read failed",
      reasons: ["oracle_read_failed"],
      state: null,
    };
  }

  const answer = BigInt(input.state.answer);
  const roundId = BigInt(input.state.roundId);
  const answeredInRound = BigInt(input.state.answeredInRound);
  const updatedAt = BigInt(input.state.updatedAt);
  const timestampNotFuture = updatedAt <= input.blockTimestamp;
  const age = input.blockTimestamp - updatedAt;
  const priceAgeSeconds = timestampNotFuture ? Number(age) : null;
  const flags = {
    answerPositive: answer > 0n,
    decimalsMatch: input.state.decimals === input.feed.decimals,
    descriptionMatches: oracleDescriptionMatches(input.state.description, input.feed),
    priceFresh:
      updatedAt > 0n &&
      timestampNotFuture &&
      age <= BigInt(maxAgeSeconds),
    roundComplete: updatedAt > 0n && answeredInRound >= roundId,
    timestampNotFuture,
  };
  const reasons: string[] = [];
  if (!flags.answerPositive) reasons.push("oracle_answer_nonpositive");
  if (!flags.decimalsMatch) reasons.push("oracle_decimals_mismatch");
  if (!flags.descriptionMatches) reasons.push("oracle_description_mismatch");
  if (!flags.roundComplete) reasons.push("oracle_round_incomplete");
  if (!flags.timestampNotFuture) reasons.push("oracle_timestamp_future");
  if (!flags.priceFresh) reasons.push("oracle_price_stale");

  return {
    executionEligible: reasons.length === 0,
    feed: input.feed,
    flags,
    maxAgeSeconds,
    priceAgeSeconds,
    readError: null,
    reasons,
    state: input.state,
  };
}

export function evaluateAssetRisk(input: {
  readonly blockTimestamp: bigint;
  readonly globalReasons: readonly string[];
  readonly onchain: TokenRiskState | null;
  readonly onchainReadError?: string;
  readonly oracle: OracleRiskSnapshot | null;
  readonly quoteOracle: OracleRiskSnapshot | null;
  readonly registry: CanonicalAsset;
}): AssetRiskSnapshot {
  const trading = tradingCapabilityFlags(input.registry.tradingCapabilities);
  const registryMultiplier = parseRegistryMultiplier(input.registry.currentMultiplier);
  const onchainMultiplier = input.onchain === null
    ? null
    : BigInt(input.onchain.uiMultiplier);
  const multiplierConsistent =
    registryMultiplier !== null &&
    onchainMultiplier !== null &&
    registryMultiplier === onchainMultiplier;
  const scheduledOnchain = input.onchain !== null &&
    BigInt(input.onchain.newUIMultiplier) !== BigInt(input.onchain.uiMultiplier) &&
    BigInt(input.onchain.effectiveAt) > input.blockTimestamp;
  const corporateActionPending =
    input.registry.pendingMultiplier !== null || scheduledOnchain;
  const flags = {
    corporateActionPending,
    multiplierConsistent,
    registryActive: input.registry.status === "ASSET_STATUS_ACTIVE",
    tradingCapabilitiesComplete: trading.complete,
    tradingCapabilitiesTradable: trading.tradable,
  };
  const reasons = [...input.globalReasons];
  if (!flags.registryActive) reasons.push("registry_asset_inactive");
  if (!flags.tradingCapabilitiesComplete) {
    reasons.push("trading_capabilities_incomplete");
  } else if (!flags.tradingCapabilitiesTradable) {
    reasons.push("trading_not_tradable");
  }
  if (input.onchain === null) reasons.push("token_risk_read_failed");
  if (!flags.multiplierConsistent) reasons.push("registry_multiplier_mismatch");
  if (flags.corporateActionPending) reasons.push("corporate_action_pending");
  if (input.onchain?.oraclePaused === true) reasons.push("oracle_paused");
  if (input.oracle === null) {
    reasons.push("oracle_feed_missing");
  } else {
    reasons.push(...input.oracle.reasons);
  }
  if (input.quoteOracle === null) {
    reasons.push("quote_oracle_feed_missing");
  } else if (!input.quoteOracle.executionEligible) {
    reasons.push("quote_oracle_unavailable");
  }

  return {
    executionEligible: reasons.length === 0,
    flags,
    onchain: input.onchain,
    onchainReadError: input.onchain === null
      ? input.onchainReadError ?? "Token risk read failed"
      : null,
    oracle: input.oracle,
    reasons: [...new Set(reasons)],
    registry: input.registry,
  };
}
