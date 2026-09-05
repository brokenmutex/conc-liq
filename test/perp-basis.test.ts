import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { USDG } from "../src/constants.js";
import type { PerpBasisConfig, PerpBasisSource } from "../src/perp-basis/domain.js";
import { evaluatePerpBasis } from "../src/perp-basis/evaluate.js";
import { parseUnsignedDecimalX18 } from "../src/perp-reference/math.js";

const rwa = "0x1111111111111111111111111111111111111111";
const pool = "0x2222222222222222222222222222222222222222";
const blockHash = `0x${"ab".repeat(32)}`;

const config: PerpBasisConfig = {
  maxPoolDeviationPpm: 20_000n,
  maxQuoteDepegPpm: 10_000n,
  maxQuoteOracleAgeSeconds: 86_400,
  maxSourceAgeSeconds: 600,
  maxSourceSkewSeconds: 360,
};

function source(): PerpBasisSource {
  return {
    asset: {
      corporateActionPending: false,
      currentMultiplier: "1.050000000000000000",
      multiplierConsistent: true,
      pendingMultiplier: null,
      registryActive: true,
      registryAddress: rwa,
      token: {
        effectiveAt: "0",
        newUiMultiplierX18: "1050000000000000000",
        oraclePaused: false,
        uiMultiplierX18: "1050000000000000000",
      },
      tokenAddress: rwa,
      tradingCapabilitiesComplete: true,
      tradingCapabilitiesTradable: true,
    },
    chain: {
      blockHash,
      blockNumber: "100",
      blockTimestamp: "2026-09-05T12:00:00.000Z",
      canonical: true,
      canonicalBlockNumber: "100",
      canonicalExpectedHash: blockHash,
      canonicalObservedHash: blockHash,
      capturedAt: "2026-09-05T12:00:05.000Z",
      chainlinkOraclePriceX18: parseUnsignedDecimalX18(
        "105.5",
        "Chainlink price",
      ).toString(),
      checkpointRunId: "1",
      fee: 500,
      liquidity: "1000000",
      poolAddress: pool,
      poolPriceX18: parseUnsignedDecimalX18("107", "Pool price").toString(),
      poolReasons: ["rwa_oracle_price_stale"],
      poolStatus: "excluded",
      poolUnlocked: true,
      riskRunId: "2",
      rwaAddress: rwa,
      rwaSymbol: "NVDA",
      streamKey: "test",
      token0: USDG,
      token1: rwa,
    },
    perp: {
      coin: "xyz:NVDA",
      dex: "xyz",
      evidenceSha256: `sha256:${"cd".repeat(32)}`,
      expectedPricingMode: "scheduled_internal_weekend",
      markPrice: "102",
      midPrice: "101",
      observedAt: "2026-09-05T12:01:00.000Z",
      oraclePriceX18: parseUnsignedDecimalX18("100", "Perp oracle").toString(),
      qualityPass: true,
      reasons: [],
      snapshotRunId: "3",
      status: "observed",
    },
    quoteOracle: {
      answer: "100000000",
      answeredInRound: "9",
      baseAsset: "USDG",
      decimals: 8,
      decimalsMatch: true,
      descriptionMatches: true,
      feedAddress: "0x3333333333333333333333333333333333333333",
      heartbeatSeconds: 86_400,
      quoteAsset: "USD",
      roundComplete: true,
      roundId: "9",
      timestampNotFuture: true,
      updatedAt: String(Date.parse("2026-09-05T11:00:00.000Z") / 1_000),
    },
  };
}

describe("multiplier-adjusted perp/pool basis", () => {
  it("creates a shadow weekend candidate through heartbeat-bounded USDG", () => {
    const assessment = evaluatePerpBasis({
      config,
      evaluatedAt: "2026-09-05T12:05:00.000Z",
      source: source(),
    });
    assert.equal(assessment.referenceMode, "perp_internal_weekend_candidate");
    assert.equal(assessment.primaryReferenceAvailable, false);
    assert.equal(assessment.fallbackCandidate, true);
    assert.equal(assessment.qualityPass, true);
    assert.equal(assessment.executionEligible, false);
    assert.equal(
      assessment.metrics.perpReferenceUsdX18,
      parseUnsignedDecimalX18("101", "Expected reference").toString(),
    );
    assert.equal(
      assessment.metrics.tokenReferenceUsdX18,
      parseUnsignedDecimalX18("106.05", "Expected token price").toString(),
    );
    assert.equal(assessment.metrics.tokenReferenceUsdgX18,
      assessment.metrics.tokenReferenceUsdX18);
    assert.equal(assessment.metrics.sourceSkewSeconds, 60);
    assert.equal(assessment.metrics.quoteOracleAgeSeconds, 3_900);
  });

  it("does not call the perp comparison a fallback when Chainlink is valid", () => {
    const base = source();
    const assessment = evaluatePerpBasis({
      config,
      evaluatedAt: "2026-09-05T12:05:00.000Z",
      source: {
        ...base,
        chain: { ...base.chain, poolReasons: [], poolStatus: "valid" },
      },
    });
    assert.equal(assessment.referenceMode, "chainlink_primary_comparison");
    assert.equal(assessment.primaryReferenceAvailable, true);
    assert.equal(assessment.fallbackCandidate, false);
    assert.equal(assessment.qualityPass, true);
  });

  it("rejects a multiplier transition and quote beyond its heartbeat", () => {
    const base = source();
    const assessment = evaluatePerpBasis({
      config,
      evaluatedAt: "2026-09-05T12:05:00.000Z",
      source: {
        ...base,
        asset: {
          ...base.asset,
          token: {
            ...base.asset.token!,
            newUiMultiplierX18: "1100000000000000000",
          },
        },
        quoteOracle: {
          ...base.quoteOracle!,
          updatedAt: String(Date.parse("2026-09-04T11:00:00.000Z") / 1_000),
        },
      },
    });
    assert.equal(assessment.qualityPass, false);
    assert.equal(assessment.fallbackCandidate, false);
    assert(assessment.reasons.includes("token_multiplier_transition"));
    assert(assessment.reasons.includes("quote_oracle_stale"));
    assert.equal(assessment.executionEligible, false);
  });

  it("rejects mismatched instruments and canonicality proofs", () => {
    const base = source();
    const assessment = evaluatePerpBasis({
      config,
      evaluatedAt: "2026-09-05T12:05:00.000Z",
      source: {
        ...base,
        chain: {
          ...base.chain,
          canonicalObservedHash: `0x${"ef".repeat(32)}`,
        },
        perp: { ...base.perp, coin: "xyz:AAPL" },
      },
    });
    assert.equal(assessment.qualityPass, false);
    assert(assessment.reasons.includes("checkpoint_canonicality_unproven"));
    assert(assessment.reasons.includes("perp_rwa_symbol_mismatch"));
  });
});
