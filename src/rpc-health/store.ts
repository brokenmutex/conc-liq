import pg from "pg";
import { SCHEMA_SQL } from "../storage/schema.js";
import type {
  RpcHealthEvaluation,
  RpcHealthGateStatus,
  RpcHealthPreviousStatus,
  RpcHealthState,
} from "./domain.js";

const { Pool } = pg;

interface HealthRow {
  allow_bulk: boolean;
  consecutive_healthy: number;
  consecutive_unhealthy: number;
  id: string;
  lag_blocks: string | null;
  lag_seconds: string | null;
  observed_at: Date;
  private_head: string | null;
  private_head_unchanged_since: Date | null;
  reasons: unknown;
  reference_head: string | null;
  state: string;
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry
  );
}

function reasons(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Stored RPC health reasons are malformed");
  }
  return value as string[];
}

function state(value: string): RpcHealthState {
  if (
    value !== "healthy" && value !== "degraded" &&
    value !== "open" && value !== "half_open"
  ) {
    throw new Error(`Stored RPC health state is invalid: ${value}`);
  }
  return value;
}

function previous(row: HealthRow): RpcHealthPreviousStatus {
  return {
    consecutiveHealthy: row.consecutive_healthy,
    consecutiveUnhealthy: row.consecutive_unhealthy,
    observedAt: row.observed_at.toISOString(),
    privateHead: row.private_head === null ? null : BigInt(row.private_head),
    privateHeadUnchangedSince: row.private_head_unchanged_since?.toISOString() ?? null,
    referenceHead: row.reference_head === null ? null : BigInt(row.reference_head),
    state: state(row.state),
  };
}

function gateStatus(row: HealthRow): RpcHealthGateStatus {
  return {
    allowBulk: row.allow_bulk,
    lagBlocks: row.lag_blocks === null ? null : BigInt(row.lag_blocks),
    lagSeconds: row.lag_seconds === null ? null : BigInt(row.lag_seconds),
    observedAt: row.observed_at.toISOString(),
    privateHead: row.private_head === null ? null : BigInt(row.private_head),
    reasons: reasons(row.reasons),
    referenceHead: row.reference_head === null ? null : BigInt(row.reference_head),
    sampleId: row.id,
    state: state(row.state),
  };
}

const LATEST_SQL = `
  SELECT id::text, observed_at, state, allow_bulk, reasons,
         private_head::text, reference_head::text, lag_blocks::text,
         lag_seconds::text, consecutive_healthy, consecutive_unhealthy,
         private_head_unchanged_since
  FROM rpc_health_samples
  ORDER BY observed_at DESC, id DESC
  LIMIT 1
`;

export class PostgresRpcHealthStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async latest(): Promise<RpcHealthPreviousStatus | null> {
    const result = await this.pool.query<HealthRow>(LATEST_SQL);
    return result.rows[0] === undefined ? null : previous(result.rows[0]);
  }

  public async save(evaluation: RpcHealthEvaluation): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO rpc_health_samples (
         schema_version, observed_at, state, allow_bulk, reasons, warnings,
         reference_count, reference_quorum, private_head, reference_head,
         lag_blocks, lag_seconds, private_head_timestamp,
         reference_head_timestamp, private_latency_ms, private_syncing,
         anchor_block, anchor_hash, private_anchor_hash,
         reference_head_spread_blocks, consecutive_healthy,
         consecutive_unhealthy, private_head_unchanged_since, snapshot
       ) VALUES (
         $1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,
         $15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb
       ) RETURNING id::text`,
      [
        evaluation.schemaVersion,
        evaluation.observedAt,
        evaluation.state,
        evaluation.allowBulk,
        json(evaluation.reasons),
        json(evaluation.warnings),
        evaluation.referenceCount,
        evaluation.referenceQuorum,
        evaluation.privateHead?.toString() ?? null,
        evaluation.referenceHead?.toString() ?? null,
        evaluation.lagBlocks?.toString() ?? null,
        evaluation.lagSeconds?.toString() ?? null,
        evaluation.privateHeadTimestamp?.toString() ?? null,
        evaluation.referenceHeadTimestamp?.toString() ?? null,
        evaluation.privateLatencyMs,
        evaluation.privateSyncing,
        evaluation.anchorBlock?.toString() ?? null,
        evaluation.anchorHash,
        evaluation.privateAnchorHash,
        evaluation.referenceHeadSpreadBlocks?.toString() ?? null,
        evaluation.consecutiveHealthy,
        evaluation.consecutiveUnhealthy,
        evaluation.privateHeadUnchangedSince,
        json(evaluation),
      ],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error("PostgreSQL did not return an RPC health sample ID");
    }
    return id;
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

export class RpcHealthCircuitOpenError extends Error {
  public readonly status: RpcHealthGateStatus | null;

  public constructor(message: string, status: RpcHealthGateStatus | null) {
    super(message);
    this.name = "RpcHealthCircuitOpenError";
    this.status = status;
  }
}

export interface BulkRpcHealthGate {
  assertBulkAllowed(): Promise<RpcHealthGateStatus | null>;
}

export class PostgresRpcHealthGate implements BulkRpcHealthGate {
  private readonly cacheMs: number;
  private cachedAtMs = 0;
  private cachedStatus: RpcHealthGateStatus | null = null;
  private readonly enabled: boolean;
  private readonly maxSampleAgeMs: number;
  private pending: Promise<RpcHealthGateStatus | null> | null = null;
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(input: {
    readonly cacheMs: number;
    readonly connectionString: string;
    readonly enabled: boolean;
    readonly maxSampleAgeSeconds: number;
  }) {
    this.cacheMs = input.cacheMs;
    this.enabled = input.enabled;
    this.maxSampleAgeMs = input.maxSampleAgeSeconds * 1_000;
    this.pool = new Pool({ connectionString: input.connectionString, max: 1 });
  }

  public async migrate(): Promise<void> {
    if (this.enabled) await this.pool.query(SCHEMA_SQL);
  }

  private async readLatest(): Promise<RpcHealthGateStatus | null> {
    const now = Date.now();
    if (now - this.cachedAtMs < this.cacheMs) return this.cachedStatus;
    if (this.pending !== null) return this.pending;
    this.pending = this.pool.query<HealthRow>(LATEST_SQL).then((result) => {
      this.cachedStatus = result.rows[0] === undefined
        ? null
        : gateStatus(result.rows[0]);
      this.cachedAtMs = Date.now();
      return this.cachedStatus;
    }).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  public async assertBulkAllowed(): Promise<RpcHealthGateStatus | null> {
    if (!this.enabled) return null;
    const status = await this.readLatest();
    if (status === null) {
      throw new RpcHealthCircuitOpenError(
        "RPC health circuit has no sample",
        null,
      );
    }
    const ageMs = Date.now() - Date.parse(status.observedAt);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > this.maxSampleAgeMs) {
      throw new RpcHealthCircuitOpenError(
        `RPC health sample ${status.sampleId} is stale`,
        status,
      );
    }
    if (!status.allowBulk) {
      throw new RpcHealthCircuitOpenError(
        `RPC health circuit is ${status.state}: ${status.reasons.join(",")}`,
        status,
      );
    }
    return status;
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
