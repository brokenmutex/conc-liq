import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ObserverSnapshot } from "../domain.js";
import type { SnapshotStore } from "./types.js";

export class JsonlSnapshotStore implements SnapshotStore {
  public constructor(private readonly path: string) {}

  public async save(snapshot: ObserverSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(snapshot)}\n`, "utf8");
  }

  public async close(): Promise<void> {}
}
