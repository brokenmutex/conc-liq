import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address, Hash } from "viem";
import { Q96 } from "../src/backtest/principal.js";
import { parseGuardedCanaryCli } from "../src/canary-plan/config.js";
import type {
  GuardedCanaryChainState,
  GuardedCanaryPolicy,
  GuardedCanarySource,
} from "../src/canary-plan/domain.js";
import {
  buildGuardedCanaryDraft,
  finalizeGuardedCanaryPlan,
} from "../src/canary-plan/evaluate.js";
import {
  NONFUNGIBLE_POSITION_MANAGER,
  UNISWAP_V3_FACTORY,
  USDG,
} from "../src/constants.js";
import type { RiskGateDecision } from "../src/risk/gate.js";
import type { RpcHealthGateStatus } from "../src/rpc-health/domain.js";

const rwa = "0x1111111111111111111111111111111111111111" as Address;
const pool = "0x2222222222222222222222222222222222222222" as Address;
const operator = "0x3333333333333333333333333333333333333333" as Address;
const blockHash = `0x${"44".repeat(32)}` as Hash;
const targetSetHash = `0x${"55".repeat(32)}` as Hash;
const capturedAt = "2026-09-05T12:00:01.000Z";

function source(): GuardedCanarySource {
  return {
    assetRiskExecutionEligible: true,
    assetRiskReasons: [],
    blockHash,
    blockNumber: 100n,
    blockTimestamp: "2026-09-05T12:00:00.000Z",
    capturedAt,
    chainId: 4663,
    checkpointRunId: "10",
    fee: 500,
    poolAddress: pool,
    poolDeviationPpm: 500n,
    poolLiquidity: 10n ** 30n,
    poolSqrtPriceX96: Q96,
    poolStatus: "valid",
    poolTick: 0,
    poolUnlocked: true,
    riskRunId: "9",
    rwaAddress: rwa,
    rwaSymbol: "NVDA",
    streamKey: "test",
    targetSetHash,
    token0: rwa,
    token1: USDG,
    tokenDecimals: 18,
  };
}

function chain(): GuardedCanaryChainState {
  return {
    blockHash,
    blockNumber: 100n,
    blockTimestamp: 1_788_609_600n,
    chainId: 4663,
    factoryPool: pool,
    gasPriceWei: 1_000_000_000n,
    managerFactory: UNISWAP_V3_FACTORY,
    nativeBalance: 10n ** 18n,
    pool: {
      address: pool,
      fee: 500,
      liquidity: 10n ** 30n,
      sqrtPriceX96: Q96,
      tick: 0,
      tickSpacing: 10,
      token0: rwa,
      token1: USDG,
      unlocked: true,
    },
    token0: {
      address: rwa,
      allowance: 10n ** 30n,
      balance: 10n ** 30n,
      decimals: 18,
      symbol: "NVDA",
    },
    token1: {
      address: USDG,
      allowance: 10n ** 30n,
      balance: 10n ** 30n,
      decimals: 6,
      symbol: "USDG",
    },
  };
}

function policy(): GuardedCanaryPolicy {
  return {
    budgetCapQuote: 2_000_000n,
    budgetQuote: 1_000_000n,
    halfWidthSpacings: 20,
    maxLiquiditySharePpm: 10_000n,
    maxOracleDeviationPpm: 5_000n,
    slippageBps: 50,
    ttlSeconds: 300,
  };
}

function riskGate(): RiskGateDecision {
  return {
    attemptId: "11",
    attemptStatus: "succeeded",
    blockCanonical: true,
    canonicalityAgeSeconds: 1,
    evaluatedAt: "2026-09-05T12:00:02.000Z",
    executionEligible: true,
    maxCanonicalityAgeSeconds: 30,
    maxSnapshotAgeSeconds: 180,
    reasons: [],
    snapshotAgeSeconds: 1,
    snapshotBlockNumber: "100",
    snapshotId: "9",
    snapshotObservedAt: capturedAt,
    sourceCoversSnapshot: true,
  };
}

function rpcHealth(): RpcHealthGateStatus {
  return {
    allowBulk: true,
    lagBlocks: 0n,
    lagSeconds: 0n,
    observedAt: "2026-09-05T12:00:02.000Z",
    privateHead: 164n,
    reasons: [],
    referenceHead: 164n,
    sampleId: "12",
    state: "healthy",
  };
}

describe("guarded canary planner", () => {
  it("builds a deterministic direct-mint approval envelope without authorization", () => {
    const input = {
      chain: chain(),
      createdAt: "2026-09-05T12:00:02.000Z",
      maxCheckpointAgeSeconds: 180,
      operator,
      policy: policy(),
      riskGate: riskGate(),
      rpcHealth: rpcHealth(),
      source: source(),
    };
    const first = buildGuardedCanaryDraft(input);
    const second = buildGuardedCanaryDraft({
      ...input,
      createdAt: "2026-09-05T12:00:03.000Z",
    });

    assert.deepEqual(first.reasons, []);
    assert.equal(first.approvalHash, second.approvalHash);
    assert.equal(first.broadcastAuthorized, false);
    assert.equal(first.executionEligible, false);
    assert.equal(first.transaction.positionManager, NONFUNGIBLE_POSITION_MANAGER);
    assert.equal(first.transaction.recipient, operator);
    assert.equal(first.transaction.fee, 500);
    assert.equal(first.transaction.tickLower, -200);
    assert.equal(first.transaction.tickUpper, 200);
    assert.match(first.transaction.calldata, /^0x88316456/u);
  });

  it("requires successful simulation and estimation before manual approval", () => {
    const draft = buildGuardedCanaryDraft({
      chain: chain(),
      createdAt: "2026-09-05T12:00:02.000Z",
      maxCheckpointAgeSeconds: 180,
      operator,
      policy: policy(),
      riskGate: riskGate(),
      rpcHealth: rpcHealth(),
      source: source(),
    });
    const ready = finalizeGuardedCanaryPlan({
      draft,
      gasEstimate: { error: null, gas: "500000", succeeded: true },
      simulation: {
        amount0: draft.transaction.amount0Desired,
        amount1: draft.transaction.amount1Desired,
        error: null,
        liquidity: draft.candidateLiquidity,
        returnData: "0x01",
        succeeded: true,
        tokenId: "123",
      },
    });
    assert.equal(ready.status, "manual_approval_candidate");
    assert.equal(ready.manualApprovalCandidate, true);
    assert.equal(ready.executionEligible, false);
    assert.equal(ready.estimatedGasCostWei, "500000000000000");

    const rejected = finalizeGuardedCanaryPlan({
      draft,
      gasEstimate: { error: "revert", gas: null, succeeded: false },
      simulation: {
        amount0: "0",
        amount1: "0",
        error: "revert",
        liquidity: "0",
        returnData: null,
        succeeded: false,
        tokenId: "0",
      },
    });
    assert.equal(rejected.status, "preflight_rejected");
    assert.deepEqual(rejected.preflightReasons, [
      "mint_simulation_failed",
      "mint_gas_estimate_failed",
    ]);

    const malformedSuccess = finalizeGuardedCanaryPlan({
      draft,
      gasEstimate: { error: null, gas: null, succeeded: true },
      simulation: {
        amount0: "0",
        amount1: "0",
        error: null,
        liquidity: "0",
        returnData: "0x01",
        succeeded: true,
        tokenId: "0",
      },
    });
    assert.deepEqual(malformedSuccess.preflightReasons, [
      "mint_simulation_result_invalid",
      "mint_gas_estimate_failed",
    ]);
  });

  it("fails closed on risk, oracle, checkpoint, balances, and allowances", () => {
    const unsafeChain = chain();
    const draft = buildGuardedCanaryDraft({
      chain: {
        ...unsafeChain,
        token0: { ...unsafeChain.token0, allowance: 0n, balance: 0n },
      },
      createdAt: "2026-09-05T12:10:00.000Z",
      maxCheckpointAgeSeconds: 180,
      operator,
      policy: { ...policy(), maxOracleDeviationPpm: 100n },
      riskGate: { ...riskGate(), executionEligible: false, reasons: ["oracle_paused"] },
      rpcHealth: rpcHealth(),
      source: source(),
    });
    assert.ok(draft.reasons.includes("risk_gate:oracle_paused"));
    assert.ok(draft.reasons.includes("checkpoint_stale"));
    assert.ok(draft.reasons.includes("oracle_deviation_above_limit"));
    assert.ok(draft.reasons.includes("token0_balance_insufficient"));
    assert.ok(draft.reasons.includes("token0_allowance_insufficient"));
    assert.ok(draft.reasons.includes("transaction_deadline_expired"));
  });

  it("rejects implicit policy and parses explicit quote precision exactly", () => {
    assert.deepEqual(parseGuardedCanaryCli([]), { help: false });
    const parsed = parseGuardedCanaryCli([
      "--operator", operator,
      "--budget-usdg", "1.25",
      "--budget-cap-usdg", "2",
      "--half-width-spacings", "20",
      "--slippage-bps", "50",
      "--max-oracle-deviation-ppm", "5000",
      "--max-liquidity-share-ppm", "10000",
      "--ttl-seconds", "300",
    ]);
    assert.equal(parsed.budgetQuote, 1_250_000n);
    assert.equal(parsed.budgetCapQuote, 2_000_000n);
    assert.equal(parsed.operator, operator);
    assert.equal(parseGuardedCanaryCli([
      "--max-oracle-deviation-ppm", "0",
    ]).maxOracleDeviationPpm, 0n);
    assert.throws(() => parseGuardedCanaryCli([
      "--budget-usdg", "1.0000001",
    ]), /up to 6 decimals/u);
  });
});
