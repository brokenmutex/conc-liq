import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hash } from "viem";
import type { OracleFeedMetadata, OracleRoundState } from "../src/risk/domain.js";
import { evaluateOracleRisk } from "../src/risk/evaluate.js";
import type { ApprovalCostValuationObservation } from "../src/approval-cost/valuation-domain.js";
import {
  evaluateApprovalCostValuation,
  summarizeApprovalCostValuations,
} from "../src/approval-cost/valuation.js";

const blockHash = `0x${"11".repeat(32)}` as Hash;
const transactionHash = `0x${"22".repeat(32)}` as Hash;
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

function round(answer: string, name: string): OracleRoundState {
  return {
    answer,
    answeredInRound: "2",
    codeHash: `0x${"33".repeat(32)}`,
    decimals: 8,
    description: name,
    roundId: "2",
    startedAt: "900",
    updatedAt: "900",
  };
}

function oracle(feed: OracleFeedMetadata, answer: string) {
  return evaluateOracleRisk({
    blockTimestamp: 1_000n,
    feed,
    maxPriceAgeSeconds: 86_400,
    state: round(answer, feed.name),
  });
}

function observation(
  overrides: Partial<ApprovalCostValuationObservation> = {},
): ApprovalCostValuationObservation {
  return {
    blockHash,
    blockNumber: 100n,
    l1DataFeeWei: 25_000_000_000_000n,
    l2ExecutionFeeWei: 75_000_000_000_000n,
    sourceReasons: [],
    sourceStatus: "comparable",
    tokenSymbols: ["USDG"],
    totalFeeWei: 100_000_000_000_000n,
    transactionHash,
    ...overrides,
  };
}

describe("approval-cost valuation", () => {
  it("values a proven approval at its exact canonical oracle mark", () => {
    const mark = evaluateApprovalCostValuation({
      block: { hash: blockHash, number: 100n, timestamp: 1_000n },
      ethOracle: oracle(ethFeed, "200000000000"),
      observation: observation(),
      quoteDecimals: 6,
      quoteOracle: oracle(quoteFeed, "100000000"),
    });
    assert.equal(mark.status, "valid");
    assert.equal(mark.totalCostQuoteRaw, 200_000n);
    assert.equal(mark.l1DataCostQuoteRaw, 50_000n);
    assert.equal(mark.l2ExecutionCostQuoteRaw, 150_000n);
    assert.deepEqual(mark.reasons, []);
  });

  it("carries source exclusions forward without inventing a valuation", () => {
    const mark = evaluateApprovalCostValuation({
      block: null,
      ethOracle: null,
      observation: observation({
        sourceReasons: ["approval_transition_not_initial:nonzero_to_nonzero"],
        sourceStatus: "excluded",
      }),
      quoteDecimals: 6,
      quoteOracle: null,
    });
    assert.equal(mark.status, "excluded");
    assert.equal(mark.blockReadError, null);
    assert.equal(mark.totalCostQuoteRaw, null);
    assert.deepEqual(mark.reasons, [
      "approval_source_not_comparable",
      "approval_transition_not_initial:nonzero_to_nonzero",
    ]);
  });

  it("excludes a noncanonical block or invalid oracle", () => {
    const mark = evaluateApprovalCostValuation({
      block: {
        hash: `0x${"44".repeat(32)}`,
        number: 100n,
        timestamp: 1_000n,
      },
      ethOracle: oracle(ethFeed, "200000000000"),
      observation: observation(),
      quoteDecimals: 6,
      quoteOracle: null,
    });
    assert.equal(mark.status, "excluded");
    assert.ok(mark.reasons.includes("block_canonicality_mismatch"));
    assert.ok(mark.reasons.includes("quote_oracle_unavailable"));
  });

  it("summarizes exact token-specific valid costs", () => {
    const base = evaluateApprovalCostValuation({
      block: { hash: blockHash, number: 100n, timestamp: 1_000n },
      ethOracle: oracle(ethFeed, "200000000000"),
      observation: observation(),
      quoteDecimals: 6,
      quoteOracle: oracle(quoteFeed, "100000000"),
    });
    const summary = summarizeApprovalCostValuations([
      base,
      { ...base, totalCostQuoteRaw: 300_000n },
      {
        ...base,
        reasons: ["block_read_failed"],
        status: "excluded",
        totalCostQuoteRaw: null,
      },
    ]);
    assert.equal(summary.validObservations, 2);
    assert.equal(summary.excludedObservations, 1);
    assert.equal(summary.byToken.USDG?.totalCostQuoteRawP50, 200_000n);
    assert.equal(summary.byToken.USDG?.totalCostQuoteRawP90, 300_000n);
  });
});
