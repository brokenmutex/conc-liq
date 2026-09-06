import type {
  OraclePolicyReplayCandidate,
  OraclePolicyReplaySource,
} from "../oracle-policy/domain.js";
import type { PerpBasisReferenceMode } from "../perp-basis/domain.js";

export interface JoinedPolicyReference {
  readonly basisRunId: string;
  readonly checkpointRunId: string;
  readonly fallbackCandidate: boolean;
  readonly primaryReferenceAvailable: boolean;
  readonly qualityPass: true;
  readonly referenceMode: PerpBasisReferenceMode;
  readonly selectedPriceX18: bigint;
  readonly chainlinkPriceX18: bigint | null;
  readonly tokenReferenceUsdgX18: bigint | null;
}

export interface JoinedPolicyCoverage {
  readonly passingCheckpoints: number;
  readonly passingRows: number;
  readonly rejectedRows: number;
  readonly rejectionReasons: Readonly<Record<string, number>>;
  readonly totalRows: number;
}

export interface JoinedPolicyCostModel {
  readonly computedAt: string;
  readonly entryCostQuote: bigint;
  readonly exitCostQuote: bigint;
  readonly modelId: string;
  readonly rebalanceCostQuote: bigint;
  readonly status: "complete";
  readonly warnings: readonly string[];
}

export interface JoinedPolicyReplaySource {
  readonly costModel: JoinedPolicyCostModel;
  readonly coverage: JoinedPolicyCoverage;
  readonly oracleSource: OraclePolicyReplaySource;
  readonly references: readonly JoinedPolicyReference[];
}

export interface JoinedPolicyEvidenceRequirements {
  readonly minExternalFallbackCheckpoints: number;
  readonly minPassingCheckpoints: number;
  readonly minWeekendFallbackCheckpoints: number;
  readonly minWindowHours: number;
}

export interface JoinedPolicyReplayCandidate extends OraclePolicyReplayCandidate {
  readonly exitCostAppliedQuote: string;
  readonly preExitFinalNavQuote: string | null;
}

export interface JoinedPolicyReplay {
  readonly assumptions: readonly string[];
  readonly budgetQuote: string;
  readonly candidates: readonly JoinedPolicyReplayCandidate[];
  readonly completedCandidates: number;
  readonly computedAt: string;
  readonly costModel: {
    readonly computedAt: string;
    readonly entryCostQuote: string;
    readonly exitCostQuote: string;
    readonly modelId: string;
    readonly rebalanceCostQuote: string;
    readonly status: "complete";
    readonly warnings: readonly string[];
  };
  readonly coverage: JoinedPolicyCoverage;
  readonly evidence: {
    readonly externalFallbackCheckpoints: number;
    readonly primaryCheckpoints: number;
    readonly requirements: JoinedPolicyEvidenceRequirements;
    readonly selectedCheckpoints: number;
    readonly weekendFallbackCheckpoints: number;
    readonly windowHours: number;
  };
  readonly excludedCandidates: number;
  readonly executionEligible: false;
  readonly fee: number;
  readonly firstCheckpointRunId: string;
  readonly halfWidths: readonly number[];
  readonly lastCheckpointRunId: string;
  readonly methodology: "joined_reference_cost_complete_policy_replay_v1";
  readonly policySetHash: string;
  readonly poolAddress: string;
  readonly references: readonly {
    readonly basisRunId: string;
    readonly checkpointRunId: string;
    readonly referenceMode: PerpBasisReferenceMode;
    readonly selectedPriceX18: string;
  }[];
  readonly rwaSymbol: string;
  readonly schemaVersion: 1;
  readonly streamKey: string;
  readonly triggerPercent: number;
}
