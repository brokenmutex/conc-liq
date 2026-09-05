import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address, Hash, Hex } from "viem";
import {
  assessActionCostCall,
  POSITION_MANAGER_SELECTORS,
  summarizeActionCostCalls,
} from "../src/action-cost/comparability.js";
import type { ActionCostCallSourceMark } from "../src/action-cost/comparability-domain.js";

const manager = "0x73991a25c818bf1f1128deaab1492d45638de0d3" as Address;
const transactionHash = `0x${"11".repeat(32)}` as Hash;

function mark(
  overrides: Partial<ActionCostCallSourceMark> = {},
): ActionCostCallSourceMark {
  return {
    actionClass: "mint_bundle",
    recipient: manager,
    selector: POSITION_MANAGER_SELECTORS.mint,
    sourceReasons: [],
    sourceStatus: "valid",
    totalCostQuoteRaw: 2_000_000n,
    transactionHash,
    ...overrides,
  };
}

describe("action-cost call comparability", () => {
  it("derives the canonical Position Manager selectors", () => {
    assert.equal(POSITION_MANAGER_SELECTORS.mint, "0x88316456");
    assert.equal(POSITION_MANAGER_SELECTORS.increase, "0x219f5d17");
    assert.equal(POSITION_MANAGER_SELECTORS.decrease, "0x0c49ccbe");
    assert.equal(POSITION_MANAGER_SELECTORS.collect, "0xfc6f7865");
    assert.equal(POSITION_MANAGER_SELECTORS.multicall, "0xac9650d8");
  });

  it("accepts only direct known calls with a consistent pool-event mix", () => {
    const mint = assessActionCostCall(mark(), manager);
    assert.equal(mint.status, "comparable");
    assert.equal(mint.intendedAction, "initial_mint");

    const collect = assessActionCostCall(mark({
      actionClass: "exit_bundle",
      selector: POSITION_MANAGER_SELECTORS.collect,
    }), manager);
    assert.equal(collect.status, "comparable");
    assert.equal(collect.intendedAction, "collect_fees");

    const inconsistent = assessActionCostCall(mark({
      actionClass: "swap_only",
    }), manager);
    assert.equal(inconsistent.status, "excluded");
    assert.deepEqual(inconsistent.reasons, [
      "pool_event_mix_inconsistent_with_selector",
    ]);
  });

  it("keeps multicall opaque and external contracts excluded", () => {
    const opaque = assessActionCostCall(mark({
      selector: POSITION_MANAGER_SELECTORS.multicall,
    }), manager);
    assert.equal(opaque.status, "opaque");
    assert.deepEqual(opaque.reasons, ["multicall_inner_selectors_unobserved"]);

    const external = assessActionCostCall(mark({
      recipient: "0x1111111111111111111111111111111111111111",
      selector: "0x12345678" as Hex,
    }), manager);
    assert.equal(external.callFamily, "external_call");
    assert.equal(external.status, "excluded");
  });

  it("never upgrades an excluded source valuation", () => {
    const result = assessActionCostCall(mark({
      sourceReasons: ["eth_oracle_price_stale"],
      sourceStatus: "excluded",
      totalCostQuoteRaw: null,
    }), manager);
    assert.equal(result.status, "excluded");
    assert.ok(result.reasons.includes("source_valuation_unavailable"));
    assert.ok(result.reasons.includes("eth_oracle_price_stale"));
  });

  it("summarizes comparable costs separately by exact call family", () => {
    const mint = assessActionCostCall(mark(), manager);
    const expensiveMint = { ...mint, totalCostQuoteRaw: 5_000_000n };
    const opaque = assessActionCostCall(mark({
      selector: POSITION_MANAGER_SELECTORS.multicall,
    }), manager);
    const summary = summarizeActionCostCalls([mint, expensiveMint, opaque]);
    assert.equal(summary.comparableObservations, 2);
    assert.equal(summary.opaqueObservations, 1);
    assert.equal(
      summary.byCallFamily.position_manager_mint.totalCostQuoteRawP90,
      5_000_000n,
    );
    assert.equal(
      summary.byCallFamily.position_manager_multicall.totalCostQuoteRawP90,
      null,
    );
  });
});
