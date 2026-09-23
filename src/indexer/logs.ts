import { getAddress, type Hash, type Hex } from "viem";
import type { RobinhoodClient } from "../client.js";
import type {
  BlockCheckpoint,
  IndexedEventBlock,
  IndexedV3Event,
  PoolManifest,
} from "./domain.js";
import { v3PoolEventsAbi } from "./abi.js";
import { toJsonValue } from "./json.js";

const MAX_EVENT_BLOCK_HEADERS_PER_CHUNK = 512;

function requireLogField<T>(value: T | null, name: string): T {
  if (value === null) {
    throw new Error(`Confirmed log is missing ${name}`);
  }
  return value;
}

export async function fetchV3Events(
  client: RobinhoodClient,
  manifest: PoolManifest,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<IndexedV3Event[]> {
  const logs = await client.getLogs({
    address: manifest.pools.map((pool) => pool.address),
    events: v3PoolEventsAbi,
    fromBlock,
    strict: true,
    toBlock,
  });

  const seen = new Set<string>();
  const addresses = new Set(manifest.pools.map((pool) => pool.address.toLowerCase()));
  for (const entry of logs) {
    if (entry.removed || entry.blockNumber === null ||
        entry.blockNumber < fromBlock || entry.blockNumber > toBlock ||
        !addresses.has(entry.address.toLowerCase())) {
      throw new Error("Historical log is removed or outside the requested pool/block range");
    }
    const key = `${entry.transactionHash?.toLowerCase()}:${entry.logIndex}`;
    if (seen.has(key)) throw new Error("Historical provider returned duplicate logs");
    seen.add(key);
  }

  const events = logs.map((entry): IndexedV3Event => ({
    args: toJsonValue(entry.args),
    blockHash: requireLogField(entry.blockHash, "blockHash") as Hash,
    blockNumber: requireLogField(entry.blockNumber, "blockNumber"),
    chainId: manifest.chainId,
    data: entry.data,
    eventName: entry.eventName,
    logIndex: requireLogField(entry.logIndex, "logIndex"),
    poolAddress: getAddress(entry.address),
    topics: entry.topics as readonly Hex[],
    transactionHash: requireLogField(entry.transactionHash, "transactionHash") as Hash,
    transactionIndex: requireLogField(entry.transactionIndex, "transactionIndex"),
  }));

  events.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber < right.blockNumber ? -1 : 1;
    }
    if (left.transactionIndex !== right.transactionIndex) {
      return left.transactionIndex - right.transactionIndex;
    }
    return left.logIndex - right.logIndex;
  });
  return events;
}

export async function fetchCheckpoint(
  client: RobinhoodClient,
  blockNumber: bigint,
): Promise<BlockCheckpoint> {
  const block = await client.getBlock({ blockNumber });
  return {
    hash: block.hash,
    number: block.number,
    parentHash: block.parentHash,
    timestamp: new Date(Number(block.timestamp) * 1_000),
  };
}

/**
 * Fetch and verify one canonical timestamp/hash per distinct event block.
 * Concurrency is bounded so a dense chunk cannot fan out unbounded RPC work.
 */
export async function fetchEventBlockHeaders(
  client: RobinhoodClient,
  events: readonly IndexedV3Event[],
  knownHeaders: readonly BlockCheckpoint[],
  beforeRpc?: () => Promise<void>,
): Promise<IndexedEventBlock[]> {
  const logHashes = new Map<bigint, Hash>();
  for (const event of events) {
    const prior = logHashes.get(event.blockNumber);
    if (prior !== undefined && prior.toLowerCase() !== event.blockHash.toLowerCase()) {
      throw new Error(`Conflicting event block hashes at ${event.blockNumber}`);
    }
    logHashes.set(event.blockNumber, event.blockHash);
  }
  const known = new Map(knownHeaders.map((header) => [header.number, header]));
  const blocks = [...logHashes.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (blocks.length > MAX_EVENT_BLOCK_HEADERS_PER_CHUNK) {
    throw new Error(`Indexer chunk contains ${blocks.length} event blocks; maximum is ${MAX_EVENT_BLOCK_HEADERS_PER_CHUNK}`);
  }
  const result = new Array<IndexedEventBlock>(blocks.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= blocks.length) return;
      const [number, logHash] = blocks[index]!;
      const cached = known.get(number);
      if (cached !== undefined) {
        if (cached.hash.toLowerCase() !== logHash.toLowerCase()) {
          throw new Error(`Event block hash does not match canonical checkpoint at ${number}`);
        }
        result[index] = { number, hash: cached.hash, timestamp: cached.timestamp };
        continue;
      }
      await beforeRpc?.();
      const block = await client.getBlock({ blockNumber: number });
      if (block.number !== number || block.hash.toLowerCase() !== logHash.toLowerCase()) {
        throw new Error(`Event block header does not match indexed logs at ${number}`);
      }
      const timestamp = new Date(Number(block.timestamp) * 1_000);
      if (!Number.isFinite(timestamp.getTime())) {
        throw new Error(`Event block timestamp is out of range at ${number}`);
      }
      result[index] = {
        number,
        hash: block.hash,
        timestamp,
      };
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(8, blocks.length) }, worker),
  );
  const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  if (failed !== undefined) throw failed.reason;
  return result;
}
