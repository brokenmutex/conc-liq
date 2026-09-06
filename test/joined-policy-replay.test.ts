import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sqrtRatioAtTick } from "../src/backtest/principal.js";
import { parseJoinedPolicyCli } from "../src/joined-policy/config.js";
import type {
  JoinedPolicyReplaySource,
  JoinedPolicyReference,
} from "../src/joined-policy/domain.js";
import { replayJoinedReferencePolicies } from "../src/joined-policy/evaluate.js";
import { USDG } from "../src/constants.js";
import { poolQuotePerRwaX18 } from "../src/oracle/math.js";
import type {
  OraclePolicyCheckpoint,
  OraclePolicyReplaySource,
} from "../src/oracle-policy/domain.js";

const Q128 = 1n << 128n;
const X18 = 1_000_000_000_000_000_000n;
const rwa = "0x1111111111111111111111111111111111111111";
const poolAddress = "0x2222222222222222222222222222222222222222";
const baseTime = Date.parse("2026-09-05T00:00:00.000Z");

function checkpoint(input: {
  readonly feeGrowth0: bigint;
  readonly feeGrowth1: bigint;
  readonly hour: number;
  readonly id: string;
  readonly referencePriceX18: bigint;
  readonly tick: number;
}): OraclePolicyCheckpoint {
  const sqrtPriceX96 = sqrtRatioAtTick(input.tick);
  return {
    oraclePriceX18: input.referencePriceX18,
    pool: {
      feeGrowthGlobal0X128: input.feeGrowth0,
      feeGrowthGlobal1X128: input.feeGrowth1,
      liquidity: 100_000_000n,
      sqrtPriceX96,
      tick: input.tick,
    },
    poolPriceX18: poolQuotePerRwaX18({
      quoteDecimals: 6,
      quoteToken: USDG,
      rwaDecimals: 6,
      sqrtPriceX96,
      token0: USDG,
      token1: rwa,
    }),
    reasons: [],
    run: {
      blockHash: `0x${input.id.padStart(64, "0")}`,
      blockNumber: BigInt(input.hour * 100 + 100),
      blockTimestamp: new Date(baseTime + input.hour * 3_600_000).toISOString(),
      capturedAt: new Date(baseTime + input.hour * 3_600_000 + 500).toISOString(),
      chainId: 4663,
      checkpointRunId: input.id,
      riskRunId: String(100 + Number(input.id)),
    },
    status: "valid",
    tokenDecimals: 6,
  };
}

function joinedSource(): JoinedPolicyReplaySource {
  const checkpoints = [
    checkpoint({
      feeGrowth0: 10n * Q128,
      feeGrowth1: 20n * Q128,
      hour: 0,
      id: "1",
      referencePriceX18: X18,
      tick: 0,
    }),
    checkpoint({
      feeGrowth0: 10n * Q128 + Q128 / 1_000_000n,
      feeGrowth1: 20n * Q128 + Q128 / 2_000_000n,
      hour: 24,
      id: "2",
      referencePriceX18: 2n * X18,
      tick: 5,
    }),
    checkpoint({
      feeGrowth0: 10n * Q128 + Q128 / 500_000n,
      feeGrowth1: 20n * Q128 + Q128 / 1_000_000n,
      hour: 72,
      id: "3",
      referencePriceX18: 3n * X18,
      tick: 15,
    }),
  ];
  const references: JoinedPolicyReference[] = [
    {
      basisRunId: "11",
      chainlinkPriceX18: X18,
      checkpointRunId: "1",
      fallbackCandidate: false,
      primaryReferenceAvailable: true,
      qualityPass: true,
      referenceMode: "chainlink_primary_comparison",
      selectedPriceX18: X18,
      tokenReferenceUsdgX18: X18,
    },
    {
      basisRunId: "12",
      chainlinkPriceX18: 2n * X18,
      checkpointRunId: "2",
      fallbackCandidate: false,
      primaryReferenceAvailable: true,
      qualityPass: true,
      referenceMode: "chainlink_primary_comparison",
      selectedPriceX18: 2n * X18,
      tokenReferenceUsdgX18: 2n * X18,
    },
    {
      basisRunId: "13",
      chainlinkPriceX18: null,
      checkpointRunId: "3",
      fallbackCandidate: true,
      primaryReferenceAvailable: false,
      qualityPass: true,
      referenceMode: "perp_internal_weekend_candidate",
      selectedPriceX18: 3n * X18,
      tokenReferenceUsdgX18: 3n * X18,
    },
  ];
  const oracleSource: OraclePolicyReplaySource = {
    checkpoints,
    fee: 500,
    indexedThroughBlock: 8_000n,
    intervals: [
      {
        fromRunId: "1",
        pathMaxTick: 5,
        pathMinTick: 0,
        swapCount: 2n,
        toRunId: "2",
      },
      {
        fromRunId: "2",
        pathMaxTick: 15,
        pathMinTick: 5,
        swapCount: 3n,
        toRunId: "3",
      },
    ],
    poolAddress,
    quoteToken: USDG,
    rwaAddress: rwa,
    rwaDecimals: 6,
    rwaSymbol: "NVDA",
    streamKey: "test",
    targetSetHash: `0x${"aa".repeat(32)}`,
    token0: USDG,
    token1: rwa,
  };
  return {
    costModel: {
      computedAt: "2026-09-05T00:00:00.000Z",
      entryCostQuote: 1_000_000n,
      exitCostQuote: 2_000_000n,
      modelId: "21",
      rebalanceCostQuote: 1_500_000n,
      status: "complete",
      warnings: [],
    },
    coverage: {
      passingCheckpoints: 3,
      passingRows: 3,
      rejectedRows: 1,
      rejectionReasons: { source_skew_high: 1 },
      totalRows: 4,
    },
    oracleSource,
    references,
  };
}

const requirements = {
  minExternalFallbackCheckpoints: 0,
  minPassingCheckpoints: 3,
  minWeekendFallbackCheckpoints: 1,
  minWindowHours: 48,
};

describe("joined reference historical policy replay", () => {
  it("selects primary and weekend marks and charges complete measured costs", () => {
    const replay = replayJoinedReferencePolicies({
      budgetQuote: 1_000_000_000n,
      halfWidths: [50],
      requirements,
      source: joinedSource(),
      triggerPercent: 50,
    });
    assert.equal(replay.executionEligible, false);
    assert.equal(replay.evidence.primaryCheckpoints, 2);
    assert.equal(replay.evidence.weekendFallbackCheckpoints, 1);
    assert.equal(replay.evidence.externalFallbackCheckpoints, 0);
    assert.equal(replay.evidence.windowHours, 72);
    assert.equal(replay.coverage.rejectedRows, 1);
    const candidate = replay.candidates[0]!;
    assert.equal(candidate.status, "complete");
    assert.equal(candidate.exitCostAppliedQuote, "2000000");
    assert.equal(
      BigInt(candidate.finalNavQuote!),
      BigInt(candidate.preExitFinalNavQuote!) - 2_000_000n,
    );
    assert.equal(
      BigInt(candidate.totalCostQuote),
      1_000_000n + BigInt(candidate.rebalances) * 1_500_000n + 2_000_000n,
    );
    assert.match(replay.policySetHash, /^sha256:[0-9a-f]{64}$/u);
  });

  it("rejects insufficient weekend evidence and inconsistent fallback marks", () => {
    assert.throws(() => replayJoinedReferencePolicies({
      budgetQuote: 1_000_000_000n,
      halfWidths: [50],
      requirements: { ...requirements, minWeekendFallbackCheckpoints: 2 },
      source: joinedSource(),
      triggerPercent: 50,
    }), /fewer weekend fallback/u);

    const source = joinedSource();
    const bad = {
      ...source,
      references: source.references.map((reference, index) => index === 2
        ? { ...reference, fallbackCandidate: false }
        : reference),
    };
    assert.throws(() => replayJoinedReferencePolicies({
      budgetQuote: 1_000_000_000n,
      halfWidths: [50],
      requirements,
      source: bad,
      triggerPercent: 50,
    }), /fallback reference is inconsistent/u);
  });

  it("excludes candidates whose final NAV cannot pay the measured exit", () => {
    const source = joinedSource();
    const replay = replayJoinedReferencePolicies({
      budgetQuote: 1_000_000_000n,
      halfWidths: [50],
      requirements,
      source: {
        ...source,
        costModel: { ...source.costModel, exitCostQuote: 10n ** 30n },
      },
      triggerPercent: 50,
    });
    assert.equal(replay.completedCandidates, 0);
    assert.equal(replay.candidates[0]?.failureReason, "exit_cost_exhausted_final_nav");
    assert.equal(replay.candidates[0]?.exitCostAppliedQuote, "0");
  });

  it("parses every evidence threshold and scenario input explicitly", () => {
    const parsed = parseJoinedPolicyCli([
      "--rwa", "nvda",
      "--fee", "500",
      "--budget-usdg", "1000.25",
      "--half-widths", "20,50",
      "--trigger-percent", "50",
      "--lookback", "60",
      "--min-passing-checkpoints", "50",
      "--min-window-hours", "72",
      "--min-weekend-fallback-checkpoints", "3",
      "--min-external-fallback-checkpoints", "0",
    ]);
    assert.equal(parsed.rwaSymbol, "NVDA");
    assert.equal(parsed.budgetQuote, 1_000_250_000n);
    assert.deepEqual(parsed.halfWidths, [20, 50]);
    assert.equal(parsed.minWeekendFallbackCheckpoints, 3);
    assert.equal(parsed.minExternalFallbackCheckpoints, 0);
  });
});
