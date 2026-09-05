import type { OracleRiskSnapshot } from "../risk/domain.js";
import type { RiskBlock } from "../risk/reader.js";
import { convertWeiToQuoteRaw } from "../action-cost/valuation.js";
import type {
  ApprovalCostValuationMark,
  ApprovalCostValuationObservation,
  ApprovalCostValuationSummary,
  ApprovalCostValuationTokenSummary,
} from "./valuation-domain.js";

export function evaluateApprovalCostValuation(input: {
  readonly block: RiskBlock | null;
  readonly blockReadError?: string;
  readonly ethOracle: OracleRiskSnapshot | null;
  readonly observation: ApprovalCostValuationObservation;
  readonly quoteDecimals: number;
  readonly quoteOracle: OracleRiskSnapshot | null;
}): ApprovalCostValuationMark {
  const reasons: string[] = [];
  if (input.observation.sourceStatus !== "comparable") {
    reasons.push("approval_source_not_comparable", ...input.observation.sourceReasons);
  } else {
    if (input.block === null) {
      reasons.push("block_read_failed");
    } else if (
      input.block.number !== input.observation.blockNumber ||
      input.block.hash.toLowerCase() !== input.observation.blockHash.toLowerCase()
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
  }
  const uniqueReasons = [...new Set(reasons)];
  const valid = uniqueReasons.length === 0;
  const convert = (feeWei: bigint): bigint => {
    if (
      input.ethOracle?.state === null || input.ethOracle?.state === undefined ||
      input.quoteOracle?.state === null || input.quoteOracle?.state === undefined
    ) {
      throw new Error("Valid approval valuation is missing oracle state");
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
    blockHash: input.observation.blockHash,
    blockNumber: input.observation.blockNumber,
    blockReadError: input.observation.sourceStatus === "comparable" && input.block === null
      ? input.blockReadError ?? "Block read failed"
      : null,
    blockTimestamp: input.block?.timestamp ?? null,
    ethOracle: input.ethOracle,
    executionEligible: false,
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
    sourceStatus: input.observation.sourceStatus,
    status: valid ? "valid" : "excluded",
    tokenSymbols: input.observation.tokenSymbols,
    totalCostQuoteRaw: valid ? convert(input.observation.totalFeeWei) : null,
    totalFeeWei: input.observation.totalFeeWei,
    transactionHash: input.observation.transactionHash,
  };
}

function percentile(values: readonly bigint[], numerator: number): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return sorted[Math.ceil(sorted.length * numerator / 100) - 1]!;
}

export function summarizeApprovalCostValuations(
  marks: readonly ApprovalCostValuationMark[],
): ApprovalCostValuationSummary {
  const symbols = [...new Set(marks.flatMap((mark) => mark.tokenSymbols))].sort();
  const byToken = Object.fromEntries(symbols.map((symbol) => {
    const selected = marks.filter((mark) => mark.tokenSymbols.includes(symbol));
    const costs = selected.flatMap((mark) =>
      mark.totalCostQuoteRaw === null ? [] : [mark.totalCostQuoteRaw]
    );
    const summary: ApprovalCostValuationTokenSummary = {
      excludedObservations: selected.length - costs.length,
      totalCostQuoteRawP50: percentile(costs, 50),
      totalCostQuoteRawP90: percentile(costs, 90),
      validObservations: costs.length,
    };
    return [symbol, summary] as const;
  })) as Readonly<Record<string, ApprovalCostValuationTokenSummary>>;
  const validObservations = marks.filter((mark) => mark.status === "valid").length;
  return {
    byToken,
    excludedObservations: marks.length - validObservations,
    observations: marks.length,
    validObservations,
  };
}
