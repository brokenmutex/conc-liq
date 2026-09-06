import type { RobinhoodClient } from "../client.js";
import type { BlockCheckpoint } from "../indexer/domain.js";
import { fetchCheckpoint } from "../indexer/logs.js";

export async function verifyHistoryBoundary(
  history: RobinhoodClient,
  live: RobinhoodClient,
  blockNumber: bigint,
  checkpoint?: BlockCheckpoint,
): Promise<void> {
  const [historical, canonical] = await Promise.all([
    checkpoint ?? fetchCheckpoint(history, blockNumber),
    fetchCheckpoint(live, blockNumber),
  ]);
  if (historical.number !== blockNumber || canonical.number !== blockNumber ||
      historical.hash.toLowerCase() !== canonical.hash.toLowerCase()) {
    throw new Error(`Historical provider disagrees with live chain at block ${blockNumber}`);
  }
}
