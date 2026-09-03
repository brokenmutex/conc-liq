import pg, { type PoolClient } from "pg";
import { SCHEMA_SQL } from "../storage/schema.js";
import type { FeeAccountingSnapshot } from "./domain.js";

const { Pool } = pg;
const INSERT_BATCH_SIZE = 250;

function placeholders(rowCount: number, columnCount: number): string {
  return Array.from({ length: rowCount }, (_, row) => {
    const offset = row * columnCount;
    return `(${Array.from(
      { length: columnCount },
      (__, column) => `$${offset + column + 1}`,
    ).join(",")})`;
  }).join(",");
}

async function saveTicks(
  client: PoolClient,
  runId: string,
  snapshot: FeeAccountingSnapshot,
): Promise<void> {
  for (let offset = 0; offset < snapshot.ticks.length; offset += INSERT_BATCH_SIZE) {
    const batch = snapshot.ticks.slice(offset, offset + INSERT_BATCH_SIZE);
    const values = batch.flatMap((tick) => [
      runId,
      tick.poolAddress.toLowerCase(),
      tick.tick,
      tick.liquidityGross.toString(),
      tick.liquidityNet.toString(),
      tick.feeGrowthOutside0X128.toString(),
      tick.feeGrowthOutside1X128.toString(),
    ]);
    await client.query(
      `INSERT INTO v3_tick_fee_accounting (
         run_id, pool_address, tick, liquidity_gross, liquidity_net,
         fee_growth_outside0_x128, fee_growth_outside1_x128
       ) VALUES ${placeholders(batch.length, 7)}`,
      values,
    );
  }
}

async function savePositions(
  client: PoolClient,
  runId: string,
  snapshot: FeeAccountingSnapshot,
): Promise<void> {
  for (
    let offset = 0;
    offset < snapshot.positions.length;
    offset += INSERT_BATCH_SIZE
  ) {
    const batch = snapshot.positions.slice(offset, offset + INSERT_BATCH_SIZE);
    const values = batch.flatMap((position) => [
      runId,
      position.poolAddress.toLowerCase(),
      position.ownerAddress.toLowerCase(),
      position.tickLower,
      position.tickUpper,
      position.liquidity.toString(),
      position.feeGrowthInside0LastX128.toString(),
      position.feeGrowthInside1LastX128.toString(),
      position.feeGrowthInside0X128?.toString() ?? null,
      position.feeGrowthInside1X128?.toString() ?? null,
      position.tokensOwed0.toString(),
      position.tokensOwed1.toString(),
      position.pending0.toString(),
      position.pending1.toString(),
      position.claimable0.toString(),
      position.claimable1.toString(),
    ]);
    await client.query(
      `INSERT INTO v3_position_fee_accounting (
         run_id, pool_address, owner_address, tick_lower, tick_upper,
         liquidity, fee_growth_inside0_last_x128,
         fee_growth_inside1_last_x128, fee_growth_inside0_x128,
         fee_growth_inside1_x128, tokens_owed0, tokens_owed1,
         pending0, pending1, claimable0, claimable1
       ) VALUES ${placeholders(batch.length, 16)}`,
      values,
    );
  }
}

export class PostgresFeeAccountingStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async save(snapshot: FeeAccountingSnapshot): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `INSERT INTO v3_fee_accounting_runs (
           schema_version, stream_key, chain_id, block_number, block_hash,
           events_applied, observed_at, pool_count, tick_count, position_count
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          snapshot.schemaVersion,
          snapshot.streamKey,
          snapshot.chainId,
          snapshot.blockNumber.toString(),
          snapshot.blockHash,
          snapshot.eventsApplied.toString(),
          snapshot.observedAt,
          snapshot.pools.length,
          snapshot.ticks.length,
          snapshot.positions.length,
        ],
      );
      const runId = result.rows[0]?.id;
      if (runId === undefined) {
        throw new Error("PostgreSQL did not return a fee accounting run ID");
      }
      for (const pool of snapshot.pools) {
        await client.query(
          `INSERT INTO v3_pool_fee_accounting (
             run_id, pool_address, rwa_symbol, fee, token0, token1, tick,
             sqrt_price_x96, liquidity, fee_growth_global0_x128,
             fee_growth_global1_x128, positions, active_positions,
             tokens_owed0, tokens_owed1, pending0, pending1,
             claimable0, claimable1
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
           )`,
          [
            runId,
            pool.poolAddress.toLowerCase(),
            pool.rwaSymbol,
            pool.fee,
            pool.token0.toLowerCase(),
            pool.token1.toLowerCase(),
            pool.tick,
            pool.sqrtPriceX96.toString(),
            pool.liquidity.toString(),
            pool.feeGrowthGlobal0X128.toString(),
            pool.feeGrowthGlobal1X128.toString(),
            pool.positions,
            pool.activePositions,
            pool.tokensOwed0.toString(),
            pool.tokensOwed1.toString(),
            pool.pending0.toString(),
            pool.pending1.toString(),
            pool.claimable0.toString(),
            pool.claimable1.toString(),
          ],
        );
      }
      await saveTicks(client, runId, snapshot);
      await savePositions(client, runId, snapshot);
      await client.query("COMMIT");
      return runId;
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
