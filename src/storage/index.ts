import type { ObserverConfig } from "../config.js";
import { JsonlSnapshotStore } from "./jsonl.js";
import { PostgresSnapshotStore } from "./postgres.js";
import type { SnapshotStore } from "./types.js";

export async function createSnapshotStore(
  config: ObserverConfig,
): Promise<SnapshotStore> {
  if (config.databaseUrl === undefined) {
    return new JsonlSnapshotStore(config.jsonlPath);
  }

  const store = new PostgresSnapshotStore(config.databaseUrl);
  await store.migrate();
  return store;
}
