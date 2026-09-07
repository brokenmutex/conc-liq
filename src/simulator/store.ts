import pg from "pg";
import { USDG } from "../constants.js";
import { assertSchemaReady } from "../storage/compatibility.js";
import type {
  RangePolicySimulation,
  RangeSimulationSource,
} from "./domain.js";

const { Pool } = pg;

export class RangeSimulationSourceUnavailableError extends Error {
  public constructor(message = "Two accounting runs are required for simulation") {
    super(message);
    this.name = "RangeSimulationSourceUnavailableError";
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

interface SwapPathRow {
  max_tick: number | null;
  min_tick: number | null;
  swap_count: string;
}

export interface RangeSimulationSaveResult {
  readonly created: boolean;
  readonly simulationRunId: string;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export class PostgresRangeSimulationStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async assertReady(): Promise<void> {
    await assertSchemaReady(this.pool);
  }

  public async load(input: {
    readonly fee: number;
    readonly fromRunId?: string;
    readonly rwaSymbol: string;
    readonly streamKey: string;
    readonly toRunId?: string;
  }): Promise<RangeSimulationSource> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const explicit = input.fromRunId !== undefined && input.toRunId !== undefined;
      const result = explicit
        ? await client.query<SourceRow>(
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
            input.fromRunId,
            input.toRunId,
            input.rwaSymbol,
            input.fee,
          ],
        )
        : await client.query<SourceRow>(
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
           LIMIT 2`,
          [input.streamKey, input.rwaSymbol, input.fee],
        );
      if (result.rows.length !== 2) {
        throw new RangeSimulationSourceUnavailableError(
          `Pool ${input.rwaSymbol}/${input.fee} does not have two selected checkpoints`,
        );
      }
      const rows = [...result.rows].sort((left, right) =>
        BigInt(left.block_number) < BigInt(right.block_number) ? -1 : 1
      );
      const [from, to] = rows;
      if (from === undefined || to === undefined) {
        throw new RangeSimulationSourceUnavailableError();
      }
      if (
        explicit &&
        (from.id !== input.fromRunId || to.id !== input.toRunId)
      ) {
        throw new Error("Explicit simulation runs are not in increasing block order");
      }
      if (
        !sameAddress(from.pool_address, to.pool_address) ||
        !sameAddress(from.token0, to.token0) ||
        !sameAddress(from.token1, to.token1) ||
        from.rwa_symbol !== to.rwa_symbol || from.fee !== to.fee
      ) {
        throw new Error("Simulation pool identity changed across checkpoints");
      }
      const quoteInPool = sameAddress(from.token0, USDG) !==
        sameAddress(from.token1, USDG);
      if (!quoteInPool) {
        throw new Error("Simulation pool does not contain canonical USDG exactly once");
      }
      const path = await client.query<SwapPathRow>(
        `SELECT MIN((event_args->>'tick')::integer) AS min_tick,
                MAX((event_args->>'tick')::integer) AS max_tick,
                COUNT(*)::text AS swap_count
         FROM v3_pool_events
         WHERE stream_key = $1 AND pool_address = (
             SELECT pool_address FROM indexer_pools
             WHERE stream_key = $1 AND LOWER(pool_address) = LOWER($2)
               AND enabled
           )
           AND block_number > $3 AND block_number <= $4
           AND event_name = 'Swap'`,
        [input.streamKey, from.pool_address, from.block_number, to.block_number],
      );
      const pathRow = path.rows[0];
      if (pathRow === undefined) throw new Error("Swap-path query returned no row");
      await client.query("COMMIT");
      return {
        fee: from.fee,
        from: {
          blockHash: from.block_hash,
          blockNumber: BigInt(from.block_number),
          chainId: Number(from.chain_id),
          observedAt: from.observed_at.toISOString(),
          runId: from.id,
        },
        fromPool: {
          feeGrowthGlobal0X128: BigInt(from.fee_growth_global0_x128),
          feeGrowthGlobal1X128: BigInt(from.fee_growth_global1_x128),
          liquidity: BigInt(from.liquidity),
          sqrtPriceX96: BigInt(from.sqrt_price_x96),
          tick: from.tick,
        },
        pathMaxTick: Math.max(
          from.tick,
          to.tick,
          pathRow.max_tick ?? from.tick,
        ),
        pathMinTick: Math.min(
          from.tick,
          to.tick,
          pathRow.min_tick ?? from.tick,
        ),
        poolAddress: from.pool_address,
        quoteToken: USDG,
        rwaSymbol: from.rwa_symbol,
        streamKey: input.streamKey,
        swapCount: BigInt(pathRow.swap_count),
        to: {
          blockHash: to.block_hash,
          blockNumber: BigInt(to.block_number),
          chainId: Number(to.chain_id),
          observedAt: to.observed_at.toISOString(),
          runId: to.id,
        },
        toPool: {
          feeGrowthGlobal0X128: BigInt(to.fee_growth_global0_x128),
          feeGrowthGlobal1X128: BigInt(to.fee_growth_global1_x128),
          liquidity: BigInt(to.liquidity),
          sqrtPriceX96: BigInt(to.sqrt_price_x96),
          tick: to.tick,
        },
        token0: from.token0,
        token1: from.token1,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(
    simulation: RangePolicySimulation,
  ): Promise<RangeSimulationSaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `INSERT INTO v3_range_simulation_runs (
           schema_version, stream_key, from_accounting_run_id,
           to_accounting_run_id, computed_at, pool_address, rwa_symbol,
           fee, token0, token1, quote_token, quote_decimals, budget_quote,
           cost_quote, tick_spacing, path_min_tick, path_max_tick,
           swap_count, policy_set_hash, methodology, execution_eligible,
           completed_candidates, excluded_candidates, assumptions
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
           $17,$18,$19,$20,$21,$22,$23,$24::jsonb
         )
         ON CONFLICT (
           schema_version, stream_key, from_accounting_run_id,
           to_accounting_run_id, pool_address, policy_set_hash
         ) DO NOTHING
         RETURNING id`,
        [
          simulation.schemaVersion,
          simulation.streamKey,
          simulation.from.runId,
          simulation.to.runId,
          simulation.computedAt,
          simulation.poolAddress.toLowerCase(),
          simulation.rwaSymbol,
          simulation.fee,
          simulation.token0.toLowerCase(),
          simulation.token1.toLowerCase(),
          simulation.quoteToken.toLowerCase(),
          simulation.quoteDecimals,
          simulation.budgetQuote,
          simulation.costQuote,
          simulation.tickSpacing,
          simulation.pathMinTick,
          simulation.pathMaxTick,
          simulation.swapCount,
          simulation.policySetHash,
          simulation.methodology,
          simulation.executionEligible,
          simulation.completedCandidates,
          simulation.excludedCandidates,
          JSON.stringify(simulation.assumptions),
        ],
      );
      let simulationRunId = result.rows[0]?.id;
      if (simulationRunId === undefined) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM v3_range_simulation_runs
           WHERE schema_version = $1 AND stream_key = $2
             AND from_accounting_run_id = $3 AND to_accounting_run_id = $4
             AND pool_address = $5 AND policy_set_hash = $6`,
          [
            simulation.schemaVersion,
            simulation.streamKey,
            simulation.from.runId,
            simulation.to.runId,
            simulation.poolAddress.toLowerCase(),
            simulation.policySetHash,
          ],
        );
        simulationRunId = existing.rows[0]?.id;
        if (simulationRunId === undefined) {
          throw new Error("PostgreSQL did not resolve the simulation conflict");
        }
        await client.query("COMMIT");
        return { created: false, simulationRunId };
      }
      for (const candidate of simulation.candidates) {
        await client.query(
          `INSERT INTO v3_range_simulation_candidates (
             simulation_run_id, half_width_spacings, tick_lower, tick_upper,
             status, exclusion_reason, rank, liquidity, liquidity_share_ppm,
             start_amount0, start_amount1, idle_quote, end_amount0,
             end_amount1, fee0, fee1, end_principal_value_quote,
             fee_value_quote, gross_end_value_quote, net_end_value_quote,
             hodl_end_value_quote, divergence_quote, absolute_pnl_quote,
             lp_alpha_quote
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18,$19,$20,$21,$22,$23,$24
           )`,
          [
            simulationRunId,
            candidate.halfWidthSpacings,
            candidate.tickLower,
            candidate.tickUpper,
            candidate.status,
            candidate.exclusionReason,
            candidate.rank,
            candidate.liquidity,
            candidate.liquiditySharePpm,
            candidate.startAmount0,
            candidate.startAmount1,
            candidate.idleQuote,
            candidate.endAmount0,
            candidate.endAmount1,
            candidate.fee0,
            candidate.fee1,
            candidate.endPrincipalValueQuote,
            candidate.feeValueQuote,
            candidate.grossEndValueQuote,
            candidate.netEndValueQuote,
            candidate.hodlEndValueQuote,
            candidate.divergenceQuote,
            candidate.absolutePnlQuote,
            candidate.lpAlphaQuote,
          ],
        );
      }
      await client.query("COMMIT");
      return { created: true, simulationRunId };
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
