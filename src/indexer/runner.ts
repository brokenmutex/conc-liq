import type { RobinhoodClient } from "../client.js";
import { log } from "../logger.js";
import type {
  BlockCheckpoint,
  IndexerCursor,
  PoolManifest,
} from "./domain.js";
import type { IndexerConfig } from "./config.js";
import { fetchCheckpoint, fetchV3Events } from "./logs.js";
import { PostgresEventStore } from "./store.js";

export interface BackfillOptions {
  readonly beforeRpc?: () => Promise<void>;
  readonly dryRun: boolean;
  readonly explicitFromBlock?: bigint;
  readonly maxChunks?: number;
  readonly toBlock: bigint;
}

export interface BackfillResult {
  readonly chunks: number;
  readonly complete: boolean;
  readonly events: number;
  readonly nextBlock: bigint;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

export function calculateResumeStart(input: {
  readonly canonicalAnchor: bigint | null;
  readonly cursor: IndexerCursor | null;
  readonly explicitFromBlock?: bigint;
  readonly manifestFromBlock: bigint;
  readonly reorgOverlap: number;
  readonly targetSetChanged: boolean;
}): bigint {
  const {
    canonicalAnchor,
    cursor,
    explicitFromBlock,
    manifestFromBlock,
    reorgOverlap,
    targetSetChanged,
  } = input;
  const floor = explicitFromBlock ?? manifestFromBlock;
  if (cursor === null) {
    return floor;
  }
  if (explicitFromBlock !== undefined && explicitFromBlock > cursor.nextBlock) {
    throw new Error(
      `--from-block ${explicitFromBlock} would skip the stored cursor at ${cursor.nextBlock}`,
    );
  }
  if (targetSetChanged && explicitFromBlock === undefined) {
    throw new Error(
      "Indexer pool target set changed; pass --from-block at or before the earliest newly added pool",
    );
  }

  let resume = targetSetChanged
    ? explicitFromBlock!
    : minBigInt(explicitFromBlock ?? cursor.nextBlock, cursor.nextBlock);

  if (cursor.lastScannedBlock !== null && canonicalAnchor !== cursor.lastScannedBlock) {
    resume = canonicalAnchor === null
      ? floor
      : minBigInt(resume, canonicalAnchor + 1n);
  }

  const overlap = BigInt(reorgOverlap);
  const withOverlap = resume > overlap ? resume - overlap : 0n;
  return maxBigInt(floor, withOverlap);
}

export async function findCanonicalAnchor(
  client: RobinhoodClient,
  cursor: IndexerCursor,
  checkpoints: readonly BlockCheckpoint[],
  beforeRpc?: () => Promise<void>,
): Promise<bigint | null> {
  if (cursor.lastScannedBlock === null || cursor.lastScannedHash === null) {
    return null;
  }

  const candidates: BlockCheckpoint[] = [
    {
      hash: cursor.lastScannedHash,
      number: cursor.lastScannedBlock,
      parentHash: cursor.lastScannedHash,
      timestamp: new Date(0),
    },
    ...checkpoints.filter((checkpoint) => checkpoint.number !== cursor.lastScannedBlock),
  ];
  for (const candidate of candidates) {
    await beforeRpc?.();
    const canonical = await client.getBlock({ blockNumber: candidate.number });
    if (canonical.hash.toLowerCase() === candidate.hash.toLowerCase()) {
      return candidate.number;
    }
  }
  return null;
}

export async function runBackfill(
  client: RobinhoodClient,
  manifest: PoolManifest,
  config: IndexerConfig,
  options: BackfillOptions,
  store?: PostgresEventStore,
): Promise<BackfillResult> {
  const manifestFromBlock = manifest.pools.reduce(
    (minimum, pool) => pool.createdBlock < minimum ? pool.createdBlock : minimum,
    manifest.pools[0]!.createdBlock,
  );

  let fromBlock = options.explicitFromBlock ?? manifestFromBlock;
  if (!options.dryRun) {
    if (store === undefined) {
      throw new Error("A PostgreSQL event store is required outside --dry-run mode");
    }
    await store.migrate();
    await store.registerManifest(config.streamKey, manifest);
    const cursor = await store.getCursor(config.streamKey);
    if (cursor !== null && cursor.chainId !== manifest.chainId) {
      throw new Error(
        `Stored cursor chain ID ${cursor.chainId} does not match ${manifest.chainId}`,
      );
    }
    const checkpoints = cursor === null
      ? []
      : await store.recentCheckpoints(config.streamKey);
    const canonicalAnchor = cursor === null
      ? null
      : await findCanonicalAnchor(
        client,
        cursor,
        checkpoints,
        options.beforeRpc,
      );
    const targetSetChanged = cursor !== null &&
      cursor.targetSetHash.toLowerCase() !== manifest.targetSetHash.toLowerCase();
    fromBlock = calculateResumeStart({
      canonicalAnchor,
      cursor,
      explicitFromBlock: options.explicitFromBlock,
      manifestFromBlock,
      reorgOverlap: config.reorgOverlap,
      targetSetChanged,
    });
    await store.rewind(
      config.streamKey,
      manifest.chainId,
      manifest.targetSetHash,
      fromBlock,
    );
  }

  if (fromBlock > options.toBlock) {
    return { chunks: 0, complete: true, events: 0, nextBlock: fromBlock };
  }

  let chunkSize = config.initialChunkSize;
  let chunks = 0;
  let eventCount = 0;
  let nextBlock = fromBlock;

  while (nextBlock <= options.toBlock) {
    if (options.maxChunks !== undefined && chunks >= options.maxChunks) {
      break;
    }
    const toBlock = minBigInt(
      options.toBlock,
      nextBlock + BigInt(chunkSize) - 1n,
    );

    let events;
    try {
      await options.beforeRpc?.();
      events = await fetchV3Events(client, manifest, nextBlock, toBlock);
    } catch (error) {
      if (chunkSize <= config.minChunkSize) {
        throw error;
      }
      const previousChunkSize = chunkSize;
      chunkSize = Math.max(config.minChunkSize, Math.floor(chunkSize / 2));
      log("warn", "indexer_chunk_reduced", {
        error,
        fromBlock,
        nextBlock,
        previousChunkSize,
        retryChunkSize: chunkSize,
      });
      continue;
    }

    await options.beforeRpc?.();
    const checkpoint = await fetchCheckpoint(client, toBlock);
    if (store !== undefined) {
      await store.saveChunk({
        chainId: manifest.chainId,
        checkpoint,
        events,
        fromBlock: nextBlock,
        streamKey: config.streamKey,
        targetSetHash: manifest.targetSetHash,
        toBlock,
      });
    }

    chunks += 1;
    eventCount += events.length;
    const eventCounts = new Map<string, number>();
    for (const event of events) {
      eventCounts.set(event.eventName, (eventCounts.get(event.eventName) ?? 0) + 1);
    }
    const eventsByType = Object.fromEntries(
      [...eventCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
    log("info", "indexer_chunk_complete", {
      chunk: chunks,
      dryRun: options.dryRun,
      eventCount: events.length,
      eventsByType,
      fromBlock: nextBlock,
      toBlock,
    });
    nextBlock = toBlock + 1n;

    if (events.length > 5_000) {
      chunkSize = Math.max(config.minChunkSize, Math.floor(chunkSize / 2));
    } else if (events.length < 500) {
      chunkSize = Math.min(config.maxChunkSize, chunkSize * 2);
    }
  }

  return {
    chunks,
    complete: nextBlock > options.toBlock,
    events: eventCount,
    nextBlock,
  };
}
