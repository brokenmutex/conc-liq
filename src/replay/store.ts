import pg, { type PoolClient } from "pg";
import type { Hash } from "viem";
import { SCHEMA_SQL } from "../storage/schema.js";
import type {
  ReplayChanges,
  ReplayCoordinate,
  ReplayCursor,
  ReplayPoolState,
  ReplayPositionState,
  ReplaySource,
  ReplayTickState,
  StoredReplayEvent,
} from "./domain.js";

const { Pool } = pg;

interface SourceRow {
  stream_key: string;
  chain_id: string;
  target_set_hash: Hash;
  last_scanned_block: string | null;
  last_scanned_hash: Hash | null;
}

interface CursorRow {
  stream_key: string;
  chain_id: string;
  target_set_hash: Hash;
  last_block_number: string | null;
  last_block_hash: Hash | null;
  last_transaction_hash: Hash | null;
  last_transaction_index: number | null;
  last_log_index: number | null;
  events_applied: string;
  complete_through_block: string | null;
  complete_through_hash: Hash | null;
}

interface EventRow {
  pool_address: string;
  block_number: string;
  block_hash: Hash;
  transaction_hash: Hash;
  transaction_index: number;
  log_index: number;
  event_name: string;
  event_args: unknown;
}

interface PoolRow {
  pool_address: string;
  chain_id: string;
  rwa_symbol: string;
  fee: number;
  initialized: boolean;
  sqrt_price_x96: string | null;
  tick: number | null;
  liquidity: string;
  observation_cardinality_next: number | null;
  fee_protocol0: number;
  fee_protocol1: number;
  event_count: string;
  mint_count: string;
  burn_count: string;
  swap_count: string;
  collect_count: string;
  flash_count: string;
  last_event_block: string | null;
  last_event_transaction_index: number | null;
  last_event_log_index: number | null;
}

interface TickRow {
  pool_address: string;
  tick: number;
  liquidity_gross: string;
  liquidity_net: string;
}

interface PositionRow {
  pool_address: string;
  owner_address: string;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
  minted_liquidity: string;
  burned_liquidity: string;
  minted_amount0: string;
  minted_amount1: string;
  burned_amount0: string;
  burned_amount1: string;
  collected_amount0: string;
  collected_amount1: string;
}

function cursorFromRow(row: CursorRow): ReplayCursor {
  const hasLast = row.last_block_number !== null;
  return {
    chainId: Number(row.chain_id),
    completeThroughBlock: row.complete_through_block === null
      ? null
      : BigInt(row.complete_through_block),
    completeThroughHash: row.complete_through_hash,
    eventsApplied: BigInt(row.events_applied),
    last: hasLast
      ? {
        blockHash: row.last_block_hash!,
        blockNumber: BigInt(row.last_block_number!),
        logIndex: row.last_log_index!,
        transactionHash: row.last_transaction_hash!,
        transactionIndex: row.last_transaction_index!,
      }
      : null,
    streamKey: row.stream_key,
    targetSetHash: row.target_set_hash,
  };
}

function poolFromRow(row: PoolRow): ReplayPoolState {
  return {
    burnCount: BigInt(row.burn_count),
    chainId: Number(row.chain_id),
    collectCount: BigInt(row.collect_count),
    eventCount: BigInt(row.event_count),
    fee: row.fee,
    feeProtocol0: row.fee_protocol0,
    feeProtocol1: row.fee_protocol1,
    flashCount: BigInt(row.flash_count),
    initialized: row.initialized,
    lastEventBlock: row.last_event_block === null ? null : BigInt(row.last_event_block),
    lastEventLogIndex: row.last_event_log_index,
    lastEventTransactionIndex: row.last_event_transaction_index,
    liquidity: BigInt(row.liquidity),
    mintCount: BigInt(row.mint_count),
    observationCardinalityNext: row.observation_cardinality_next,
    poolAddress: row.pool_address,
    rwaSymbol: row.rwa_symbol,
    sqrtPriceX96: row.sqrt_price_x96 === null ? null : BigInt(row.sqrt_price_x96),
    swapCount: BigInt(row.swap_count),
    tick: row.tick,
  };
}

function tickFromRow(row: TickRow): ReplayTickState {
  return {
    liquidityGross: BigInt(row.liquidity_gross),
    liquidityNet: BigInt(row.liquidity_net),
    poolAddress: row.pool_address,
    tick: row.tick,
  };
}

function positionFromRow(row: PositionRow): ReplayPositionState {
  return {
    burnedAmount0: BigInt(row.burned_amount0),
    burnedAmount1: BigInt(row.burned_amount1),
    burnedLiquidity: BigInt(row.burned_liquidity),
    collectedAmount0: BigInt(row.collected_amount0),
    collectedAmount1: BigInt(row.collected_amount1),
    liquidity: BigInt(row.liquidity),
    mintedAmount0: BigInt(row.minted_amount0),
    mintedAmount1: BigInt(row.minted_amount1),
    mintedLiquidity: BigInt(row.minted_liquidity),
    ownerAddress: row.owner_address,
    poolAddress: row.pool_address,
    tickLower: row.tick_lower,
    tickUpper: row.tick_upper,
  };
}

function eventFromRow(row: EventRow): StoredReplayEvent {
  return {
    args: row.event_args,
    blockHash: row.block_hash,
    blockNumber: BigInt(row.block_number),
    eventName: row.event_name,
    logIndex: row.log_index,
    poolAddress: row.pool_address,
    transactionHash: row.transaction_hash,
    transactionIndex: row.transaction_index,
  };
}

export class PostgresReplayStore {
  private readonly pool: InstanceType<typeof Pool>;
  private client: PoolClient | null = null;
  private lockName: string | null = null;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async open(streamKey: string): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
    this.client = await this.pool.connect();
    this.lockName = `v3-replay:${streamKey}`;
    const result = await this.client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [this.lockName],
    );
    if (result.rows[0]?.locked !== true) {
      throw new Error(`Another replay process holds the ${streamKey} lock`);
    }
  }

  private connection(): PoolClient {
    if (this.client === null) {
      throw new Error("Replay store is not open");
    }
    return this.client;
  }

  public async getSource(streamKey: string): Promise<ReplaySource> {
    const result = await this.connection().query<SourceRow>(
      `SELECT stream_key, chain_id, target_set_hash,
              last_scanned_block, last_scanned_hash
       FROM indexer_cursors WHERE stream_key = $1`,
      [streamKey],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`No indexer cursor exists for ${streamKey}`);
    }
    if (row.last_scanned_block === null || row.last_scanned_hash === null) {
      throw new Error(`Indexer cursor ${streamKey} has no completed source block`);
    }
    return {
      chainId: Number(row.chain_id),
      lastScannedBlock: BigInt(row.last_scanned_block),
      lastScannedHash: row.last_scanned_hash,
      streamKey: row.stream_key,
      targetSetHash: row.target_set_hash,
    };
  }

  public async prepare(source: ReplaySource, rebuild: boolean): Promise<ReplayCursor> {
    const client = this.connection();
    await client.query("BEGIN");
    try {
      if (rebuild) {
        await client.query("DELETE FROM v3_replay_pools WHERE stream_key = $1", [source.streamKey]);
        await client.query("DELETE FROM v3_replay_cursors WHERE stream_key = $1", [source.streamKey]);
      } else {
        const existing = await client.query<{
          chain_id: string;
          target_set_hash: Hash;
        }>(
          `SELECT chain_id, target_set_hash
           FROM v3_replay_cursors WHERE stream_key = $1`,
          [source.streamKey],
        );
        const row = existing.rows[0];
        if (row !== undefined && Number(row.chain_id) !== source.chainId) {
          throw new Error(`Replay chain ID ${row.chain_id} does not match ${source.chainId}`);
        }
        if (
          row !== undefined &&
          row.target_set_hash.toLowerCase() !== source.targetSetHash.toLowerCase()
        ) {
          throw new Error("Replay target set changed; rerun with --rebuild");
        }
      }
      await client.query(
        `INSERT INTO v3_replay_pools (
           stream_key, pool_address, chain_id, rwa_symbol, fee
         )
         SELECT stream_key, pool_address, chain_id, rwa_symbol, fee
         FROM indexer_pools
         WHERE stream_key = $1 AND enabled = TRUE
         ON CONFLICT (stream_key, pool_address) DO NOTHING`,
        [source.streamKey],
      );
      await client.query(
        `INSERT INTO v3_replay_cursors (
           stream_key, chain_id, target_set_hash
         ) VALUES ($1,$2,$3)
         ON CONFLICT (stream_key) DO NOTHING`,
        [source.streamKey, source.chainId, source.targetSetHash],
      );

      const counts = await client.query<{ source_count: string; replay_count: string }>(
        `SELECT
           (SELECT count(*) FROM indexer_pools
            WHERE stream_key = $1 AND enabled = TRUE) AS source_count,
           (SELECT count(*) FROM v3_replay_pools
            WHERE stream_key = $1) AS replay_count`,
        [source.streamKey],
      );
      const countRow = counts.rows[0]!;
      if (countRow.source_count !== countRow.replay_count) {
        throw new Error(
          `Replay pool set has ${countRow.replay_count} rows; source has ${countRow.source_count}`,
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const cursor = await this.getCursor(source.streamKey);
    if (cursor === null) {
      throw new Error("Replay cursor was not created");
    }
    if (cursor.chainId !== source.chainId) {
      throw new Error(`Replay chain ID ${cursor.chainId} does not match ${source.chainId}`);
    }
    if (cursor.targetSetHash.toLowerCase() !== source.targetSetHash.toLowerCase()) {
      throw new Error("Replay target set changed; rerun with --rebuild");
    }
    return cursor;
  }

  public async getCursor(streamKey: string): Promise<ReplayCursor | null> {
    const result = await this.connection().query<CursorRow>(
      `SELECT stream_key, chain_id, target_set_hash, last_block_number,
              last_block_hash, last_transaction_hash, last_transaction_index,
              last_log_index, events_applied, complete_through_block,
              complete_through_hash
       FROM v3_replay_cursors WHERE stream_key = $1`,
      [streamKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : cursorFromRow(row);
  }

  public async validateCursorSource(cursor: ReplayCursor): Promise<void> {
    if (cursor.last === null) {
      return;
    }
    const result = await this.connection().query<EventRow>(
      `SELECT pool_address, block_number, block_hash, transaction_hash,
              transaction_index, log_index, event_name, event_args
       FROM v3_pool_events
       WHERE stream_key = $1 AND transaction_hash = $2 AND log_index = $3`,
      [cursor.streamKey, cursor.last.transactionHash, cursor.last.logIndex],
    );
    const row = result.rows[0];
    if (
      row === undefined ||
      BigInt(row.block_number) !== cursor.last.blockNumber ||
      row.block_hash.toLowerCase() !== cursor.last.blockHash.toLowerCase() ||
      row.transaction_index !== cursor.last.transactionIndex
    ) {
      throw new Error("Indexed source changed behind the replay cursor; rerun with --rebuild");
    }
  }

  public async loadState(streamKey: string): Promise<{
    pools: ReplayPoolState[];
    positions: ReplayPositionState[];
    ticks: ReplayTickState[];
  }> {
    const pools = await this.connection().query<PoolRow>(
        `SELECT pool_address, chain_id, rwa_symbol, fee, initialized,
                sqrt_price_x96, tick, liquidity, observation_cardinality_next,
                fee_protocol0, fee_protocol1, event_count, mint_count,
                burn_count, swap_count, collect_count, flash_count,
                last_event_block, last_event_transaction_index,
                last_event_log_index
         FROM v3_replay_pools WHERE stream_key = $1`,
        [streamKey],
      );
    const ticks = await this.connection().query<TickRow>(
        `SELECT pool_address, tick, liquidity_gross, liquidity_net
         FROM v3_replay_ticks WHERE stream_key = $1`,
        [streamKey],
      );
    const positions = await this.connection().query<PositionRow>(
        `SELECT pool_address, owner_address, tick_lower, tick_upper,
                liquidity, minted_liquidity, burned_liquidity,
                minted_amount0, minted_amount1, burned_amount0,
                burned_amount1, collected_amount0, collected_amount1
         FROM v3_replay_positions WHERE stream_key = $1`,
        [streamKey],
      );
    return {
      pools: pools.rows.map(poolFromRow),
      positions: positions.rows.map(positionFromRow),
      ticks: ticks.rows.map(tickFromRow),
    };
  }

  public async fetchEvents(
    streamKey: string,
    after: ReplayCoordinate | null,
    throughBlock: bigint,
    limit: number,
  ): Promise<StoredReplayEvent[]> {
    const base = `SELECT pool_address, block_number, block_hash,
                         transaction_hash, transaction_index, log_index,
                         event_name, event_args
                  FROM v3_pool_events
                  WHERE stream_key = $1 AND block_number <= $2`;
    const result = after === null
      ? await this.connection().query<EventRow>(
        `${base}
         ORDER BY block_number, transaction_index, log_index
         LIMIT $3`,
        [streamKey, throughBlock.toString(), limit],
      )
      : await this.connection().query<EventRow>(
        `${base} AND (block_number, transaction_index, log_index) > ($3,$4,$5)
         ORDER BY block_number, transaction_index, log_index
         LIMIT $6`,
        [
          streamKey,
          throughBlock.toString(),
          after.blockNumber.toString(),
          after.transactionIndex,
          after.logIndex,
          limit,
        ],
      );
    return result.rows.map(eventFromRow);
  }

  public async saveBatch(
    source: ReplaySource,
    last: ReplayCoordinate,
    eventsApplied: bigint,
    changes: ReplayChanges,
  ): Promise<void> {
    const client = this.connection();
    await client.query("BEGIN");
    try {
      for (const pool of changes.pools) {
        await client.query(
          `UPDATE v3_replay_pools SET
             initialized=$3, sqrt_price_x96=$4, tick=$5, liquidity=$6,
             observation_cardinality_next=$7, fee_protocol0=$8,
             fee_protocol1=$9, event_count=$10, mint_count=$11,
             burn_count=$12, swap_count=$13, collect_count=$14,
             flash_count=$15, last_event_block=$16,
             last_event_transaction_index=$17, last_event_log_index=$18,
             updated_at=NOW()
           WHERE stream_key=$1 AND pool_address=$2`,
          [
            source.streamKey,
            pool.poolAddress,
            pool.initialized,
            pool.sqrtPriceX96?.toString() ?? null,
            pool.tick,
            pool.liquidity.toString(),
            pool.observationCardinalityNext,
            pool.feeProtocol0,
            pool.feeProtocol1,
            pool.eventCount.toString(),
            pool.mintCount.toString(),
            pool.burnCount.toString(),
            pool.swapCount.toString(),
            pool.collectCount.toString(),
            pool.flashCount.toString(),
            pool.lastEventBlock?.toString() ?? null,
            pool.lastEventTransactionIndex,
            pool.lastEventLogIndex,
          ],
        );
      }
      for (const tick of changes.deletedTicks) {
        await client.query(
          `DELETE FROM v3_replay_ticks
           WHERE stream_key=$1 AND pool_address=$2 AND tick=$3`,
          [source.streamKey, tick.poolAddress, tick.tick],
        );
      }
      for (const tick of changes.ticks) {
        await client.query(
          `INSERT INTO v3_replay_ticks (
             stream_key, pool_address, tick, liquidity_gross, liquidity_net
           ) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (stream_key, pool_address, tick) DO UPDATE SET
             liquidity_gross=EXCLUDED.liquidity_gross,
             liquidity_net=EXCLUDED.liquidity_net,
             updated_at=NOW()`,
          [
            source.streamKey,
            tick.poolAddress,
            tick.tick,
            tick.liquidityGross.toString(),
            tick.liquidityNet.toString(),
          ],
        );
      }
      for (const position of changes.positions) {
        await client.query(
          `INSERT INTO v3_replay_positions (
             stream_key, pool_address, owner_address, tick_lower, tick_upper,
             liquidity, minted_liquidity, burned_liquidity, minted_amount0,
             minted_amount1, burned_amount0, burned_amount1,
             collected_amount0, collected_amount1
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (
             stream_key, pool_address, owner_address, tick_lower, tick_upper
           ) DO UPDATE SET
             liquidity=EXCLUDED.liquidity,
             minted_liquidity=EXCLUDED.minted_liquidity,
             burned_liquidity=EXCLUDED.burned_liquidity,
             minted_amount0=EXCLUDED.minted_amount0,
             minted_amount1=EXCLUDED.minted_amount1,
             burned_amount0=EXCLUDED.burned_amount0,
             burned_amount1=EXCLUDED.burned_amount1,
             collected_amount0=EXCLUDED.collected_amount0,
             collected_amount1=EXCLUDED.collected_amount1,
             updated_at=NOW()`,
          [
            source.streamKey,
            position.poolAddress,
            position.ownerAddress,
            position.tickLower,
            position.tickUpper,
            position.liquidity.toString(),
            position.mintedLiquidity.toString(),
            position.burnedLiquidity.toString(),
            position.mintedAmount0.toString(),
            position.mintedAmount1.toString(),
            position.burnedAmount0.toString(),
            position.burnedAmount1.toString(),
            position.collectedAmount0.toString(),
            position.collectedAmount1.toString(),
          ],
        );
      }
      await client.query(
        `UPDATE v3_replay_cursors SET
           last_block_number=$2, last_block_hash=$3,
           last_transaction_hash=$4, last_transaction_index=$5,
           last_log_index=$6, events_applied=$7, updated_at=NOW()
         WHERE stream_key=$1`,
        [
          source.streamKey,
          last.blockNumber.toString(),
          last.blockHash,
          last.transactionHash,
          last.transactionIndex,
          last.logIndex,
          eventsApplied.toString(),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  public async markComplete(source: ReplaySource): Promise<void> {
    await this.connection().query(
      `UPDATE v3_replay_cursors SET
         complete_through_block=$2, complete_through_hash=$3, updated_at=NOW()
       WHERE stream_key=$1`,
      [source.streamKey, source.lastScannedBlock.toString(), source.lastScannedHash],
    );
  }

  public async close(): Promise<void> {
    if (this.client !== null) {
      if (this.lockName !== null) {
        await this.client.query("SELECT pg_advisory_unlock(hashtext($1))", [
          this.lockName,
        ]).catch(() => undefined);
      }
      this.client.release();
      this.client = null;
      this.lockName = null;
    }
    await this.pool.end();
  }
}
