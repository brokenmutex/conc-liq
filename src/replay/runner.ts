import { log } from "../logger.js";
import type { ReplayCoordinate, ReplaySource } from "./domain.js";
import { V3ReplayState } from "./state.js";
import { PostgresReplayStore } from "./store.js";

export interface ReplayOptions {
  readonly batchSize: number;
  readonly maxBatches?: number;
  readonly rebuild: boolean;
}

export interface ReplayResult {
  readonly batches: number;
  readonly complete: boolean;
  readonly eventsApplied: bigint;
  readonly eventsThisRun: bigint;
  readonly sourceBlock: bigint;
}

function compareCoordinates(left: ReplayCoordinate, right: ReplayCoordinate): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }
  return left.logIndex - right.logIndex;
}

function sameSource(left: ReplaySource, right: ReplaySource): boolean {
  return left.lastScannedBlock === right.lastScannedBlock &&
    left.lastScannedHash.toLowerCase() === right.lastScannedHash.toLowerCase() &&
    left.targetSetHash.toLowerCase() === right.targetSetHash.toLowerCase();
}

export async function runReplay(
  store: PostgresReplayStore,
  streamKey: string,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const source = await store.getSource(streamKey);
  let cursor = await store.prepare(source, options.rebuild);
  await store.validateCursorSource(cursor);
  const loaded = await store.loadState(streamKey);
  const state = new V3ReplayState(loaded);

  let batches = 0;
  let eventsThisRun = 0n;
  while (options.maxBatches === undefined || batches < options.maxBatches) {
    const events = await store.fetchEvents(
      streamKey,
      cursor.last,
      source.lastScannedBlock,
      options.batchSize,
    );
    if (events.length === 0) {
      const currentSource = await store.getSource(streamKey);
      if (!sameSource(source, currentSource)) {
        log("warn", "replay_source_advanced", {
          initialSourceBlock: source.lastScannedBlock,
          currentSourceBlock: currentSource.lastScannedBlock,
        });
        return {
          batches,
          complete: false,
          eventsApplied: cursor.eventsApplied,
          eventsThisRun,
          sourceBlock: source.lastScannedBlock,
        };
      }
      await store.markComplete(source);
      return {
        batches,
        complete: true,
        eventsApplied: cursor.eventsApplied,
        eventsThisRun,
        sourceBlock: source.lastScannedBlock,
      };
    }

    let previous = cursor.last;
    for (const event of events) {
      if (previous !== null && compareCoordinates(previous, event) >= 0) {
        throw new Error("Replay source events are not in strict canonical order");
      }
      state.apply(event);
      previous = event;
    }
    const last = events.at(-1)!;
    const nextEventsApplied = cursor.eventsApplied + BigInt(events.length);
    await store.saveBatch(source, last, nextEventsApplied, state.changes());
    state.clearChanges();
    cursor = {
      ...cursor,
      completeThroughBlock: null,
      completeThroughHash: null,
      eventsApplied: nextEventsApplied,
      last,
    };
    batches += 1;
    eventsThisRun += BigInt(events.length);
    log("info", "replay_batch_complete", {
      batch: batches,
      events: events.length,
      eventsApplied: cursor.eventsApplied,
      lastBlock: last.blockNumber,
      sourceBlock: source.lastScannedBlock,
    });
  }

  return {
    batches,
    complete: false,
    eventsApplied: cursor.eventsApplied,
    eventsThisRun,
    sourceBlock: source.lastScannedBlock,
  };
}
