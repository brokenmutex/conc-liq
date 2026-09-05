import pg from "pg";
import { SCHEMA_SQL } from "../storage/schema.js";
import type { StrategyCheckpointSnapshot } from "./domain.js";

const { Pool } = pg;

export interface StrategyCheckpointSaveResult {
  readonly checkpointRunId: string;
  readonly created: boolean;
  readonly riskRunId: string;
}

export class PostgresStrategyCheckpointStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async save(
    snapshot: StrategyCheckpointSnapshot,
  ): Promise<StrategyCheckpointSaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const risk = await client.query<{ id: string }>(
        `SELECT id FROM risk_snapshot_runs
         WHERE chain_id = $1 AND block_number = $2 AND LOWER(block_hash) = LOWER($3)
         ORDER BY id DESC LIMIT 1`,
        [snapshot.chainId, snapshot.blockNumber, snapshot.blockHash],
      );
      const riskRunId = risk.rows[0]?.id;
      if (riskRunId === undefined) {
        throw new Error("Synchronized risk snapshot is not stored");
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO v3_strategy_checkpoint_runs (
           risk_run_id, schema_version, stream_key, chain_id, block_number,
           block_hash, block_timestamp, captured_at, target_set_hash,
           methodology, execution_eligible, valid_pools, excluded_pools,
           assumptions, snapshot
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb
         ) ON CONFLICT (risk_run_id) DO NOTHING RETURNING id`,
        [
          riskRunId,
          snapshot.schemaVersion,
          snapshot.streamKey,
          snapshot.chainId,
          snapshot.blockNumber,
          snapshot.blockHash,
          snapshot.blockTimestamp,
          snapshot.capturedAt,
          snapshot.targetSetHash,
          snapshot.methodology,
          snapshot.executionEligible,
          snapshot.validPools,
          snapshot.excludedPools,
          JSON.stringify(snapshot.assumptions),
          JSON.stringify(snapshot),
        ],
      );
      let checkpointRunId = inserted.rows[0]?.id;
      if (checkpointRunId === undefined) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM v3_strategy_checkpoint_runs WHERE risk_run_id = $1`,
          [riskRunId],
        );
        checkpointRunId = existing.rows[0]?.id;
        if (checkpointRunId === undefined) {
          throw new Error("PostgreSQL did not resolve the checkpoint conflict");
        }
        await client.query("COMMIT");
        return { checkpointRunId, created: false, riskRunId };
      }
      for (const pool of snapshot.pools) {
        await client.query(
          `INSERT INTO v3_strategy_pool_checkpoints (
             checkpoint_run_id, pool_address, rwa_symbol, rwa_address, fee,
             token0, token1, tick, sqrt_price_x96, liquidity,
             fee_growth_global0_x128, fee_growth_global1_x128, pool_unlocked,
             status, reasons, pool_price_x18, oracle_price_x18, deviation_ppm,
             rwa_oracle_round_id, quote_oracle_round_id, token_decimals,
             checkpoint
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,
             $16,$17,$18,$19,$20,$21,$22::jsonb
           )`,
          [
            checkpointRunId,
            pool.poolAddress.toLowerCase(),
            pool.rwaSymbol,
            pool.rwaAddress.toLowerCase(),
            pool.fee,
            pool.token0.toLowerCase(),
            pool.token1.toLowerCase(),
            pool.state.tick,
            pool.state.sqrtPriceX96,
            pool.state.liquidity,
            pool.state.feeGrowthGlobal0X128,
            pool.state.feeGrowthGlobal1X128,
            pool.state.unlocked,
            pool.valuation.status,
            JSON.stringify(pool.valuation.reasons),
            pool.valuation.poolPriceX18,
            pool.valuation.oraclePriceX18,
            pool.valuation.deviationPpm,
            pool.valuation.rwaOracle?.roundId ?? null,
            pool.valuation.quoteOracle?.roundId ?? null,
            pool.valuation.tokenDecimals,
            JSON.stringify(pool),
          ],
        );
      }
      await client.query("COMMIT");
      return { checkpointRunId, created: true, riskRunId };
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
