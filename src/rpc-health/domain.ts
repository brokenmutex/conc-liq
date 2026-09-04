export type RpcHealthState = "healthy" | "degraded" | "open" | "half_open";

export interface RpcEndpointProbe {
  readonly anchorBlock: bigint | null;
  readonly anchorError: string | null;
  readonly anchorHash: string | null;
  readonly chainId: number | null;
  readonly error: string | null;
  readonly headBlock: bigint | null;
  readonly headHash: string | null;
  readonly headTimestamp: bigint | null;
  readonly latencyMs: number;
  readonly name: string;
  readonly role: "private" | "reference";
  readonly syncing: boolean | null;
  readonly syncingError: string | null;
}

export interface RpcHealthPreviousStatus {
  readonly consecutiveHealthy: number;
  readonly consecutiveUnhealthy: number;
  readonly observedAt: string;
  readonly privateHead: bigint | null;
  readonly privateHeadUnchangedSince: string | null;
  readonly referenceHead: bigint | null;
  readonly state: RpcHealthState;
}

export interface RpcHealthEvaluation {
  readonly allowBulk: boolean;
  readonly anchorBlock: bigint | null;
  readonly anchorHash: string | null;
  readonly consecutiveHealthy: number;
  readonly consecutiveUnhealthy: number;
  readonly lagBlocks: bigint | null;
  readonly lagSeconds: bigint | null;
  readonly observedAt: string;
  readonly privateAnchorHash: string | null;
  readonly privateHead: bigint | null;
  readonly privateHeadTimestamp: bigint | null;
  readonly privateHeadUnchangedSince: string | null;
  readonly privateLatencyMs: number | null;
  readonly privateSyncing: boolean | null;
  readonly probes: readonly RpcEndpointProbe[];
  readonly reasons: readonly string[];
  readonly referenceCount: number;
  readonly referenceHead: bigint | null;
  readonly referenceHeadSpreadBlocks: bigint | null;
  readonly referenceHeadTimestamp: bigint | null;
  readonly referenceQuorum: number;
  readonly schemaVersion: 1;
  readonly state: RpcHealthState;
  readonly warnings: readonly string[];
}

export interface RpcHealthGateStatus {
  readonly allowBulk: boolean;
  readonly lagBlocks: bigint | null;
  readonly lagSeconds: bigint | null;
  readonly observedAt: string;
  readonly privateHead: bigint | null;
  readonly reasons: readonly string[];
  readonly referenceHead: bigint | null;
  readonly sampleId: string;
  readonly state: RpcHealthState;
}
