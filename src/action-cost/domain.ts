import type { Address, Hash, Hex } from "viem";

export type ActionCostClass =
  | "collect_bundle"
  | "exit_bundle"
  | "mint_bundle"
  | "mixed"
  | "rebalance_bundle"
  | "swap_only";

export interface ActionCostCandidate {
  readonly actionClass: ActionCostClass;
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly chainId: number;
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly poolAddresses: readonly Address[];
  readonly transactionHash: Hash;
  readonly transactionIndex: number;
}

export interface ActionCostSource {
  readonly candidates: readonly ActionCostCandidate[];
  readonly chainId: number;
  readonly eligibleCandidates: number;
  readonly fromBlock: bigint;
  readonly streamKey: string;
  readonly targetSetHash: Hash;
  readonly toBlock: bigint;
  readonly toBlockHash: Hash;
}

export interface RawActionTransaction {
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly chainId: number;
  readonly effectiveGasPrice: bigint;
  readonly from: Address;
  readonly gasUsed: bigint;
  readonly gasUsedForL1: bigint | null;
  readonly input: Hex;
  readonly status: "success" | "reverted";
  readonly to: Address | null;
  readonly transactionHash: Hash;
  readonly transactionIndex: number;
}

export interface ActionCostObservation {
  /** Present on new observations; older stored snapshots retain their original shape. */
  readonly input?: Hex;
  readonly sourceProvider?: "legacy" | "envio" | "hypersync";
  readonly actionClass: ActionCostClass;
  readonly actionNames: readonly string[];
  readonly attribution: "whole_transaction_action_mix";
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly chainId: number;
  readonly effectiveGasPrice: bigint;
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly executionEligible: false;
  readonly feeComponentsComplete: boolean;
  readonly from: Address;
  readonly gasUsed: bigint;
  readonly gasUsedForL1: bigint | null;
  readonly inputBytes: number;
  readonly l1DataFeeWei: bigint | null;
  readonly l2ExecutionFeeWei: bigint | null;
  readonly l2ExecutionGasUsed: bigint | null;
  readonly observedAt: string;
  readonly poolAddresses: readonly Address[];
  readonly schemaVersion: 1;
  readonly selector: Hex | null;
  readonly streamKey: string;
  readonly to: Address | null;
  readonly totalFeeWei: bigint;
  readonly transactionHash: Hash;
  readonly transactionIndex: number;
}

export interface ActionCostRunSummary {
  readonly byClass: Readonly<Record<ActionCostClass, ActionCostClassSummary>>;
  readonly completeFeeComponents: number;
  readonly observations: number;
}

export interface ActionCostClassSummary {
  readonly completeFeeComponents: number;
  readonly gasUsedP50: bigint | null;
  readonly gasUsedP90: bigint | null;
  readonly l1DataFeeWeiP50: bigint | null;
  readonly l1DataFeeWeiP90: bigint | null;
  readonly observations: number;
  readonly totalFeeWeiMax: bigint | null;
  readonly totalFeeWeiMin: bigint | null;
  readonly totalFeeWeiP50: bigint | null;
  readonly totalFeeWeiP90: bigint | null;
}

export interface ActionCostRun {
  readonly capturedAt: string;
  readonly executionEligible: false;
  readonly maxPerClass: number;
  readonly methodology: "stratified_canonical_receipt_cost_v1";
  readonly observations: readonly ActionCostObservation[];
  readonly schemaVersion: 1;
  readonly source: ActionCostSource;
  readonly summary: ActionCostRunSummary;
}
