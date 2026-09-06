import type { Address } from "viem";

export interface CostSample {
  readonly p90QuoteRaw: bigint | null;
  readonly sampleCount: number;
}

export interface GuardedCostModelEvidence {
  readonly actionAssessmentRunId: string;
  readonly approvalValuationRunId: string;
  readonly initialMint: CostSample;
  readonly quoteApproval: CostSample;
  readonly rwaApproval: CostSample;
}

export interface GuardedCostModelSource {
  readonly fee: number;
  readonly poolAddress: Address;
  readonly rwaSymbol: string;
  readonly streamKey: string;
}

export interface GuardedCostModel {
  readonly computedAt: string;
  readonly entryCostQuoteRaw: bigint | null;
  readonly evidence: GuardedCostModelEvidence;
  readonly executionEligible: false;
  readonly methodology: "pool_specific_direct_call_p90_v1";
  readonly quoteDecimals: 6;
  readonly reasons: readonly string[];
  readonly rebalanceCostQuoteRaw: bigint | null;
  readonly exitCostQuoteRaw: bigint | null;
  readonly schemaVersion: 1;
  readonly source: GuardedCostModelSource;
  readonly status: "complete" | "entry_measured" | "unavailable";
  readonly warnings: readonly string[];
}
