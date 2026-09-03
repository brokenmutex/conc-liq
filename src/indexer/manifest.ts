import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getAddress, isAddress, type Hash } from "viem";
import { z } from "zod";
import { ROBINHOOD_CHAIN_ID } from "../constants.js";
import type { PoolManifest, V3PoolTarget } from "./domain.js";

const decimalInteger = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().nonnegative(),
]);

const poolSchema = z.object({
  address: z.string(),
  createdBlock: decimalInteger,
  fee: z.number().int().positive().max(1_000_000),
  rwaAddress: z.string(),
  rwaSymbol: z.string().min(1),
});

const manifestSchema = z.object({
  chainId: z.number().int(),
  pools: z.array(poolSchema).min(1),
  schemaVersion: z.literal(1),
  source: z.object({
    kind: z.string().min(1),
    repository: z.string().min(1),
    snapshotBlock: decimalInteger,
  }),
});

export async function loadPoolManifest(path: string): Promise<PoolManifest> {
  const raw = await readFile(path, "utf8");
  const parsed = manifestSchema.parse(JSON.parse(raw));
  if (parsed.chainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error(
      `Pool manifest chain ID mismatch: expected ${ROBINHOOD_CHAIN_ID}, received ${parsed.chainId}`,
    );
  }

  const pools: V3PoolTarget[] = parsed.pools.map((pool) => {
    if (!isAddress(pool.address) || !isAddress(pool.rwaAddress)) {
      throw new Error(`Invalid address in pool manifest for ${pool.rwaSymbol}`);
    }
    return {
      address: getAddress(pool.address),
      createdBlock: BigInt(pool.createdBlock),
      fee: pool.fee,
      rwaAddress: getAddress(pool.rwaAddress),
      rwaSymbol: pool.rwaSymbol.toUpperCase(),
    };
  });

  const addresses = new Set<string>();
  for (const pool of pools) {
    const key = pool.address.toLowerCase();
    if (addresses.has(key)) {
      throw new Error(`Duplicate pool address in manifest: ${pool.address}`);
    }
    addresses.add(key);
  }

  const canonicalTargets = pools
    .map((pool) => ({
      address: pool.address.toLowerCase(),
      createdBlock: pool.createdBlock.toString(),
      fee: pool.fee,
      rwaAddress: pool.rwaAddress.toLowerCase(),
      rwaSymbol: pool.rwaSymbol,
    }))
    .sort((left, right) => left.address.localeCompare(right.address));
  const targetSetHash = `0x${createHash("sha256")
    .update(JSON.stringify(canonicalTargets))
    .digest("hex")}` as Hash;

  return {
    chainId: parsed.chainId,
    pools,
    schemaVersion: parsed.schemaVersion,
    source: {
      kind: parsed.source.kind,
      repository: parsed.source.repository,
      snapshotBlock: BigInt(parsed.source.snapshotBlock),
    },
    targetSetHash,
  };
}

export function earliestCreationBlock(manifest: PoolManifest): bigint {
  return manifest.pools.reduce(
    (earliest, pool) => pool.createdBlock < earliest ? pool.createdBlock : earliest,
    manifest.pools[0]!.createdBlock,
  );
}
