import { createHash } from "node:crypto";
import type { CanonicalAsset } from "../domain.js";
import type {
  OracleFeedMetadata,
  OracleRoundState,
  SourceEvidence,
  TokenRiskState,
} from "../risk/domain.js";
import { sanitizeRiskError } from "../risk/evaluate.js";
import type { RiskChainReader } from "../risk/reader.js";
import type { CanonicalRangePolicyReplaySource } from "../simulator/domain.js";
import type {
  OracleCalibrationMark,
  OracleCalibrationRun,
} from "./domain.js";
import { evaluateOracleCalibrationMark } from "./evaluate.js";

type OracleCalibrationReader = Pick<
  RiskChainReader,
  "readOracle" | "readToken" | "readTokenDecimals"
>;

async function safeOracleRead(
  reader: OracleCalibrationReader,
  feed: OracleFeedMetadata,
  blockNumber: bigint,
): Promise<{ readonly error: string | null; readonly state: OracleRoundState | null }> {
  try {
    return { error: null, state: await reader.readOracle(feed.address, blockNumber) };
  } catch (error) {
    return { error: sanitizeRiskError(error), state: null };
  }
}

async function safeTokenRead(
  reader: OracleCalibrationReader,
  address: CanonicalAsset["address"],
  blockNumber: bigint,
): Promise<{ readonly error: string | null; readonly state: TokenRiskState | null }> {
  try {
    return { error: null, state: await reader.readToken(address, blockNumber) };
  } catch (error) {
    return { error: sanitizeRiskError(error), state: null };
  }
}

async function safeTokenDecimalsRead(
  reader: OracleCalibrationReader,
  address: CanonicalAsset["address"],
  blockNumber: bigint,
): Promise<{ readonly error: string | null; readonly value: number | null }> {
  try {
    return {
      error: null,
      value: await reader.readTokenDecimals(address, blockNumber),
    };
  } catch (error) {
    return { error: sanitizeRiskError(error), value: null };
  }
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function calibrationHash(input: {
  readonly checkpointIds: readonly string[];
  readonly feedDirectorySha256: string;
  readonly markEvidence: readonly unknown[];
  readonly maxPriceAgeSeconds: number;
  readonly quoteFeed: string;
  readonly registrySha256: string;
  readonly rwaDecimals: number;
  readonly rwaFeed: string;
}): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

export async function collectOracleCalibration(input: {
  readonly feedDirectory: SourceEvidence;
  readonly maxPriceAgeSeconds: number;
  readonly quoteFeed: OracleFeedMetadata;
  readonly reader: OracleCalibrationReader;
  readonly registry: SourceEvidence;
  readonly registryAsset: CanonicalAsset;
  readonly rwaFeed: OracleFeedMetadata;
  readonly source: CanonicalRangePolicyReplaySource;
}): Promise<OracleCalibrationRun> {
  const quoteIsToken0 = sameAddress(input.source.quoteToken, input.source.token0);
  const quoteIsToken1 = sameAddress(input.source.quoteToken, input.source.token1);
  if (quoteIsToken0 === quoteIsToken1) {
    throw new Error("Oracle calibration pool must contain USDG exactly once");
  }
  const rwaToken = quoteIsToken0 ? input.source.token1 : input.source.token0;
  if (!sameAddress(rwaToken, input.registryAsset.address)) {
    throw new Error(
      `Pool RWA token ${rwaToken} does not match registry ` +
      `${input.registryAsset.address}`,
    );
  }
  if (input.registryAsset.symbol !== input.source.rwaSymbol) {
    throw new Error("Pool RWA symbol does not match the canonical registry asset");
  }
  if (input.registryAsset.decimals < 0 || input.registryAsset.decimals > 255) {
    throw new Error("Registry RWA decimals are outside the uint8 domain");
  }
  if (!Number.isSafeInteger(input.maxPriceAgeSeconds) || input.maxPriceAgeSeconds <= 0) {
    throw new Error("Oracle maximum price age must be a positive safe integer");
  }
  if (
    input.rwaFeed.baseAsset.toUpperCase() !== input.source.rwaSymbol ||
    input.rwaFeed.quoteAsset.toUpperCase() !== "USD" ||
    input.rwaFeed.productTypeCode !== "primaryTokenizedPrice"
  ) {
    throw new Error("RWA feed metadata does not match the calibrated asset");
  }
  if (
    input.quoteFeed.baseAsset.toUpperCase() !== "USDG" ||
    input.quoteFeed.quoteAsset.toUpperCase() !== "USD" ||
    input.quoteFeed.productTypeCode !== "RefPrice"
  ) {
    throw new Error("Quote feed metadata is not canonical USDG/USD reference price");
  }

  const marks: OracleCalibrationMark[] = [];
  for (let offset = 0; offset < input.source.checkpoints.length; offset += 4) {
    const batch = input.source.checkpoints.slice(offset, offset + 4);
    marks.push(...await Promise.all(batch.map(async (checkpoint) => {
      const [rwaOracle, quoteOracle, token, tokenDecimals] = await Promise.all([
        safeOracleRead(input.reader, input.rwaFeed, checkpoint.run.blockNumber),
        safeOracleRead(input.reader, input.quoteFeed, checkpoint.run.blockNumber),
        safeTokenRead(
          input.reader,
          input.registryAsset.address,
          checkpoint.run.blockNumber,
        ),
        safeTokenDecimalsRead(
          input.reader,
          input.registryAsset.address,
          checkpoint.run.blockNumber,
        ),
      ]);
      return evaluateOracleCalibrationMark({
        checkpoint,
        maxPriceAgeSeconds: input.maxPriceAgeSeconds,
        quoteDecimals: 6,
        quoteFeed: input.quoteFeed,
        quoteOracle: quoteOracle.state,
        quoteOracleReadError: quoteOracle.error ?? undefined,
        quoteToken: input.source.quoteToken,
        rwaDecimals: input.registryAsset.decimals,
        rwaFeed: input.rwaFeed,
        rwaOracle: rwaOracle.state,
        rwaOracleReadError: rwaOracle.error ?? undefined,
        token: token.state,
        tokenDecimals: tokenDecimals.value,
        tokenDecimalsReadError: tokenDecimals.error ?? undefined,
        token0: input.source.token0,
        token1: input.source.token1,
        tokenReadError: token.error ?? undefined,
      });
    })));
  }
  const validMarks = marks.filter((mark) => mark.status === "valid").length;
  const first = input.source.checkpoints[0]!.run;
  const last = input.source.checkpoints.at(-1)!.run;
  return {
    assumptions: [
      "Chainlink token feed is already UI-multiplier adjusted",
      "USDG/USD converts the token feed into USDG/RWA",
      "feed-directory metadata is current and source-hashed",
      "oracle rounds and token guards are historical block-pinned reads",
      "stale, paused, transitioning, or unreadable marks are excluded",
      "pool/oracle deviation is a diagnostic, not executable edge",
    ],
    calibrationHash: calibrationHash({
      checkpointIds: input.source.checkpoints.map((checkpoint) =>
        checkpoint.run.runId
      ),
      feedDirectorySha256: input.feedDirectory.sha256,
      markEvidence: marks.map((mark) => ({
        accountingRunId: mark.accountingRunId,
        deviationPpm: mark.deviationPpm,
        oraclePriceX18: mark.oraclePriceX18,
        poolPriceX18: mark.poolPriceX18,
        quoteRoundId: mark.quoteOracle?.roundId ?? null,
        reasons: mark.reasons,
        rwaRoundId: mark.rwaOracle?.roundId ?? null,
        tokenDecimals: mark.tokenDecimals,
        tokenNewUiMultiplier: mark.token?.newUIMultiplier ?? null,
        tokenOraclePaused: mark.token?.oraclePaused ?? null,
        tokenUiMultiplier: mark.token?.uiMultiplier ?? null,
      })),
      maxPriceAgeSeconds: input.maxPriceAgeSeconds,
      quoteFeed: input.quoteFeed.address.toLowerCase(),
      registrySha256: input.registry.sha256,
      rwaDecimals: input.registryAsset.decimals,
      rwaFeed: input.rwaFeed.address.toLowerCase(),
    }),
    computedAt: new Date().toISOString(),
    executionEligible: false,
    excludedMarks: marks.length - validMarks,
    feedDirectory: input.feedDirectory,
    fee: input.source.fee,
    first,
    last,
    marks,
    maxPriceAgeSeconds: input.maxPriceAgeSeconds,
    methodology: "block_pinned_multiplier_adjusted_oracle_basis_v1",
    poolAddress: input.source.poolAddress,
    quoteDecimals: 6,
    quoteFeed: input.quoteFeed,
    quoteToken: input.source.quoteToken,
    registry: input.registry,
    registryAsset: input.registryAsset,
    rwaFeed: input.rwaFeed,
    rwaSymbol: input.source.rwaSymbol,
    schemaVersion: 2,
    streamKey: input.source.streamKey,
    token0: input.source.token0,
    token1: input.source.token1,
    validMarks,
  };
}
