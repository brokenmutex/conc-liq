import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address, Hash, Hex } from "viem";
import type { ActionCostCandidate, RawActionTransaction } from "../src/action-cost/domain.js";
import {
  classifyActionMix,
  evaluateActionCost,
  summarizeActionCosts,
} from "../src/action-cost/evaluate.js";
import { JsonRpcActionCostReader } from "../src/action-cost/reader.js";

const transactionHash = `0x${"11".repeat(32)}` as Hash;
const blockHash = `0x${"22".repeat(32)}` as Hash;
const sender = "0x1111111111111111111111111111111111111111" as Address;
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const pool = "0x3333333333333333333333333333333333333333" as Address;

function candidate(
  eventCounts: Readonly<Record<string, number>> = {
    Burn: 1,
    Collect: 1,
    Mint: 1,
    Swap: 1,
  },
): ActionCostCandidate {
  return {
    actionClass: classifyActionMix(eventCounts),
    blockHash,
    blockNumber: 100n,
    chainId: 4663,
    eventCounts,
    poolAddresses: [pool],
    transactionHash,
    transactionIndex: 2,
  };
}

function raw(overrides: Partial<RawActionTransaction> = {}): RawActionTransaction {
  return {
    blockHash,
    blockNumber: 100n,
    chainId: 4663,
    effectiveGasPrice: 2n,
    from: sender,
    gasUsed: 100n,
    gasUsedForL1: 25n,
    input: "0x12345678aabb" as Hex,
    status: "success",
    to: recipient,
    transactionHash,
    transactionIndex: 2,
    ...overrides,
  };
}

describe("action-cost classification", () => {
  it("labels whole transaction action mixes without single-event attribution", () => {
    assert.equal(classifyActionMix({ Swap: 2 }), "swap_only");
    assert.equal(classifyActionMix({ Mint: 1 }), "mint_bundle");
    assert.equal(classifyActionMix({ Burn: 1, Collect: 1 }), "exit_bundle");
    assert.equal(
      classifyActionMix({ Burn: 1, Collect: 1, Mint: 1, Swap: 1 }),
      "rebalance_bundle",
    );
    assert.equal(classifyActionMix({ Collect: 1 }), "collect_bundle");
    assert.equal(classifyActionMix({ Flash: 1, Swap: 1 }), "mixed");
  });
});

describe("action-cost receipt evaluation", () => {
  it("splits exact receipt fees into parent-data and child-execution components", () => {
    const observation = evaluateActionCost({
      candidate: candidate(),
      observedAt: "2026-09-04T17:00:00.000Z",
      raw: raw(),
      streamKey: "stream",
    });
    assert.equal(observation.actionClass, "rebalance_bundle");
    assert.equal(observation.attribution, "whole_transaction_action_mix");
    assert.equal(observation.totalFeeWei, 200n);
    assert.equal(observation.l1DataFeeWei, 50n);
    assert.equal(observation.l2ExecutionGasUsed, 75n);
    assert.equal(observation.l2ExecutionFeeWei, 150n);
    assert.equal(observation.inputBytes, 6);
    assert.equal(observation.selector, "0x12345678");
    assert.equal(observation.executionEligible, false);
  });

  it("retains total fee but marks an absent L1 component incomplete", () => {
    const observation = evaluateActionCost({
      candidate: candidate({ Swap: 1 }),
      observedAt: "2026-09-04T17:00:00.000Z",
      raw: raw({ gasUsedForL1: null }),
      streamKey: "stream",
    });
    assert.equal(observation.totalFeeWei, 200n);
    assert.equal(observation.feeComponentsComplete, false);
    assert.equal(observation.l1DataFeeWei, null);
    assert.equal(observation.l2ExecutionFeeWei, null);
  });

  it("rejects reverted, mismatched, and arithmetically invalid receipts", () => {
    const input = {
      candidate: candidate(),
      observedAt: "2026-09-04T17:00:00.000Z",
      streamKey: "stream",
    };
    assert.throws(() => evaluateActionCost({
      ...input,
      raw: raw({ status: "reverted" }),
    }), /reverted/);
    assert.throws(() => evaluateActionCost({
      ...input,
      raw: raw({ blockNumber: 101n }),
    }), /source mismatch/);
    assert.throws(() => evaluateActionCost({
      ...input,
      raw: raw({ gasUsedForL1: 101n }),
    }), /exceeds total/);
  });

  it("summarizes stratified observations", () => {
    const observations = [candidate({ Swap: 1 }), candidate({ Mint: 1 })].map(
      (source) => evaluateActionCost({
        candidate: source,
        observedAt: "2026-09-04T17:00:00.000Z",
        raw: raw(),
        streamKey: "stream",
      }),
    );
    const summary = summarizeActionCosts(observations);
    assert.equal(summary.observations, 2);
    assert.equal(summary.completeFeeComponents, 2);
    assert.equal(summary.byClass.swap_only.observations, 1);
    assert.equal(summary.byClass.swap_only.totalFeeWeiP90, 200n);
    assert.equal(summary.byClass.mint_bundle.observations, 1);
    assert.equal(summary.byClass.collect_bundle.observations, 0);
    assert.equal(summary.byClass.collect_bundle.totalFeeWeiP50, null);
  });
});

describe("action-cost JSON-RPC reader", () => {
  it("parses Nitro gasUsedForL1 from a batch response and checks the gate", async () => {
    const originalFetch = globalThis.fetch;
    let gateChecks = 0;
    globalThis.fetch = async () => new Response(JSON.stringify([
      {
        id: 2,
        jsonrpc: "2.0",
        result: {
          blockHash,
          blockNumber: "0x64",
          effectiveGasPrice: "0x2",
          gasUsed: "0x64",
          gasUsedForL1: "0x19",
          status: "0x1",
          transactionHash,
          transactionIndex: "0x2",
        },
      },
      {
        id: 1,
        jsonrpc: "2.0",
        result: {
          blockHash,
          blockNumber: "0x64",
          chainId: "0x1237",
          from: sender,
          hash: transactionHash,
          input: "0x12345678",
          to: recipient,
          transactionIndex: "0x2",
        },
      },
    ]));
    try {
      const reader = new JsonRpcActionCostReader({
        gate: {
          async assertBulkAllowed() {
            gateChecks += 1;
            return null;
          },
        },
        rpcUrl: "http://private.invalid",
        timeoutMs: 1_000,
      });
      const result = await reader.read(transactionHash);
      assert.equal(gateChecks, 1);
      assert.equal(result.gasUsed, 100n);
      assert.equal(result.gasUsedForL1, 25n);
      assert.equal(result.chainId, 4663);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
