import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hash } from "viem";
import type { OracleFeedMetadata, OracleRoundState } from "../src/risk/domain.js";
import { evaluateOracleRisk } from "../src/risk/evaluate.js";
import type { ActionCostValuationObservation } from "../src/action-cost/valuation-domain.js";
import {
  convertWeiToQuoteRaw,
  evaluateActionCostValuation,
  summarizeActionCostValuations,
} from "../src/action-cost/valuation.js";

const blockHash = `0x${"22".repeat(32)}` as Hash;
const transactionHash = `0x${"11".repeat(32)}` as Hash;

const ethFeed: OracleFeedMetadata = {
  address: "0x1111111111111111111111111111111111111111",
  baseAsset: "ETH",
  decimals: 8,
  heartbeatSeconds: 86_400,
  marketHours: null,
  name: "ETH / USD",
  productTypeCode: "RefPrice",
  quoteAsset: "USD",
};

const quoteFeed: OracleFeedMetadata = {
  ...ethFeed,
  address: "0x2222222222222222222222222222222222222222",
  baseAsset: "USDG",
  name: "USDG / USD",
};

function round(answer: string, description: string): OracleRoundState {
  return {
    answer,
    answeredInRound: "10",
    codeHash: `0x${"33".repeat(32)}`,
    decimals: 8,
    description,
    roundId: "10",
    startedAt: "900",
    updatedAt: "900",
  };
}

function oracle(feed: OracleFeedMetadata, answer: string, timestamp = 1_000n) {
  return evaluateOracleRisk({
    blockTimestamp: timestamp,
    feed,
    maxPriceAgeSeconds: 300,
    state: round(answer, feed.name),
  });
}

function observation(
  overrides: Partial<ActionCostValuationObservation> = {},
): ActionCostValuationObservation {
  return {
    actionClass: "rebalance_bundle",
    blockHash,
    blockNumber: 100n,
    feeComponentsComplete: true,
    l1DataFeeWei: 250_000_000_000_000_000n,
    l2ExecutionFeeWei: 750_000_000_000_000_000n,
    streamKey: "stream",
    totalFeeWei: 1_000_000_000_000_000_000n,
    transactionHash,
    ...overrides,
  };
}

describe("action-cost quote conversion", () => {
  it("ceil-converts wei through independent ETH/USD and USDG/USD marks", () => {
    assert.equal(convertWeiToQuoteRaw({
      ethUsdAnswer: 200_000_000_000n,
      ethUsdDecimals: 8,
      feeWei: 1_000_000_000_000_000_000n,
      quoteDecimals: 6,
      quoteUsdAnswer: 100_000_000n,
      quoteUsdDecimals: 8,
    }), 2_000_000_000n);
    assert.equal(convertWeiToQuoteRaw({
      ethUsdAnswer: 200_000_000_000n,
      ethUsdDecimals: 8,
      feeWei: 1n,
      quoteDecimals: 6,
      quoteUsdAnswer: 100_000_000n,
      quoteUsdDecimals: 8,
    }), 1n);
  });

  it("values total and fee components at the exact canonical block", () => {
    const mark = evaluateActionCostValuation({
      block: { hash: blockHash, number: 100n, timestamp: 1_000n },
      ethOracle: oracle(ethFeed, "200000000000"),
      observation: observation(),
      quoteDecimals: 6,
      quoteOracle: oracle(quoteFeed, "100000000"),
    });
    assert.equal(mark.status, "valid");
    assert.equal(mark.totalCostQuoteRaw, 2_000_000_000n);
    assert.equal(mark.l1DataCostQuoteRaw, 500_000_000n);
    assert.equal(mark.l2ExecutionCostQuoteRaw, 1_500_000_000n);
    assert.deepEqual(mark.reasons, []);
    assert.equal(mark.executionEligible, false);
  });

  it("retains a valid total while leaving absent components unavailable", () => {
    const mark = evaluateActionCostValuation({
      block: { hash: blockHash, number: 100n, timestamp: 1_000n },
      ethOracle: oracle(ethFeed, "200000000000"),
      observation: observation({
        feeComponentsComplete: false,
        l1DataFeeWei: null,
        l2ExecutionFeeWei: null,
      }),
      quoteDecimals: 6,
      quoteOracle: oracle(quoteFeed, "100000000"),
    });
    assert.equal(mark.status, "valid");
    assert.equal(mark.totalCostQuoteRaw, 2_000_000_000n);
    assert.equal(mark.l1DataCostQuoteRaw, null);
    assert.equal(mark.l2ExecutionCostQuoteRaw, null);
  });

  it("excludes stale prices and canonical block mismatches", () => {
    const stale = evaluateActionCostValuation({
      block: { hash: blockHash, number: 100n, timestamp: 1_201n },
      ethOracle: oracle(ethFeed, "200000000000", 1_201n),
      observation: observation(),
      quoteDecimals: 6,
      quoteOracle: oracle(quoteFeed, "100000000", 1_201n),
    });
    assert.equal(stale.status, "excluded");
    assert.ok(stale.reasons.includes("eth_oracle_price_stale"));
    assert.equal(stale.totalCostQuoteRaw, null);

    const mismatch = evaluateActionCostValuation({
      block: {
        hash: `0x${"44".repeat(32)}`,
        number: 100n,
        timestamp: 1_000n,
      },
      ethOracle: oracle(ethFeed, "200000000000"),
      observation: observation(),
      quoteDecimals: 6,
      quoteOracle: oracle(quoteFeed, "100000000"),
    });
    assert.equal(mismatch.status, "excluded");
    assert.deepEqual(mismatch.reasons, ["block_canonicality_mismatch"]);
  });

  it("summarizes only valid marks with nearest-rank percentiles", () => {
    const base = evaluateActionCostValuation({
      block: { hash: blockHash, number: 100n, timestamp: 1_000n },
      ethOracle: oracle(ethFeed, "200000000000"),
      observation: observation(),
      quoteDecimals: 6,
      quoteOracle: oracle(quoteFeed, "100000000"),
    });
    const summary = summarizeActionCostValuations([
      base,
      { ...base, totalCostQuoteRaw: 3_000_000_000n },
      {
        ...base,
        reasons: ["block_read_failed"],
        status: "excluded",
        totalCostQuoteRaw: null,
      },
    ]);
    assert.equal(summary.validObservations, 2);
    assert.equal(summary.excludedObservations, 1);
    assert.equal(summary.byClass.rebalance_bundle.totalCostQuoteRawP50, 2_000_000_000n);
    assert.equal(summary.byClass.rebalance_bundle.totalCostQuoteRawP90, 3_000_000_000n);
  });
});
