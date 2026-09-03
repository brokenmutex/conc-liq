import type { RobinhoodClient } from "../client.js";
import type { IndexerConfig } from "../indexer/config.js";
import type { PoolManifest } from "../indexer/domain.js";
import { runBackfill, type BackfillResult } from "../indexer/runner.js";
import { PostgresEventStore } from "../indexer/store.js";
import { log } from "../logger.js";
import type { ReplayConfig } from "../replay/config.js";
import { runReplay, type ReplayResult } from "../replay/runner.js";
import {
  PostgresReplayStore,
  ReplaySourceChangedError,
} from "../replay/store.js";
import type { TailConfig } from "./config.js";

export interface TailOptions {
  readonly maxCycles?: number;
  readonly signal?: AbortSignal;
}

export interface TailCycleResult {
  readonly backfill: BackfillResult;
  readonly replay: ReplayResult;
  readonly safeHead: bigint;
}

export function calculateSafeHead(head: bigint, confirmationDepth: number): bigint {
  const depth = BigInt(confirmationDepth);
  if (head < depth) {
    throw new Error(`Head ${head} is below confirmation depth ${depth}`);
  }
  return head - depth;
}

export function calculateRetryDelay(baseDelayMs: number, failures: number): number {
  return Math.min(60_000, baseDelayMs * (2 ** Math.max(0, failures - 1)));
}

export async function waitForDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function runReplayCycle(
  databaseUrl: string,
  streamKey: string,
  replayConfig: ReplayConfig,
): Promise<ReplayResult> {
  const store = new PostgresReplayStore(databaseUrl);
  try {
    await store.open(streamKey);
    try {
      return await runReplay(store, streamKey, {
        batchSize: replayConfig.batchSize,
        rebuild: false,
      });
    } catch (error) {
      if (!(error instanceof ReplaySourceChangedError)) {
        throw error;
      }
      log("warn", "tail_replay_rebuild", { error });
      return await runReplay(store, streamKey, {
        batchSize: replayConfig.batchSize,
        rebuild: true,
      });
    }
  } finally {
    await store.close();
  }
}

export async function runTailCycle(input: {
  readonly client: RobinhoodClient;
  readonly databaseUrl: string;
  readonly indexerConfig: IndexerConfig;
  readonly manifest: PoolManifest;
  readonly replayConfig: ReplayConfig;
}): Promise<TailCycleResult> {
  const head = await input.client.getBlockNumber();
  const safeHead = calculateSafeHead(head, input.indexerConfig.confirmationDepth);
  const eventStore = new PostgresEventStore(input.databaseUrl);
  let backfill: BackfillResult;
  try {
    backfill = await runBackfill(
      input.client,
      input.manifest,
      input.indexerConfig,
      { dryRun: false, toBlock: safeHead },
      eventStore,
    );
  } finally {
    await eventStore.close();
  }
  if (!backfill.complete) {
    throw new Error(`Backfill stopped before safe head ${safeHead}`);
  }
  const replay = await runReplayCycle(
    input.databaseUrl,
    input.indexerConfig.streamKey,
    input.replayConfig,
  );
  if (!replay.complete) {
    throw new Error(`Replay stopped before indexed source ${replay.sourceBlock}`);
  }
  return { backfill, replay, safeHead };
}

export async function runTail(input: {
  readonly client: RobinhoodClient;
  readonly databaseUrl: string;
  readonly indexerConfig: IndexerConfig;
  readonly manifest: PoolManifest;
  readonly options: TailOptions;
  readonly replayConfig: ReplayConfig;
  readonly tailConfig: TailConfig;
}): Promise<void> {
  let completedCycles = 0;
  let consecutiveFailures = 0;
  while (input.options.signal?.aborted !== true) {
    const startedAt = Date.now();
    try {
      const result = await runTailCycle(input);
      completedCycles += 1;
      consecutiveFailures = 0;
      log("info", "tail_cycle_complete", {
        cycle: completedCycles,
        durationMs: Date.now() - startedAt,
        indexedEvents: result.backfill.events,
        replayedEvents: result.replay.eventsThisRun,
        safeHead: result.safeHead,
      });
      if (
        input.options.maxCycles !== undefined &&
        completedCycles >= input.options.maxCycles
      ) {
        return;
      }
      const remainingDelay = Math.max(
        0,
        input.tailConfig.pollIntervalMs - (Date.now() - startedAt),
      );
      await waitForDelay(remainingDelay, input.options.signal);
    } catch (error) {
      consecutiveFailures += 1;
      log("error", "tail_cycle_failed", {
        consecutiveFailures,
        error,
        maxConsecutiveFailures: input.tailConfig.maxConsecutiveFailures,
      });
      if (consecutiveFailures >= input.tailConfig.maxConsecutiveFailures) {
        throw error;
      }
      await waitForDelay(
        calculateRetryDelay(input.tailConfig.errorDelayMs, consecutiveFailures),
        input.options.signal,
      );
    }
  }
}
