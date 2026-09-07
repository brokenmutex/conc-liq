import pg, { type PoolClient } from "pg";
import type { Hash } from "viem";
import { assertSchemaReady } from "../storage/compatibility.js";
import type {
  BlockCheckpoint,
  IndexerChunk,
  IndexerCursor,
  IndexedV3Event,
  PoolManifest,
} from "./domain.js";

const { Pool } = pg;
const INSERT_BATCH_SIZE = 250;

interface CursorRow {
  stream_key: string;
  chain_id: string;
  target_set_hash: Hash;
  next_block: string;
  last_scanned_block: string | null;
  last_scanned_hash: Hash | null;
}

interface CheckpointRow {
  block_number: string;
  block_hash: Hash;
  parent_hash: Hash;
  block_timestamp: Date;
}

function cursorFromRow(row: CursorRow): IndexerCursor {
  return {
    chainId: Number(row.chain_id),
    lastScannedBlock: row.last_scanned_block === null
      ? null
      : BigInt(row.last_scanned_block),
    lastScannedHash: row.last_scanned_hash,
    nextBlock: BigInt(row.next_block),
    streamKey: row.stream_key,
    targetSetHash: row.target_set_hash,
  };
}

function checkpointFromRow(row: CheckpointRow): BlockCheckpoint {
  return {
    hash: row.block_hash,
    number: BigInt(row.block_number),
    parentHash: row.parent_hash,
    timestamp: row.block_timestamp,
  };
}

async function insertEventBatch(
  client: PoolClient,
  streamKey: string,
  events: readonly IndexedV3Event[],
): Promise<void> {
  for (let offset = 0; offset < events.length; offset += INSERT_BATCH_SIZE) {
    const batch = events.slice(offset, offset + INSERT_BATCH_SIZE);
    const values: unknown[] = [];
    const rows = batch.map((event, index) => {
      const base = index * 12;
      values.push(
        streamKey,
        event.chainId,
        event.poolAddress,
        event.blockNumber.toString(),
        event.blockHash,
        event.transactionHash,
        event.transactionIndex,
        event.logIndex,
        event.eventName,
        JSON.stringify(event.args),
        JSON.stringify(event.topics),
        event.data,
      );
      return `(${Array.from({ length: 12 }, (_, parameter) => `$${base + parameter + 1}`).join(",")})`;
    });

    await client.query(
      `INSERT INTO v3_pool_events (
         stream_key, chain_id, pool_address, block_number, block_hash,
         transaction_hash, transaction_index, log_index, event_name,
         event_args, raw_topics, raw_data
       ) VALUES ${rows.join(",")}
       ON CONFLICT (stream_key, transaction_hash, log_index) DO UPDATE SET
         chain_id = EXCLUDED.chain_id,
         pool_address = EXCLUDED.pool_address,
         block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash,
         transaction_index = EXCLUDED.transaction_index,
         event_name = EXCLUDED.event_name,
         event_args = EXCLUDED.event_args,
         raw_topics = EXCLUDED.raw_topics,
         raw_data = EXCLUDED.raw_data,
         observed_at = NOW()`,
      values,
    );
  }
}

export class PostgresEventStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 4 });
  }

  public async assertReady(): Promise<void> {
    await assertSchemaReady(this.pool);
  }

  public async registerManifest(
    streamKey: string,
    manifest: PoolManifest,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE indexer_pools SET enabled = FALSE, updated_at = NOW() WHERE stream_key = $1",
        [streamKey],
      );
      for (const target of manifest.pools) {
        await client.query(
          `INSERT INTO indexer_pools (
             stream_key, pool_address, chain_id, rwa_symbol, rwa_address,
             fee, created_block, target_set_hash, enabled
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
           ON CONFLICT (stream_key, pool_address) DO UPDATE SET
             chain_id = EXCLUDED.chain_id,
             rwa_symbol = EXCLUDED.rwa_symbol,
             rwa_address = EXCLUDED.rwa_address,
             fee = EXCLUDED.fee,
             created_block = EXCLUDED.created_block,
             target_set_hash = EXCLUDED.target_set_hash,
             enabled = TRUE,
             updated_at = NOW()`,
          [
            streamKey,
            target.address,
            manifest.chainId,
            target.rwaSymbol,
            target.rwaAddress,
            target.fee,
            target.createdBlock.toString(),
            manifest.targetSetHash,
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

  public async getCursor(streamKey: string): Promise<IndexerCursor | null> {
    const result = await this.pool.query<CursorRow>(
      `SELECT stream_key, chain_id, target_set_hash, next_block,
              last_scanned_block, last_scanned_hash
       FROM indexer_cursors WHERE stream_key = $1`,
      [streamKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : cursorFromRow(row);
  }

  public async recentCheckpoints(
    streamKey: string,
    limit: number = 128,
  ): Promise<BlockCheckpoint[]> {
    const result = await this.pool.query<CheckpointRow>(
      `SELECT block_number, block_hash, parent_hash, block_timestamp
       FROM indexer_checkpoints
       WHERE stream_key = $1
       ORDER BY block_number DESC
       LIMIT $2`,
      [streamKey, limit],
    );
    return result.rows.map(checkpointFromRow);
  }

  public async rewind(
    streamKey: string,
    chainId: number,
    targetSetHash: Hash,
    fromBlock: bigint,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM v3_pool_events WHERE stream_key = $1 AND block_number >= $2",
        [streamKey, fromBlock.toString()],
      );
      await client.query(
        "DELETE FROM indexer_checkpoints WHERE stream_key = $1 AND block_number >= $2",
        [streamKey, fromBlock.toString()],
      );
      const anchor = await client.query<CheckpointRow>(
        `SELECT block_number, block_hash, parent_hash, block_timestamp
         FROM indexer_checkpoints
         WHERE stream_key = $1 AND block_number < $2
         ORDER BY block_number DESC LIMIT 1`,
        [streamKey, fromBlock.toString()],
      );
      const anchorRow = anchor.rows[0];
      await client.query(
        `INSERT INTO indexer_cursors (
           stream_key, chain_id, target_set_hash, next_block,
           last_scanned_block, last_scanned_hash
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (stream_key) DO UPDATE SET
           chain_id = EXCLUDED.chain_id,
           target_set_hash = EXCLUDED.target_set_hash,
           next_block = EXCLUDED.next_block,
           last_scanned_block = EXCLUDED.last_scanned_block,
           last_scanned_hash = EXCLUDED.last_scanned_hash,
           updated_at = NOW()`,
        [
          streamKey,
          chainId,
          targetSetHash,
          fromBlock.toString(),
          anchorRow?.block_number ?? null,
          anchorRow?.block_hash ?? null,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async saveChunk(chunk: IndexerChunk): Promise<void> {
    if (chunk.checkpoint.number !== chunk.toBlock) {
      throw new Error("Chunk checkpoint does not match its ending block");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM v3_pool_events
         WHERE stream_key = $1 AND block_number BETWEEN $2 AND $3`,
        [chunk.streamKey, chunk.fromBlock.toString(), chunk.toBlock.toString()],
      );
      await insertEventBatch(client, chunk.streamKey, chunk.events);
      await client.query(
        `INSERT INTO indexer_checkpoints (
           stream_key, block_number, block_hash, parent_hash, block_timestamp
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (stream_key, block_number) DO UPDATE SET
           block_hash = EXCLUDED.block_hash,
           parent_hash = EXCLUDED.parent_hash,
           block_timestamp = EXCLUDED.block_timestamp,
           created_at = NOW()`,
        [
          chunk.streamKey,
          chunk.checkpoint.number.toString(),
          chunk.checkpoint.hash,
          chunk.checkpoint.parentHash,
          chunk.checkpoint.timestamp,
        ],
      );
      await client.query(
        `INSERT INTO indexer_cursors (
           stream_key, chain_id, target_set_hash, next_block,
           last_scanned_block, last_scanned_hash
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (stream_key) DO UPDATE SET
           chain_id = EXCLUDED.chain_id,
           target_set_hash = EXCLUDED.target_set_hash,
           next_block = EXCLUDED.next_block,
           last_scanned_block = EXCLUDED.last_scanned_block,
           last_scanned_hash = EXCLUDED.last_scanned_hash,
           updated_at = NOW()`,
        [
          chunk.streamKey,
          chunk.chainId,
          chunk.targetSetHash,
          (chunk.toBlock + 1n).toString(),
          chunk.toBlock.toString(),
          chunk.checkpoint.hash,
        ],
      );
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
