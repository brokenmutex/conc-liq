import type { PoolClient } from "pg";

export const DEFAULT_RISK_GATE_MAX_SNAPSHOT_AGE_SECONDS = 180;
export const DEFAULT_RISK_GATE_MAX_CANONICALITY_AGE_SECONDS = 30;

export type RiskAttemptStatus = "failed" | "started" | "succeeded";

export interface RiskGateInput {
  readonly attemptId: string | null;
  readonly attemptStatus: RiskAttemptStatus | null;
  readonly canonicalityCanonical: boolean | null;
  readonly canonicalityValidatedAt: Date | null;
  readonly maxCanonicalityAgeSeconds: number;
  readonly maxSnapshotAgeSeconds: number;
  readonly now: Date;
  readonly snapshotBlockHash: string | null;
  readonly snapshotBlockNumber: string | null;
  readonly snapshotExecutionEligible: boolean | null;
  readonly snapshotId: string | null;
  readonly snapshotObservedAt: Date | null;
  readonly snapshotReasons: readonly string[];
  readonly sourceCoversSnapshot: boolean | null;
}

export interface RiskGateDecision {
  readonly attemptId: string | null;
  readonly attemptStatus: RiskAttemptStatus | null;
  readonly blockCanonical: boolean | null;
  readonly canonicalityAgeSeconds: number | null;
  readonly executionEligible: boolean;
  readonly evaluatedAt: string;
  readonly maxSnapshotAgeSeconds: number;
  readonly maxCanonicalityAgeSeconds: number;
  readonly reasons: readonly string[];
  readonly snapshotAgeSeconds: number | null;
  readonly snapshotBlockNumber: string | null;
  readonly snapshotId: string | null;
  readonly snapshotObservedAt: string | null;
  readonly sourceCoversSnapshot: boolean | null;
}

interface RiskGateDbRow {
  attempt_id: string | null;
  attempt_status: RiskAttemptStatus | null;
  canonicality_canonical: boolean | null;
  canonicality_validated_at: Date | null;
  server_time: Date;
  snapshot_block_hash: string | null;
  snapshot_block_number: string | null;
  snapshot_execution_eligible: boolean | null;
  snapshot_id: string | null;
  snapshot_observed_at: Date | null;
  snapshot_reasons: unknown;
  source_covers_snapshot: boolean | null;
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
  let canonicalityAgeSeconds: number | null = null;
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

    if (
      input.canonicalityCanonical === null ||
      input.canonicalityValidatedAt === null
    ) {
      blockCanonical = false;
      reasons.push("risk_block_validation_missing");
    } else {
      const validationAgeMilliseconds =
        input.now.getTime() - input.canonicalityValidatedAt.getTime();
      if (validationAgeMilliseconds < 0) {
        reasons.push("risk_block_validation_timestamp_future");
      } else {
        canonicalityAgeSeconds = Math.floor(validationAgeMilliseconds / 1_000);
        if (canonicalityAgeSeconds > input.maxCanonicalityAgeSeconds) {
          reasons.push("risk_block_validation_stale");
        }
      }
      blockCanonical = input.canonicalityCanonical;
      if (!blockCanonical) reasons.push("risk_block_not_canonical");
    }

    if (input.snapshotExecutionEligible !== true) {
      if (input.snapshotReasons.length === 0) {
        reasons.push("risk_snapshot_ineligible");
      } else {
        reasons.push(...input.snapshotReasons);
      }
    }
    if (input.sourceCoversSnapshot === null) {
      reasons.push("risk_source_cursor_missing");
    } else if (!input.sourceCoversSnapshot) {
      reasons.push("risk_snapshot_ahead_of_canonical_state");
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    attemptId: input.attemptId,
    attemptStatus: input.attemptStatus,
    blockCanonical,
    canonicalityAgeSeconds,
    evaluatedAt: input.now.toISOString(),
    executionEligible: uniqueReasons.length === 0,
    maxCanonicalityAgeSeconds: input.maxCanonicalityAgeSeconds,
    maxSnapshotAgeSeconds: input.maxSnapshotAgeSeconds,
    reasons: uniqueReasons,
    snapshotAgeSeconds,
    snapshotBlockNumber: input.snapshotBlockNumber,
    snapshotId: input.snapshotId,
    snapshotObservedAt: input.snapshotObservedAt?.toISOString() ?? null,
    sourceCoversSnapshot: input.sourceCoversSnapshot,
  };
}

export async function readRiskGate(
  client: Pick<PoolClient, "query">,
  streamKey: string,
  maxSnapshotAgeSeconds: number,
  maxCanonicalityAgeSeconds: number,
  assetSymbol?: string,
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
            CASE WHEN $2::text IS NULL THEN r.execution_eligible
                 ELSE asset.execution_eligible END AS snapshot_execution_eligible,
            CASE WHEN $2::text IS NULL THEN r.reasons
                 ELSE asset.reasons END AS snapshot_reasons,
            validation.canonical AS canonicality_canonical,
            validation.validated_at AS canonicality_validated_at,
            CASE
              WHEN index_cursor.last_scanned_block IS NULL
                OR replay_cursor.complete_through_block IS NULL THEN NULL
              ELSE index_cursor.last_scanned_block >= r.block_number
                AND replay_cursor.complete_through_block >= r.block_number
            END AS source_covers_snapshot
     FROM (SELECT 1) seed
     LEFT JOIN latest_attempt a ON TRUE
     LEFT JOIN risk_snapshot_runs r ON r.id = a.risk_run_id
     LEFT JOIN asset_risk_snapshots asset
       ON asset.run_id = r.id AND UPPER(asset.symbol) = UPPER($2::text)
     LEFT JOIN risk_snapshot_canonicality validation
       ON validation.risk_run_id = r.id
     LEFT JOIN indexer_cursors index_cursor ON index_cursor.stream_key = $1
     LEFT JOIN v3_replay_cursors replay_cursor ON replay_cursor.stream_key = $1`,
    [streamKey, assetSymbol ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Risk gate query returned no row");
  }
  return evaluateRiskGate({
    attemptId: row.attempt_id,
    attemptStatus: row.attempt_status,
    canonicalityCanonical: row.canonicality_canonical,
    canonicalityValidatedAt: row.canonicality_validated_at,
    maxCanonicalityAgeSeconds,
    maxSnapshotAgeSeconds,
    now: row.server_time,
    snapshotBlockHash: row.snapshot_block_hash,
    snapshotBlockNumber: row.snapshot_block_number,
    snapshotExecutionEligible: row.snapshot_execution_eligible,
    snapshotId: row.snapshot_id,
    snapshotObservedAt: row.snapshot_observed_at,
    snapshotReasons: stringArray(row.snapshot_reasons),
    sourceCoversSnapshot: row.source_covers_snapshot,
  });
}
