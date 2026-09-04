import pg from "pg";
import { USDG } from "../constants.js";
import { SCHEMA_SQL } from "../storage/schema.js";
import type {
  OraclePolicyCheckpoint,
  OraclePolicyReplay,
  OraclePolicyReplaySource,
} from "./domain.js";

const { Pool } = pg;

const SOURCE_SELECT = `
  SELECT r.id::text AS checkpoint_run_id, r.risk_run_id::text,
         r.chain_id::text, r.block_number::text, r.block_hash,
         r.block_timestamp, r.captured_at, r.target_set_hash,
         p.pool_address, p.rwa_symbol, p.rwa_address, p.fee,
         p.token0, p.token1, p.tick, p.sqrt_price_x96::text,
         p.liquidity::text, p.fee_growth_global0_x128::text,
         p.fee_growth_global1_x128::text, p.status, p.reasons,
         p.pool_price_x18::text, p.oracle_price_x18::text,
         p.token_decimals,
         c.block_number::text AS canonical_block_number,
         c.expected_hash AS canonical_expected_hash,
         c.observed_hash AS canonical_observed_hash,
         c.canonical
  FROM v3_strategy_checkpoint_runs r
  JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id = r.id
  LEFT JOIN risk_snapshot_canonicality c ON c.risk_run_id = r.risk_run_id
`;

export class OraclePolicyReplaySourceUnavailableError extends Error {
  public constructor(message = "Oracle policy replay checkpoints are unavailable") {
    super(message);
    this.name = "OraclePolicyReplaySourceUnavailableError";
  }
}

interface SourceRow {
  block_hash: string;
  block_number: string;
  block_timestamp: Date;
  canonical: boolean | null;
  canonical_block_number: string | null;
  canonical_expected_hash: string | null;
  canonical_observed_hash: string | null;
  captured_at: Date;
  chain_id: string;
  checkpoint_run_id: string;
  fee: number;
  fee_growth_global0_x128: string;
  fee_growth_global1_x128: string;
  liquidity: string;
  oracle_price_x18: string | null;
  pool_address: string;
  pool_price_x18: string;
  reasons: unknown;
  risk_run_id: string;
  rwa_address: string;
  rwa_symbol: string;
  sqrt_price_x96: string;
  status: string;
  target_set_hash: string;
  tick: number;
  token0: string;
  token1: string;
  token_decimals: number | null;
}

interface CursorRow {
  chain_id: string;
  last_scanned_block: string | null;
  target_set_hash: string;
}

interface IndexedPoolRow {
  chain_id: string;
  created_block: string;
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

export interface OraclePolicyReplaySaveResult {
  readonly created: boolean;
  readonly replayRunId: string;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function reasons(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Oracle policy checkpoint reasons are malformed");
  }
  return value as string[];
}

function checkpoint(row: SourceRow): OraclePolicyCheckpoint {
  if (row.status !== "valid" && row.status !== "excluded") {
    throw new Error(`Oracle policy checkpoint ${row.checkpoint_run_id} has invalid status`);
  }
  if (row.token_decimals === null) {
    throw new OraclePolicyReplaySourceUnavailableError(
      `Checkpoint ${row.checkpoint_run_id} has no RWA token decimals`,
    );
  }
  return {
    oraclePriceX18: row.oracle_price_x18 === null
      ? null
      : BigInt(row.oracle_price_x18),
    pool: {
      feeGrowthGlobal0X128: BigInt(row.fee_growth_global0_x128),
      feeGrowthGlobal1X128: BigInt(row.fee_growth_global1_x128),
      liquidity: BigInt(row.liquidity),
      sqrtPriceX96: BigInt(row.sqrt_price_x96),
      tick: row.tick,
    },
    poolPriceX18: BigInt(row.pool_price_x18),
    reasons: reasons(row.reasons),
    run: {
      blockHash: row.block_hash,
      blockNumber: BigInt(row.block_number),
      blockTimestamp: row.block_timestamp.toISOString(),
      capturedAt: row.captured_at.toISOString(),
      chainId: Number(row.chain_id),
      checkpointRunId: row.checkpoint_run_id,
      riskRunId: row.risk_run_id,
    },
    status: row.status,
    tokenDecimals: row.token_decimals,
  };
}

function assertCanonical(row: SourceRow): void {
  if (
    row.canonical !== true ||
    row.canonical_block_number !== row.block_number ||
    row.canonical_expected_hash === null ||
    row.canonical_observed_hash === null ||
    !sameHash(row.canonical_expected_hash, row.block_hash) ||
    !sameHash(row.canonical_observed_hash, row.block_hash)
  ) {
    throw new OraclePolicyReplaySourceUnavailableError(
      `Checkpoint ${row.checkpoint_run_id} has no matching stored canonicality proof`,
    );
  }
}

export class PostgresOraclePolicyReplayStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async load(input: {
    readonly fee: number;
    readonly firstCheckpointRunId?: string;
    readonly lastCheckpointRunId?: string;
    readonly lookback: number;
    readonly rwaSymbol: string;
    readonly streamKey: string;
  }): Promise<OraclePolicyReplaySource> {
    if (
      !Number.isSafeInteger(input.lookback) ||
      input.lookback < 2 || input.lookback > 256
    ) {
      throw new Error("Oracle policy replay checkpoint count must be between 2 and 256");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const explicit = input.firstCheckpointRunId !== undefined &&
        input.lastCheckpointRunId !== undefined;
      let rows: SourceRow[];
      if (explicit) {
        const endpoints = await client.query<SourceRow>(
          `${SOURCE_SELECT}
           WHERE r.stream_key = $1 AND r.id IN ($2, $3)
             AND UPPER(p.rwa_symbol) = UPPER($4) AND p.fee = $5
           ORDER BY r.block_number, r.id`,
          [
            input.streamKey,
            input.firstCheckpointRunId,
            input.lastCheckpointRunId,
            input.rwaSymbol,
            input.fee,
          ],
        );
        if (
          endpoints.rows.length !== 2 ||
          endpoints.rows[0]?.checkpoint_run_id !== input.firstCheckpointRunId ||
          endpoints.rows[1]?.checkpoint_run_id !== input.lastCheckpointRunId
        ) {
          throw new OraclePolicyReplaySourceUnavailableError(
            "Explicit oracle replay endpoints are missing or not in increasing block order",
          );
        }
        rows = (await client.query<SourceRow>(
          `${SOURCE_SELECT}
           WHERE r.stream_key = $1
             AND r.block_number BETWEEN $2 AND $3
             AND UPPER(p.rwa_symbol) = UPPER($4) AND p.fee = $5
           ORDER BY r.block_number, r.id
           LIMIT 257`,
          [
            input.streamKey,
            endpoints.rows[0]!.block_number,
            endpoints.rows[1]!.block_number,
            input.rwaSymbol,
            input.fee,
          ],
        )).rows;
      } else {
        const latest = await client.query<SourceRow>(
          `${SOURCE_SELECT}
           WHERE r.stream_key = $1
             AND UPPER(p.rwa_symbol) = UPPER($2) AND p.fee = $3
           ORDER BY r.block_number DESC, r.id DESC
           LIMIT $4`,
          [input.streamKey, input.rwaSymbol, input.fee, input.lookback],
        );
        if (latest.rows.length !== input.lookback) {
          throw new OraclePolicyReplaySourceUnavailableError(
            `Pool ${input.rwaSymbol}/${input.fee} has ${latest.rows.length} of ` +
            `${input.lookback} requested strategy checkpoints`,
          );
        }
        rows = [...latest.rows].reverse();
      }
      if (rows.length < 2) {
        throw new OraclePolicyReplaySourceUnavailableError(
          "Oracle policy replay requires at least two selected checkpoints",
        );
      }
      if (rows.length > 256) {
        throw new OraclePolicyReplaySourceUnavailableError(
          `Oracle policy replay selected more than 256 checkpoints`,
        );
      }

      const first = rows[0]!;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        assertCanonical(row);
        if (
          !sameAddress(first.pool_address, row.pool_address) ||
          !sameAddress(first.rwa_address, row.rwa_address) ||
          !sameAddress(first.token0, row.token0) ||
          !sameAddress(first.token1, row.token1) ||
          first.rwa_symbol.toUpperCase() !== row.rwa_symbol.toUpperCase() ||
          first.fee !== row.fee || first.chain_id !== row.chain_id ||
          !sameHash(first.target_set_hash, row.target_set_hash)
        ) {
          throw new Error("Oracle policy pool identity changed across checkpoints");
        }
        if (
          index > 0 &&
          BigInt(rows[index - 1]!.block_number) >= BigInt(row.block_number)
        ) {
          throw new OraclePolicyReplaySourceUnavailableError(
            "Oracle policy checkpoints are not strictly block-ordered",
          );
        }
        if (
          row.token_decimals === null ||
          row.token_decimals !== first.token_decimals
        ) {
          throw new OraclePolicyReplaySourceUnavailableError(
            "RWA token decimals changed or are unavailable in the replay window",
          );
        }
      }
      if (
        explicit &&
        rows.at(-1)?.checkpoint_run_id !== input.lastCheckpointRunId
      ) {
        throw new Error("Explicit oracle replay range did not end at the requested checkpoint");
      }
      const quoteInPool = sameAddress(first.token0, USDG) !==
        sameAddress(first.token1, USDG);
      if (!quoteInPool) {
        throw new Error("Oracle policy pool does not contain canonical USDG exactly once");
      }
      const rwaToken = sameAddress(first.token0, USDG) ? first.token1 : first.token0;
      if (!sameAddress(rwaToken, first.rwa_address)) {
        throw new Error("Oracle policy pool RWA address does not match token identity");
      }

      const cursorResult = await client.query<CursorRow>(
        `SELECT chain_id::text, target_set_hash, last_scanned_block::text
         FROM indexer_cursors WHERE stream_key = $1`,
        [input.streamKey],
      );
      const cursor = cursorResult.rows[0];
      const last = rows.at(-1)!;
      if (
        cursor === undefined || cursor.last_scanned_block === null ||
        cursor.chain_id !== first.chain_id ||
        !sameHash(cursor.target_set_hash, first.target_set_hash) ||
        BigInt(cursor.last_scanned_block) < BigInt(last.block_number)
      ) {
        throw new OraclePolicyReplaySourceUnavailableError(
          `Indexer coverage does not prove the selected window through block ${last.block_number}`,
        );
      }
      const indexedPoolResult = await client.query<IndexedPoolRow>(
        `SELECT chain_id::text, created_block::text, enabled, fee,
                pool_address, rwa_address, rwa_symbol, target_set_hash
         FROM indexer_pools
         WHERE stream_key = $1 AND LOWER(pool_address) = LOWER($2)`,
        [input.streamKey, first.pool_address],
      );
      const indexedPool = indexedPoolResult.rows[0];
      if (
        indexedPool === undefined || !indexedPool.enabled ||
        indexedPool.chain_id !== first.chain_id || indexedPool.fee !== first.fee ||
        !sameAddress(indexedPool.pool_address, first.pool_address) ||
        !sameAddress(indexedPool.rwa_address, first.rwa_address) ||
        indexedPool.rwa_symbol.toUpperCase() !== first.rwa_symbol.toUpperCase() ||
        !sameHash(indexedPool.target_set_hash, first.target_set_hash) ||
        BigInt(indexedPool.created_block) > BigInt(first.block_number)
      ) {
        throw new OraclePolicyReplaySourceUnavailableError(
          "Selected pool is not covered by the matching enabled indexer target set",
        );
      }

      const swaps = await client.query<SwapRow>(
        `SELECT block_number::text,
                (event_args->>'tick')::integer AS tick
         FROM v3_pool_events
         WHERE stream_key = $1 AND LOWER(pool_address) = LOWER($2)
           AND block_number > $3 AND block_number <= $4
           AND event_name = 'Swap'
         ORDER BY block_number, transaction_index, log_index`,
        [input.streamKey, first.pool_address, first.block_number, last.block_number],
      );
      const checkpoints = rows.map(checkpoint);
      let swapIndex = 0;
      const intervals = checkpoints.slice(0, -1).map((from, index) => {
        const to = checkpoints[index + 1]!;
        let pathMinTick = Math.min(from.pool.tick, to.pool.tick);
        let pathMaxTick = Math.max(from.pool.tick, to.pool.tick);
        let swapCount = 0n;
        while (
          swapIndex < swaps.rows.length &&
          BigInt(swaps.rows[swapIndex]!.block_number) <= from.run.blockNumber
        ) {
          swapIndex += 1;
        }
        while (
          swapIndex < swaps.rows.length &&
          BigInt(swaps.rows[swapIndex]!.block_number) <= to.run.blockNumber
        ) {
          const tick = swaps.rows[swapIndex]!.tick;
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
      await client.query("COMMIT");
      return {
        checkpoints,
        fee: first.fee,
        indexedThroughBlock: BigInt(cursor.last_scanned_block),
        intervals,
        poolAddress: first.pool_address,
        quoteToken: USDG,
        rwaAddress: first.rwa_address,
        rwaDecimals: first.token_decimals!,
        rwaSymbol: first.rwa_symbol,
        streamKey: input.streamKey,
        targetSetHash: first.target_set_hash,
        token0: first.token0,
        token1: first.token1,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(replay: OraclePolicyReplay): Promise<OraclePolicyReplaySaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `INSERT INTO v3_oracle_policy_replay_runs (
           schema_version, stream_key, first_checkpoint_run_id,
           last_checkpoint_run_id, computed_at, pool_address, rwa_symbol,
           rwa_address, fee, token0, token1, quote_token, quote_decimals,
           rwa_decimals, target_set_hash, indexed_through_block, budget_quote,
           entry_cost_quote, rebalance_cost_quote, trigger_percent,
           tick_spacing, checkpoint_count, interval_count, policy_set_hash,
           methodology, execution_eligible, completed_candidates,
           excluded_candidates, assumptions
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
           $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb
         )
         ON CONFLICT (
           schema_version, stream_key, first_checkpoint_run_id,
           last_checkpoint_run_id, pool_address, policy_set_hash
         ) DO NOTHING
         RETURNING id`,
        [
          replay.schemaVersion,
          replay.streamKey,
          replay.first.checkpointRunId,
          replay.last.checkpointRunId,
          replay.computedAt,
          replay.poolAddress.toLowerCase(),
          replay.rwaSymbol,
          replay.rwaAddress.toLowerCase(),
          replay.fee,
          replay.token0.toLowerCase(),
          replay.token1.toLowerCase(),
          replay.quoteToken.toLowerCase(),
          replay.quoteDecimals,
          replay.rwaDecimals,
          replay.targetSetHash,
          replay.indexedThroughBlock,
          replay.budgetQuote,
          replay.entryCostQuote,
          replay.rebalanceCostQuote,
          replay.triggerPercent,
          replay.tickSpacing,
          replay.checkpointCount,
          replay.intervalCount,
          replay.policySetHash,
          replay.methodology,
          replay.executionEligible,
          replay.completedCandidates,
          replay.excludedCandidates,
          JSON.stringify(replay.assumptions),
        ],
      );
      let replayRunId = result.rows[0]?.id;
      if (replayRunId === undefined) {
        const existing = await client.query<{ id: string }>(
          `SELECT id::text FROM v3_oracle_policy_replay_runs
           WHERE schema_version = $1 AND stream_key = $2
             AND first_checkpoint_run_id = $3 AND last_checkpoint_run_id = $4
             AND LOWER(pool_address) = LOWER($5) AND policy_set_hash = $6`,
          [
            replay.schemaVersion,
            replay.streamKey,
            replay.first.checkpointRunId,
            replay.last.checkpointRunId,
            replay.poolAddress,
            replay.policySetHash,
          ],
        );
        replayRunId = existing.rows[0]?.id;
        if (replayRunId === undefined) {
          throw new Error("PostgreSQL did not resolve the oracle replay conflict");
        }
        await client.query("COMMIT");
        return { created: false, replayRunId };
      }

      for (const candidate of replay.candidates) {
        await client.query(
          `INSERT INTO v3_oracle_policy_replay_candidates (
             replay_run_id, half_width_spacings, status, failure_reason,
             failure_checkpoint_run_id, rank, completed_intervals, rebalances,
             total_cost_quote, marked_fee_value_quote, max_drawdown_ppm,
             initial_amount0, initial_amount1, initial_nav_quote,
             final_liquidity, final_tick_lower, final_tick_upper,
             final_amount0, final_amount1, final_nav_quote,
             hodl_end_value_quote, absolute_pnl_quote, lp_alpha_quote
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             $18,$19,$20,$21,$22,$23
           )`,
          [
            replayRunId,
            candidate.halfWidthSpacings,
            candidate.status,
            candidate.failureReason,
            candidate.failureCheckpointRunId,
            candidate.rank,
            candidate.completedIntervals,
            candidate.rebalances,
            candidate.totalCostQuote,
            candidate.markedFeeValueQuote,
            candidate.maxDrawdownPpm,
            candidate.initialAmount0,
            candidate.initialAmount1,
            candidate.initialNavQuote,
            candidate.finalLiquidity,
            candidate.finalTickLower,
            candidate.finalTickUpper,
            candidate.finalAmount0,
            candidate.finalAmount1,
            candidate.finalNavQuote,
            candidate.hodlEndValueQuote,
            candidate.absolutePnlQuote,
            candidate.lpAlphaQuote,
          ],
        );
        for (const step of candidate.steps) {
          await client.query(
            `INSERT INTO v3_oracle_policy_replay_steps (
               replay_run_id, half_width_spacings, step_index,
               from_checkpoint_run_id, to_checkpoint_run_id,
               active_tick_lower, active_tick_upper,
               ending_tick_lower, ending_tick_upper, path_min_tick,
               path_max_tick, fee0, fee1, fee_value_quote, end_amount0,
               end_amount1, pool_spot_nav_before_action_quote,
               oracle_price_x18, pool_price_x18, nav_quote, hodl_value_quote,
               lp_alpha_quote, rebalanced, action_cost_quote
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               $17,$18,$19,$20,$21,$22,$23,$24
             )`,
            [
              replayRunId,
              candidate.halfWidthSpacings,
              step.index,
              step.fromCheckpointRunId,
              step.toCheckpointRunId,
              step.activeTickLower,
              step.activeTickUpper,
              step.endingTickLower,
              step.endingTickUpper,
              step.pathMinTick,
              step.pathMaxTick,
              step.fee0,
              step.fee1,
              step.feeValueQuote,
              step.endAmount0,
              step.endAmount1,
              step.poolSpotNavBeforeActionQuote,
              step.oraclePriceX18,
              step.poolPriceX18,
              step.navQuote,
              step.hodlValueQuote,
              step.lpAlphaQuote,
              step.rebalanced,
              step.actionCostQuote,
            ],
          );
        }
      }
      await client.query("COMMIT");
      return { created: true, replayRunId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
