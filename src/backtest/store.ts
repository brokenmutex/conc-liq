import pg, { type PoolClient } from "pg";
import { SCHEMA_SQL } from "../storage/schema.js";
import type { BaselineSourceInput } from "./canonical.js";
import type {
  AccountingRunSource,
  PoolIntervalInput,
  PositionIntervalInput,
  StableFeeBaseline,
} from "./domain.js";

const { Pool } = pg;

export class InsufficientAccountingRunsError extends Error {
  public constructor() {
    super("Two accounting runs are required for a baseline");
    this.name = "InsufficientAccountingRunsError";
  }
}

interface RunRow {
  block_hash: string;
  block_number: string;
  chain_id: string;
  id: string;
  observed_at: Date;
  pool_count: number;
}

interface PoolRow {
  active_positions_from: number;
  active_positions_to: number;
  fee: number;
  fee_to: number;
  pool_address: string;
  rwa_symbol: string;
  rwa_symbol_to: string;
  token0: string;
  token0_to: string;
  token1: string;
  token1_to: string;
}

interface PositionRow {
  fee_growth_inside0_last_from_x128: string;
  fee_growth_inside0_last_to_x128: string;
  fee_growth_inside1_last_from_x128: string;
  fee_growth_inside1_last_to_x128: string;
  liquidity_from: string;
  liquidity_to: string;
  owner_address: string;
  pending0_from: string;
  pending0_to: string;
  pending1_from: string;
  pending1_to: string;
  pool_address: string;
  tick_lower: number;
  tick_upper: number;
}

interface TouchedRow {
  owner_address: string;
  pool_address: string;
  tick_lower: number;
  tick_upper: number;
}

function positionKey(input: {
  readonly owner_address: string;
  readonly pool_address: string;
  readonly tick_lower: number;
  readonly tick_upper: number;
}): string {
  return `${input.pool_address.toLowerCase()}:` +
    `${input.owner_address.toLowerCase()}:${input.tick_lower}:${input.tick_upper}`;
}

function mapRun(row: RunRow): AccountingRunSource {
  return {
    blockHash: row.block_hash,
    blockNumber: BigInt(row.block_number),
    chainId: Number(row.chain_id),
    observedAt: row.observed_at.toISOString(),
    runId: row.id,
  };
}

async function loadRuns(
  client: PoolClient,
  streamKey: string,
  fromRunId?: string,
  toRunId?: string,
): Promise<{ readonly from: RunRow; readonly to: RunRow }> {
  const explicit = fromRunId !== undefined && toRunId !== undefined;
  const result = explicit
    ? await client.query<RunRow>(
      `SELECT r.id, r.chain_id::text, r.block_number::text, r.block_hash,
              r.observed_at, r.pool_count
       FROM v3_fee_accounting_runs r
       WHERE r.stream_key = $1 AND r.id IN ($2, $3)
       ORDER BY r.block_number, r.id`,
      [streamKey, fromRunId, toRunId],
    )
    : await client.query<RunRow>(
      `SELECT r.id, r.chain_id::text, r.block_number::text, r.block_hash,
              r.observed_at, r.pool_count
       FROM v3_fee_accounting_runs r
       WHERE r.stream_key = $1
       ORDER BY r.block_number DESC, r.id DESC
       LIMIT 2`,
      [streamKey],
    );
  if (result.rows.length !== 2) {
    throw new InsufficientAccountingRunsError();
  }
  const ordered = [...result.rows].sort((left, right) =>
    BigInt(left.block_number) < BigInt(right.block_number) ? -1 : 1
  );
  const [from, to] = ordered;
  if (from === undefined || to === undefined) {
    throw new Error("Unable to order baseline accounting runs");
  }
  if (
    explicit &&
    (from.id !== fromRunId || to.id !== toRunId)
  ) {
    throw new Error("Explicit accounting runs are not in increasing block order");
  }
  return { from, to };
}

async function loadPools(
  client: PoolClient,
  from: RunRow,
  to: RunRow,
): Promise<PoolIntervalInput[]> {
  const result = await client.query<PoolRow>(
    `SELECT a.pool_address, a.rwa_symbol, b.rwa_symbol AS rwa_symbol_to,
            a.fee, b.fee AS fee_to, a.token0, b.token0 AS token0_to,
            a.token1, b.token1 AS token1_to,
            a.active_positions AS active_positions_from,
            b.active_positions AS active_positions_to
     FROM v3_pool_fee_accounting a
     JOIN v3_pool_fee_accounting b USING (pool_address)
     WHERE a.run_id = $1 AND b.run_id = $2
     ORDER BY a.rwa_symbol, a.fee`,
    [from.id, to.id],
  );
  if (result.rows.length !== from.pool_count || result.rows.length !== to.pool_count) {
    throw new Error("Baseline accounting runs do not cover the same pool universe");
  }
  return result.rows.map((row) => {
    if (
      row.rwa_symbol !== row.rwa_symbol_to ||
      row.fee !== row.fee_to ||
      row.token0.toLowerCase() !== row.token0_to.toLowerCase() ||
      row.token1.toLowerCase() !== row.token1_to.toLowerCase()
    ) {
      throw new Error(`Pool identity changed across baseline ${row.pool_address}`);
    }
    return {
      activePositionsFrom: row.active_positions_from,
      activePositionsTo: row.active_positions_to,
      fee: row.fee,
      poolAddress: row.pool_address,
      rwaSymbol: row.rwa_symbol,
      token0: row.token0,
      token1: row.token1,
    };
  });
}

async function loadPositions(
  client: PoolClient,
  streamKey: string,
  from: RunRow,
  to: RunRow,
): Promise<PositionIntervalInput[]> {
  const positions = await client.query<PositionRow>(
    `SELECT a.pool_address, a.owner_address, a.tick_lower, a.tick_upper,
            a.liquidity::text AS liquidity_from,
            b.liquidity::text AS liquidity_to,
            a.fee_growth_inside0_last_x128::text
              AS fee_growth_inside0_last_from_x128,
            b.fee_growth_inside0_last_x128::text
              AS fee_growth_inside0_last_to_x128,
            a.fee_growth_inside1_last_x128::text
              AS fee_growth_inside1_last_from_x128,
            b.fee_growth_inside1_last_x128::text
              AS fee_growth_inside1_last_to_x128,
            a.pending0::text AS pending0_from,
            b.pending0::text AS pending0_to,
            a.pending1::text AS pending1_from,
            b.pending1::text AS pending1_to
     FROM v3_position_fee_accounting a
     JOIN v3_position_fee_accounting b
       USING (pool_address, owner_address, tick_lower, tick_upper)
     WHERE a.run_id = $1 AND b.run_id = $2
       AND a.liquidity > 0 AND b.liquidity > 0
     ORDER BY a.pool_address, a.owner_address, a.tick_lower, a.tick_upper`,
    [from.id, to.id],
  );
  const touched = await client.query<TouchedRow>(
    `SELECT DISTINCT LOWER(pool_address) AS pool_address,
            LOWER(event_args->>'owner') AS owner_address,
            (event_args->>'tickLower')::integer AS tick_lower,
            (event_args->>'tickUpper')::integer AS tick_upper
     FROM v3_pool_events
     WHERE stream_key = $1
       AND block_number > $2 AND block_number <= $3
       AND event_name IN ('Mint', 'Burn')`,
    [streamKey, from.block_number, to.block_number],
  );
  const touchedKeys = new Set(touched.rows.map(positionKey));
  return positions.rows.map((row) => ({
    feeGrowthInside0LastFromX128:
      BigInt(row.fee_growth_inside0_last_from_x128),
    feeGrowthInside0LastToX128: BigInt(row.fee_growth_inside0_last_to_x128),
    feeGrowthInside1LastFromX128:
      BigInt(row.fee_growth_inside1_last_from_x128),
    feeGrowthInside1LastToX128: BigInt(row.fee_growth_inside1_last_to_x128),
    liquidityFrom: BigInt(row.liquidity_from),
    liquidityTo: BigInt(row.liquidity_to),
    ownerAddress: row.owner_address,
    pending0From: BigInt(row.pending0_from),
    pending0To: BigInt(row.pending0_to),
    pending1From: BigInt(row.pending1_from),
    pending1To: BigInt(row.pending1_to),
    poolAddress: row.pool_address,
    tickLower: row.tick_lower,
    tickUpper: row.tick_upper,
    touched: touchedKeys.has(positionKey(row)),
  }));
}

export interface BaselineSaveResult {
  readonly baselineId: string;
  readonly created: boolean;
}

export class PostgresStableFeeBaselineStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async load(input: {
    readonly fromRunId?: string;
    readonly streamKey: string;
    readonly toRunId?: string;
  }): Promise<BaselineSourceInput> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const runs = await loadRuns(
        client,
        input.streamKey,
        input.fromRunId,
        input.toRunId,
      );
      const pools = await loadPools(client, runs.from, runs.to);
      const positions = await loadPositions(
        client,
        input.streamKey,
        runs.from,
        runs.to,
      );
      await client.query("COMMIT");
      return {
        from: mapRun(runs.from),
        pools,
        positions,
        streamKey: input.streamKey,
        to: mapRun(runs.to),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(baseline: StableFeeBaseline): Promise<BaselineSaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `INSERT INTO v3_stable_fee_baseline_runs (
           schema_version, stream_key, from_accounting_run_id,
           to_accounting_run_id, computed_at, methodology,
           execution_eligible, block_delta, elapsed_seconds,
           paired_active_positions, stable_positions, touched_positions,
           entered_positions, exited_positions, limitations
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb
         )
         ON CONFLICT (
           schema_version, stream_key,
           from_accounting_run_id, to_accounting_run_id
         ) DO NOTHING
         RETURNING id`,
        [
          baseline.schemaVersion,
          baseline.streamKey,
          baseline.from.runId,
          baseline.to.runId,
          baseline.computedAt,
          baseline.methodology,
          baseline.executionEligible,
          baseline.blockDelta,
          baseline.elapsedSeconds,
          baseline.totals.pairedActivePositions,
          baseline.totals.stablePositions,
          baseline.totals.touchedPositions,
          baseline.totals.enteredPositions,
          baseline.totals.exitedPositions,
          JSON.stringify(baseline.limitations),
        ],
      );
      let baselineId = result.rows[0]?.id;
      if (baselineId === undefined) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM v3_stable_fee_baseline_runs
           WHERE schema_version = $1 AND stream_key = $2
             AND from_accounting_run_id = $3 AND to_accounting_run_id = $4`,
          [
            baseline.schemaVersion,
            baseline.streamKey,
            baseline.from.runId,
            baseline.to.runId,
          ],
        );
        baselineId = existing.rows[0]?.id;
        if (baselineId === undefined) {
          throw new Error("PostgreSQL did not resolve the fee baseline conflict");
        }
        await client.query("COMMIT");
        return { baselineId, created: false };
      }
      for (const pool of baseline.pools) {
        await client.query(
          `INSERT INTO v3_stable_fee_pool_baselines (
             baseline_run_id, pool_address, rwa_symbol, fee, token0, token1,
             active_positions_from, active_positions_to,
             paired_active_positions, stable_positions, touched_positions,
             entered_positions, exited_positions, accrued0, accrued1
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
           )`,
          [
            baselineId,
            pool.poolAddress.toLowerCase(),
            pool.rwaSymbol,
            pool.fee,
            pool.token0.toLowerCase(),
            pool.token1.toLowerCase(),
            pool.activePositionsFrom,
            pool.activePositionsTo,
            pool.pairedActivePositions,
            pool.stablePositions,
            pool.touchedPositions,
            pool.enteredPositions,
            pool.exitedPositions,
            pool.accrued0,
            pool.accrued1,
          ],
        );
      }
      await client.query("COMMIT");
      return { baselineId, created: true };
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
