import pg, { type PoolClient } from "pg";
import { assertSchemaReady } from "../storage/compatibility.js";
import type { AccountingRunSource } from "./domain.js";
import type {
  PrincipalPoolSource,
  PrincipalSnapshot,
} from "./principal.js";

const { Pool } = pg;
const INSERT_BATCH_SIZE = 250;
const PRINCIPAL_SCHEMA_VERSION = 1;

export class AccountingRunUnavailableError extends Error {
  public constructor(runId?: string) {
    super(runId === undefined
      ? "No accounting run is available for principal reconstruction"
      : `Accounting run ${runId} is unavailable`);
    this.name = "AccountingRunUnavailableError";
  }
}

interface RunRow {
  block_hash: string;
  block_number: string;
  chain_id: string;
  id: string;
  observed_at: Date;
  pool_count: number;
  stream_key: string;
}

interface PoolRow {
  active_positions: number;
  fee: number;
  pool_address: string;
  rwa_symbol: string;
  sqrt_price_x96: string;
  tick: number;
  token0: string;
  token1: string;
}

interface PositionRow {
  liquidity: string;
  owner_address: string;
  pool_address: string;
  tick_lower: number;
  tick_upper: number;
}

export interface PrincipalSourceInput {
  readonly pools: readonly PrincipalPoolSource[];
  readonly run: AccountingRunSource;
  readonly streamKey: string;
}

export interface PrincipalSaveResult {
  readonly created: boolean;
  readonly principalRunId: string;
}

function placeholders(rowCount: number, columnCount: number): string {
  return Array.from({ length: rowCount }, (_, row) => {
    const offset = row * columnCount;
    return `(${Array.from(
      { length: columnCount },
      (__, column) => `$${offset + column + 1}`,
    ).join(",")})`;
  }).join(",");
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

async function savePositions(
  client: PoolClient,
  principalRunId: string,
  snapshot: PrincipalSnapshot,
): Promise<void> {
  for (
    let offset = 0;
    offset < snapshot.positions.length;
    offset += INSERT_BATCH_SIZE
  ) {
    const batch = snapshot.positions.slice(offset, offset + INSERT_BATCH_SIZE);
    const values = batch.flatMap((position) => [
      principalRunId,
      position.poolAddress.toLowerCase(),
      position.ownerAddress.toLowerCase(),
      position.tickLower,
      position.tickUpper,
      position.liquidity.toString(),
      position.sqrtRatioLowerX96,
      position.sqrtRatioUpperX96,
      position.region,
      position.amount0,
      position.amount1,
    ]);
    await client.query(
      `INSERT INTO v3_position_principal_accounting (
         principal_run_id, pool_address, owner_address, tick_lower,
         tick_upper, liquidity, sqrt_ratio_lower_x96,
         sqrt_ratio_upper_x96, region, amount0, amount1
       ) VALUES ${placeholders(batch.length, 11)}`,
      values,
    );
  }
}

export class PostgresPrincipalStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async assertReady(): Promise<void> {
    await assertSchemaReady(this.pool);
  }

  public async runIds(input: {
    readonly allMissing: boolean;
    readonly runId?: string;
    readonly streamKey: string;
  }): Promise<string[]> {
    if (input.runId !== undefined) {
      const result = await this.pool.query<{ id: string }>(
        `SELECT id FROM v3_fee_accounting_runs
         WHERE id = $1 AND stream_key = $2`,
        [input.runId, input.streamKey],
      );
      if (result.rows[0] === undefined) {
        throw new AccountingRunUnavailableError(input.runId);
      }
      return [input.runId];
    }
    if (input.allMissing) {
      const result = await this.pool.query<{ id: string }>(
        `SELECT a.id
         FROM v3_fee_accounting_runs a
         LEFT JOIN v3_principal_accounting_runs p
           ON p.accounting_run_id = a.id AND p.schema_version = $1
         WHERE a.stream_key = $2 AND p.id IS NULL
         ORDER BY a.block_number, a.id`,
        [PRINCIPAL_SCHEMA_VERSION, input.streamKey],
      );
      return result.rows.map((row) => row.id);
    }
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM v3_fee_accounting_runs WHERE stream_key = $1
       ORDER BY block_number DESC, id DESC LIMIT 1`,
      [input.streamKey],
    );
    const runId = result.rows[0]?.id;
    if (runId === undefined) throw new AccountingRunUnavailableError();
    return [runId];
  }

  public async load(runId: string): Promise<PrincipalSourceInput> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const runResult = await client.query<RunRow>(
        `SELECT id, stream_key, chain_id::text, block_number::text,
                block_hash, observed_at, pool_count
         FROM v3_fee_accounting_runs WHERE id = $1`,
        [runId],
      );
      const run = runResult.rows[0];
      if (run === undefined) throw new AccountingRunUnavailableError(runId);
      const poolResult = await client.query<PoolRow>(
        `SELECT pool_address, rwa_symbol, fee, token0, token1, tick,
                sqrt_price_x96::text, active_positions
         FROM v3_pool_fee_accounting
         WHERE run_id = $1 ORDER BY rwa_symbol, fee`,
        [runId],
      );
      if (poolResult.rows.length !== run.pool_count) {
        throw new Error(`Accounting pool count disagrees for run ${runId}`);
      }
      const positionResult = await client.query<PositionRow>(
        `SELECT pool_address, owner_address, tick_lower, tick_upper,
                liquidity::text
         FROM v3_position_fee_accounting
         WHERE run_id = $1 AND liquidity > 0
         ORDER BY pool_address, owner_address, tick_lower, tick_upper`,
        [runId],
      );
      const positionsByPool = new Map<string, PositionRow[]>();
      for (const position of positionResult.rows) {
        const key = position.pool_address.toLowerCase();
        const rows = positionsByPool.get(key) ?? [];
        rows.push(position);
        positionsByPool.set(key, rows);
      }
      const pools = poolResult.rows.map((pool): PrincipalPoolSource => ({
        activePositions: pool.active_positions,
        fee: pool.fee,
        poolAddress: pool.pool_address,
        positions: (positionsByPool.get(pool.pool_address.toLowerCase()) ?? [])
          .map((position) => ({
            liquidity: BigInt(position.liquidity),
            ownerAddress: position.owner_address,
            tickLower: position.tick_lower,
            tickUpper: position.tick_upper,
          })),
        rwaSymbol: pool.rwa_symbol,
        sqrtPriceX96: BigInt(pool.sqrt_price_x96),
        tick: pool.tick,
        token0: pool.token0,
        token1: pool.token1,
      }));
      await client.query("COMMIT");
      return { pools, run: mapRun(run), streamKey: run.stream_key };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(snapshot: PrincipalSnapshot): Promise<PrincipalSaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `INSERT INTO v3_principal_accounting_runs (
           schema_version, accounting_run_id, computed_at, methodology,
           execution_eligible, pool_count, position_count,
           below_range_positions, in_range_positions, above_range_positions
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (schema_version, accounting_run_id) DO NOTHING
         RETURNING id`,
        [
          snapshot.schemaVersion,
          snapshot.run.runId,
          snapshot.computedAt,
          snapshot.methodology,
          snapshot.executionEligible,
          snapshot.pools.length,
          snapshot.totals.positionCount,
          snapshot.totals.belowRangePositions,
          snapshot.totals.inRangePositions,
          snapshot.totals.aboveRangePositions,
        ],
      );
      let principalRunId = result.rows[0]?.id;
      if (principalRunId === undefined) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM v3_principal_accounting_runs
           WHERE schema_version = $1 AND accounting_run_id = $2`,
          [snapshot.schemaVersion, snapshot.run.runId],
        );
        principalRunId = existing.rows[0]?.id;
        if (principalRunId === undefined) {
          throw new Error("PostgreSQL did not resolve the principal run conflict");
        }
        await client.query("COMMIT");
        return { created: false, principalRunId };
      }
      for (const pool of snapshot.pools) {
        await client.query(
          `INSERT INTO v3_pool_principal_accounting (
             principal_run_id, pool_address, rwa_symbol, fee, token0, token1,
             tick, sqrt_price_x96, position_count, below_range_positions,
             in_range_positions, above_range_positions, amount0, amount1
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            principalRunId,
            pool.poolAddress.toLowerCase(),
            pool.rwaSymbol,
            pool.fee,
            pool.token0.toLowerCase(),
            pool.token1.toLowerCase(),
            pool.tick,
            pool.sqrtPriceX96,
            pool.positionCount,
            pool.belowRangePositions,
            pool.inRangePositions,
            pool.aboveRangePositions,
            pool.amount0,
            pool.amount1,
          ],
        );
      }
      await savePositions(client, principalRunId, snapshot);
      await client.query("COMMIT");
      return { created: true, principalRunId };
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
