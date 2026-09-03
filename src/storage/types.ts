import type { ObserverSnapshot } from "../domain.js";

export interface SnapshotStore {
  save(snapshot: ObserverSnapshot): Promise<void>;
  close(): Promise<void>;
}
