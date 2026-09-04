import type { RpcHealthPolicyConfig } from "./config.js";
import type {
  RpcEndpointProbe,
  RpcHealthEvaluation,
  RpcHealthPreviousStatus,
} from "./domain.js";

function maximum(values: readonly bigint[]): bigint {
  return values.reduce((result, value) => value > result ? value : result);
}

function minimum(values: readonly bigint[]): bigint {
  return values.reduce((result, value) => value < result ? value : result);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function elapsedSeconds(from: string, to: string): number {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return 0;
  }
  return Math.floor((toMs - fromMs) / 1_000);
}

function validLatest(
  probe: RpcEndpointProbe,
  expectedChainId: number,
): boolean {
  return probe.error === null && probe.chainId === expectedChainId &&
    probe.headBlock !== null && probe.headHash !== null &&
    probe.headTimestamp !== null;
}

function canonicalReferenceGroup(input: {
  readonly expectedChainId: number;
  readonly probes: readonly RpcEndpointProbe[];
}): readonly RpcEndpointProbe[] {
  const groups = new Map<string, RpcEndpointProbe[]>();
  for (const probe of input.probes) {
    if (
      probe.role !== "reference" ||
      !validLatest(probe, input.expectedChainId) ||
      probe.anchorError !== null || probe.anchorHash === null
    ) {
      continue;
    }
    const key = probe.anchorHash.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(probe);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => {
    if (left.length !== right.length) return right.length - left.length;
    const leftHead = maximum(left.map((probe) => probe.headBlock!));
    const rightHead = maximum(right.map((probe) => probe.headBlock!));
    if (leftHead !== rightHead) return leftHead > rightHead ? -1 : 1;
    return left[0]!.name.localeCompare(right[0]!.name);
  })[0] ?? [];
}

export function evaluateRpcHealth(input: {
  readonly config: RpcHealthPolicyConfig;
  readonly observedAt: string;
  readonly previous: RpcHealthPreviousStatus | null;
  readonly probes: readonly RpcEndpointProbe[];
}): RpcHealthEvaluation {
  const observedMs = Date.parse(input.observedAt);
  if (!Number.isFinite(observedMs)) {
    throw new Error("RPC health observation timestamp is invalid");
  }
  const privateProbe = input.probes.find((probe) => probe.role === "private");
  if (privateProbe === undefined) {
    throw new Error("RPC health evaluation requires one private probe");
  }
  if (input.probes.filter((probe) => probe.role === "private").length !== 1) {
    throw new Error("RPC health evaluation received multiple private probes");
  }
  const references = input.probes.filter((probe) => probe.role === "reference");
  const canonicalReferences = canonicalReferenceGroup({
    expectedChainId: input.config.expectedChainId,
    probes: input.probes,
  });
  const privateLatestValid = validLatest(privateProbe, input.config.expectedChainId);
  const hasReferenceQuorum = canonicalReferences.length >=
    input.config.referenceQuorum;
  const referenceHeads = hasReferenceQuorum
    ? canonicalReferences.map((probe) => probe.headBlock!)
    : [];
  const referenceTimestamps = hasReferenceQuorum
    ? canonicalReferences.map((probe) => probe.headTimestamp!)
    : [];
  const referenceHead = referenceHeads.length === 0 ? null : maximum(referenceHeads);
  const referenceHeadTimestamp = referenceTimestamps.length === 0
    ? null
    : maximum(referenceTimestamps);
  const referenceHeadSpreadBlocks = referenceHeads.length === 0
    ? null
    : maximum(referenceHeads) - minimum(referenceHeads);
  const anchorBlock = canonicalReferences[0]?.anchorBlock ?? null;
  const anchorHash = canonicalReferences[0]?.anchorHash ?? null;
  const privateAnchorMatches = hasReferenceQuorum && anchorHash !== null &&
    privateProbe.anchorError === null && privateProbe.anchorHash !== null &&
    privateProbe.anchorHash.toLowerCase() === anchorHash.toLowerCase();
  const privateHead = privateLatestValid ? privateProbe.headBlock : null;
  const privateHeadTimestamp = privateLatestValid
    ? privateProbe.headTimestamp
    : null;
  const lagBlocks = referenceHead === null || privateHead === null
    ? null
    : referenceHead > privateHead ? referenceHead - privateHead : 0n;
  const lagSeconds = referenceHeadTimestamp === null || privateHeadTimestamp === null
    ? null
    : referenceHeadTimestamp > privateHeadTimestamp
      ? referenceHeadTimestamp - privateHeadTimestamp
      : 0n;

  let privateHeadUnchangedSince: string | null = privateHead === null
    ? null
    : input.observedAt;
  if (
    privateHead !== null && input.previous?.privateHead === privateHead &&
    referenceHead !== null && input.previous.referenceHead !== null &&
    referenceHead > input.previous.referenceHead && referenceHead > privateHead
  ) {
    privateHeadUnchangedSince = input.previous.privateHeadUnchangedSince ??
      input.previous.observedAt;
  }

  const hardReasons: string[] = [];
  const softReasons: string[] = [];
  const warnings: string[] = [];
  if (references.length < input.config.referenceQuorum) {
    hardReasons.push("reference_count_below_quorum");
  }
  if (!hasReferenceQuorum) {
    hardReasons.push("reference_hash_quorum_unavailable");
  }
  for (const reference of references) {
    if (!validLatest(reference, input.config.expectedChainId)) {
      warnings.push(`reference_probe_failed:${reference.name}`);
    } else if (reference.anchorError !== null || reference.anchorHash === null) {
      warnings.push(`reference_anchor_failed:${reference.name}`);
    } else if (!canonicalReferences.includes(reference)) {
      warnings.push(`reference_anchor_disagreed:${reference.name}`);
    }
  }
  if (!privateLatestValid) {
    hardReasons.push("private_probe_failed");
  }
  if (privateProbe.syncing === true) {
    hardReasons.push("private_reports_syncing");
  } else if (privateProbe.syncing === null && privateProbe.syncingError !== null) {
    warnings.push("private_syncing_signal_unavailable");
  }
  if (hasReferenceQuorum && !privateAnchorMatches) {
    if (privateProbe.anchorError !== null || privateProbe.anchorHash === null) {
      hardReasons.push("private_confirmed_anchor_unavailable");
    } else {
      hardReasons.push("private_canonical_hash_mismatch");
    }
  }
  if (lagBlocks !== null) {
    if (lagBlocks > input.config.hardLagBlocks) {
      hardReasons.push("private_block_lag_hard");
    } else if (lagBlocks > input.config.softLagBlocks) {
      softReasons.push("private_block_lag_soft");
    }
  }
  if (lagSeconds !== null) {
    if (lagSeconds > input.config.hardLagSeconds) {
      hardReasons.push("private_time_lag_hard");
    } else if (lagSeconds > input.config.softLagSeconds) {
      softReasons.push("private_time_lag_soft");
    }
  }
  if (privateProbe.latencyMs > input.config.hardLatencyMs) {
    hardReasons.push("private_latency_hard");
  } else if (privateProbe.latencyMs > input.config.softLatencyMs) {
    softReasons.push("private_latency_soft");
  }
  if (
    privateHeadUnchangedSince !== null &&
    elapsedSeconds(privateHeadUnchangedSince, input.observedAt) >=
      input.config.stallSeconds
  ) {
    hardReasons.push("private_head_stalled");
  }
  const observedSeconds = BigInt(Math.floor(observedMs / 1_000));
  if (
    referenceHeadTimestamp !== null &&
    observedSeconds > referenceHeadTimestamp + input.config.hardLagSeconds
  ) {
    hardReasons.push("reference_head_stale");
  }
  if (
    referenceHeadTimestamp !== null &&
    referenceHeadTimestamp > observedSeconds + input.config.hardLagSeconds
  ) {
    hardReasons.push("reference_timestamp_future");
  }
  if (
    privateHeadTimestamp !== null &&
    privateHeadTimestamp > observedSeconds + input.config.hardLagSeconds
  ) {
    hardReasons.push("private_timestamp_future");
  }
  if (
    referenceHeadSpreadBlocks !== null &&
    referenceHeadSpreadBlocks > input.config.softLagBlocks
  ) {
    warnings.push("reference_head_spread_large");
  }

  const unhealthy = hardReasons.length > 0 || softReasons.length > 0;
  const consecutiveHealthy = unhealthy
    ? 0
    : (input.previous?.consecutiveHealthy ?? 0) + 1;
  const consecutiveUnhealthy = unhealthy
    ? (input.previous?.consecutiveUnhealthy ?? 0) + 1
    : 0;
  let state: RpcHealthEvaluation["state"];
  if (hardReasons.length > 0) {
    state = "open";
  } else if (softReasons.length > 0) {
    state = "degraded";
  } else if (
    input.previous?.state === "healthy" ||
    consecutiveHealthy >= input.config.recoverySamples
  ) {
    state = "healthy";
  } else {
    state = "half_open";
  }
  const reasons = [...hardReasons, ...softReasons];
  if (state === "half_open") reasons.push("recovery_hysteresis");

  return {
    allowBulk: state === "healthy",
    anchorBlock,
    anchorHash,
    consecutiveHealthy,
    consecutiveUnhealthy,
    lagBlocks,
    lagSeconds,
    observedAt: input.observedAt,
    privateAnchorHash: privateProbe.anchorHash,
    privateHead,
    privateHeadTimestamp,
    privateHeadUnchangedSince,
    privateLatencyMs: privateLatestValid ? privateProbe.latencyMs : null,
    privateSyncing: privateProbe.syncing,
    probes: input.probes,
    reasons: unique(reasons),
    referenceCount: references.length,
    referenceHead,
    referenceHeadSpreadBlocks,
    referenceHeadTimestamp,
    referenceQuorum: input.config.referenceQuorum,
    schemaVersion: 1,
    state,
    warnings: unique(warnings),
  };
}
