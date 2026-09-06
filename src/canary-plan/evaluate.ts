import { createHash } from "node:crypto";
import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  type Address,
} from "viem";
import {
  NONFUNGIBLE_POSITION_MANAGER,
  ROBINHOOD_CHAIN_ID,
  UNISWAP_V3_FACTORY,
  USDG,
} from "../constants.js";
import {
  centeredRange,
  sizeLiquidityForQuoteBudget,
  validateTickAndSqrtPrice,
} from "../simulator/math.js";
import { guardedCanaryPositionManagerAbi } from "./abi.js";
import type {
  GuardedCanaryChainState,
  GuardedCanaryDraft,
  GuardedCanaryGasEstimate,
  GuardedCanaryPlan,
  GuardedCanaryPolicy,
  GuardedCanarySimulation,
  GuardedCanarySource,
} from "./domain.js";
import type { RiskGateDecision } from "../risk/gate.js";
import type { RpcHealthGateStatus } from "../rpc-health/domain.js";
import { regularEquitySession, type CanaryEntryReadiness } from "./entry-readiness.js";

const BPS = 10_000n;
const ONE_MILLION = 1_000_000n;

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function timestampSeconds(value: string): bigint {
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(`Invalid timestamp ${value}`);
  }
  return BigInt(Math.floor(milliseconds / 1_000));
}

function ageSeconds(from: string, to: string): number | null {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return null;
  }
  return Math.floor((toMs - fromMs) / 1_000);
}

function approvalHash(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function requirePolicy(policy: GuardedCanaryPolicy): void {
  if (policy.budgetQuote <= 0n) throw new Error("Canary budget must be positive");
  if (policy.budgetCapQuote <= 0n) throw new Error("Canary budget cap must be positive");
  if (policy.budgetQuote > policy.budgetCapQuote) {
    throw new Error("Canary budget exceeds the explicit budget cap");
  }
  if (
    !Number.isSafeInteger(policy.slippageBps) ||
    policy.slippageBps <= 0 || policy.slippageBps > 500
  ) {
    throw new Error("Canary slippage must be between 1 and 500 bps");
  }
  if (
    !Number.isSafeInteger(policy.ttlSeconds) ||
    policy.ttlSeconds < 60 || policy.ttlSeconds > 1_800
  ) {
    throw new Error("Canary TTL must be between 60 and 1800 seconds");
  }
  if (policy.maxOracleDeviationPpm < 0n || policy.maxOracleDeviationPpm > 100_000n) {
    throw new Error("Oracle deviation limit must be between 0 and 100000 ppm");
  }
  if (policy.maxLiquiditySharePpm <= 0n || policy.maxLiquiditySharePpm > ONE_MILLION) {
    throw new Error("Liquidity share limit must be between 1 and 1000000 ppm");
  }
}

function requiredToken(
  state: GuardedCanaryChainState,
  address: Address,
): GuardedCanaryChainState["token0"] {
  if (isAddressEqual(state.token0.address, address)) return state.token0;
  if (isAddressEqual(state.token1.address, address)) return state.token1;
  throw new Error(`Missing token state for ${address}`);
}

export function buildGuardedCanaryDraft(input: {
  readonly entryReadiness?: CanaryEntryReadiness;
  readonly chain: GuardedCanaryChainState;
  readonly createdAt: string;
  readonly maxCheckpointAgeSeconds: number;
  readonly operator: Address;
  readonly policy: GuardedCanaryPolicy;
  readonly riskGate: RiskGateDecision;
  readonly rpcHealth: RpcHealthGateStatus;
  readonly source: GuardedCanarySource;
}): GuardedCanaryDraft {
  requirePolicy(input.policy);
  if (
    !Number.isSafeInteger(input.maxCheckpointAgeSeconds) ||
    input.maxCheckpointAgeSeconds <= 0
  ) {
    throw new Error("Maximum checkpoint age must be a positive safe integer");
  }
  if (input.source.rwaSymbol !== "NVDA" || input.source.fee !== 500) {
    throw new Error("Guarded canary planner is restricted to NVDA/USDG fee 500");
  }
  validateTickAndSqrtPrice({
    sqrtPriceX96: input.chain.pool.sqrtPriceX96,
    tick: input.chain.pool.tick,
  });
  const reasons: string[] = [];
  const readiness = input.entryReadiness;
  const readinessAge = readiness ? ageSeconds(readiness.evaluatedAt, input.createdAt) : null;
  const readinessFresh = readinessAge !== null && readinessAge <= 20;
  if (!readiness || !readinessFresh) reasons.push("entry_readiness_missing_or_stale");
  if (regularEquitySession(input.createdAt) !== "regular_session") reasons.push("equity_session_closed_or_unverified");
  if (readiness) reasons.push(...readiness.reasons);
  if (readiness && (!readiness.chainEligible || readiness.session !== "regular_session") && readiness.reasons.length === 0) {
    reasons.push("entry_readiness_ineligible");
  }
  const residualRiskReasons = (values: readonly string[]) => values.filter((reason) =>
    !(reason === "sequencer_feed_unavailable" && readinessFresh && readiness?.chainEligible),
  );
  if (input.chain.chainId !== ROBINHOOD_CHAIN_ID) reasons.push("chain_id_mismatch");
  if (input.source.chainId !== ROBINHOOD_CHAIN_ID) reasons.push("source_chain_id_mismatch");
  if (input.chain.blockNumber !== input.source.blockNumber) {
    reasons.push("source_block_number_mismatch");
  }
  if (input.chain.blockHash.toLowerCase() !== input.source.blockHash.toLowerCase()) {
    reasons.push("source_block_not_canonical");
  }
  if (!isAddressEqual(input.chain.factoryPool, input.source.poolAddress)) {
    reasons.push("factory_pool_mismatch");
  }
  if (!isAddressEqual(input.chain.managerFactory, UNISWAP_V3_FACTORY)) {
    reasons.push("position_manager_factory_mismatch");
  }
  if (!isAddressEqual(input.chain.pool.address, input.source.poolAddress)) {
    reasons.push("pool_address_mismatch");
  }
  if (
    input.chain.pool.fee !== input.source.fee ||
    input.chain.pool.tickSpacing !== 10
  ) {
    reasons.push("pool_fee_or_spacing_mismatch");
  }
  const expectedTokens = [input.source.rwaAddress, USDG]
    .map((address) => address.toLowerCase()).sort();
  const actualTokens = [input.chain.pool.token0, input.chain.pool.token1]
    .map((address) => address.toLowerCase()).sort();
  if (expectedTokens[0] !== actualTokens[0] || expectedTokens[1] !== actualTokens[1]) {
    reasons.push("pool_token_pair_mismatch");
  }
  if (
    !sameAddress(input.chain.pool.token0, input.source.token0) ||
    !sameAddress(input.chain.pool.token1, input.source.token1) ||
    input.chain.pool.tick !== input.source.poolTick ||
    input.chain.pool.sqrtPriceX96 !== input.source.poolSqrtPriceX96 ||
    input.chain.pool.liquidity !== input.source.poolLiquidity ||
    input.chain.pool.unlocked !== input.source.poolUnlocked
  ) {
    reasons.push("pool_checkpoint_state_mismatch");
  }
  if (!input.chain.pool.unlocked) reasons.push("pool_locked");
  if (input.chain.pool.liquidity <= 0n) reasons.push("pool_liquidity_zero");
  const rwa = requiredToken(input.chain, input.source.rwaAddress);
  const quote = requiredToken(input.chain, USDG);
  if (rwa.decimals !== input.source.tokenDecimals) reasons.push("rwa_decimals_mismatch");
  if (quote.decimals !== 6) reasons.push("usdg_decimals_mismatch");
  if (rwa.symbol.toUpperCase() !== "NVDA") reasons.push("rwa_symbol_mismatch");
  if (quote.symbol.toUpperCase() !== "USDG") reasons.push("usdg_symbol_mismatch");
  if (!input.rpcHealth.allowBulk || input.rpcHealth.state !== "healthy") {
    reasons.push(...input.rpcHealth.reasons.map((reason) => `rpc_health:${reason}`));
    if (input.rpcHealth.reasons.length === 0) reasons.push("rpc_health:not_healthy");
  }
  if (!input.riskGate.executionEligible) {
    reasons.push(...residualRiskReasons(input.riskGate.reasons).map((reason) => `risk_gate:${reason}`));
    if (input.riskGate.reasons.length === 0) reasons.push("risk_gate:ineligible");
  }
  if (input.riskGate.snapshotId !== input.source.riskRunId) {
    reasons.push("checkpoint_not_latest_risk_snapshot");
  }
  if (!input.source.assetRiskExecutionEligible) {
    reasons.push(...residualRiskReasons(input.source.assetRiskReasons).map((reason) => `asset_risk:${reason}`));
    if (input.source.assetRiskReasons.length === 0) reasons.push("asset_risk:ineligible");
  }
  if (input.source.poolStatus !== "valid") reasons.push("pool_valuation_invalid");
  const checkpointAgeSeconds = ageSeconds(input.source.capturedAt, input.createdAt);
  if (checkpointAgeSeconds === null) {
    reasons.push("checkpoint_timestamp_invalid");
  } else if (checkpointAgeSeconds > input.maxCheckpointAgeSeconds) {
    reasons.push("checkpoint_stale");
  }
  if (input.source.poolDeviationPpm === null) {
    reasons.push("oracle_deviation_unavailable");
  } else if (
    (input.source.poolDeviationPpm < 0n
      ? -input.source.poolDeviationPpm
      : input.source.poolDeviationPpm) > input.policy.maxOracleDeviationPpm
  ) {
    reasons.push("oracle_deviation_above_limit");
  }

  const { tickLower, tickUpper } = centeredRange({
    currentTick: input.chain.pool.tick,
    halfWidthSpacings: input.policy.halfWidthSpacings,
    tickSpacing: input.chain.pool.tickSpacing,
  });
  const sized = sizeLiquidityForQuoteBudget({
    budgetQuote: input.policy.budgetQuote,
    quoteToken: USDG,
    sqrtPriceX96: input.chain.pool.sqrtPriceX96,
    tickLower,
    tickUpper,
    token0: input.chain.pool.token0,
    token1: input.chain.pool.token1,
  });
  if (sized.liquidity === 0n) reasons.push("budget_too_small_for_nonzero_liquidity");
  const liquiditySharePpm = sized.liquidity * ONE_MILLION /
    input.chain.pool.liquidity;
  if (liquiditySharePpm > input.policy.maxLiquiditySharePpm) {
    reasons.push("liquidity_share_above_limit");
  }
  const amount0Min = sized.amount0 * (BPS - BigInt(input.policy.slippageBps)) / BPS;
  const amount1Min = sized.amount1 * (BPS - BigInt(input.policy.slippageBps)) / BPS;
  if (input.chain.token0.balance < sized.amount0) reasons.push("token0_balance_insufficient");
  if (input.chain.token1.balance < sized.amount1) reasons.push("token1_balance_insufficient");
  if (input.chain.token0.allowance < sized.amount0) reasons.push("token0_allowance_insufficient");
  if (input.chain.token1.allowance < sized.amount1) reasons.push("token1_allowance_insufficient");
  if (input.chain.nativeBalance === 0n) reasons.push("native_gas_balance_zero");
  const deadline = input.chain.blockTimestamp + BigInt(input.policy.ttlSeconds);
  if (deadline <= timestampSeconds(input.createdAt)) reasons.push("transaction_deadline_expired");
  const transaction = {
    amount0Desired: sized.amount0.toString(),
    amount0Min: amount0Min.toString(),
    amount1Desired: sized.amount1.toString(),
    amount1Min: amount1Min.toString(),
    calldata: encodeFunctionData({
      abi: guardedCanaryPositionManagerAbi,
      functionName: "mint",
      args: [{
        amount0Desired: sized.amount0,
        amount0Min,
        amount1Desired: sized.amount1,
        amount1Min,
        deadline,
        fee: input.source.fee,
        recipient: getAddress(input.operator),
        tickLower,
        tickUpper,
        token0: input.chain.pool.token0,
        token1: input.chain.pool.token1,
      }],
    }),
    deadline: deadline.toString(),
    fee: input.source.fee,
    positionManager: NONFUNGIBLE_POSITION_MANAGER,
    recipient: getAddress(input.operator),
    tickLower,
    tickUpper,
    token0: input.chain.pool.token0,
    token1: input.chain.pool.token1,
    value: "0" as const,
  };
  const policy = {
    budgetCapQuote: input.policy.budgetCapQuote.toString(),
    budgetQuote: input.policy.budgetQuote.toString(),
    halfWidthSpacings: input.policy.halfWidthSpacings,
    maxLiquiditySharePpm: input.policy.maxLiquiditySharePpm.toString(),
    maxOracleDeviationPpm: input.policy.maxOracleDeviationPpm.toString(),
    slippageBps: input.policy.slippageBps,
    ttlSeconds: input.policy.ttlSeconds,
  };
  const hashPayload = {
    entryReadiness: readiness ?? null,
    chainId: input.chain.chainId,
    sourceBlockHash: input.source.blockHash,
    sourceBlockNumber: input.source.blockNumber.toString(),
    operator: getAddress(input.operator),
    policy,
    transaction,
  };
  return {
    entryReadiness: readiness ?? null,
    approvalHash: approvalHash(hashPayload),
    assumptions: [
      "single_direct_position_manager_mint",
      "no_permit_or_approval_calls_bundled",
      "quote_budget_sized_at_pinned_pool_spot",
      "amount_minimums_apply_symmetric_configured_slippage",
      "manual_approval_does_not_authorize_broadcast",
      "plan_must_be_regenerated_after_deadline_or_source_change",
    ],
    balances: {
      gasPriceWei: input.chain.gasPriceWei.toString(),
      native: input.chain.nativeBalance.toString(),
      token0: { ...input.chain.token0, required: sized.amount0.toString() },
      token1: { ...input.chain.token1, required: sized.amount1.toString() },
    },
    broadcastAuthorized: false,
    candidateLiquidity: sized.liquidity.toString(),
    checkpointAgeSeconds,
    createdAt: input.createdAt,
    executionEligible: false,
    idleQuote: sized.idleQuote.toString(),
    liquiditySharePpm: liquiditySharePpm.toString(),
    methodology: "guarded_v3_mint_preflight_v1",
    operator: getAddress(input.operator),
    policy,
    reasons: unique(reasons),
    riskGate: input.riskGate,
    rpcHealth: input.rpcHealth,
    schemaVersion: 1,
    source: {
      blockHash: input.source.blockHash,
      blockNumber: input.source.blockNumber.toString(),
      blockTimestamp: input.source.blockTimestamp,
      checkpointRunId: input.source.checkpointRunId,
      poolAddress: input.source.poolAddress,
      poolDeviationPpm: input.source.poolDeviationPpm?.toString() ?? null,
      riskRunId: input.source.riskRunId,
      rwaSymbol: input.source.rwaSymbol,
      streamKey: input.source.streamKey,
      targetSetHash: input.source.targetSetHash,
    },
    transaction,
  };
}

export function finalizeGuardedCanaryPlan(input: {
  readonly draft: GuardedCanaryDraft;
  readonly gasEstimate: GuardedCanaryGasEstimate;
  readonly simulation: GuardedCanarySimulation;
}): GuardedCanaryPlan {
  const preflightReasons = [...input.draft.reasons];
  let simulationValid = false;
  if (!input.simulation.succeeded) {
    preflightReasons.push("mint_simulation_failed");
  } else {
    try {
      const amount0 = BigInt(input.simulation.amount0);
      const amount1 = BigInt(input.simulation.amount1);
      const liquidity = BigInt(input.simulation.liquidity);
      const tokenId = BigInt(input.simulation.tokenId);
      simulationValid = input.simulation.returnData !== null &&
        tokenId > 0n && liquidity > 0n &&
        amount0 >= BigInt(input.draft.transaction.amount0Min) &&
        amount0 <= BigInt(input.draft.transaction.amount0Desired) &&
        amount1 >= BigInt(input.draft.transaction.amount1Min) &&
        amount1 <= BigInt(input.draft.transaction.amount1Desired);
    } catch {
      simulationValid = false;
    }
    if (!simulationValid) preflightReasons.push("mint_simulation_result_invalid");
  }
  let gasValid = false;
  if (input.gasEstimate.succeeded && input.gasEstimate.gas !== null) {
    try {
      gasValid = BigInt(input.gasEstimate.gas) > 0n;
    } catch {
      gasValid = false;
    }
  }
  if (!gasValid) preflightReasons.push("mint_gas_estimate_failed");
  const estimatedGasCostWei = !gasValid
    ? null
    : BigInt(input.gasEstimate.gas!) * BigInt(input.draft.balances.gasPriceWei);
  if (
    estimatedGasCostWei !== null &&
    BigInt(input.draft.balances.native) < estimatedGasCostWei
  ) {
    preflightReasons.push("native_gas_balance_insufficient");
  }
  const reasons = unique(preflightReasons);
  const manualApprovalCandidate = reasons.length === 0;
  return {
    ...input.draft,
    estimatedGasCostWei: estimatedGasCostWei?.toString() ?? null,
    gasEstimate: input.gasEstimate,
    manualApprovalCandidate,
    preflightReasons: reasons,
    simulation: input.simulation,
    status: manualApprovalCandidate
      ? "manual_approval_candidate"
      : "preflight_rejected",
  };
}
