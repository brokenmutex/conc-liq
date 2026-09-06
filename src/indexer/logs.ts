import { getAddress, type Hash, type Hex } from "viem";
import type { RobinhoodClient } from "../client.js";
import type {
  BlockCheckpoint,
  IndexedV3Event,
  PoolManifest,
} from "./domain.js";
import { v3PoolEventsAbi } from "./abi.js";
import { toJsonValue } from "./json.js";

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
