import pg from "pg";
import { getAddress, type Hash } from "viem";
import { readRiskGate, type RiskGateDecision } from "../risk/gate.js";
import { SCHEMA_SQL } from "../storage/schema.js";
import type { GuardedCanaryPlan, GuardedCanarySource } from "./domain.js";

const { Pool } = pg;

interface SourceRow {
  asset_execution_eligible: boolean;
  asset_reasons: unknown;
  block_hash: string;
  block_number: string;
  block_timestamp: Date;
  captured_at: Date;
  chain_id: string;
  checkpoint_run_id: string;
  fee: number;
  pool_address: string;
  pool_deviation_ppm: string | null;
  pool_liquidity: string;
  pool_sqrt_price_x96: string;
  pool_status: string;
  pool_tick: number;
  pool_unlocked: boolean;
  risk_run_id: string;
  rwa_address: string;
  rwa_symbol: string;
  stream_key: string;
  target_set_hash: string;
  token0: string;
  token1: string;
  token_decimals: number | null;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Stored ${label} is malformed`);
  }
  return value as string[];
}

function poolStatus(value: string): "excluded" | "valid" {
  if (value !== "excluded" && value !== "valid") {
    throw new Error(`Stored pool checkpoint status is invalid: ${value}`);
  }
  return value;
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry
  );
}

export class PostgresGuardedCanaryPlanStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async loadLatestSource(input: {
    readonly fee: number;
    readonly rwaSymbol: string;
    readonly streamKey: string;
  }): Promise<GuardedCanarySource> {
    const result = await this.pool.query<SourceRow>(
      `SELECT c.id::text AS checkpoint_run_id,
              c.risk_run_id::text, c.stream_key, c.chain_id::text,
              c.block_number::text, c.block_hash, c.block_timestamp,
              c.captured_at, c.target_set_hash,
              p.pool_address, p.rwa_symbol, p.rwa_address, p.fee,
              p.token0, p.token1, p.tick AS pool_tick,
              p.sqrt_price_x96::text AS pool_sqrt_price_x96,
              p.liquidity::text AS pool_liquidity,
              p.pool_unlocked, p.status AS pool_status,
              p.deviation_ppm::text AS pool_deviation_ppm,
              p.token_decimals,
              a.execution_eligible AS asset_execution_eligible,
              a.reasons AS asset_reasons
       FROM v3_strategy_checkpoint_runs c
       JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id = c.id
       JOIN asset_risk_snapshots a
         ON a.run_id = c.risk_run_id AND UPPER(a.symbol) = UPPER(p.rwa_symbol)
       WHERE c.stream_key = $1 AND UPPER(p.rwa_symbol) = UPPER($2)
         AND p.fee = $3
       ORDER BY c.block_number DESC, c.id DESC
       LIMIT 1`,
      [input.streamKey, input.rwaSymbol, input.fee],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `No synchronized ${input.rwaSymbol}/${input.fee} checkpoint is stored`,
      );
    }
    if (row.token_decimals === null) {
      throw new Error("Latest canary checkpoint has no RWA token decimals");
    }
    return {
      assetRiskExecutionEligible: row.asset_execution_eligible,
      assetRiskReasons: stringArray(row.asset_reasons, "asset risk reasons"),
      blockHash: row.block_hash as Hash,
      blockNumber: BigInt(row.block_number),
      blockTimestamp: row.block_timestamp.toISOString(),
      capturedAt: row.captured_at.toISOString(),
      chainId: Number(row.chain_id),
      checkpointRunId: row.checkpoint_run_id,
      fee: row.fee,
      poolAddress: getAddress(row.pool_address),
      poolDeviationPpm: row.pool_deviation_ppm === null
        ? null
        : BigInt(row.pool_deviation_ppm),
      poolLiquidity: BigInt(row.pool_liquidity),
      poolSqrtPriceX96: BigInt(row.pool_sqrt_price_x96),
      poolStatus: poolStatus(row.pool_status),
      poolTick: row.pool_tick,
      poolUnlocked: row.pool_unlocked,
      riskRunId: row.risk_run_id,
      rwaAddress: getAddress(row.rwa_address),
      rwaSymbol: row.rwa_symbol.toUpperCase(),
      streamKey: row.stream_key,
      targetSetHash: row.target_set_hash as Hash,
      token0: getAddress(row.token0),
      token1: getAddress(row.token1),
      tokenDecimals: row.token_decimals,
    };
  }

  public async readRiskGate(input: {
    readonly maxCanonicalityAgeSeconds: number;
    readonly maxSnapshotAgeSeconds: number;
    readonly streamKey: string;
  }): Promise<RiskGateDecision> {
    return readRiskGate(
      this.pool,
      input.streamKey,
      input.maxSnapshotAgeSeconds,
      input.maxCanonicalityAgeSeconds,
    );
  }

  public async save(plan: GuardedCanaryPlan): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO guarded_canary_plan_runs (
         schema_version, created_at, checkpoint_run_id, risk_run_id,
         rpc_health_sample_id, chain_id, pool_address, rwa_symbol, fee,
         operator_address, budget_quote_raw, budget_cap_quote_raw,
         half_width_spacings, slippage_bps, max_oracle_deviation_ppm,
         max_liquidity_share_ppm, ttl_seconds, approval_hash, status,
         manual_approval_candidate, simulation_succeeded, gas_estimate,
         gas_cost_estimate_wei,
         broadcast_authorized, execution_eligible, reasons, snapshot
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27::jsonb
       ) RETURNING id::text`,
      [
        plan.schemaVersion,
        plan.createdAt,
        plan.source.checkpointRunId,
        plan.source.riskRunId,
        plan.rpcHealth.sampleId,
        4663,
        plan.source.poolAddress.toLowerCase(),
        plan.source.rwaSymbol,
        plan.transaction.fee,
        plan.operator.toLowerCase(),
        plan.policy.budgetQuote,
        plan.policy.budgetCapQuote,
        plan.policy.halfWidthSpacings,
        plan.policy.slippageBps,
        plan.policy.maxOracleDeviationPpm,
        plan.policy.maxLiquiditySharePpm,
        plan.policy.ttlSeconds,
        plan.approvalHash,
        plan.status,
        plan.manualApprovalCandidate,
        plan.simulation.succeeded,
        plan.gasEstimate.gas,
        plan.estimatedGasCostWei,
        plan.broadcastAuthorized,
        plan.executionEligible,
        json(plan.preflightReasons),
        json(plan),
      ],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error("PostgreSQL did not return a canary plan ID");
    return id;
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
