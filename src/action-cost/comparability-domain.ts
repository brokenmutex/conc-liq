import type { Address, Hash, Hex } from "viem";
import type { ActionCostClass } from "./domain.js";

export type PositionManagerCallFamily =
  | "position_manager_mint"
  | "position_manager_increase"
  | "position_manager_decrease"
  | "position_manager_collect"
  | "position_manager_multicall"
  | "position_manager_other"
  | "external_call";

export type ComparableLpAction =
  | "initial_mint"
  | "increase_liquidity"
  | "decrease_liquidity"
  | "collect_fees";

export interface ActionCostCallSourceMark {
  readonly actionClass: ActionCostClass;
  readonly recipient: Address | null;
  readonly selector: Hex | null;
  readonly sourceReasons: readonly string[];
  readonly sourceStatus: "valid" | "excluded";
  readonly totalCostQuoteRaw: bigint | null;
  readonly transactionHash: Hash;
}

export interface ActionCostCallSource {
  readonly marks: readonly ActionCostCallSourceMark[];
  readonly streamKey: string;
  readonly valuationRunId: string;
}

export interface ActionCostCallAssessment {
  readonly actionClass: ActionCostClass;
  readonly callFamily: PositionManagerCallFamily;
  readonly executionEligible: false;
  readonly intendedAction: ComparableLpAction | null;
  readonly reasons: readonly string[];
  readonly recipient: Address | null;
  readonly selector: Hex | null;
  readonly status: "comparable" | "opaque" | "excluded";
  readonly totalCostQuoteRaw: bigint | null;
  readonly transactionHash: Hash;
}

export interface ActionCostCallFamilySummary {
  readonly comparableObservations: number;
  readonly excludedObservations: number;
  readonly opaqueObservations: number;
  readonly totalCostQuoteRawP50: bigint | null;
  readonly totalCostQuoteRawP90: bigint | null;
}

export interface ActionCostCallSummary {
  readonly byCallFamily: Readonly<
    Record<PositionManagerCallFamily, ActionCostCallFamilySummary>
  >;
  readonly comparableObservations: number;
  readonly excludedObservations: number;
  readonly observations: number;
  readonly opaqueObservations: number;
}

export interface ActionCostCallAssessmentRun {
  readonly assessments: readonly ActionCostCallAssessment[];
  readonly computedAt: string;
  readonly executionEligible: false;
  readonly methodology: "position_manager_selector_comparability_v1";
  readonly positionManager: Address;
  readonly schemaVersion: 1;
  readonly source: ActionCostCallSource;
  readonly summary: ActionCostCallSummary;
}
