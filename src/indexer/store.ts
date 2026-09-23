import pg, { type PoolClient } from "pg";
import type { Hash } from "viem";
import { assertIndexerEventTimestampsSchemaReady } from "../storage/compatibility.js";
import type {
  BlockCheckpoint,
  IndexedEventBlock,
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
  covered_through_block: string | null;
}

interface CheckpointRow {
  block_number: string;
  block_hash: Hash;
  parent_hash: Hash;
  block_timestamp: Date;
}

interface EventTimestampCoverageRow {
  from_block: string;
  from_hash: Hash;
  from_timestamp: Date;
  through_block: string;
  through_hash: Hash;
  through_timestamp: Date;
}

function cursorFromRow(row: CursorRow): IndexerCursor {
  return {
    chainId: Number(row.chain_id),
    lastScannedBlock: row.last_scanned_block === null
      ? null
      : BigInt(row.last_scanned_block),
    lastScannedHash: row.last_scanned_hash,
    coveredThroughBlock: row.covered_through_block === null
      ? null
      : BigInt(row.covered_through_block),
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

async function updateEventTimestampCoverage(
  client: PoolClient,
  chunk: IndexerChunk,
): Promise<void> {
  const selected = await client.query<EventTimestampCoverageRow>(
    `SELECT from_block, from_hash, from_timestamp, through_block,
            through_hash, through_timestamp
       FROM indexer_event_timestamp_coverage
      WHERE stream_key = $1 FOR UPDATE`,
    [chunk.streamKey],
  );
  const current = selected.rows[0];
  if (current === undefined) {
    await client.query(
      `INSERT INTO indexer_event_timestamp_coverage (
         stream_key, from_block, from_hash, from_timestamp,
         through_block, through_hash, through_timestamp
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [chunk.streamKey, chunk.fromCheckpoint.number.toString(), chunk.fromCheckpoint.hash,
        chunk.fromCheckpoint.timestamp, chunk.checkpoint.number.toString(),
        chunk.checkpoint.hash, chunk.checkpoint.timestamp],
    );
    return;
  }

  const currentFrom = BigInt(current.from_block);
  const currentThrough = BigInt(current.through_block);
  let from = current.from_block;
  let fromHash: Hash = current.from_hash;
  let fromTimestamp = current.from_timestamp;
  let through = current.through_block;
  let throughHash: Hash = current.through_hash;
  let throughTimestamp = current.through_timestamp;
  const chunkFrom = chunk.fromCheckpoint.number;
  const chunkTo = chunk.checkpoint.number;
  const separate = chunkFrom > currentThrough + 1n || chunkTo + 1n < currentFrom;
  if (separate) {
    from = chunkFrom.toString();
    fromHash = chunk.fromCheckpoint.hash;
    fromTimestamp = chunk.fromCheckpoint.timestamp;
    through = chunkTo.toString();
    throughHash = chunk.checkpoint.hash;
    throughTimestamp = chunk.checkpoint.timestamp;
  } else {
    if (chunkFrom < currentFrom) {
      from = chunkFrom.toString();
      fromHash = chunk.fromCheckpoint.hash;
      fromTimestamp = chunk.fromCheckpoint.timestamp;
    }
    if (chunkTo > currentThrough) {
      through = chunkTo.toString();
      throughHash = chunk.checkpoint.hash;
      throughTimestamp = chunk.checkpoint.timestamp;
    }
  }
  await client.query(
    `UPDATE indexer_event_timestamp_coverage
        SET from_block = $2, from_hash = $3, from_timestamp = $4,
            through_block = $5, through_hash = $6, through_timestamp = $7,
            updated_at = NOW()
      WHERE stream_key = $1`,
    [chunk.streamKey, from, fromHash, fromTimestamp, through, throughHash, throughTimestamp],
  );
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

async function insertEventBlockBatch(
  client: PoolClient,
  streamKey: string,
  blocks: readonly IndexedEventBlock[],
): Promise<void> {
  for (let offset = 0; offset < blocks.length; offset += INSERT_BATCH_SIZE) {
    const batch = blocks.slice(offset, offset + INSERT_BATCH_SIZE);
    const values: unknown[] = [];
    const rows = batch.map((block, index) => {
      const base = index * 4;
      values.push(streamKey, block.number.toString(), block.hash, block.timestamp);
      return `(${Array.from({ length: 4 }, (_, parameter) => `$${base + parameter + 1}`).join(",")})`;
    });
    await client.query(
      `INSERT INTO indexer_event_blocks (
         stream_key, block_number, block_hash, block_timestamp
       ) VALUES ${rows.join(",")}
       ON CONFLICT (stream_key, block_number) DO UPDATE SET
         block_hash = EXCLUDED.block_hash,
         block_timestamp = EXCLUDED.block_timestamp,
         created_at = NOW()`,
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
    await assertIndexerEventTimestampsSchemaReady(this.pool);
  }

  public async registerManifest(
    streamKey: string,
    manifest: PoolManifest,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const previous = await client.query<{ target_set_hash: Hash }>(
        "SELECT target_set_hash FROM indexer_cursors WHERE stream_key = $1",
        [streamKey],
      );
      if (previous.rows[0] !== undefined &&
          previous.rows[0].target_set_hash.toLowerCase() !== manifest.targetSetHash.toLowerCase()) {
        // Coverage only proves completeness for the exact pool target set that
        // was scanned; a manifest change requires a new bounded rescan.
        await client.query(
          "DELETE FROM indexer_event_timestamp_coverage WHERE stream_key = $1",
          [streamKey],
        );
      }
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
              last_scanned_block, last_scanned_hash,
              COALESCE(covered_through_block, last_scanned_block) AS covered_through_block
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
    boundary: BlockCheckpoint | null,
  ): Promise<void> {
    if ((fromBlock === 0n) !== (boundary === null) ||
        (boundary !== null && boundary.number !== fromBlock - 1n)) {
      throw new Error("Indexer rewind requires the canonical block immediately before its start");
    }
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
      await client.query(
        "DELETE FROM indexer_event_blocks WHERE stream_key = $1 AND block_number >= $2",
        [streamKey, fromBlock.toString()],
      );
      if (boundary === null) {
        await client.query(
          "DELETE FROM indexer_event_timestamp_coverage WHERE stream_key = $1",
          [streamKey],
        );
      } else {
        await client.query(
          `DELETE FROM indexer_event_timestamp_coverage
            WHERE stream_key = $1 AND from_block >= $2`,
          [streamKey, fromBlock.toString()],
        );
        await client.query(
          `UPDATE indexer_event_timestamp_coverage
              SET through_hash = CASE WHEN through_block > $2 THEN $3 ELSE through_hash END,
                  through_timestamp = CASE WHEN through_block > $2 THEN $4 ELSE through_timestamp END,
                  through_block = LEAST(through_block, $2),
                  updated_at = NOW()
            WHERE stream_key = $1 AND from_block < $2`,
          [streamKey, boundary.number.toString(), boundary.hash, boundary.timestamp],
        );
      }
      const anchor = await client.query<CheckpointRow>(
        `SELECT block_number, block_hash, parent_hash, block_timestamp
         FROM indexer_checkpoints
         WHERE stream_key = $1 AND block_number < $2
         ORDER BY block_number DESC LIMIT 1`,
        [streamKey, fromBlock.toString()],
      );
      const anchorRow = anchor.rows[0];
      // `last_scanned_block` is the reorg anchor and follows the surviving
      // checkpoint rows, which are sparse. Coverage is a separate, monotone
      // high-water mark: this call invalidated everything at or above
      // `fromBlock` and nothing below it, so coverage ends at fromBlock - 1.
      // Pointing coverage at the anchor instead made every consumer read no
      // coverage at all for the ~1 s each tail cycle spends re-scanning its
      // reorg overlap.
      await client.query(
        `INSERT INTO indexer_cursors (
           stream_key, chain_id, target_set_hash, next_block,
           last_scanned_block, last_scanned_hash, covered_through_block
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (stream_key) DO UPDATE SET
           chain_id = EXCLUDED.chain_id,
           target_set_hash = EXCLUDED.target_set_hash,
           next_block = EXCLUDED.next_block,
           last_scanned_block = EXCLUDED.last_scanned_block,
           last_scanned_hash = EXCLUDED.last_scanned_hash,
           covered_through_block = LEAST(
             COALESCE(indexer_cursors.covered_through_block, indexer_cursors.last_scanned_block, EXCLUDED.covered_through_block),
             EXCLUDED.covered_through_block),
           updated_at = NOW()`,
        [
          streamKey,
          chainId,
          targetSetHash,
          fromBlock.toString(),
          anchorRow?.block_number ?? null,
          anchorRow?.block_hash ?? null,
          (fromBlock > 0n ? fromBlock - 1n : 0n).toString(),
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
    if (chunk.checkpoint.number !== chunk.toBlock ||
        chunk.fromCheckpoint.number !== chunk.fromBlock ||
        chunk.fromCheckpoint.timestamp > chunk.checkpoint.timestamp) {
      throw new Error("Chunk checkpoint does not match its ending block");
    }
    const headers = new Map(chunk.eventBlocks.map((header) => [header.number, header]));
    if (headers.size !== chunk.eventBlocks.length || chunk.eventBlocks.some((header) =>
      header.number < chunk.fromBlock || header.number > chunk.toBlock ||
      header.timestamp < chunk.fromCheckpoint.timestamp || header.timestamp > chunk.checkpoint.timestamp ||
      (header.number === chunk.fromCheckpoint.number && header.hash.toLowerCase() !== chunk.fromCheckpoint.hash.toLowerCase()) ||
      (header.number === chunk.checkpoint.number && header.hash.toLowerCase() !== chunk.checkpoint.hash.toLowerCase())
    ) || chunk.events.some((event) => {
      const header = headers.get(event.blockNumber);
      return header === undefined || header.hash.toLowerCase() !== event.blockHash.toLowerCase();
    })) {
      throw new Error("Chunk event blocks are missing or do not match canonical log hashes");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM v3_pool_events
         WHERE stream_key = $1 AND block_number BETWEEN $2 AND $3`,
        [chunk.streamKey, chunk.fromBlock.toString(), chunk.toBlock.toString()],
      );
      await client.query(
        `DELETE FROM indexer_event_blocks
         WHERE stream_key = $1 AND block_number BETWEEN $2 AND $3`,
        [chunk.streamKey, chunk.fromBlock.toString(), chunk.toBlock.toString()],
      );
      await insertEventBlockBatch(client, chunk.streamKey, chunk.eventBlocks);
      await insertEventBatch(client, chunk.streamKey, chunk.events);
      await updateEventTimestampCoverage(client, chunk);
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
      // A saved chunk only ever extends coverage. A stale or out-of-order
      // writer must not be able to move the high-water mark backwards; only
      // `rewind` lowers it, and only to the block it invalidated.
      await client.query(
        `INSERT INTO indexer_cursors (
           stream_key, chain_id, target_set_hash, next_block,
           last_scanned_block, last_scanned_hash, covered_through_block
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (stream_key) DO UPDATE SET
           chain_id = EXCLUDED.chain_id,
           target_set_hash = EXCLUDED.target_set_hash,
           next_block = EXCLUDED.next_block,
           last_scanned_block = EXCLUDED.last_scanned_block,
           last_scanned_hash = EXCLUDED.last_scanned_hash,
           covered_through_block = GREATEST(
             COALESCE(indexer_cursors.covered_through_block, 0), EXCLUDED.covered_through_block),
           updated_at = NOW()`,
        [
          chunk.streamKey,
          chunk.chainId,
          chunk.targetSetHash,
          (chunk.toBlock + 1n).toString(),
          chunk.toBlock.toString(),
          chunk.checkpoint.hash,
          chunk.toBlock.toString(),
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
