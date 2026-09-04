import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address, Hash } from "viem";
import { Q96 } from "../src/backtest/principal.js";
import { USDG } from "../src/constants.js";
import type { PoolManifest } from "../src/indexer/domain.js";
import type {
  AssetRiskSnapshot,
  OracleFeedMetadata,
  OracleRiskSnapshot,
  OracleRoundState,
  RiskSnapshot,
} from "../src/risk/domain.js";
import { collectStrategyCheckpoint } from "../src/strategy-checkpoint/collector.js";
import { loadStrategyCheckpointConfig } from "../src/strategy-checkpoint/config.js";
import type {
  RawStrategyPoolState,
  StrategyCheckpointReader,
} from "../src/strategy-checkpoint/reader.js";

const rwa = "0x1111111111111111111111111111111111111111" as Address;
const poolA = "0x2222222222222222222222222222222222222222" as Address;
const poolB = "0x3333333333333333333333333333333333333333" as Address;
const blockHash = `0x${"44".repeat(32)}` as Hash;
const targetSetHash = `0x${"55".repeat(32)}` as Hash;
const timestamp = 1_700_000_000;

function feed(symbol: string): OracleFeedMetadata {
  return {
    address: (symbol === "USDG"
      ? "0x6666666666666666666666666666666666666666"
      : "0x7777777777777777777777777777777777777777") as Address,
    baseAsset: symbol,
    decimals: 8,
    heartbeatSeconds: 60,
    marketHours: null,
    name: `${symbol} / USD`,
    productTypeCode: symbol === "USDG" ? "RefPrice" : "primaryTokenizedPrice",
    quoteAsset: "USD",
  };
}

function oracleState(symbol: string): OracleRoundState {
  return {
    answer: "100000000",
    answeredInRound: "10",
    codeHash: `0x${"88".repeat(32)}` as Hash,
    decimals: 8,
    description: `${symbol} / USD`,
    roundId: "10",
    startedAt: String(timestamp - 10),
    updatedAt: String(timestamp - 10),
  };
}

function oracleRisk(symbol: string): OracleRiskSnapshot {
  return {
    executionEligible: true,
    feed: feed(symbol),
    flags: {
      answerPositive: true,
      decimalsMatch: true,
      descriptionMatches: true,
      priceFresh: true,
      roundComplete: true,
      timestampNotFuture: true,
    },
    maxAgeSeconds: 300,
    priceAgeSeconds: 10,
    readError: null,
    reasons: [],
    state: oracleState(symbol),
  };
}

function asset(): AssetRiskSnapshot {
  return {
    executionEligible: false,
    flags: {
      corporateActionPending: false,
      multiplierConsistent: true,
      registryActive: true,
      tradingCapabilitiesComplete: true,
      tradingCapabilitiesTradable: true,
    },
    onchain: {
      codeHash: `0x${"99".repeat(32)}` as Hash,
      effectiveAt: "0",
      newUIMultiplier: "1000000000000000000",
      oraclePaused: false,
      uiMultiplier: "1000000000000000000",
    },
    onchainReadError: null,
    oracle: oracleRisk("TEST"),
    reasons: ["sequencer_feed_unavailable"],
    registry: {
      address: rwa,
      currentMultiplier: "1.000000000000000000",
      decimals: 6,
      id: "test-id",
      isin: null,
      name: "Test Token",
      pendingMultiplier: null,
      pendingMultiplierEffectiveTime: null,
      status: "ASSET_STATUS_ACTIVE",
      symbol: "TEST",
      tradingCapabilities: null,
    },
  };
}

function risk(): RiskSnapshot {
  const observedAt = new Date((timestamp + 1) * 1_000).toISOString();
  const evidence = {
    fetchedAt: observedAt,
    sha256: `sha256:${"ab".repeat(32)}`,
    url: "https://example.invalid/source",
  };
  return {
    assets: [asset()],
    blockHash,
    blockNumber: "100",
    blockTimestamp: new Date(timestamp * 1_000).toISOString(),
    chainId: 4663,
    executionEligible: false,
    feedDirectory: evidence,
    marketSession: {
      evidence,
      executionEligible: true,
      policy: "robinhood_stock_tokens_24_7",
      reasons: [],
      status: "open_24_7",
    },
    observedAt,
    quoteOracle: oracleRisk("USDG"),
    reasons: ["sequencer_feed_unavailable"],
    registry: evidence,
    schemaVersion: 2,
    sequencer: {
      executionEligible: false,
      reasons: ["sequencer_feed_unavailable"],
      status: "unavailable",
    },
  };
}

function manifest(): PoolManifest {
  return {
    chainId: 4663,
    pools: [poolA, poolB].map((address) => ({
      address,
      createdBlock: 1n,
      fee: 500,
      rwaAddress: rwa,
      rwaSymbol: "TEST",
    })),
    schemaVersion: 1,
    source: {
      kind: "test",
      repository: "test",
      snapshotBlock: 1n,
    },
    targetSetHash,
  };
}

class Reader implements StrategyCheckpointReader {
  public decimalsReads = 0;

  public async readPool(address: Address): Promise<RawStrategyPoolState> {
    return {
      feeGrowthGlobal0X128: 10n,
      feeGrowthGlobal1X128: 20n,
      liquidity: 1_000n,
      sqrtPriceX96: Q96,
      tick: 0,
      unlocked: address !== poolB,
    };
  }

  public async readTokenDecimals(): Promise<number> {
    this.decimalsReads += 1;
    return 6;
  }
}

describe("lightweight synchronized strategy checkpoints", () => {
  it("is disabled by default and validates bounded concurrency", () => {
    assert.deepEqual(loadStrategyCheckpointConfig({}), {
      concurrency: 4,
      enabled: false,
    });
    assert.deepEqual(loadStrategyCheckpointConfig({
      STRATEGY_CHECKPOINT_CONCURRENCY: "8",
      STRATEGY_CHECKPOINT_ENABLED: "true",
    }), {
      concurrency: 8,
      enabled: true,
    });
    assert.throws(() => loadStrategyCheckpointConfig({
      STRATEGY_CHECKPOINT_CONCURRENCY: "25",
    }));
  });

  it("deduplicates token reads and excludes a locked pool without using global gates", async () => {
    const reader = new Reader();
    const checkpoint = await collectStrategyCheckpoint({
      concurrency: 2,
      manifest: manifest(),
      reader,
      risk: risk(),
      streamKey: "test",
    });

    assert.equal(reader.decimalsReads, 1);
    assert.equal(checkpoint.validPools, 1);
    assert.equal(checkpoint.excludedPools, 1);
    assert.equal(checkpoint.executionEligible, false);
    assert.equal(checkpoint.pools[0]?.valuation.status, "valid");
    assert.equal(checkpoint.pools[0]?.valuation.oraclePriceX18, "1000000000000000000");
    assert.equal(checkpoint.pools[0]?.valuation.poolPriceX18, "1000000000000000000");
    assert.deepEqual(checkpoint.pools[1]?.valuation.reasons, ["pool_locked"]);
  });

  it("retains a pool but excludes its valuation when an oracle feed is absent", async () => {
    const missing = risk();
    const checkpoint = await collectStrategyCheckpoint({
      concurrency: 1,
      manifest: {
        ...manifest(),
        pools: manifest().pools.slice(0, 1),
      },
      reader: new Reader(),
      risk: {
        ...missing,
        assets: [{ ...missing.assets[0]!, oracle: null }],
      },
      streamKey: "test",
    });
    assert.equal(checkpoint.validPools, 0);
    assert.deepEqual(checkpoint.pools[0]?.valuation.reasons, [
      "rwa_oracle_feed_missing",
    ]);
    assert.equal(checkpoint.pools[0]?.valuation.oraclePriceX18, null);
  });
});
