import type { Hash } from "viem";
import type { OracleRiskSnapshot } from "../risk/domain.js";
import type { RiskBlock } from "../risk/reader.js";
import type {
  ActionCostValuationClassSummary,
  ActionCostValuationMark,
  ActionCostValuationObservation,
  ActionCostValuationSummary,
} from "./valuation-domain.js";
import type { ActionCostClass } from "./domain.js";

const ACTION_CLASSES: readonly ActionCostClass[] = [
  "collect_bundle",
  "exit_bundle",
  "mint_bundle",
  "mixed",
  "rebalance_bundle",
  "swap_only",
];

function sameHash(left: Hash, right: Hash): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Cost conversion denominator must be positive");
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

export function convertWeiToQuoteRaw(input: {
  readonly ethUsdAnswer: bigint;
  readonly ethUsdDecimals: number;
  readonly feeWei: bigint;
  readonly quoteDecimals: number;
  readonly quoteUsdAnswer: bigint;
  readonly quoteUsdDecimals: number;
}): bigint {
  if (input.feeWei < 0n) throw new Error("Fee cannot be negative");
  if (input.ethUsdAnswer <= 0n || input.quoteUsdAnswer <= 0n) {
    throw new Error("Oracle answers must be positive");
  }
  for (const [name, value] of [
    ["ETH oracle", input.ethUsdDecimals],
    ["quote oracle", input.quoteUsdDecimals],
    ["quote token", input.quoteDecimals],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
      throw new Error(`${name} decimals are invalid`);
    }
  }
  const numerator = input.feeWei * input.ethUsdAnswer *
    10n ** BigInt(input.quoteUsdDecimals) * 10n ** BigInt(input.quoteDecimals);
  const denominator = 10n ** 18n * 10n ** BigInt(input.ethUsdDecimals) *
    input.quoteUsdAnswer;
  return ceilDivide(numerator, denominator);
}

export function evaluateActionCostValuation(input: {
  readonly block: RiskBlock | null;
  readonly blockReadError?: string;
  readonly ethOracle: OracleRiskSnapshot | null;
  readonly observation: ActionCostValuationObservation;
  readonly quoteDecimals: number;
  readonly quoteOracle: OracleRiskSnapshot | null;
}): ActionCostValuationMark {
  const reasons: string[] = [];
  if (input.block === null) {
    reasons.push("block_read_failed");
  } else if (
    input.block.number !== input.observation.blockNumber ||
    !sameHash(input.block.hash, input.observation.blockHash)
  ) {
    reasons.push("block_canonicality_mismatch");
  }
  if (input.ethOracle === null) {
    reasons.push("eth_oracle_unavailable");
  } else {
    reasons.push(...input.ethOracle.reasons.map((reason) => `eth_${reason}`));
  }
  if (input.quoteOracle === null) {
    reasons.push("quote_oracle_unavailable");
  } else {
    reasons.push(...input.quoteOracle.reasons.map((reason) => `quote_${reason}`));
  }
  const uniqueReasons = [...new Set(reasons)];
  const valid = uniqueReasons.length === 0;
  const convert = (feeWei: bigint): bigint => {
    if (
      input.ethOracle?.state === null || input.ethOracle?.state === undefined ||
      input.quoteOracle?.state === null || input.quoteOracle?.state === undefined
    ) {
      throw new Error("Valid valuation is missing oracle state");
    }
    return convertWeiToQuoteRaw({
      ethUsdAnswer: BigInt(input.ethOracle.state.answer),
      ethUsdDecimals: input.ethOracle.state.decimals,
      feeWei,
      quoteDecimals: input.quoteDecimals,
      quoteUsdAnswer: BigInt(input.quoteOracle.state.answer),
      quoteUsdDecimals: input.quoteOracle.state.decimals,
    });
  };
  return {
    actionClass: input.observation.actionClass,
    blockHash: input.observation.blockHash,
    blockNumber: input.observation.blockNumber,
    blockReadError: input.block === null
      ? input.blockReadError ?? "Block read failed"
      : null,
    blockTimestamp: input.block?.timestamp ?? null,
    ethOracle: input.ethOracle,
    executionEligible: false,
    feeComponentsComplete: input.observation.feeComponentsComplete,
    l1DataCostQuoteRaw: valid && input.observation.l1DataFeeWei !== null
      ? convert(input.observation.l1DataFeeWei)
      : null,
    l1DataFeeWei: input.observation.l1DataFeeWei,
    l2ExecutionCostQuoteRaw: valid && input.observation.l2ExecutionFeeWei !== null
      ? convert(input.observation.l2ExecutionFeeWei)
      : null,
    l2ExecutionFeeWei: input.observation.l2ExecutionFeeWei,
    quoteOracle: input.quoteOracle,
    reasons: uniqueReasons,
    status: valid ? "valid" : "excluded",
    streamKey: input.observation.streamKey,
    totalCostQuoteRaw: valid ? convert(input.observation.totalFeeWei) : null,
    totalFeeWei: input.observation.totalFeeWei,
    transactionHash: input.observation.transactionHash,
  };
}

function percentile(values: readonly bigint[], numerator: number): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const rank = Math.ceil(values.length * numerator / 100) - 1;
  return sorted[Math.max(0, rank)]!;
}

export function summarizeActionCostValuations(
  marks: readonly ActionCostValuationMark[],
): ActionCostValuationSummary {
  const entries = ACTION_CLASSES.map((actionClass) => {
    const selected = marks.filter((mark) => mark.actionClass === actionClass);
    const costs = selected.flatMap((mark) =>
      mark.totalCostQuoteRaw === null ? [] : [mark.totalCostQuoteRaw]
    );
    const summary: ActionCostValuationClassSummary = {
      excludedObservations: selected.length - costs.length,
      totalCostQuoteRawMax: percentile(costs, 100),
      totalCostQuoteRawP50: percentile(costs, 50),
      totalCostQuoteRawP90: percentile(costs, 90),
      validObservations: costs.length,
    };
    return [actionClass, summary] as const;
  });
  const validObservations = marks.filter((mark) => mark.status === "valid").length;
  return {
    byClass: Object.fromEntries(entries) as Readonly<
      Record<ActionCostClass, ActionCostValuationClassSummary>
    >,
    completeFeeComponents: marks.filter((mark) =>
      mark.status === "valid" && mark.feeComponentsComplete
    ).length,
    excludedObservations: marks.length - validObservations,
    observations: marks.length,
    validObservations,
  };
}
