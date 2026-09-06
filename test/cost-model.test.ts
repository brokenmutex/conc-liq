import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "viem";
import { resolveGuardedCostModel } from "../src/cost-model/evaluate.js";

const source = {
  fee: 500,
  poolAddress: "0x1111111111111111111111111111111111111111" as Address,
  rwaSymbol: "NVDA",
  streamKey: "stream",
};

describe("guarded measured cost model", () => {
  it("adds only pool- and token-specific direct-call P90 components", () => {
    const model = resolveGuardedCostModel({
      evidence: {
        actionAssessmentRunId: "1",
        approvalValuationRunId: "2",
        initialMint: { p90QuoteRaw: 2_850_024n, sampleCount: 3 },
        quoteApproval: { p90QuoteRaw: 56_655n, sampleCount: 5 },
        rwaApproval: { p90QuoteRaw: 59_480n, sampleCount: 1 },
      },
      source,
    });
    assert.equal(model.status, "entry_measured");
    assert.equal(model.entryCostQuoteRaw, 2_966_159n);
    assert.equal(model.rebalanceCostQuoteRaw, null);
    assert.equal(model.exitCostQuoteRaw, null);
    assert.deepEqual(model.reasons, ["rebalance_execution_path_unset"]);
    assert.deepEqual(model.warnings, ["rwa_approval_sample_below_three"]);
    assert.equal(model.executionEligible, false);
  });

  it("fails entry closed when a pool-specific component is unavailable", () => {
    const model = resolveGuardedCostModel({
      evidence: {
        actionAssessmentRunId: "1",
        approvalValuationRunId: "2",
        initialMint: { p90QuoteRaw: null, sampleCount: 0 },
        quoteApproval: { p90QuoteRaw: 56_655n, sampleCount: 5 },
        rwaApproval: { p90QuoteRaw: 59_480n, sampleCount: 1 },
      },
      source,
    });
    assert.equal(model.status, "unavailable");
    assert.equal(model.entryCostQuoteRaw, null);
    assert.ok(model.reasons.includes("initial_mint_cost_unavailable"));
  });

  it("rejects internally inconsistent sample evidence", () => {
    assert.throws(() => resolveGuardedCostModel({
      evidence: {
        actionAssessmentRunId: "1",
        approvalValuationRunId: "2",
        initialMint: { p90QuoteRaw: 1n, sampleCount: 0 },
        quoteApproval: { p90QuoteRaw: 1n, sampleCount: 1 },
        rwaApproval: { p90QuoteRaw: 1n, sampleCount: 1 },
      },
      source,
    }), /disagree/);
  });
});
