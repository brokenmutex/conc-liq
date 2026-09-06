import { createHash } from "node:crypto";
import { replayOracleMarkedPolicies } from "../oracle-policy/replay.js";
import type { JoinedPolicyReplayCandidate } from "./domain.js";
import type {
  JoinedPolicyEvidenceRequirements,
  JoinedPolicyReplay,
  JoinedPolicyReplaySource,
} from "./domain.js";

const ONE_MILLION = 1_000_000n;

function hoursBetween(first: string, last: string): number {
  const firstMs = Date.parse(first);
  const lastMs = Date.parse(last);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || lastMs <= firstMs) {
    throw new Error("Joined replay checkpoint timestamps are invalid or unordered");
  }
  return (lastMs - firstMs) / 3_600_000;
}

function validateRequirements(requirements: JoinedPolicyEvidenceRequirements): void {
  for (const [name, value] of [
    ["minimum external fallback checkpoints", requirements.minExternalFallbackCheckpoints],
    ["minimum passing checkpoints", requirements.minPassingCheckpoints],
    ["minimum weekend fallback checkpoints", requirements.minWeekendFallbackCheckpoints],
    ["minimum window hours", requirements.minWindowHours],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Joined replay ${name} must be a nonnegative safe integer`);
    }
  }
  if (requirements.minPassingCheckpoints < 2) {
    throw new Error("Joined replay requires at least two passing checkpoints");
  }
  if (requirements.minWindowHours <= 0) {
    throw new Error("Joined replay minimum window must be positive");
  }
}

function validateSource(source: JoinedPolicyReplaySource): {
  readonly externalFallbackCheckpoints: number;
  readonly primaryCheckpoints: number;
  readonly weekendFallbackCheckpoints: number;
} {
  if (source.costModel.status !== "complete") {
    throw new Error("Joined replay requires a complete measured cost model");
  }
  for (const [name, value] of [
    ["entry", source.costModel.entryCostQuote],
    ["rebalance", source.costModel.rebalanceCostQuote],
    ["exit", source.costModel.exitCostQuote],
  ] as const) {
    if (value < 0n) throw new Error(`Joined replay ${name} cost cannot be negative`);
  }
  if (source.references.length !== source.oracleSource.checkpoints.length) {
    throw new Error("Joined references do not cover every replay checkpoint");
  }
  if (
    source.coverage.totalRows !==
      source.coverage.passingRows + source.coverage.rejectedRows ||
    source.coverage.passingCheckpoints < source.references.length ||
    source.coverage.passingRows < source.coverage.passingCheckpoints
  ) {
    throw new Error("Joined replay coverage counts are inconsistent");
  }
  const basisIds = new Set<string>();
  const checkpointIds = new Set<string>();
  let externalFallbackCheckpoints = 0;
  let primaryCheckpoints = 0;
  let weekendFallbackCheckpoints = 0;
  for (let index = 0; index < source.references.length; index += 1) {
    const reference = source.references[index]!;
    const checkpoint = source.oracleSource.checkpoints[index]!;
    if (
      basisIds.has(reference.basisRunId) ||
      checkpointIds.has(reference.checkpointRunId)
    ) {
      throw new Error("Joined replay references contain duplicate source IDs");
    }
    basisIds.add(reference.basisRunId);
    checkpointIds.add(reference.checkpointRunId);
    if (
      reference.checkpointRunId !== checkpoint.run.checkpointRunId ||
      checkpoint.status !== "valid" || checkpoint.reasons.length !== 0 ||
      checkpoint.oraclePriceX18 !== reference.selectedPriceX18 ||
      reference.selectedPriceX18 <= 0n
    ) {
      throw new Error("Joined replay reference does not match its checkpoint mark");
    }
    if (reference.referenceMode === "chainlink_primary_comparison") {
      if (
        !reference.primaryReferenceAvailable || reference.fallbackCandidate ||
        reference.chainlinkPriceX18 !== reference.selectedPriceX18
      ) {
        throw new Error("Joined replay primary reference is inconsistent");
      }
      primaryCheckpoints += 1;
    } else {
      if (
        reference.primaryReferenceAvailable || !reference.fallbackCandidate ||
        reference.tokenReferenceUsdgX18 !== reference.selectedPriceX18
      ) {
        throw new Error("Joined replay fallback reference is inconsistent");
      }
      if (reference.referenceMode === "perp_internal_weekend_candidate") {
        weekendFallbackCheckpoints += 1;
      } else {
        externalFallbackCheckpoints += 1;
      }
    }
  }
  return {
    externalFallbackCheckpoints,
    primaryCheckpoints,
    weekendFallbackCheckpoints,
  };
}

function drawdownPpm(peak: bigint, value: bigint): bigint {
  if (peak <= 0n || value >= peak) return 0n;
  return (peak - value) * ONE_MILLION / peak;
}

function applyExitCost(
  candidate: JoinedPolicyReplayCandidate,
  exitCost: bigint,
  lastCheckpointRunId: string,
): JoinedPolicyReplayCandidate {
  if (candidate.status !== "complete") {
    return { ...candidate, exitCostAppliedQuote: "0", preExitFinalNavQuote: null };
  }
  const preExitFinalNav = BigInt(candidate.finalNavQuote!);
  if (preExitFinalNav <= exitCost) {
    return {
      ...candidate,
      absolutePnlQuote: null,
      exitCostAppliedQuote: "0",
      failureCheckpointRunId: lastCheckpointRunId,
      failureReason: "exit_cost_exhausted_final_nav",
      finalAmount0: null,
      finalAmount1: null,
      finalLiquidity: null,
      finalNavQuote: null,
      finalTickLower: null,
      finalTickUpper: null,
      hodlEndValueQuote: null,
      lpAlphaQuote: null,
      preExitFinalNavQuote: preExitFinalNav.toString(),
      rank: null,
      status: "excluded",
    };
  }
  const finalNav = preExitFinalNav - exitCost;
  const peaks = [
    BigInt(candidate.initialNavQuote!),
    ...candidate.steps.map((step) => BigInt(step.navQuote)),
  ];
  const peak = peaks.reduce((result, value) => value > result ? value : result);
  const maxDrawdown = BigInt(candidate.maxDrawdownPpm);
  const afterExitDrawdown = drawdownPpm(peak, finalNav);
  return {
    ...candidate,
    absolutePnlQuote: (BigInt(candidate.absolutePnlQuote!) - exitCost).toString(),
    exitCostAppliedQuote: exitCost.toString(),
    finalNavQuote: finalNav.toString(),
    lpAlphaQuote: (BigInt(candidate.lpAlphaQuote!) - exitCost).toString(),
    maxDrawdownPpm: (afterExitDrawdown > maxDrawdown
      ? afterExitDrawdown
      : maxDrawdown).toString(),
    preExitFinalNavQuote: preExitFinalNav.toString(),
    totalCostQuote: (BigInt(candidate.totalCostQuote) + exitCost).toString(),
  };
}

function policyHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function replayJoinedReferencePolicies(input: {
  readonly budgetQuote: bigint;
  readonly halfWidths: readonly number[];
  readonly requirements: JoinedPolicyEvidenceRequirements;
  readonly source: JoinedPolicyReplaySource;
  readonly triggerPercent: number;
}): JoinedPolicyReplay {
  validateRequirements(input.requirements);
  const modes = validateSource(input.source);
  const first = input.source.oracleSource.checkpoints[0];
  const last = input.source.oracleSource.checkpoints.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("Joined replay source has no checkpoints");
  }
  const windowHours = hoursBetween(first.run.blockTimestamp, last.run.blockTimestamp);
  if (input.source.references.length < input.requirements.minPassingCheckpoints) {
    throw new Error("Joined replay has fewer passing checkpoints than required");
  }
  if (windowHours < input.requirements.minWindowHours) {
    throw new Error("Joined replay window is shorter than required");
  }
  if (
    modes.weekendFallbackCheckpoints <
    input.requirements.minWeekendFallbackCheckpoints
  ) {
    throw new Error("Joined replay has fewer weekend fallback checkpoints than required");
  }
  if (
    modes.externalFallbackCheckpoints <
    input.requirements.minExternalFallbackCheckpoints
  ) {
    throw new Error("Joined replay has fewer external-session fallback checkpoints than required");
  }
  const core = replayOracleMarkedPolicies({
    budgetQuote: input.budgetQuote,
    entryCostQuote: input.source.costModel.entryCostQuote,
    halfWidths: input.halfWidths,
    rebalanceCostQuote: input.source.costModel.rebalanceCostQuote,
    source: input.source.oracleSource,
    triggerPercent: input.triggerPercent,
  });
  const candidates = core.candidates.map((candidate) => applyExitCost(
    candidate as JoinedPolicyReplayCandidate,
    input.source.costModel.exitCostQuote,
    last.run.checkpointRunId,
  ));
  const ranked = candidates.filter((candidate) => candidate.status === "complete")
    .sort((left, right) => {
      const leftAlpha = BigInt(left.lpAlphaQuote!);
      const rightAlpha = BigInt(right.lpAlphaQuote!);
      if (leftAlpha !== rightAlpha) return leftAlpha > rightAlpha ? -1 : 1;
      return left.halfWidthSpacings - right.halfWidthSpacings;
    });
  const ranks = new Map(ranked.map((candidate, index) => [
    candidate.halfWidthSpacings,
    index + 1,
  ]));
  const finalCandidates = candidates.map((candidate) => candidate.status === "complete"
    ? { ...candidate, rank: ranks.get(candidate.halfWidthSpacings)! }
    : candidate
  );
  const references = input.source.references.map((reference) => ({
    basisRunId: reference.basisRunId,
    checkpointRunId: reference.checkpointRunId,
    referenceMode: reference.referenceMode,
    selectedPriceX18: reference.selectedPriceX18.toString(),
  }));
  const halfWidths = [...input.halfWidths].sort((left, right) => left - right);
  const policySetHash = policyHash({
    budgetQuote: input.budgetQuote.toString(),
    costModelId: input.source.costModel.modelId,
    entryCostQuote: input.source.costModel.entryCostQuote.toString(),
    exitCostQuote: input.source.costModel.exitCostQuote.toString(),
    halfWidths,
    methodology: "joined_reference_cost_complete_policy_replay_v1",
    rebalanceCostQuote: input.source.costModel.rebalanceCostQuote.toString(),
    references,
    requirements: input.requirements,
    triggerPercent: input.triggerPercent,
  });
  return {
    assumptions: [
      ...core.assumptions,
      "chainlink_mark_selected_when_primary_reference_is_available",
      "normalized_perp_mark_selected_only_for_quality_passing_fallback_candidates",
      "entry_rebalance_and_exit_costs_are_measured_model_inputs",
      "exit_cost_applied_once_after_final_checkpoint",
      "joined_reference_replay_is_not_execution_authorization",
    ],
    budgetQuote: input.budgetQuote.toString(),
    candidates: finalCandidates,
    completedCandidates: finalCandidates.filter((candidate) =>
      candidate.status === "complete"
    ).length,
    computedAt: core.computedAt,
    costModel: {
      computedAt: input.source.costModel.computedAt,
      entryCostQuote: input.source.costModel.entryCostQuote.toString(),
      exitCostQuote: input.source.costModel.exitCostQuote.toString(),
      modelId: input.source.costModel.modelId,
      rebalanceCostQuote: input.source.costModel.rebalanceCostQuote.toString(),
      status: "complete",
      warnings: input.source.costModel.warnings,
    },
    coverage: input.source.coverage,
    evidence: {
      ...modes,
      requirements: input.requirements,
      selectedCheckpoints: references.length,
      windowHours,
    },
    excludedCandidates: finalCandidates.filter((candidate) =>
      candidate.status === "excluded"
    ).length,
    executionEligible: false,
    fee: core.fee,
    firstCheckpointRunId: first.run.checkpointRunId,
    halfWidths,
    lastCheckpointRunId: last.run.checkpointRunId,
    methodology: "joined_reference_cost_complete_policy_replay_v1",
    policySetHash,
    poolAddress: core.poolAddress,
    references,
    rwaSymbol: core.rwaSymbol,
    schemaVersion: 1,
    streamKey: core.streamKey,
    triggerPercent: input.triggerPercent,
  };
}
