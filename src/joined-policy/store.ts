import pg from "pg";
import { USDG } from "../constants.js";
import type {
  OraclePolicyCheckpoint,
  OraclePolicyReplaySource,
} from "../oracle-policy/domain.js";
import type { PerpBasisReferenceMode } from "../perp-basis/domain.js";
import { SCHEMA_SQL } from "../storage/schema.js";
import type {
  JoinedPolicyCostModel,
  JoinedPolicyCoverage,
  JoinedPolicyReference,
  JoinedPolicyReplay,
  JoinedPolicyReplaySource,
} from "./domain.js";

const { Pool } = pg;

interface ReferenceRow {
  basis_run_id: string;
  block_hash: string;
  block_number: string;
  block_timestamp: Date;
  captured_at: Date;
  chain_id: string;
  chainlink_price_x18: string | null;
  checkpoint_run_id: string;
  fallback_candidate: boolean;
  fee: number;
  fee_growth_global0_x128: string;
  fee_growth_global1_x128: string;
  liquidity: string;
  pool_address: string;
  pool_price_x18: string;
  primary_reference_available: boolean;
  reference_mode: string;
  risk_run_id: string;
  rwa_address: string;
  rwa_symbol: string;
  sqrt_price_x96: string;
  stream_key: string;
  target_set_hash: string;
  tick: number;
  token0: string;
  token1: string;
  token_decimals: number | null;
  token_reference_usdg_x18: string | null;
}

interface CoverageRow {
  checkpoint_run_id: string;
  quality_pass: boolean;
  reasons: unknown;
}

interface CostRow {
  computed_at: Date;
  entry_cost_quote_raw: string | null;
  exit_cost_quote_raw: string | null;
  id: string;
  reasons: unknown;
  rebalance_cost_quote_raw: string | null;
  status: string;
  warnings: unknown;
}

interface CursorRow {
  chain_id: string;
  last_scanned_block: string | null;
  target_set_hash: string;
}

interface IndexedPoolRow {
  chain_id: string;
  enabled: boolean;
  fee: number;
  pool_address: string;
  rwa_address: string;
  rwa_symbol: string;
  target_set_hash: string;
}

interface SwapRow {
  block_number: string;
  tick: number;
}

export class JoinedPolicyReplaySourceUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "JoinedPolicyReplaySourceUnavailableError";
  }
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Stored ${label} is malformed`);
  }
  return value as string[];
}

function mode(value: string): PerpBasisReferenceMode {
  if (
    value !== "chainlink_primary_comparison" &&
    value !== "perp_external_session_candidate" &&
    value !== "perp_internal_weekend_candidate"
  ) {
    throw new Error(`Stored joined reference mode is invalid: ${value}`);
  }
  return value;
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry
  );
}

function selectedReference(row: ReferenceRow): {
  readonly checkpoint: OraclePolicyCheckpoint;
  readonly reference: JoinedPolicyReference;
} {
  const referenceMode = mode(row.reference_mode);
  const selectedRaw = referenceMode === "chainlink_primary_comparison"
    ? row.chainlink_price_x18
    : row.token_reference_usdg_x18;
  if (selectedRaw === null || BigInt(selectedRaw) <= 0n) {
    throw new Error(`Passing basis run ${row.basis_run_id} has no selected price`);
  }
  if (row.token_decimals === null) {
    throw new Error(`Passing basis run ${row.basis_run_id} has no token decimals`);
  }
  const selectedPriceX18 = BigInt(selectedRaw);
  return {
    checkpoint: {
      oraclePriceX18: selectedPriceX18,
      pool: {
        feeGrowthGlobal0X128: BigInt(row.fee_growth_global0_x128),
        feeGrowthGlobal1X128: BigInt(row.fee_growth_global1_x128),
        liquidity: BigInt(row.liquidity),
        sqrtPriceX96: BigInt(row.sqrt_price_x96),
        tick: row.tick,
      },
      poolPriceX18: BigInt(row.pool_price_x18),
      reasons: [],
      run: {
        blockHash: row.block_hash,
        blockNumber: BigInt(row.block_number),
        blockTimestamp: row.block_timestamp.toISOString(),
        capturedAt: row.captured_at.toISOString(),
        chainId: Number(row.chain_id),
        checkpointRunId: row.checkpoint_run_id,
        riskRunId: row.risk_run_id,
      },
      status: "valid",
      tokenDecimals: row.token_decimals,
    },
    reference: {
      basisRunId: row.basis_run_id,
      chainlinkPriceX18: row.chainlink_price_x18 === null
        ? null
        : BigInt(row.chainlink_price_x18),
      checkpointRunId: row.checkpoint_run_id,
      fallbackCandidate: row.fallback_candidate,
      primaryReferenceAvailable: row.primary_reference_available,
      qualityPass: true,
      referenceMode,
      selectedPriceX18,
      tokenReferenceUsdgX18: row.token_reference_usdg_x18 === null
        ? null
        : BigInt(row.token_reference_usdg_x18),
    },
  };
}

function coverage(rows: readonly CoverageRow[]): JoinedPolicyCoverage {
  const passing = rows.filter((row) => row.quality_pass);
  const rejected = rows.filter((row) => !row.quality_pass);
  const rejectionReasons: Record<string, number> = {};
  for (const row of rejected) {
    for (const reason of stringArray(row.reasons, "basis rejection reasons")) {
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    }
  }
  return {
    passingCheckpoints: new Set(passing.map((row) => row.checkpoint_run_id)).size,
    passingRows: passing.length,
    rejectedRows: rejected.length,
    rejectionReasons: Object.fromEntries(
      Object.entries(rejectionReasons).sort(([left], [right]) => left.localeCompare(right)),
    ),
    totalRows: rows.length,
  };
}

function completeCost(row: CostRow | undefined, latest: CostRow | undefined): JoinedPolicyCostModel {
  if (row === undefined) {
    const detail = latest === undefined
      ? "no guarded cost model exists"
      : `latest model ${latest.id} is ${latest.status}: ` +
        stringArray(latest.reasons, "cost-model reasons").join(",");
    throw new JoinedPolicyReplaySourceUnavailableError(
      `Complete measured entry/rebalance/exit cost model unavailable; ${detail}`,
    );
  }
  if (
    row.status !== "complete" || row.entry_cost_quote_raw === null ||
    row.rebalance_cost_quote_raw === null || row.exit_cost_quote_raw === null
  ) {
    throw new Error("Stored complete cost model is internally inconsistent");
  }
  return {
    computedAt: row.computed_at.toISOString(),
    entryCostQuote: BigInt(row.entry_cost_quote_raw),
    exitCostQuote: BigInt(row.exit_cost_quote_raw),
    modelId: row.id,
    rebalanceCostQuote: BigInt(row.rebalance_cost_quote_raw),
    status: "complete",
    warnings: stringArray(row.warnings, "cost-model warnings"),
  };
}

export class PostgresJoinedPolicyReplayStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async load(input: {
    readonly fee: number;
    readonly lookback: number;
    readonly rwaSymbol: string;
    readonly streamKey: string;
  }): Promise<JoinedPolicyReplaySource> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const referenceResult = await client.query<ReferenceRow>(
        `WITH best AS (
           SELECT DISTINCT ON (b.checkpoint_run_id)
             b.id::text AS basis_run_id, b.checkpoint_run_id,
             b.reference_mode, b.primary_reference_available,
             b.fallback_candidate, b.chainlink_price_x18::text,
             b.token_reference_usdg_x18::text,
             b.source_skew_seconds, b.evaluated_at
           FROM perp_pool_basis_runs b
           WHERE b.stream_key = $1 AND UPPER(b.rwa_symbol) = UPPER($2)
             AND b.fee = $3 AND b.quality_pass
           ORDER BY b.checkpoint_run_id, b.source_skew_seconds,
                    b.evaluated_at DESC, b.id DESC
         ), selected AS (
           SELECT best.*, c.block_number
           FROM best JOIN v3_strategy_checkpoint_runs c
             ON c.id = best.checkpoint_run_id
           ORDER BY c.block_number DESC, c.id DESC
           LIMIT $4
         )
         SELECT s.basis_run_id, s.reference_mode,
                s.primary_reference_available, s.fallback_candidate,
                s.chainlink_price_x18, s.token_reference_usdg_x18,
                c.id::text AS checkpoint_run_id, c.risk_run_id::text,
                c.stream_key, c.chain_id::text, c.block_number::text,
                c.block_hash, c.block_timestamp, c.captured_at,
                c.target_set_hash, p.pool_address, p.rwa_symbol,
                p.rwa_address, p.fee, p.token0, p.token1, p.tick,
                p.sqrt_price_x96::text, p.liquidity::text,
                p.fee_growth_global0_x128::text,
                p.fee_growth_global1_x128::text,
                p.pool_price_x18::text, p.token_decimals
         FROM selected s
         JOIN v3_strategy_checkpoint_runs c ON c.id = s.checkpoint_run_id
         JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id = c.id
           AND UPPER(p.rwa_symbol) = UPPER($2) AND p.fee = $3
         ORDER BY c.block_number, c.id`,
        [input.streamKey, input.rwaSymbol, input.fee, input.lookback],
      );
      if (referenceResult.rows.length !== input.lookback) {
        throw new JoinedPolicyReplaySourceUnavailableError(
          `Pool ${input.rwaSymbol}/${input.fee} has ` +
          `${referenceResult.rows.length} of ${input.lookback} requested ` +
          "quality-passing joined checkpoints",
        );
      }
      const selected = referenceResult.rows.map(selectedReference);
      const firstRow = referenceResult.rows[0]!;
      const lastRow = referenceResult.rows.at(-1)!;
      for (let index = 0; index < referenceResult.rows.length; index += 1) {
        const row = referenceResult.rows[index]!;
        if (
          !same(row.pool_address, firstRow.pool_address) ||
          !same(row.rwa_address, firstRow.rwa_address) ||
          !same(row.token0, firstRow.token0) || !same(row.token1, firstRow.token1) ||
          row.fee !== firstRow.fee || row.chain_id !== firstRow.chain_id ||
          !same(row.target_set_hash, firstRow.target_set_hash) ||
          row.token_decimals !== firstRow.token_decimals ||
          (index > 0 && BigInt(referenceResult.rows[index - 1]!.block_number) >=
            BigInt(row.block_number))
        ) {
          throw new Error("Joined replay pool identity or checkpoint order changed");
        }
      }
      const quoteInPool = same(firstRow.token0, USDG) !== same(firstRow.token1, USDG);
      const rwaToken = same(firstRow.token0, USDG) ? firstRow.token1 : firstRow.token0;
      if (!quoteInPool || !same(rwaToken, firstRow.rwa_address)) {
        throw new Error("Joined replay pool token identity is invalid");
      }

      const coverageResult = await client.query<CoverageRow>(
        `SELECT b.checkpoint_run_id::text, b.quality_pass, b.reasons
           FROM perp_pool_basis_runs b
           JOIN v3_strategy_checkpoint_runs c ON c.id = b.checkpoint_run_id
           WHERE b.stream_key = $1 AND UPPER(b.rwa_symbol) = UPPER($2)
             AND b.fee = $3 AND c.block_number BETWEEN $4 AND $5`,
        [input.streamKey, input.rwaSymbol, input.fee,
          firstRow.block_number, lastRow.block_number],
      );
      const completeCostResult = await client.query<CostRow>(
        `SELECT id::text, computed_at, status, entry_cost_quote_raw::text,
                  rebalance_cost_quote_raw::text, exit_cost_quote_raw::text,
                  reasons, warnings
           FROM v3_guarded_cost_models
           WHERE stream_key = $1 AND LOWER(pool_address) = LOWER($2)
             AND UPPER(rwa_symbol) = UPPER($3) AND fee = $4
             AND status = 'complete'
           ORDER BY computed_at DESC, id DESC LIMIT 1`,
        [input.streamKey, firstRow.pool_address, input.rwaSymbol, input.fee],
      );
      const latestCostResult = await client.query<CostRow>(
        `SELECT id::text, computed_at, status, entry_cost_quote_raw::text,
                  rebalance_cost_quote_raw::text, exit_cost_quote_raw::text,
                  reasons, warnings
           FROM v3_guarded_cost_models
           WHERE stream_key = $1 AND LOWER(pool_address) = LOWER($2)
             AND UPPER(rwa_symbol) = UPPER($3) AND fee = $4
           ORDER BY computed_at DESC, id DESC LIMIT 1`,
        [input.streamKey, firstRow.pool_address, input.rwaSymbol, input.fee],
      );
      const cursorResult = await client.query<CursorRow>(
        `SELECT chain_id::text, target_set_hash, last_scanned_block::text
           FROM indexer_cursors WHERE stream_key = $1`,
        [input.streamKey],
      );
      const indexedPoolResult = await client.query<IndexedPoolRow>(
        `SELECT chain_id::text, target_set_hash, pool_address, rwa_address,
                  rwa_symbol, fee, enabled
           FROM indexer_pools
           WHERE stream_key = $1 AND LOWER(pool_address) = LOWER($2)`,
        [input.streamKey, firstRow.pool_address],
      );
      const swapResult = await client.query<SwapRow>(
        `SELECT block_number::text, (event_args->>'tick')::integer AS tick
           FROM v3_pool_events
           WHERE stream_key = $1 AND LOWER(pool_address) = LOWER($2)
             AND block_number > $3 AND block_number <= $4
             AND event_name = 'Swap'
           ORDER BY block_number, transaction_index, log_index`,
        [input.streamKey, firstRow.pool_address,
          firstRow.block_number, lastRow.block_number],
      );
      const cursor = cursorResult.rows[0];
      if (
        cursor === undefined || cursor.last_scanned_block === null ||
        cursor.chain_id !== firstRow.chain_id ||
        !same(cursor.target_set_hash, firstRow.target_set_hash) ||
        BigInt(cursor.last_scanned_block) < BigInt(lastRow.block_number)
      ) {
        throw new JoinedPolicyReplaySourceUnavailableError(
          "Indexer coverage does not reach the final joined checkpoint",
        );
      }
      const indexedPool = indexedPoolResult.rows[0];
      if (
        indexedPool === undefined || !indexedPool.enabled ||
        indexedPool.chain_id !== firstRow.chain_id || indexedPool.fee !== firstRow.fee ||
        !same(indexedPool.pool_address, firstRow.pool_address) ||
        !same(indexedPool.rwa_address, firstRow.rwa_address) ||
        indexedPool.rwa_symbol.toUpperCase() !== firstRow.rwa_symbol.toUpperCase() ||
        !same(indexedPool.target_set_hash, firstRow.target_set_hash)
      ) {
        throw new JoinedPolicyReplaySourceUnavailableError(
          "Joined replay pool is outside the enabled indexer target set",
        );
      }
      const checkpoints = selected.map((entry) => entry.checkpoint);
      let swapIndex = 0;
      const intervals = checkpoints.slice(0, -1).map((from, index) => {
        const to = checkpoints[index + 1]!;
        let pathMinTick = Math.min(from.pool.tick, to.pool.tick);
        let pathMaxTick = Math.max(from.pool.tick, to.pool.tick);
        let swapCount = 0n;
        while (
          swapIndex < swapResult.rows.length &&
          BigInt(swapResult.rows[swapIndex]!.block_number) <= from.run.blockNumber
        ) swapIndex += 1;
        while (
          swapIndex < swapResult.rows.length &&
          BigInt(swapResult.rows[swapIndex]!.block_number) <= to.run.blockNumber
        ) {
          const tick = swapResult.rows[swapIndex]!.tick;
          pathMinTick = Math.min(pathMinTick, tick);
          pathMaxTick = Math.max(pathMaxTick, tick);
          swapCount += 1n;
          swapIndex += 1;
        }
        return {
          fromRunId: from.run.checkpointRunId,
          pathMaxTick,
          pathMinTick,
          swapCount,
          toRunId: to.run.checkpointRunId,
        };
      });
      const oracleSource: OraclePolicyReplaySource = {
        checkpoints,
        fee: firstRow.fee,
        indexedThroughBlock: BigInt(cursor.last_scanned_block),
        intervals,
        poolAddress: firstRow.pool_address,
        quoteToken: USDG,
        rwaAddress: firstRow.rwa_address,
        rwaDecimals: firstRow.token_decimals!,
        rwaSymbol: firstRow.rwa_symbol,
        streamKey: input.streamKey,
        targetSetHash: firstRow.target_set_hash,
        token0: firstRow.token0,
        token1: firstRow.token1,
      };
      const result = {
        costModel: completeCost(
          completeCostResult.rows[0],
          latestCostResult.rows[0],
        ),
        coverage: coverage(coverageResult.rows),
        oracleSource,
        references: selected.map((entry) => entry.reference),
      };
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(replay: JoinedPolicyReplay): Promise<{
    readonly created: boolean;
    readonly replayRunId: string;
  }> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO v3_joined_policy_replay_runs (
         schema_version, stream_key, first_checkpoint_run_id,
         last_checkpoint_run_id, cost_model_id, computed_at, pool_address,
         rwa_symbol, fee, budget_quote, trigger_percent, half_widths,
         min_passing_checkpoints, min_window_hours,
         min_weekend_fallback_checkpoints,
         min_external_fallback_checkpoints, selected_checkpoints,
         primary_checkpoints, weekend_fallback_checkpoints,
         external_fallback_checkpoints, coverage_total_rows,
         coverage_passing_rows, coverage_rejected_rows, policy_set_hash,
         completed_candidates, excluded_candidates, methodology,
         execution_eligible, assumptions, snapshot
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,
         $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb,$30::jsonb
       ) ON CONFLICT (
         schema_version, stream_key, first_checkpoint_run_id,
         last_checkpoint_run_id, pool_address, policy_set_hash
       ) DO NOTHING RETURNING id::text`,
      [
        replay.schemaVersion,
        replay.streamKey,
        replay.firstCheckpointRunId,
        replay.lastCheckpointRunId,
        replay.costModel.modelId,
        replay.computedAt,
        replay.poolAddress,
        replay.rwaSymbol,
        replay.fee,
        replay.budgetQuote,
        replay.triggerPercent,
        json(replay.halfWidths),
        replay.evidence.requirements.minPassingCheckpoints,
        replay.evidence.requirements.minWindowHours,
        replay.evidence.requirements.minWeekendFallbackCheckpoints,
        replay.evidence.requirements.minExternalFallbackCheckpoints,
        replay.evidence.selectedCheckpoints,
        replay.evidence.primaryCheckpoints,
        replay.evidence.weekendFallbackCheckpoints,
        replay.evidence.externalFallbackCheckpoints,
        replay.coverage.totalRows,
        replay.coverage.passingRows,
        replay.coverage.rejectedRows,
        replay.policySetHash,
        replay.completedCandidates,
        replay.excludedCandidates,
        replay.methodology,
        replay.executionEligible,
        json(replay.assumptions),
        json(replay),
      ],
    );
    const id = result.rows[0]?.id;
    if (id !== undefined) return { created: true, replayRunId: id };
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id::text FROM v3_joined_policy_replay_runs
       WHERE schema_version = $1 AND stream_key = $2 AND
         first_checkpoint_run_id = $3 AND last_checkpoint_run_id = $4 AND
         LOWER(pool_address) = LOWER($5) AND policy_set_hash = $6`,
      [replay.schemaVersion, replay.streamKey, replay.firstCheckpointRunId,
        replay.lastCheckpointRunId, replay.poolAddress, replay.policySetHash],
    );
    const replayRunId = existing.rows[0]?.id;
    if (replayRunId === undefined) throw new Error("Joined replay conflict vanished");
    return { created: false, replayRunId };
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
