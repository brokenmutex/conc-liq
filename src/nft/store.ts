import pg from "pg";
import { getAddress } from "viem";
import type { AccountingRunSource } from "../backtest/domain.js";
import { SCHEMA_SQL } from "../storage/schema.js";
import type {
  NftPoolSource,
  NftPositionSnapshot,
  NftSourceInput,
  NftTickSource,
} from "./domain.js";

const { Pool } = pg;

export class NftAccountingRunUnavailableError extends Error {
  public constructor(runId?: string) {
    super(runId === undefined
      ? "No accounting run is available for NFT monitoring"
      : `Accounting run ${runId} is unavailable for NFT monitoring`);
    this.name = "NftAccountingRunUnavailableError";
  }
}

interface RunRow {
  block_hash: string;
  block_number: string;
  chain_id: string;
  id: string;
  observed_at: Date;
  stream_key: string;
}

interface PoolRow {
  fee: number;
  fee_growth_global0_x128: string;
  fee_growth_global1_x128: string;
  pool_address: string;
  rwa_symbol: string;
  sqrt_price_x96: string;
  tick: number;
  token0: string;
  token1: string;
}

interface TickRow {
  fee_growth_outside0_x128: string;
  fee_growth_outside1_x128: string;
  pool_address: string;
  tick: number;
}

export interface NftSaveResult {
  readonly created: number;
  readonly existing: number;
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

export class PostgresNftPositionStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async loadSource(input: {
    readonly accountingRunId?: string;
    readonly streamKey: string;
  }): Promise<NftSourceInput> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const runResult = input.accountingRunId === undefined
        ? await client.query<RunRow>(
          `SELECT id, stream_key, chain_id::text, block_number::text,
                  block_hash, observed_at
           FROM v3_fee_accounting_runs
           WHERE stream_key = $1
           ORDER BY block_number DESC, id DESC LIMIT 1`,
          [input.streamKey],
        )
        : await client.query<RunRow>(
          `SELECT id, stream_key, chain_id::text, block_number::text,
                  block_hash, observed_at
           FROM v3_fee_accounting_runs
           WHERE stream_key = $1 AND id = $2`,
          [input.streamKey, input.accountingRunId],
        );
      const run = runResult.rows[0];
      if (run === undefined) {
        throw new NftAccountingRunUnavailableError(input.accountingRunId);
      }
      const poolResult = await client.query<PoolRow>(
        `SELECT pool_address, rwa_symbol, fee, token0, token1, tick,
                sqrt_price_x96::text,
                fee_growth_global0_x128::text,
                fee_growth_global1_x128::text
         FROM v3_pool_fee_accounting
         WHERE run_id = $1 ORDER BY rwa_symbol, fee`,
        [run.id],
      );
      const tickResult = await client.query<TickRow>(
        `SELECT pool_address, tick, fee_growth_outside0_x128::text,
                fee_growth_outside1_x128::text
         FROM v3_tick_fee_accounting
         WHERE run_id = $1 ORDER BY pool_address, tick`,
        [run.id],
      );
      const pools: NftPoolSource[] = poolResult.rows.map((row) => ({
        fee: row.fee,
        feeGrowthGlobal0X128: BigInt(row.fee_growth_global0_x128),
        feeGrowthGlobal1X128: BigInt(row.fee_growth_global1_x128),
        poolAddress: getAddress(row.pool_address),
        rwaSymbol: row.rwa_symbol,
        sqrtPriceX96: BigInt(row.sqrt_price_x96),
        tick: row.tick,
        token0: getAddress(row.token0),
        token1: getAddress(row.token1),
      }));
      const ticks: NftTickSource[] = tickResult.rows.map((row) => ({
        feeGrowthOutside0X128: BigInt(row.fee_growth_outside0_x128),
        feeGrowthOutside1X128: BigInt(row.fee_growth_outside1_x128),
        poolAddress: getAddress(row.pool_address),
        tick: row.tick,
      }));
      await client.query("COMMIT");
      return {
        pools,
        run: mapRun(run),
        streamKey: run.stream_key,
        ticks,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(
    snapshots: readonly NftPositionSnapshot[],
  ): Promise<NftSaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let created = 0;
      for (const snapshot of snapshots) {
        const result = await client.query(
          `INSERT INTO v3_nft_position_snapshots (
             schema_version, accounting_run_id, computed_at,
             position_manager, token_id, owner_address, operator, nonce,
             pool_address, rwa_symbol, fee, token0, token1,
             token0_decimals, token1_decimals, tick_lower, tick_upper,
             current_tick, sqrt_price_x96, liquidity, region,
             principal0, principal1, fee_growth_inside0_last_x128,
             fee_growth_inside1_last_x128, fee_growth_inside0_x128,
             fee_growth_inside1_x128, tokens_owed0, tokens_owed1,
             pending0, pending1, claimable0, claimable1, methodology,
             execution_eligible
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
             $31,$32,$33,$34,$35
           )
           ON CONFLICT (
             schema_version, accounting_run_id, position_manager, token_id
           ) DO NOTHING
           RETURNING id`,
          [
            snapshot.schemaVersion,
            snapshot.run.runId,
            snapshot.computedAt,
            snapshot.positionManager.toLowerCase(),
            snapshot.tokenId,
            snapshot.ownerAddress.toLowerCase(),
            snapshot.operator.toLowerCase(),
            snapshot.nonce,
            snapshot.poolAddress.toLowerCase(),
            snapshot.rwaSymbol,
            snapshot.fee,
            snapshot.token0.toLowerCase(),
            snapshot.token1.toLowerCase(),
            snapshot.token0Decimals,
            snapshot.token1Decimals,
            snapshot.tickLower,
            snapshot.tickUpper,
            snapshot.currentTick,
            snapshot.sqrtPriceX96,
            snapshot.liquidity,
            snapshot.region,
            snapshot.principal0,
            snapshot.principal1,
            snapshot.feeGrowthInside0LastX128,
            snapshot.feeGrowthInside1LastX128,
            snapshot.feeGrowthInside0X128,
            snapshot.feeGrowthInside1X128,
            snapshot.tokensOwed0,
            snapshot.tokensOwed1,
            snapshot.pending0,
            snapshot.pending1,
            snapshot.claimable0,
            snapshot.claimable1,
            snapshot.methodology,
            snapshot.executionEligible,
          ],
        );
        if (result.rowCount === 1) created += 1;
      }
      await client.query("COMMIT");
      return { created, existing: snapshots.length - created };
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
