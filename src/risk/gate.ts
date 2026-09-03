import type { PoolClient } from "pg";

export const DEFAULT_RISK_GATE_MAX_SNAPSHOT_AGE_SECONDS = 180;

export type RiskAttemptStatus = "failed" | "started" | "succeeded";

export interface RiskGateInput {
  readonly attemptId: string | null;
  readonly attemptStatus: RiskAttemptStatus | null;
  readonly canonicalBlockHash: string | null;
  readonly maxSnapshotAgeSeconds: number;
  readonly now: Date;
  readonly snapshotBlockHash: string | null;
  readonly snapshotBlockNumber: string | null;
  readonly snapshotExecutionEligible: boolean | null;
  readonly snapshotId: string | null;
  readonly snapshotObservedAt: Date | null;
  readonly snapshotReasons: readonly string[];
}

export interface RiskGateDecision {
  readonly attemptId: string | null;
  readonly attemptStatus: RiskAttemptStatus | null;
  readonly blockCanonical: boolean | null;
  readonly executionEligible: boolean;
  readonly evaluatedAt: string;
  readonly maxSnapshotAgeSeconds: number;
  readonly reasons: readonly string[];
  readonly snapshotAgeSeconds: number | null;
  readonly snapshotBlockNumber: string | null;
  readonly snapshotId: string | null;
  readonly snapshotObservedAt: string | null;
}

interface RiskGateDbRow {
  attempt_id: string | null;
  attempt_status: RiskAttemptStatus | null;
  canonical_block_hash: string | null;
  server_time: Date;
  snapshot_block_hash: string | null;
  snapshot_block_number: string | null;
  snapshot_execution_eligible: boolean | null;
  snapshot_id: string | null;
  snapshot_observed_at: Date | null;
  snapshot_reasons: unknown;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function evaluateRiskGate(input: RiskGateInput): RiskGateDecision {
  const reasons: string[] = [];
  if (input.attemptId === null || input.attemptStatus === null) {
    reasons.push("risk_attempt_missing");
  } else if (input.attemptStatus !== "succeeded") {
    reasons.push(`latest_risk_attempt_${input.attemptStatus}`);
  }

  let snapshotAgeSeconds: number | null = null;
  let blockCanonical: boolean | null = null;
  if (input.snapshotId === null || input.snapshotObservedAt === null) {
    reasons.push("risk_snapshot_missing");
  } else {
    const ageMilliseconds = input.now.getTime() - input.snapshotObservedAt.getTime();
    if (ageMilliseconds < 0) {
      reasons.push("risk_snapshot_timestamp_future");
    } else {
      snapshotAgeSeconds = Math.floor(ageMilliseconds / 1_000);
      if (snapshotAgeSeconds > input.maxSnapshotAgeSeconds) {
        reasons.push("risk_snapshot_stale");
      }
    }

    if (input.canonicalBlockHash === null) {
      blockCanonical = false;
      reasons.push("risk_block_checkpoint_missing");
    } else if (input.snapshotBlockHash !== input.canonicalBlockHash) {
      blockCanonical = false;
      reasons.push("risk_block_not_canonical");
    } else {
      blockCanonical = true;
    }

    if (input.snapshotExecutionEligible !== true) {
      if (input.snapshotReasons.length === 0) {
        reasons.push("risk_snapshot_ineligible");
      } else {
        reasons.push(...input.snapshotReasons);
      }
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    attemptId: input.attemptId,
    attemptStatus: input.attemptStatus,
    blockCanonical,
    evaluatedAt: input.now.toISOString(),
    executionEligible: uniqueReasons.length === 0,
    maxSnapshotAgeSeconds: input.maxSnapshotAgeSeconds,
    reasons: uniqueReasons,
    snapshotAgeSeconds,
    snapshotBlockNumber: input.snapshotBlockNumber,
    snapshotId: input.snapshotId,
    snapshotObservedAt: input.snapshotObservedAt?.toISOString() ?? null,
  };
}

export async function readRiskGate(
  client: Pick<PoolClient, "query">,
  streamKey: string,
  maxSnapshotAgeSeconds: number,
): Promise<RiskGateDecision> {
  const result = await client.query<RiskGateDbRow>(
    `WITH latest_attempt AS (
       SELECT id, status, risk_run_id
       FROM risk_snapshot_attempts
       ORDER BY attempted_at DESC, id DESC
       LIMIT 1
     )
     SELECT NOW() AS server_time,
            a.id AS attempt_id,
            a.status AS attempt_status,
            r.id AS snapshot_id,
            r.block_number::text AS snapshot_block_number,
            r.block_hash AS snapshot_block_hash,
            r.observed_at AS snapshot_observed_at,
            r.execution_eligible AS snapshot_execution_eligible,
            r.reasons AS snapshot_reasons,
            checkpoint.block_hash AS canonical_block_hash
     FROM (SELECT 1) seed
     LEFT JOIN latest_attempt a ON TRUE
     LEFT JOIN risk_snapshot_runs r ON r.id = a.risk_run_id
     LEFT JOIN indexer_checkpoints checkpoint
       ON checkpoint.stream_key = $1
      AND checkpoint.block_number = r.block_number`,
    [streamKey],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Risk gate query returned no row");
  }
  return evaluateRiskGate({
    attemptId: row.attempt_id,
    attemptStatus: row.attempt_status,
    canonicalBlockHash: row.canonical_block_hash,
    maxSnapshotAgeSeconds,
    now: row.server_time,
    snapshotBlockHash: row.snapshot_block_hash,
    snapshotBlockNumber: row.snapshot_block_number,
    snapshotExecutionEligible: row.snapshot_execution_eligible,
    snapshotId: row.snapshot_id,
    snapshotObservedAt: row.snapshot_observed_at,
    snapshotReasons: stringArray(row.snapshot_reasons),
  });
}
