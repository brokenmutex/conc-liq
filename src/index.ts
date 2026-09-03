import { createRobinhoodClient } from "./client.js";
import { loadConfig } from "./config.js";
import { observeAtLatestBlock } from "./discover.js";
import { log } from "./logger.js";
import { fetchRegistry, selectCanonicalAssets } from "./registry.js";
import { createSnapshotStore } from "./storage/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  log("info", "observer_started", {
    assetsUrl: config.assetsUrl,
    feeTiers: config.feeTiers,
    persistence: config.databaseUrl === undefined ? "jsonl" : "postgresql",
    symbols: config.symbols,
  });

  const registry = await fetchRegistry(config.assetsUrl, config.httpTimeoutMs);
  const canonicalAssets = selectCanonicalAssets(registry, config.symbols);
  log("info", "canonical_assets_loaded", {
    assets: canonicalAssets.map(({ address, status, symbol }) => ({
      address,
      status,
      symbol,
    })),
  });

  const client = createRobinhoodClient(config.rpcUrl, config.rpcTimeoutMs);
  const snapshot = await observeAtLatestBlock(
    client,
    canonicalAssets,
    config.feeTiers,
  );

  const store = await createSnapshotStore(config);
  try {
    await store.save(snapshot);
  } finally {
    await store.close();
  }

  log("info", "observation_saved", {
    blockNumber: snapshot.blockNumber,
    discoveredPools: snapshot.pools.map(({ address, fee, liquidity, rwaSymbol }) => ({
      address,
      fee,
      liquidity,
      rwaSymbol,
    })),
    poolCount: snapshot.pools.length,
  });
}

main().catch((error: unknown) => {
  log("error", "observer_failed", { error });
  process.exitCode = 1;
});
