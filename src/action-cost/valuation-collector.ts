import type { OracleFeedMetadata, OracleRiskSnapshot, SourceEvidence } from "../risk/domain.js";
import { evaluateOracleRisk, sanitizeRiskError } from "../risk/evaluate.js";
import type { RiskBlock, RiskChainReader } from "../risk/reader.js";
import { RpcHealthCircuitOpenError } from "../rpc-health/store.js";
import type {
  ActionCostValuationMark,
  ActionCostValuationRun,
  ActionCostValuationSource,
} from "./valuation-domain.js";
import {
  evaluateActionCostValuation,
  summarizeActionCostValuations,
} from "./valuation.js";

function findCircuitError(error: unknown): RpcHealthCircuitOpenError | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (current instanceof RpcHealthCircuitOpenError) return current;
    seen.add(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { readonly cause?: unknown }).cause
      : null;
  }
  return null;
}

async function readBlock(
  reader: RiskChainReader,
  blockNumber: bigint,
): Promise<{ readonly block: RiskBlock | null; readonly error: string | null }> {
  try {
    return { block: await reader.getBlock(blockNumber), error: null };
  } catch (error) {
    const circuit = findCircuitError(error);
    if (circuit !== null) throw circuit;
    return { block: null, error: sanitizeRiskError(error) };
  }
}

async function readOracle(input: {
  readonly blockNumber: bigint;
  readonly blockTimestamp: bigint;
  readonly feed: OracleFeedMetadata;
  readonly maxPriceAgeSeconds: number;
  readonly reader: RiskChainReader;
}): Promise<OracleRiskSnapshot> {
  try {
    return evaluateOracleRisk({
      blockTimestamp: input.blockTimestamp,
      feed: input.feed,
      maxPriceAgeSeconds: input.maxPriceAgeSeconds,
      state: await input.reader.readOracle(input.feed.address, input.blockNumber),
    });
  } catch (error) {
    const circuit = findCircuitError(error);
    if (circuit !== null) throw circuit;
    return evaluateOracleRisk({
      blockTimestamp: input.blockTimestamp,
      feed: input.feed,
      maxPriceAgeSeconds: input.maxPriceAgeSeconds,
      readError: sanitizeRiskError(error),
      state: null,
    });
  }
}

function requireReferenceFeed(
  feed: OracleFeedMetadata,
  symbol: "ETH" | "USDG",
): void {
  if (
    feed.baseAsset.toUpperCase() !== symbol ||
    feed.quoteAsset.toUpperCase() !== "USD" ||
    feed.productTypeCode !== "RefPrice"
  ) {
    throw new Error(`${symbol}/USD feed metadata is not a canonical reference price`);
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  delayMs: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await operation(values[index]!);
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

export async function collectActionCostValuation(input: {
  readonly concurrency: number;
  readonly ethFeed: OracleFeedMetadata;
  readonly feedDirectory: SourceEvidence;
  readonly interMarkDelayMs: number;
  readonly maxPriceAgeSeconds: number;
  readonly quoteFeed: OracleFeedMetadata;
  readonly reader: RiskChainReader;
  readonly source: ActionCostValuationSource;
}): Promise<ActionCostValuationRun> {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency <= 0) {
    throw new Error("Valuation concurrency must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.interMarkDelayMs) || input.interMarkDelayMs < 0) {
    throw new Error("Valuation inter-mark delay must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(input.maxPriceAgeSeconds) || input.maxPriceAgeSeconds <= 0) {
    throw new Error("Oracle maximum price age must be a positive safe integer");
  }
  if (input.source.observations.length === 0) {
    throw new Error("Action-cost valuation source has no observations");
  }
  requireReferenceFeed(input.ethFeed, "ETH");
  requireReferenceFeed(input.quoteFeed, "USDG");

  const marks: ActionCostValuationMark[] = await mapConcurrent(
    input.source.observations,
    input.concurrency,
    input.interMarkDelayMs,
    async (observation) => {
      const blockRead = await readBlock(input.reader, observation.blockNumber);
      if (blockRead.block === null) {
        return {
          ...evaluateActionCostValuation({
            block: null,
            blockReadError: blockRead.error ?? undefined,
            ethOracle: null,
            observation,
            quoteDecimals: 6,
            quoteOracle: null,
          }),
          blockReadError: blockRead.error,
        };
      }
      const ethOracle = await readOracle({
        blockNumber: observation.blockNumber,
        blockTimestamp: blockRead.block.timestamp,
        feed: input.ethFeed,
        maxPriceAgeSeconds: input.maxPriceAgeSeconds,
        reader: input.reader,
      });
      const quoteOracle = await readOracle({
        blockNumber: observation.blockNumber,
        blockTimestamp: blockRead.block.timestamp,
        feed: input.quoteFeed,
        maxPriceAgeSeconds: input.maxPriceAgeSeconds,
        reader: input.reader,
      });
      return {
        ...evaluateActionCostValuation({
          block: blockRead.block,
          ethOracle,
          observation,
          quoteDecimals: 6,
          quoteOracle,
        }),
        blockReadError: null,
      };
    },
  );
  return {
    computedAt: new Date().toISOString(),
    ethFeed: input.ethFeed,
    executionEligible: false,
    feedDirectory: input.feedDirectory,
    marks,
    maxPriceAgeSeconds: input.maxPriceAgeSeconds,
    methodology: "block_pinned_eth_usdg_action_cost_v1",
    quoteDecimals: 6,
    quoteFeed: input.quoteFeed,
    schemaVersion: 1,
    source: input.source,
    summary: summarizeActionCostValuations(marks),
  };
}
