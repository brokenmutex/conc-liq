import { getAddress, type Hex } from "viem";
import type {
  ActionCostCandidate,
  ActionCostClass,
  ActionCostClassSummary,
  ActionCostObservation,
  ActionCostRunSummary,
  RawActionTransaction,
} from "./domain.js";

const ACTION_CLASSES: readonly ActionCostClass[] = [
  "collect_bundle",
  "exit_bundle",
  "mint_bundle",
  "mixed",
  "rebalance_bundle",
  "swap_only",
];

export function classifyActionMix(
  eventCounts: Readonly<Record<string, number>>,
): ActionCostClass {
  const mint = (eventCounts.Mint ?? 0) > 0;
  const burn = (eventCounts.Burn ?? 0) > 0;
  const collect = (eventCounts.Collect ?? 0) > 0;
  const swap = (eventCounts.Swap ?? 0) > 0;
  const recognized = new Set(["Mint", "Burn", "Collect", "Swap"]);
  const hasOther = Object.entries(eventCounts).some(
    ([name, count]) => count > 0 && !recognized.has(name),
  );
  if (hasOther) return "mixed";
  if (mint && burn) return "rebalance_bundle";
  if (burn) return "exit_bundle";
  if (mint) return "mint_bundle";
  if (collect) return "collect_bundle";
  if (swap) return "swap_only";
  return "mixed";
}

function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function evaluateActionCost(input: {
  readonly candidate: ActionCostCandidate;
  readonly observedAt: string;
  readonly raw: RawActionTransaction;
  readonly streamKey: string;
}): ActionCostObservation {
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error("Action-cost observation timestamp is invalid");
  }
  if (
    !sameHash(input.raw.transactionHash, input.candidate.transactionHash) ||
    input.raw.chainId !== input.candidate.chainId ||
    input.raw.blockNumber !== input.candidate.blockNumber ||
    !sameHash(input.raw.blockHash, input.candidate.blockHash) ||
    input.raw.transactionIndex !== input.candidate.transactionIndex
  ) {
    throw new Error(
      `Action-cost receipt source mismatch for ${input.candidate.transactionHash}`,
    );
  }
  if (input.raw.status !== "success") {
    throw new Error(
      `Indexed action transaction reverted: ${input.candidate.transactionHash}`,
    );
  }
  if (
    input.raw.gasUsedForL1 !== null &&
    input.raw.gasUsedForL1 > input.raw.gasUsed
  ) {
    throw new Error("Receipt gasUsedForL1 exceeds total gasUsed");
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
  const inputBytes = (input.raw.input.length - 2) / 2;
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) {
    throw new Error("Transaction input byte length is invalid");
  }
  const selector = inputBytes >= 4
    ? input.raw.input.slice(0, 10) as Hex
    : null;
  const actionNames = Object.entries(input.candidate.eventCounts)
    .filter(([, count]) => count > 0)
    .map(([name]) => name)
    .sort();
  return {
    actionClass: input.candidate.actionClass,
    actionNames,
    attribution: "whole_transaction_action_mix",
    blockHash: input.raw.blockHash,
    blockNumber: input.raw.blockNumber,
    chainId: input.raw.chainId,
    effectiveGasPrice: input.raw.effectiveGasPrice,
    eventCounts: input.candidate.eventCounts,
    executionEligible: false,
    feeComponentsComplete: input.raw.gasUsedForL1 !== null,
    from: getAddress(input.raw.from),
    gasUsed: input.raw.gasUsed,
    gasUsedForL1: input.raw.gasUsedForL1,
    input: input.raw.input,
    inputBytes,
    l1DataFeeWei,
    l2ExecutionFeeWei,
    l2ExecutionGasUsed,
    observedAt: input.observedAt,
    poolAddresses: input.candidate.poolAddresses.map(getAddress),
    schemaVersion: 1,
    selector,
    streamKey: input.streamKey,
    to: input.raw.to === null ? null : getAddress(input.raw.to),
    totalFeeWei,
    transactionHash: input.raw.transactionHash,
    transactionIndex: input.raw.transactionIndex,
  };
}

export function summarizeActionCosts(
  observations: readonly ActionCostObservation[],
): ActionCostRunSummary {
  function percentile(values: readonly bigint[], numerator: number): bigint | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const index = Math.ceil(sorted.length * numerator / 100) - 1;
    return sorted[index]!;
  }
  function classSummary(
    entries: readonly ActionCostObservation[],
  ): ActionCostClassSummary {
    const complete = entries.filter((entry) => entry.feeComponentsComplete);
    const gasUsed = entries.map((entry) => entry.gasUsed);
    const totalFees = entries.map((entry) => entry.totalFeeWei);
    const l1Fees = complete.map((entry) => entry.l1DataFeeWei!);
    return {
      completeFeeComponents: complete.length,
      gasUsedP50: percentile(gasUsed, 50),
      gasUsedP90: percentile(gasUsed, 90),
      l1DataFeeWeiP50: percentile(l1Fees, 50),
      l1DataFeeWeiP90: percentile(l1Fees, 90),
      observations: entries.length,
      totalFeeWeiMax: totalFees.length === 0 ? null : percentile(totalFees, 100),
      totalFeeWeiMin: totalFees.length === 0
        ? null
        : [...totalFees].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)[0]!,
      totalFeeWeiP50: percentile(totalFees, 50),
      totalFeeWeiP90: percentile(totalFees, 90),
    };
  }
  const byClass = Object.fromEntries(ACTION_CLASSES.map((actionClass) => [
    actionClass,
    classSummary(observations.filter((entry) => entry.actionClass === actionClass)),
  ])) as Record<ActionCostClass, ActionCostClassSummary>;
  let completeFeeComponents = 0;
  for (const observation of observations) {
    if (observation.feeComponentsComplete) completeFeeComponents += 1;
  }
  return {
    byClass,
    completeFeeComponents,
    observations: observations.length,
  };
}
