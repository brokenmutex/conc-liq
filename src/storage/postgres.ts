import pg from "pg";
import type { ObserverSnapshot } from "../domain.js";
import { assertSchemaReady } from "./compatibility.js";
import type { SnapshotStore } from "./types.js";

const { Pool } = pg;

export class PostgresSnapshotStore implements SnapshotStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 4 });
  }

  public async assertReady(): Promise<void> {
    await assertSchemaReady(this.pool);
  }

  public async save(snapshot: ObserverSnapshot): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const runResult = await client.query<{ id: string }>(
        `INSERT INTO observer_runs (
           schema_version,
           chain_id,
           block_number,
           block_hash,
           block_timestamp,
           observed_at,
           snapshot
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING id`,
        [
          snapshot.schemaVersion,
          snapshot.chainId,
          snapshot.blockNumber,
          snapshot.blockHash,
          snapshot.blockTimestamp,
          snapshot.observedAt,
          JSON.stringify(snapshot),
        ],
      );

      const runId = runResult.rows[0]?.id;
      if (runId === undefined) {
        throw new Error("PostgreSQL did not return an observer run ID");
      }

      for (const pool of snapshot.pools) {
        await client.query(
          `INSERT INTO pool_snapshots (
             run_id,
             pool_address,
             rwa_symbol,
             fee,
             tick,
             liquidity,
             sqrt_price_x96,
             snapshot
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            runId,
            pool.address,
            pool.rwaSymbol,
            pool.fee,
            pool.tick,
            pool.liquidity,
            pool.sqrtPriceX96,
            JSON.stringify(pool),
          ],
        );
      }

      await client.query("COMMIT");
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
