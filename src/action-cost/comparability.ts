import { isAddressEqual, toFunctionSelector, type Address, type Hex } from "viem";
import type { ActionCostClass } from "./domain.js";
import type {
  ActionCostCallAssessment,
  ActionCostCallFamilySummary,
  ActionCostCallSourceMark,
  ActionCostCallSummary,
  ComparableLpAction,
  PositionManagerCallFamily,
} from "./comparability-domain.js";

const SELECTORS = {
  collect: toFunctionSelector(
    "collect((uint256,address,uint128,uint128))",
  ),
  decrease: toFunctionSelector(
    "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))",
  ),
  increase: toFunctionSelector(
    "increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))",
  ),
  mint: toFunctionSelector(
    "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))",
  ),
  multicall: toFunctionSelector("multicall(bytes[])"),
} as const;

const CALL_FAMILIES: readonly PositionManagerCallFamily[] = [
  "position_manager_mint",
  "position_manager_increase",
  "position_manager_decrease",
  "position_manager_collect",
  "position_manager_multicall",
  "position_manager_other",
  "external_call",
];

function sameSelector(left: Hex | null, right: Hex): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function directCall(selector: Hex | null): {
  readonly family: PositionManagerCallFamily;
  readonly intendedAction: ComparableLpAction | null;
  readonly compatibleClasses: readonly ActionCostClass[];
} {
  if (sameSelector(selector, SELECTORS.mint)) {
    return {
      compatibleClasses: ["mint_bundle"],
      family: "position_manager_mint",
      intendedAction: "initial_mint",
    };
  }
  if (sameSelector(selector, SELECTORS.increase)) {
    return {
      compatibleClasses: ["mint_bundle"],
      family: "position_manager_increase",
      intendedAction: "increase_liquidity",
    };
  }
  if (sameSelector(selector, SELECTORS.decrease)) {
    return {
      compatibleClasses: ["exit_bundle"],
      family: "position_manager_decrease",
      intendedAction: "decrease_liquidity",
    };
  }
  if (sameSelector(selector, SELECTORS.collect)) {
    return {
      compatibleClasses: ["collect_bundle", "exit_bundle"],
      family: "position_manager_collect",
      intendedAction: "collect_fees",
    };
  }
  if (sameSelector(selector, SELECTORS.multicall)) {
    return {
      compatibleClasses: [],
      family: "position_manager_multicall",
      intendedAction: null,
    };
  }
  return {
    compatibleClasses: [],
    family: "position_manager_other",
    intendedAction: null,
  };
}

export function assessActionCostCall(
  mark: ActionCostCallSourceMark,
  positionManager: Address,
): ActionCostCallAssessment {
  const managerCall = mark.recipient !== null &&
    isAddressEqual(mark.recipient, positionManager);
  const call = managerCall
    ? directCall(mark.selector)
    : {
      compatibleClasses: [] as readonly ActionCostClass[],
      family: "external_call" as const,
      intendedAction: null,
    };
  const reasons: string[] = [];
  let status: ActionCostCallAssessment["status"];
  if (mark.sourceStatus !== "valid" || mark.totalCostQuoteRaw === null) {
    reasons.push("source_valuation_unavailable", ...mark.sourceReasons);
    status = "excluded";
  } else if (call.family === "position_manager_multicall") {
    reasons.push("multicall_inner_selectors_unobserved");
    status = "opaque";
  } else if (call.intendedAction === null) {
    reasons.push(managerCall
      ? "position_manager_selector_unsupported"
      : "recipient_not_position_manager");
    status = "excluded";
  } else if (!call.compatibleClasses.includes(mark.actionClass)) {
    reasons.push("pool_event_mix_inconsistent_with_selector");
    status = "excluded";
  } else {
    status = "comparable";
  }
  return {
    actionClass: mark.actionClass,
    callFamily: call.family,
    executionEligible: false,
    intendedAction: call.intendedAction,
    reasons: [...new Set(reasons)],
    recipient: mark.recipient,
    selector: mark.selector,
    status,
    totalCostQuoteRaw: mark.totalCostQuoteRaw,
    transactionHash: mark.transactionHash,
  };
}

function percentile(values: readonly bigint[], numerator: number): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return sorted[Math.ceil(sorted.length * numerator / 100) - 1]!;
}

export function summarizeActionCostCalls(
  assessments: readonly ActionCostCallAssessment[],
): ActionCostCallSummary {
  const byCallFamily = Object.fromEntries(CALL_FAMILIES.map((family) => {
    const selected = assessments.filter((entry) => entry.callFamily === family);
    const comparable = selected.filter((entry) => entry.status === "comparable");
    const costs = comparable.map((entry) => entry.totalCostQuoteRaw!);
    const summary: ActionCostCallFamilySummary = {
      comparableObservations: comparable.length,
      excludedObservations: selected.filter((entry) => entry.status === "excluded").length,
      opaqueObservations: selected.filter((entry) => entry.status === "opaque").length,
      totalCostQuoteRawP50: percentile(costs, 50),
      totalCostQuoteRawP90: percentile(costs, 90),
    };
    return [family, summary] as const;
  })) as Readonly<Record<PositionManagerCallFamily, ActionCostCallFamilySummary>>;
  return {
    byCallFamily,
    comparableObservations: assessments.filter((entry) =>
      entry.status === "comparable"
    ).length,
    excludedObservations: assessments.filter((entry) =>
      entry.status === "excluded"
    ).length,
    observations: assessments.length,
    opaqueObservations: assessments.filter((entry) => entry.status === "opaque").length,
  };
}

export { SELECTORS as POSITION_MANAGER_SELECTORS };
