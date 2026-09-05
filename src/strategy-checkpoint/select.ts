import type { PoolManifest } from "../indexer/domain.js";

export function selectStrategyCheckpointManifest(input: {
  readonly fee?: number;
  readonly manifest: PoolManifest;
  readonly rwaSymbol?: string;
}): PoolManifest {
  if ((input.fee === undefined) !== (input.rwaSymbol === undefined)) {
    throw new Error("Strategy checkpoint RWA and fee filters must be supplied together");
  }
  if (input.fee === undefined || input.rwaSymbol === undefined) return input.manifest;
  const symbol = input.rwaSymbol.toUpperCase();
  const pools = input.manifest.pools.filter((pool) =>
    pool.rwaSymbol.toUpperCase() === symbol && pool.fee === input.fee
  );
  if (pools.length !== 1) {
    throw new Error(
      `Expected one ${symbol}/${input.fee} strategy pool, found ${pools.length}`,
    );
  }
  return { ...input.manifest, pools };
}
