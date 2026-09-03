import type { Address, Hash, Hex } from "viem";

export interface V3PoolTarget {
  readonly address: Address;
  readonly rwaSymbol: string;
  readonly rwaAddress: Address;
  readonly fee: number;
  readonly createdBlock: bigint;
}

export interface PoolManifest {
  readonly schemaVersion: 1;
  readonly chainId: number;
  readonly source: {
    readonly kind: string;
    readonly repository: string;
    readonly snapshotBlock: bigint;
  };
  readonly pools: readonly V3PoolTarget[];
  readonly targetSetHash: Hash;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface IndexedV3Event {
  readonly chainId: number;
  readonly poolAddress: Address;
  readonly blockNumber: bigint;
  readonly blockHash: Hash;
  readonly transactionHash: Hash;
  readonly transactionIndex: number;
  readonly logIndex: number;
  readonly eventName: string;
  readonly args: JsonValue;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface BlockCheckpoint {
  readonly number: bigint;
  readonly hash: Hash;
  readonly parentHash: Hash;
  readonly timestamp: Date;
}

export interface IndexerCursor {
  readonly streamKey: string;
  readonly chainId: number;
  readonly targetSetHash: Hash;
  readonly nextBlock: bigint;
  readonly lastScannedBlock: bigint | null;
  readonly lastScannedHash: Hash | null;
}

export interface IndexerChunk {
  readonly streamKey: string;
  readonly chainId: number;
  readonly targetSetHash: Hash;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly checkpoint: BlockCheckpoint;
  readonly events: readonly IndexedV3Event[];
}
