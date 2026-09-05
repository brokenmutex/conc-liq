import {
  decodeFunctionData,
  getAddress,
  isAddressEqual,
  type Hex,
  type Address,
} from "viem";
import type { RawActionTransaction } from "../action-cost/domain.js";
import type {
  AllowanceTransition,
  ApprovalAllowanceState,
  ApprovalCostCandidate,
  ApprovalCostObservation,
  ApprovalCostSummary,
  ApprovalCostTokenSummary,
} from "./domain.js";

export const erc20ApproveAbi = [{
  inputs: [
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  name: "approve",
  outputs: [{ name: "", type: "bool" }],
  stateMutability: "nonpayable",
  type: "function",
}] as const;

function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function transition(before: bigint, after: bigint): AllowanceTransition {
  if (after === 0n) return before === 0n ? "zero_to_zero" : "to_zero";
  return before === 0n ? "zero_to_nonzero" : "nonzero_to_nonzero";
}

function selector(input: Hex): Hex | null {
  return input.length >= 10 ? input.slice(0, 10) as Hex : null;
}

export function evaluateApprovalCost(input: {
  readonly allowance: ApprovalAllowanceState;
  readonly candidate: ApprovalCostCandidate;
  readonly observedAt: string;
  readonly positionManager: Address;
  readonly raw: RawActionTransaction;
}): ApprovalCostObservation {
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error("Approval-cost observation timestamp is invalid");
  }
  if (
    !sameHash(input.raw.transactionHash, input.candidate.transactionHash) ||
    input.raw.blockNumber !== input.candidate.blockNumber ||
    !sameHash(input.raw.blockHash, input.candidate.blockHash) ||
    input.raw.transactionIndex !== input.candidate.transactionIndex
  ) {
    throw new Error(`Approval receipt source mismatch for ${input.candidate.transactionHash}`);
  }
  if (input.raw.status !== "success") {
    throw new Error(`Indexed approval transaction reverted: ${input.candidate.transactionHash}`);
  }
  if (input.raw.gasUsedForL1 !== null && input.raw.gasUsedForL1 > input.raw.gasUsed) {
    throw new Error("Receipt gasUsedForL1 exceeds total gasUsed");
  }
  const reasons: string[] = [];
  const approval = input.candidate.approvals.length === 1
    ? input.candidate.approvals[0]!
    : null;
  if (approval === null) reasons.push("multiple_approval_events_in_transaction");

  let decodedSpender = null;
  let decodedValue = null;
  try {
    const decoded = decodeFunctionData({ abi: erc20ApproveAbi, data: input.raw.input });
    decodedSpender = getAddress(decoded.args[0]);
    decodedValue = decoded.args[1];
  } catch {
    reasons.push("transaction_not_direct_approve");
  }
  if (
    approval !== null &&
    (input.raw.to === null || !isAddressEqual(input.raw.to, approval.tokenAddress))
  ) {
    reasons.push("recipient_not_approval_token");
  }
  if (approval !== null && !isAddressEqual(input.raw.from, approval.owner)) {
    reasons.push("approval_owner_mismatch");
  }
  if (
    approval !== null && decodedSpender !== null &&
    !isAddressEqual(decodedSpender, approval.spender)
  ) {
    reasons.push("approval_spender_mismatch");
  }
  if (approval !== null && decodedValue !== null && decodedValue !== approval.value) {
    reasons.push("approval_value_mismatch");
  }
  if (
    decodedSpender !== null && !isAddressEqual(decodedSpender, input.positionManager)
  ) {
    reasons.push("spender_not_position_manager");
  }
  if (input.allowance.before === null) {
    reasons.push("allowance_before_unavailable");
  }
  if (input.allowance.after === null) {
    reasons.push("allowance_after_unavailable");
  }
  if (
    decodedValue !== null && input.allowance.after !== null &&
    input.allowance.after !== decodedValue
  ) {
    reasons.push("allowance_after_mismatch");
  }
  const allowanceTransition = input.allowance.before === null ||
      input.allowance.after === null
    ? null
    : transition(input.allowance.before, input.allowance.after);
  if (allowanceTransition !== null && allowanceTransition !== "zero_to_nonzero") {
    reasons.push(`approval_transition_not_initial:${allowanceTransition}`);
  }
  const totalFeeWei = input.raw.gasUsed * input.raw.effectiveGasPrice;
  const l1DataFeeWei = input.raw.gasUsedForL1 === null
    ? null
    : input.raw.gasUsedForL1 * input.raw.effectiveGasPrice;
  const l2ExecutionGasUsed = input.raw.gasUsedForL1 === null
    ? null
    : input.raw.gasUsed - input.raw.gasUsedForL1;
  const l2ExecutionFeeWei = l1DataFeeWei === null
    ? null
    : totalFeeWei - l1DataFeeWei;
  const uniqueReasons = [...new Set(reasons)];
  return {
    allowanceAfter: input.allowance.after,
    allowanceAfterReadError: input.allowance.afterReadError,
    allowanceBefore: input.allowance.before,
    allowanceBeforeReadError: input.allowance.beforeReadError,
    allowanceTransition,
    approvedValue: decodedValue,
    approvals: input.candidate.approvals,
    attribution: "whole_direct_approval_transaction",
    blockHash: input.raw.blockHash,
    blockNumber: input.raw.blockNumber,
    effectiveGasPrice: input.raw.effectiveGasPrice,
    executionEligible: false,
    feeComponentsComplete: input.raw.gasUsedForL1 !== null,
    gasUsed: input.raw.gasUsed,
    gasUsedForL1: input.raw.gasUsedForL1,
    l1DataFeeWei,
    l2ExecutionFeeWei,
    l2ExecutionGasUsed,
    observedAt: input.observedAt,
    owner: approval?.owner ?? null,
    reasons: uniqueReasons,
    recipient: input.raw.to,
    selector: selector(input.raw.input),
    spender: decodedSpender,
    status: uniqueReasons.length === 0 ? "comparable" : "excluded",
    tokenAddresses: [...new Set(input.candidate.approvals.map((entry) =>
      getAddress(entry.tokenAddress)
    ))],
    totalFeeWei,
    transactionHash: input.raw.transactionHash,
    transactionIndex: input.raw.transactionIndex,
  };
}

function percentile(values: readonly bigint[], numerator: number): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return sorted[Math.ceil(sorted.length * numerator / 100) - 1]!;
}

export function summarizeApprovalCosts(
  observations: readonly ApprovalCostObservation[],
  symbolsByAddress: ReadonlyMap<string, string>,
): ApprovalCostSummary {
  const symbols = [...new Set(symbolsByAddress.values())].sort();
  const byToken = Object.fromEntries(symbols.map((symbol) => {
    const selected = observations.filter((entry) => entry.approvals.some((approval) =>
      approval.tokenSymbol === symbol
    ));
    const comparable = selected.filter((entry) => entry.status === "comparable");
    const summary: ApprovalCostTokenSummary = {
      comparableObservations: comparable.length,
      excludedObservations: selected.length - comparable.length,
      gasUsedP50: percentile(comparable.map((entry) => entry.gasUsed), 50),
      gasUsedP90: percentile(comparable.map((entry) => entry.gasUsed), 90),
      totalFeeWeiP50: percentile(comparable.map((entry) => entry.totalFeeWei), 50),
      totalFeeWeiP90: percentile(comparable.map((entry) => entry.totalFeeWei), 90),
    };
    return [symbol, summary] as const;
  })) as Readonly<Record<string, ApprovalCostTokenSummary>>;
  const comparableObservations = observations.filter((entry) =>
    entry.status === "comparable"
  ).length;
  return {
    byToken,
    comparableObservations,
    excludedObservations: observations.length - comparableObservations,
    observations: observations.length,
  };
}
