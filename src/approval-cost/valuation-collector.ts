import { RpcHealthCircuitOpenError } from "../rpc-health/store.js";
import type { OracleFeedMetadata, OracleRiskSnapshot, SourceEvidence } from "../risk/domain.js";
import { evaluateOracleRisk, sanitizeRiskError } from "../risk/evaluate.js";
import type { RiskBlock, RiskChainReader } from "../risk/reader.js";
import type {
  ApprovalCostValuationMark,
  ApprovalCostValuationRun,
  ApprovalCostValuationSource,
} from "./valuation-domain.js";
import {
  evaluateApprovalCostValuation,
  summarizeApprovalCostValuations,
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

async function safeBlock(
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

async function safeOracle(input: {
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

export async function collectApprovalCostValuation(input: {
  readonly ethFeed: OracleFeedMetadata;
  readonly feedDirectory: SourceEvidence;
  readonly interMarkDelayMs: number;
  readonly maxPriceAgeSeconds: number;
  readonly quoteFeed: OracleFeedMetadata;
  readonly reader: RiskChainReader;
  readonly source: ApprovalCostValuationSource;
}): Promise<ApprovalCostValuationRun> {
  if (!Number.isSafeInteger(input.interMarkDelayMs) || input.interMarkDelayMs < 0) {
    throw new Error("Approval valuation delay must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(input.maxPriceAgeSeconds) || input.maxPriceAgeSeconds <= 0) {
    throw new Error("Oracle maximum price age must be a positive safe integer");
  }
  requireReferenceFeed(input.ethFeed, "ETH");
  requireReferenceFeed(input.quoteFeed, "USDG");
  const marks: ApprovalCostValuationMark[] = [];
  for (const observation of input.source.observations) {
    if (observation.sourceStatus !== "comparable") {
      marks.push(evaluateApprovalCostValuation({
        block: null,
        ethOracle: null,
        observation,
        quoteDecimals: 6,
        quoteOracle: null,
      }));
      continue;
    }
    const blockRead = await safeBlock(input.reader, observation.blockNumber);
    if (blockRead.block === null) {
      marks.push(evaluateApprovalCostValuation({
        block: null,
        blockReadError: blockRead.error ?? undefined,
        ethOracle: null,
        observation,
        quoteDecimals: 6,
        quoteOracle: null,
      }));
    } else {
      const ethOracle = await safeOracle({
        blockNumber: observation.blockNumber,
        blockTimestamp: blockRead.block.timestamp,
        feed: input.ethFeed,
        maxPriceAgeSeconds: input.maxPriceAgeSeconds,
        reader: input.reader,
      });
      const quoteOracle = await safeOracle({
        blockNumber: observation.blockNumber,
        blockTimestamp: blockRead.block.timestamp,
        feed: input.quoteFeed,
        maxPriceAgeSeconds: input.maxPriceAgeSeconds,
        reader: input.reader,
      });
      marks.push(evaluateApprovalCostValuation({
        block: blockRead.block,
        ethOracle,
        observation,
        quoteDecimals: 6,
        quoteOracle,
      }));
    }
    if (input.interMarkDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, input.interMarkDelayMs));
    }
  }
  return {
    computedAt: new Date().toISOString(),
    ethFeed: input.ethFeed,
    executionEligible: false,
    feedDirectory: input.feedDirectory,
    marks,
    maxPriceAgeSeconds: input.maxPriceAgeSeconds,
    methodology: "block_pinned_eth_usdg_approval_cost_v1",
    quoteDecimals: 6,
    quoteFeed: input.quoteFeed,
    schemaVersion: 1,
    source: input.source,
    summary: summarizeApprovalCostValuations(marks),
  };
}
