import pg from "pg";
import { USDG } from "../constants.js";
import { assertSchemaReady } from "../storage/compatibility.js";
import type {
  RangePolicyReplay,
  RangePolicyReplaySource,
  RangeReplayCheckpoint,
} from "./domain.js";

const { Pool } = pg;

export class RangePolicyReplaySourceUnavailableError extends Error {
  public constructor(message = "Policy replay checkpoints are unavailable") {
    super(message);
    this.name = "RangePolicyReplaySourceUnavailableError";
  }
}

interface SourceRow {
  block_hash: string;
  block_number: string;
  chain_id: string;
  fee: number;
  fee_growth_global0_x128: string;
  fee_growth_global1_x128: string;
  id: string;
  liquidity: string;
  observed_at: Date;
  pool_address: string;
  rwa_symbol: string;
  sqrt_price_x96: string;
  tick: number;
  token0: string;
  token1: string;
}

interface SwapRow {
  block_number: string;
  tick: number;
}

export interface RangePolicyReplaySaveResult {
  readonly created: boolean;
  readonly replayRunId: string;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function checkpoint(row: SourceRow): RangeReplayCheckpoint {
  return {
    pool: {
      feeGrowthGlobal0X128: BigInt(row.fee_growth_global0_x128),
      feeGrowthGlobal1X128: BigInt(row.fee_growth_global1_x128),
      liquidity: BigInt(row.liquidity),
      sqrtPriceX96: BigInt(row.sqrt_price_x96),
      tick: row.tick,
    },
    run: {
      blockHash: row.block_hash,
      blockNumber: BigInt(row.block_number),
      chainId: Number(row.chain_id),
      observedAt: row.observed_at.toISOString(),
      runId: row.id,
    },
  };
}

export class PostgresRangePolicyReplayStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async assertReady(): Promise<void> {
    await assertSchemaReady(this.pool);
  }

  public async load(input: {
    readonly fee: number;
    readonly firstRunId?: string;
    readonly lastRunId?: string;
    readonly lookback: number;
    readonly rwaSymbol: string;
    readonly streamKey: string;
  }): Promise<RangePolicyReplaySource> {
    if (
      !Number.isSafeInteger(input.lookback) ||
      input.lookback < 2 || input.lookback > 64
    ) {
      throw new Error("Policy replay checkpoint count must be between 2 and 64");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const explicit = input.firstRunId !== undefined && input.lastRunId !== undefined;
      let rows: SourceRow[];
      if (explicit) {
        const endpoints = await client.query<SourceRow>(
          `SELECT r.id, r.chain_id::text, r.block_number::text,
                  r.block_hash, r.observed_at, p.pool_address, p.rwa_symbol,
                  p.fee, p.token0, p.token1, p.tick,
                  p.sqrt_price_x96::text, p.liquidity::text,
                  p.fee_growth_global0_x128::text,
                  p.fee_growth_global1_x128::text
           FROM v3_fee_accounting_runs r
           JOIN v3_pool_fee_accounting p ON p.run_id = r.id
           WHERE r.stream_key = $1 AND r.id IN ($2, $3)
             AND UPPER(p.rwa_symbol) = UPPER($4) AND p.fee = $5
           ORDER BY r.block_number, r.id`,
          [
            input.streamKey,
            input.firstRunId,
            input.lastRunId,
            input.rwaSymbol,
            input.fee,
          ],
        );
        if (
          endpoints.rows.length !== 2 ||
          endpoints.rows[0]?.id !== input.firstRunId ||
          endpoints.rows[1]?.id !== input.lastRunId
        ) {
          throw new RangePolicyReplaySourceUnavailableError(
            "Explicit replay endpoints are missing or not in increasing block order",
          );
        }
        rows = (await client.query<SourceRow>(
          `SELECT r.id, r.chain_id::text, r.block_number::text,
                  r.block_hash, r.observed_at, p.pool_address, p.rwa_symbol,
                  p.fee, p.token0, p.token1, p.tick,
                  p.sqrt_price_x96::text, p.liquidity::text,
                  p.fee_growth_global0_x128::text,
                  p.fee_growth_global1_x128::text
           FROM v3_fee_accounting_runs r
           JOIN v3_pool_fee_accounting p ON p.run_id = r.id
           WHERE r.stream_key = $1
             AND r.block_number BETWEEN $2 AND $3
             AND UPPER(p.rwa_symbol) = UPPER($4) AND p.fee = $5
           ORDER BY r.block_number, r.id`,
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
          `SELECT r.id, r.chain_id::text, r.block_number::text,
                  r.block_hash, r.observed_at, p.pool_address, p.rwa_symbol,
                  p.fee, p.token0, p.token1, p.tick,
                  p.sqrt_price_x96::text, p.liquidity::text,
                  p.fee_growth_global0_x128::text,
                  p.fee_growth_global1_x128::text
           FROM v3_fee_accounting_runs r
           JOIN v3_pool_fee_accounting p ON p.run_id = r.id
           WHERE r.stream_key = $1
             AND UPPER(p.rwa_symbol) = UPPER($2) AND p.fee = $3
           ORDER BY r.block_number DESC, r.id DESC
           LIMIT $4`,
          [input.streamKey, input.rwaSymbol, input.fee, input.lookback],
        );
        if (latest.rows.length !== input.lookback) {
          throw new RangePolicyReplaySourceUnavailableError(
            `Pool ${input.rwaSymbol}/${input.fee} has ${latest.rows.length} of ` +
            `${input.lookback} requested checkpoints`,
          );
        }
        rows = [...latest.rows].reverse();
      }
      if (rows.length < 2) {
        throw new RangePolicyReplaySourceUnavailableError(
          "Policy replay requires at least two selected checkpoints",
        );
      }
      if (rows.length > 64) {
        throw new RangePolicyReplaySourceUnavailableError(
          `Policy replay selected ${rows.length} checkpoints; maximum is 64`,
        );
      }
      const first = rows[0]!;
      for (const row of rows) {
        if (
          !sameAddress(first.pool_address, row.pool_address) ||
          !sameAddress(first.token0, row.token0) ||
          !sameAddress(first.token1, row.token1) ||
          first.rwa_symbol !== row.rwa_symbol || first.fee !== row.fee
        ) {
          throw new Error("Policy replay pool identity changed across checkpoints");
        }
      }
      if (explicit && rows.at(-1)?.id !== input.lastRunId) {
        throw new Error("Explicit replay range did not end at the requested run");
      }
      const quoteInPool = sameAddress(first.token0, USDG) !==
        sameAddress(first.token1, USDG);
      if (!quoteInPool) {
        throw new Error("Policy replay pool does not contain canonical USDG exactly once");
      }
      const last = rows.at(-1)!;
      const swaps = await client.query<SwapRow>(
        `SELECT block_number::text,
                (event_args->>'tick')::integer AS tick
         FROM v3_pool_events
         WHERE stream_key = $1 AND pool_address = (
             SELECT pool_address FROM indexer_pools
             WHERE stream_key = $1 AND LOWER(pool_address) = LOWER($2)
               AND enabled
           )
           AND block_number > $3 AND block_number <= $4
           AND event_name = 'Swap'
         ORDER BY block_number, log_index`,
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
          fromRunId: from.run.runId,
          pathMaxTick,
          pathMinTick,
          swapCount,
          toRunId: to.run.runId,
        };
      });
      await client.query("COMMIT");
      return {
        checkpoints,
        fee: first.fee,
        intervals,
        poolAddress: first.pool_address,
        quoteToken: USDG,
        rwaSymbol: first.rwa_symbol,
        streamKey: input.streamKey,
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

  public async save(
    replay: RangePolicyReplay,
  ): Promise<RangePolicyReplaySaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `INSERT INTO v3_range_policy_replay_runs (
           schema_version, stream_key, first_accounting_run_id,
           last_accounting_run_id, computed_at, pool_address, rwa_symbol,
           fee, token0, token1, quote_token, quote_decimals, budget_quote,
           entry_cost_quote, rebalance_cost_quote, trigger_percent,
           tick_spacing, checkpoint_count, interval_count, policy_set_hash,
           methodology, execution_eligible, completed_candidates,
           excluded_candidates, assumptions
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
           $17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb
         )
         ON CONFLICT (
           schema_version, stream_key, first_accounting_run_id,
           last_accounting_run_id, pool_address, policy_set_hash
         ) DO NOTHING
         RETURNING id`,
        [
          replay.schemaVersion,
          replay.streamKey,
          replay.first.runId,
          replay.last.runId,
          replay.computedAt,
          replay.poolAddress.toLowerCase(),
          replay.rwaSymbol,
          replay.fee,
          replay.token0.toLowerCase(),
          replay.token1.toLowerCase(),
          replay.quoteToken.toLowerCase(),
          replay.quoteDecimals,
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
          `SELECT id FROM v3_range_policy_replay_runs
           WHERE schema_version = $1 AND stream_key = $2
             AND first_accounting_run_id = $3
             AND last_accounting_run_id = $4
             AND pool_address = $5 AND policy_set_hash = $6`,
          [
            replay.schemaVersion,
            replay.streamKey,
            replay.first.runId,
            replay.last.runId,
            replay.poolAddress.toLowerCase(),
            replay.policySetHash,
          ],
        );
        replayRunId = existing.rows[0]?.id;
        if (replayRunId === undefined) {
          throw new Error("PostgreSQL did not resolve the replay conflict");
        }
        await client.query("COMMIT");
        return { created: false, replayRunId };
      }
      for (const candidate of replay.candidates) {
        await client.query(
          `INSERT INTO v3_range_policy_replay_candidates (
             replay_run_id, half_width_spacings, status, failure_reason,
             failure_run_id, rank, completed_intervals, rebalances,
             total_cost_quote, fee_value_quote, max_drawdown_ppm,
             final_liquidity, final_tick_lower, final_tick_upper,
             final_nav_quote, hodl_end_value_quote, absolute_pnl_quote,
             lp_alpha_quote
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18
           )`,
          [
            replayRunId,
            candidate.halfWidthSpacings,
            candidate.status,
            candidate.failureReason,
            candidate.failureRunId,
            candidate.rank,
            candidate.completedIntervals,
            candidate.rebalances,
            candidate.totalCostQuote,
            candidate.feeValueQuote,
            candidate.maxDrawdownPpm,
            candidate.finalLiquidity,
            candidate.finalTickLower,
            candidate.finalTickUpper,
            candidate.finalNavQuote,
            candidate.hodlEndValueQuote,
            candidate.absolutePnlQuote,
            candidate.lpAlphaQuote,
          ],
        );
        for (const step of candidate.steps) {
          await client.query(
            `INSERT INTO v3_range_policy_replay_steps (
               replay_run_id, half_width_spacings, step_index,
               from_accounting_run_id, to_accounting_run_id,
               tick_lower, tick_upper, path_min_tick, path_max_tick,
               fee0, fee1, fee_value_quote, nav_quote, hodl_value_quote,
               lp_alpha_quote, rebalanced, action_cost_quote
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               $17
             )`,
            [
              replayRunId,
              candidate.halfWidthSpacings,
              step.index,
              step.fromRunId,
              step.toRunId,
              step.tickLower,
              step.tickUpper,
              step.pathMinTick,
              step.pathMaxTick,
              step.fee0,
              step.fee1,
              step.feeValueQuote,
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
