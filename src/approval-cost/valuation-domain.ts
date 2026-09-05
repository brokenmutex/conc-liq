import type { Hash } from "viem";
import type { OracleFeedMetadata, OracleRiskSnapshot, SourceEvidence } from "../risk/domain.js";

export interface ApprovalCostValuationObservation {
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly l1DataFeeWei: bigint | null;
  readonly l2ExecutionFeeWei: bigint | null;
  readonly sourceReasons: readonly string[];
  readonly sourceStatus: "comparable" | "excluded";
  readonly tokenSymbols: readonly string[];
  readonly totalFeeWei: bigint;
  readonly transactionHash: Hash;
}

export interface ApprovalCostValuationSource {
  readonly approvalCostRunId: string;
  readonly chainId: number;
  readonly observations: readonly ApprovalCostValuationObservation[];
  readonly streamKey: string;
}

export interface ApprovalCostValuationMark {
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly blockReadError: string | null;
  readonly blockTimestamp: bigint | null;
  readonly ethOracle: OracleRiskSnapshot | null;
  readonly executionEligible: false;
  readonly l1DataCostQuoteRaw: bigint | null;
  readonly l1DataFeeWei: bigint | null;
  readonly l2ExecutionCostQuoteRaw: bigint | null;
  readonly l2ExecutionFeeWei: bigint | null;
  readonly quoteOracle: OracleRiskSnapshot | null;
  readonly reasons: readonly string[];
  readonly sourceStatus: "comparable" | "excluded";
  readonly status: "valid" | "excluded";
  readonly tokenSymbols: readonly string[];
  readonly totalCostQuoteRaw: bigint | null;
  readonly totalFeeWei: bigint;
  readonly transactionHash: Hash;
}

export interface ApprovalCostValuationTokenSummary {
  readonly excludedObservations: number;
  readonly totalCostQuoteRawP50: bigint | null;
  readonly totalCostQuoteRawP90: bigint | null;
  readonly validObservations: number;
}

export interface ApprovalCostValuationSummary {
  readonly byToken: Readonly<Record<string, ApprovalCostValuationTokenSummary>>;
  readonly excludedObservations: number;
  readonly observations: number;
  readonly validObservations: number;
}

export interface ApprovalCostValuationRun {
  readonly computedAt: string;
  readonly ethFeed: OracleFeedMetadata;
  readonly executionEligible: false;
  readonly feedDirectory: SourceEvidence;
  readonly marks: readonly ApprovalCostValuationMark[];
  readonly maxPriceAgeSeconds: number;
  readonly methodology: "block_pinned_eth_usdg_approval_cost_v1";
  readonly quoteDecimals: 6;
  readonly quoteFeed: OracleFeedMetadata;
  readonly schemaVersion: 1;
  readonly source: ApprovalCostValuationSource;
  readonly summary: ApprovalCostValuationSummary;
}
