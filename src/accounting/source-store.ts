import pg, { type PoolClient } from "pg";
import { getAddress, type Hash } from "viem";
import type {
  AccountingSourcePool,
  AccountingSourcePosition,
  AccountingSourceSnapshot,
  AccountingSourceTick,
} from "./domain.js";

const { Pool } = pg;

interface CursorRow {
  chain_id: string;
  complete_through_block: string | null;
  complete_through_hash: Hash | null;
  events_applied: string;
  last_scanned_block: string | null;
  last_scanned_hash: Hash | null;
}

interface PoolRow {
  chain_id: string;
  fee: number;
  liquidity: string;
  pool_address: string;
  rwa_symbol: string;
  sqrt_price_x96: string | null;
  tick: number | null;
}

interface TickRow {
  liquidity_gross: string;
  liquidity_net: string;
  pool_address: string;
  tick: number;
}

interface PositionRow {
  liquidity: string;
  owner_address: string;
  pool_address: string;
  tick_lower: number;
  tick_upper: number;
}

function mapPools(rows: readonly PoolRow[]): AccountingSourcePool[] {
  return rows.map((row) => {
    if (row.sqrt_price_x96 === null || row.tick === null) {
      throw new Error(`Replay pool ${row.pool_address} is not initialized`);
    }
    return {
      chainId: Number(row.chain_id),
      fee: row.fee,
      liquidity: BigInt(row.liquidity),
      poolAddress: getAddress(row.pool_address),
      rwaSymbol: row.rwa_symbol,
      sqrtPriceX96: BigInt(row.sqrt_price_x96),
      tick: row.tick,
    };
  });
}

function mapTicks(rows: readonly TickRow[]): AccountingSourceTick[] {
  return rows.map((row) => ({
    liquidityGross: BigInt(row.liquidity_gross),
    liquidityNet: BigInt(row.liquidity_net),
    poolAddress: getAddress(row.pool_address),
    tick: row.tick,
  }));
}

function mapPositions(rows: readonly PositionRow[]): AccountingSourcePosition[] {
  return rows.map((row) => ({
    liquidity: BigInt(row.liquidity),
    ownerAddress: getAddress(row.owner_address),
    poolAddress: getAddress(row.pool_address),
    tickLower: row.tick_lower,
    tickUpper: row.tick_upper,
  }));
}

async function readSource(
  client: PoolClient,
  streamKey: string,
): Promise<AccountingSourceSnapshot> {
  const cursorResult = await client.query<CursorRow>(
    `SELECT i.chain_id, i.last_scanned_block, i.last_scanned_hash,
            r.complete_through_block, r.complete_through_hash, r.events_applied
     FROM indexer_cursors i
     JOIN v3_replay_cursors r USING (stream_key)
     WHERE i.stream_key = $1`,
    [streamKey],
  );
  const cursor = cursorResult.rows[0];
  if (
    cursor === undefined ||
    cursor.last_scanned_block === null ||
    cursor.last_scanned_hash === null ||
    cursor.complete_through_block === null ||
    cursor.complete_through_hash === null
  ) {
    throw new Error(`Indexed/replayed source ${streamKey} is incomplete`);
  }
  if (
    cursor.last_scanned_block !== cursor.complete_through_block ||
    cursor.last_scanned_hash.toLowerCase() !==
      cursor.complete_through_hash.toLowerCase()
  ) {
    throw new Error(`Indexed/replayed source ${streamKey} is not exact`);
  }

  const pools = await client.query<PoolRow>(
    `SELECT pool_address, chain_id, rwa_symbol, fee, tick,
            sqrt_price_x96::text, liquidity::text
     FROM v3_replay_pools
     WHERE stream_key = $1
     ORDER BY pool_address`,
    [streamKey],
  );
  const ticks = await client.query<TickRow>(
    `SELECT pool_address, tick, liquidity_gross::text, liquidity_net::text
     FROM v3_replay_ticks
     WHERE stream_key = $1
     ORDER BY pool_address, tick`,
    [streamKey],
  );
  const positions = await client.query<PositionRow>(
    `SELECT pool_address, owner_address, tick_lower, tick_upper,
            liquidity::text
     FROM v3_replay_positions
     WHERE stream_key = $1
     ORDER BY pool_address, owner_address, tick_lower, tick_upper`,
    [streamKey],
  );
  const chainId = Number(cursor.chain_id);
  const mappedPools = mapPools(pools.rows);
  const mismatchedPool = mappedPools.find((pool) => pool.chainId !== chainId);
  if (mismatchedPool !== undefined) {
    throw new Error(
      `Replay pool ${mismatchedPool.poolAddress} belongs to chain ` +
      `${mismatchedPool.chainId}, expected ${chainId}`,
    );
  }
  return {
    blockHash: cursor.complete_through_hash,
    blockNumber: BigInt(cursor.complete_through_block),
    chainId,
    eventsApplied: BigInt(cursor.events_applied),
    pools: mappedPools,
    positions: mapPositions(positions.rows),
    streamKey,
    ticks: mapTicks(ticks.rows),
  };
}

export class PostgresAccountingSourceStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 1,
      options: "-c default_transaction_read_only=on",
    });
  }

  public async snapshot(streamKey: string): Promise<AccountingSourceSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snapshot = await readSource(client, streamKey);
      await client.query("COMMIT");
      return snapshot;
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
