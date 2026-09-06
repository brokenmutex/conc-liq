import type { Address, Hash, Hex } from "viem";
import type { RawActionTransaction } from "../action-cost/domain.js";

export interface ApprovalTokenTarget {
  readonly address: Address;
  readonly symbol: string;
}

export interface IndexedApprovalEvent {
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly owner: Address;
  readonly spender: Address;
  readonly tokenAddress: Address;
  readonly tokenSymbol: string;
  readonly transactionHash: Hash;
  readonly transactionIndex: number;
  readonly value: bigint;
}

export interface ApprovalCostCandidate {
  readonly approvals: readonly IndexedApprovalEvent[];
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly transactionHash: Hash;
  readonly transactionIndex: number;
}

export interface ApprovalCostSource {
  readonly candidates: readonly ApprovalCostCandidate[];
  readonly chainId: number;
  readonly eligibleCandidates: number;
  readonly fromBlock: bigint;
  readonly positionManager: Address;
  readonly streamKey: string;
  readonly targetSetHash: Hash;
  readonly tokens: readonly ApprovalTokenTarget[];
  readonly toBlock: bigint;
  readonly toBlockHash: Hash;
}

export type ApprovalCostUniverse = Omit<
  ApprovalCostSource,
  "candidates" | "eligibleCandidates"
>;

export type AllowanceTransition =
  | "zero_to_nonzero"
  | "nonzero_to_nonzero"
  | "to_zero"
  | "zero_to_zero";

export interface ApprovalAllowanceState {
  readonly after: bigint | null;
  readonly afterReadError: string | null;
  readonly before: bigint | null;
  readonly beforeReadError: string | null;
}

export interface ApprovalCostObservation {
  readonly allowanceAfter: bigint | null;
  readonly allowanceAfterReadError: string | null;
  readonly allowanceBefore: bigint | null;
  readonly allowanceBeforeReadError: string | null;
  readonly allowanceTransition: AllowanceTransition | null;
  readonly approvedValue: bigint | null;
  readonly approvals: readonly IndexedApprovalEvent[];
  readonly attribution: "whole_direct_approval_transaction";
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly effectiveGasPrice: bigint;
  readonly executionEligible: false;
  readonly feeComponentsComplete: boolean;
  readonly gasUsed: bigint;
  readonly gasUsedForL1: bigint | null;
  readonly l1DataFeeWei: bigint | null;
  readonly l2ExecutionFeeWei: bigint | null;
  readonly l2ExecutionGasUsed: bigint | null;
  readonly observedAt: string;
  readonly owner: Address | null;
  readonly reasons: readonly string[];
  readonly recipient: Address | null;
  readonly selector: Hex | null;
  readonly spender: Address | null;
  readonly status: "comparable" | "excluded";
  readonly tokenAddresses: readonly Address[];
  readonly totalFeeWei: bigint;
  readonly transactionHash: Hash;
  readonly transactionIndex: number;
}

export interface ApprovalCostTokenSummary {
  readonly comparableObservations: number;
  readonly excludedObservations: number;
  readonly gasUsedP50: bigint | null;
  readonly gasUsedP90: bigint | null;
  readonly totalFeeWeiP50: bigint | null;
  readonly totalFeeWeiP90: bigint | null;
}

export interface ApprovalCostSummary {
  readonly byToken: Readonly<Record<string, ApprovalCostTokenSummary>>;
  readonly comparableObservations: number;
  readonly excludedObservations: number;
  readonly observations: number;
}

export interface ApprovalCostRun {
  readonly capturedAt: string;
  readonly executionEligible: false;
  readonly maxPerToken: number;
  readonly methodology: "direct_position_manager_approval_cost_v1";
  readonly observations: readonly ApprovalCostObservation[];
  readonly schemaVersion: 1;
  readonly source: ApprovalCostSource;
  readonly summary: ApprovalCostSummary;
}

export interface ApprovalTransactionReader {
  read(transactionHash: Hash, blockNumber?: bigint): Promise<RawActionTransaction>;
}
