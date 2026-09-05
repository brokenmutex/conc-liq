import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, type Address, type Hash, type Hex } from "viem";
import type { RawActionTransaction } from "../src/action-cost/domain.js";
import type {
  ApprovalCostCandidate,
  IndexedApprovalEvent,
} from "../src/approval-cost/domain.js";
import {
  erc20ApproveAbi,
  evaluateApprovalCost,
  summarizeApprovalCosts,
} from "../src/approval-cost/evaluate.js";
import {
  groupApprovalEvents,
  selectApprovalCandidates,
} from "../src/approval-cost/reader.js";

const owner = "0x1111111111111111111111111111111111111111" as Address;
const manager = "0x73991a25c818bf1f1128deaab1492d45638de0d3" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const transactionHash = `0x${"33".repeat(32)}` as Hash;
const blockHash = `0x${"44".repeat(32)}` as Hash;

function event(overrides: Partial<IndexedApprovalEvent> = {}): IndexedApprovalEvent {
  return {
    blockHash,
    blockNumber: 100n,
    logIndex: 1,
    owner,
    spender: manager,
    tokenAddress: token,
    tokenSymbol: "TEST",
    transactionHash,
    transactionIndex: 2,
    value: 1_000n,
    ...overrides,
  };
}

function candidate(approvals: readonly IndexedApprovalEvent[] = [event()]): ApprovalCostCandidate {
  return {
    approvals,
    blockHash,
    blockNumber: 100n,
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
    from: owner,
    gasUsed: 50_000n,
    gasUsedForL1: 10_000n,
    input: encodeFunctionData({
      abi: erc20ApproveAbi,
      args: [manager, 1_000n],
      functionName: "approve",
    }),
    status: "success",
    to: token,
    transactionHash,
    transactionIndex: 2,
    ...overrides,
  };
}

const allowance = {
  after: 1_000n,
  afterReadError: null,
  before: 0n,
  beforeReadError: null,
};

describe("approval-cost evaluation", () => {
  it("accepts a proven direct zero-to-nonzero Position Manager approval", () => {
    const observation = evaluateApprovalCost({
      allowance,
      candidate: candidate(),
      observedAt: "2026-09-05T12:00:00.000Z",
      positionManager: manager,
      raw: raw(),
    });
    assert.equal(observation.status, "comparable");
    assert.equal(observation.allowanceTransition, "zero_to_nonzero");
    assert.equal(observation.totalFeeWei, 100_000n);
    assert.equal(observation.l1DataFeeWei, 20_000n);
    assert.equal(observation.l2ExecutionFeeWei, 80_000n);
    assert.deepEqual(observation.reasons, []);
    assert.equal(observation.executionEligible, false);
  });

  it("excludes replacements, resets, indirect calls, and state mismatches", () => {
    const replacement = evaluateApprovalCost({
      allowance: { ...allowance, before: 500n },
      candidate: candidate(),
      observedAt: "2026-09-05T12:00:00.000Z",
      positionManager: manager,
      raw: raw(),
    });
    assert.equal(replacement.status, "excluded");
    assert.ok(replacement.reasons.includes(
      "approval_transition_not_initial:nonzero_to_nonzero",
    ));

    const indirect = evaluateApprovalCost({
      allowance,
      candidate: candidate(),
      observedAt: "2026-09-05T12:00:00.000Z",
      positionManager: manager,
      raw: raw({ input: "0x12345678" as Hex }),
    });
    assert.equal(indirect.status, "excluded");
    assert.ok(indirect.reasons.includes("transaction_not_direct_approve"));

    const mismatch = evaluateApprovalCost({
      allowance: { ...allowance, after: 999n },
      candidate: candidate(),
      observedAt: "2026-09-05T12:00:00.000Z",
      positionManager: manager,
      raw: raw(),
    });
    assert.ok(mismatch.reasons.includes("allowance_after_mismatch"));
  });

  it("rejects receipt inclusion mismatches", () => {
    assert.throws(() => evaluateApprovalCost({
      allowance,
      candidate: candidate(),
      observedAt: "2026-09-05T12:00:00.000Z",
      positionManager: manager,
      raw: raw({ blockNumber: 101n }),
    }), /source mismatch/);
  });

  it("groups transactions and caps recent candidates per token", () => {
    const newerHash = `0x${"55".repeat(32)}` as Hash;
    const candidates = groupApprovalEvents([
      event(),
      event({ logIndex: 2 }),
      event({ blockNumber: 101n, transactionHash: newerHash }),
    ]);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0]?.transactionHash, newerHash);
    assert.equal(candidates[1]?.approvals.length, 2);
    assert.equal(selectApprovalCandidates(candidates, 1).length, 1);
  });

  it("summarizes only comparable direct initial approvals", () => {
    const comparable = evaluateApprovalCost({
      allowance,
      candidate: candidate(),
      observedAt: "2026-09-05T12:00:00.000Z",
      positionManager: manager,
      raw: raw(),
    });
    const excluded = evaluateApprovalCost({
      allowance: { ...allowance, before: 1n },
      candidate: candidate(),
      observedAt: "2026-09-05T12:00:00.000Z",
      positionManager: manager,
      raw: raw(),
    });
    const summary = summarizeApprovalCosts(
      [comparable, excluded],
      new Map([[token.toLowerCase(), "TEST"]]),
    );
    assert.equal(summary.comparableObservations, 1);
    assert.equal(summary.excludedObservations, 1);
    assert.equal(summary.byToken.TEST?.gasUsedP90, 50_000n);
  });
});
