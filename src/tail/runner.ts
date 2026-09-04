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
import type { RiskSnapshot } from "../risk/domain.js";
import { sanitizeRiskError } from "../risk/evaluate.js";
import type { RiskCanonicalityValidation } from "../risk/store.js";
import {
  RpcHealthCircuitOpenError,
  type BulkRpcHealthGate,
} from "../rpc-health/store.js";
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

export function isRiskSnapshotDue(
  nowMs: number,
  lastAttemptAtMs: number | null,
  intervalMs: number,
): boolean {
  return lastAttemptAtMs === null || nowMs - lastAttemptAtMs >= intervalMs;
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
  readonly rpcHealthGate?: BulkRpcHealthGate;
}): Promise<TailCycleResult> {
  await input.rpcHealthGate?.assertBulkAllowed();
  const head = await input.client.getBlockNumber();
  const safeHead = calculateSafeHead(head, input.indexerConfig.confirmationDepth);
  const eventStore = new PostgresEventStore(input.databaseUrl);
  let backfill: BackfillResult;
  try {
    backfill = await runBackfill(
      input.client,
      input.manifest,
      input.indexerConfig,
      {
        beforeRpc: input.rpcHealthGate === undefined
          ? undefined
          : async () => {
            await input.rpcHealthGate!.assertBulkAllowed();
          },
        dryRun: false,
        toBlock: safeHead,
      },
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
  readonly rpcHealthGate?: BulkRpcHealthGate;
  readonly riskCanonicalityValidator?: () => Promise<RiskCanonicalityValidation | null>;
  readonly riskSnapshotter?: (blockNumber: bigint) => Promise<RiskSnapshot>;
  readonly strategyCheckpointter?: (snapshot: RiskSnapshot) => Promise<void>;
  readonly tailConfig: TailConfig;
}): Promise<void> {
  let completedCycles = 0;
  let consecutiveFailures = 0;
  let lastRiskAttemptAtMs: number | null = null;
  while (input.options.signal?.aborted !== true) {
    const startedAt = Date.now();
    try {
      const result = await runTailCycle(input);
      completedCycles += 1;
      consecutiveFailures = 0;
      if (
        input.riskSnapshotter !== undefined &&
        isRiskSnapshotDue(
          Date.now(),
          lastRiskAttemptAtMs,
          input.tailConfig.riskSnapshotIntervalMs,
        )
      ) {
        await input.rpcHealthGate?.assertBulkAllowed();
        lastRiskAttemptAtMs = Date.now();
        try {
          const snapshot = await input.riskSnapshotter(result.safeHead);
          log("info", "tail_risk_snapshot_complete", {
            blockNumber: snapshot.blockNumber,
            executionEligible: snapshot.executionEligible,
            reasons: snapshot.reasons,
          });
          if (input.strategyCheckpointter !== undefined) {
            try {
              await input.rpcHealthGate?.assertBulkAllowed();
              await input.strategyCheckpointter(snapshot);
            } catch (error) {
              if (error instanceof RpcHealthCircuitOpenError) throw error;
              log("error", "tail_strategy_checkpoint_failed", {
                error: sanitizeRiskError(error),
              });
            }
          }
        } catch (error) {
          if (error instanceof RpcHealthCircuitOpenError) throw error;
          log("error", "tail_risk_snapshot_failed", {
            error: sanitizeRiskError(error),
          });
        }
      }
      if (input.riskCanonicalityValidator !== undefined) {
        try {
          await input.rpcHealthGate?.assertBulkAllowed();
          const validation = await input.riskCanonicalityValidator();
          log("info", "tail_risk_canonicality_validated", {
            validation,
          });
        } catch (error) {
          if (error instanceof RpcHealthCircuitOpenError) throw error;
          log("error", "tail_risk_canonicality_failed", {
            error: sanitizeRiskError(error),
          });
        }
      }
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
      if (error instanceof RpcHealthCircuitOpenError) {
        consecutiveFailures = 0;
        log("warn", "tail_rpc_health_paused", {
          lagBlocks: error.status?.lagBlocks,
          lagSeconds: error.status?.lagSeconds,
          reasons: error.status?.reasons ?? [error.message],
          sampleId: error.status?.sampleId ?? null,
          state: error.status?.state ?? "unavailable",
        });
        await waitForDelay(input.tailConfig.pollIntervalMs, input.options.signal);
        continue;
      }
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
