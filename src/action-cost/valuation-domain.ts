import type { Hash } from "viem";
import type { OracleFeedMetadata, OracleRiskSnapshot, SourceEvidence } from "../risk/domain.js";
import type { ActionCostClass } from "./domain.js";

export interface ActionCostValuationObservation {
  readonly actionClass: ActionCostClass;
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly feeComponentsComplete: boolean;
  readonly l1DataFeeWei: bigint | null;
  readonly l2ExecutionFeeWei: bigint | null;
  readonly streamKey: string;
  readonly totalFeeWei: bigint;
  readonly transactionHash: Hash;
}

export interface ActionCostValuationSource {
  readonly actionCostRunId: string;
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly observations: readonly ActionCostValuationObservation[];
  readonly streamKey: string;
  readonly toBlock: bigint;
  readonly toBlockHash: Hash;
}

export interface ActionCostValuationMark {
  readonly actionClass: ActionCostClass;
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly blockReadError: string | null;
  readonly blockTimestamp: bigint | null;
  readonly ethOracle: OracleRiskSnapshot | null;
  readonly executionEligible: false;
  readonly feeComponentsComplete: boolean;
  readonly l1DataCostQuoteRaw: bigint | null;
  readonly l1DataFeeWei: bigint | null;
  readonly l2ExecutionCostQuoteRaw: bigint | null;
  readonly l2ExecutionFeeWei: bigint | null;
  readonly quoteOracle: OracleRiskSnapshot | null;
  readonly reasons: readonly string[];
  readonly status: "valid" | "excluded";
  readonly streamKey: string;
  readonly totalCostQuoteRaw: bigint | null;
  readonly totalFeeWei: bigint;
  readonly transactionHash: Hash;
}

export interface ActionCostValuationClassSummary {
  readonly excludedObservations: number;
  readonly totalCostQuoteRawMax: bigint | null;
  readonly totalCostQuoteRawP50: bigint | null;
  readonly totalCostQuoteRawP90: bigint | null;
  readonly validObservations: number;
}

export interface ActionCostValuationSummary {
  readonly byClass: Readonly<Record<ActionCostClass, ActionCostValuationClassSummary>>;
  readonly completeFeeComponents: number;
  readonly excludedObservations: number;
  readonly observations: number;
  readonly validObservations: number;
}

export interface ActionCostValuationRun {
  readonly computedAt: string;
  readonly ethFeed: OracleFeedMetadata;
  readonly executionEligible: false;
  readonly feedDirectory: SourceEvidence;
  readonly marks: readonly ActionCostValuationMark[];
  readonly maxPriceAgeSeconds: number;
  readonly methodology: "block_pinned_eth_usdg_action_cost_v1";
  readonly quoteDecimals: 6;
  readonly quoteFeed: OracleFeedMetadata;
  readonly schemaVersion: 1;
  readonly source: ActionCostValuationSource;
  readonly summary: ActionCostValuationSummary;
}
