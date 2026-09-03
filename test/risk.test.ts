import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CanonicalAsset } from "../src/domain.js";
import type {
  OracleFeedMetadata,
  OracleRoundState,
  TokenRiskState,
} from "../src/risk/domain.js";
import { evaluateAssetRisk, evaluateOracleRisk } from "../src/risk/evaluate.js";
import { evaluateRiskGate } from "../src/risk/gate.js";
import {
  evaluateMarketSessionPolicy,
  selectOracleFeed,
  type FeedDirectoryPayload,
} from "../src/risk/source.js";

const sourceEvidence = {
  fetchedAt: "2026-09-03T12:00:00.000Z",
  sha256: `sha256:${"ab".repeat(32)}`,
  url: "https://robinhood.com/rhj/stocktokens/",
};

const feed: OracleFeedMetadata = {
  address: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0",
  baseAsset: "AAPL",
  decimals: 8,
  heartbeatSeconds: 86_400,
  marketHours: "us_equities_24/5",
  name: "Robinhood AAPL / USD",
  productTypeCode: "primaryTokenizedPrice",
  quoteAsset: "USD",
};

const round: OracleRoundState = {
  answer: "20000000000",
  answeredInRound: "10",
  codeHash: `0x${"11".repeat(32)}`,
  decimals: 8,
  description: "Robinhood AAPL / USD",
  roundId: "10",
  startedAt: "900",
  updatedAt: "900",
};

const token: TokenRiskState = {
  codeHash: `0x${"22".repeat(32)}`,
  effectiveAt: "800",
  newUIMultiplier: "1000000000000000000",
  oraclePaused: false,
  uiMultiplier: "1000000000000000000",
};

const registry: CanonicalAsset = {
  address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  currentMultiplier: "1.000000000000000000",
  decimals: 18,
  id: "aapl-id",
  isin: "US0378331005",
  name: "Apple • Robinhood Token",
  pendingMultiplier: null,
  pendingMultiplierEffectiveTime: null,
  status: "ASSET_STATUS_ACTIVE",
  symbol: "AAPL",
  tradingCapabilities: {
    extended: {
      fractional: "TRADING_STATUS_TRADABLE",
      whole: "TRADING_STATUS_TRADABLE",
    },
    market: {
      fractional: "TRADING_STATUS_TRADABLE",
      whole: "TRADING_STATUS_TRADABLE",
    },
    overnight: {
      fractional: "TRADING_STATUS_TRADABLE",
      whole: "TRADING_STATUS_TRADABLE",
    },
  },
};

describe("risk evaluation", () => {
  it("accepts a complete, positive, fresh oracle round", () => {
    const result = evaluateOracleRisk({
      blockTimestamp: 1_000n,
      feed,
      maxPriceAgeSeconds: 300,
      state: round,
    });

    assert.equal(result.executionEligible, true);
    assert.equal(result.maxAgeSeconds, 300);
    assert.equal(result.priceAgeSeconds, 100);
    assert.deepEqual(result.reasons, []);
  });

  it("fails a round against the stricter configured age ceiling", () => {
    const result = evaluateOracleRisk({
      blockTimestamp: 1_201n,
      feed,
      maxPriceAgeSeconds: 300,
      state: round,
    });

    assert.equal(result.executionEligible, false);
    assert.deepEqual(result.reasons, ["oracle_price_stale"]);
  });

  it("accepts the abbreviated description used by some canonical proxies", () => {
    const result = evaluateOracleRisk({
      blockTimestamp: 1_000n,
      feed,
      maxPriceAgeSeconds: 300,
      state: { ...round, description: "RHAAPL / USD" },
    });

    assert.equal(result.flags?.descriptionMatches, true);
    assert.equal(result.executionEligible, true);
  });

  it("keeps an otherwise healthy asset fail-closed when sequencer evidence is absent", () => {
    const oracle = evaluateOracleRisk({
      blockTimestamp: 1_000n,
      feed,
      maxPriceAgeSeconds: 300,
      state: round,
    });
    const result = evaluateAssetRisk({
      blockTimestamp: 1_000n,
      globalReasons: ["market_session_unverified", "sequencer_feed_unavailable"],
      onchain: token,
      oracle,
      quoteOracle: oracle,
      registry,
    });

    assert.equal(result.flags.multiplierConsistent, true);
    assert.equal(result.flags.corporateActionPending, false);
    assert.equal(result.executionEligible, false);
    assert.deepEqual(result.reasons, [
      "market_session_unverified",
      "sequencer_feed_unavailable",
    ]);
  });

  it("detects issuer pause and a staged future multiplier", () => {
    const oracle = evaluateOracleRisk({
      blockTimestamp: 1_000n,
      feed,
      maxPriceAgeSeconds: 300,
      state: round,
    });
    const result = evaluateAssetRisk({
      blockTimestamp: 1_000n,
      globalReasons: [],
      onchain: {
        ...token,
        effectiveAt: "1200",
        newUIMultiplier: "1005000000000000000",
        oraclePaused: true,
      },
      oracle,
      quoteOracle: oracle,
      registry,
    });

    assert.equal(result.flags.corporateActionPending, true);
    assert.equal(result.executionEligible, false);
    assert.ok(result.reasons.includes("corporate_action_pending"));
    assert.ok(result.reasons.includes("oracle_paused"));
  });
});

describe("Chainlink feed selection", () => {
  const directory: FeedDirectoryPayload = [
    {
      decimals: 8,
      docs: {
        baseAsset: "AAPL",
        blockchainName: "Robinhood",
        marketHours: "us_equities_24/5",
        productTypeCode: "primaryTokenizedPrice",
        quoteAsset: "USD",
      },
      heartbeat: 86_400,
      name: "Robinhood AAPL / USD",
      proxyAddress: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0",
    },
  ];

  it("selects only the provider-specific token price feed", () => {
    assert.equal(selectOracleFeed(directory, "aapl")?.address, feed.address);
  });

  it("returns unavailable rather than substituting a different asset feed", () => {
    assert.equal(selectOracleFeed(directory, "GLD"), null);
  });
});

describe("market-session policy", () => {
  it("accepts the official Robinhood Stock Tokens 24/7 statement", () => {
    const result = evaluateMarketSessionPolicy(
      "<h2>Markets beyond borders, 24/7</h2>",
      sourceEvidence,
    );

    assert.equal(result.status, "open_24_7");
    assert.equal(result.executionEligible, true);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.evidence, sourceEvidence);
  });

  it("fails closed if the policy marker disappears", () => {
    const result = evaluateMarketSessionPolicy("<h2>Stock Tokens</h2>", sourceEvidence);

    assert.equal(result.status, "unverified");
    assert.equal(result.executionEligible, false);
    assert.deepEqual(result.reasons, ["market_session_unverified"]);
  });
});

describe("freshness-aware risk gate", () => {
  const healthyInput = {
    attemptId: "9",
    attemptStatus: "succeeded" as const,
    canonicalityCanonical: true,
    canonicalityValidatedAt: new Date("2026-09-03T12:00:55.000Z"),
    maxCanonicalityAgeSeconds: 30,
    maxSnapshotAgeSeconds: 180,
    now: new Date("2026-09-03T12:01:00.000Z"),
    snapshotBlockHash: `0x${"11".repeat(32)}`,
    snapshotBlockNumber: "1234",
    snapshotExecutionEligible: true,
    snapshotId: "8",
    snapshotObservedAt: new Date("2026-09-03T12:00:00.000Z"),
    snapshotReasons: [],
    sourceCoversSnapshot: true,
  };

  it("opens only for the newest fresh canonical eligible snapshot", () => {
    const decision = evaluateRiskGate(healthyInput);

    assert.equal(decision.executionEligible, true);
    assert.equal(decision.snapshotAgeSeconds, 60);
    assert.equal(decision.canonicalityAgeSeconds, 5);
    assert.equal(decision.blockCanonical, true);
    assert.deepEqual(decision.reasons, []);
  });

  it("closes for stale or noncanonical evidence and preserves snapshot reasons", () => {
    const decision = evaluateRiskGate({
      ...healthyInput,
      canonicalityCanonical: false,
      canonicalityValidatedAt: new Date("2026-09-03T12:03:55.000Z"),
      now: new Date("2026-09-03T12:04:00.000Z"),
      snapshotExecutionEligible: false,
      snapshotReasons: ["sequencer_feed_unavailable"],
    });

    assert.equal(decision.executionEligible, false);
    assert.deepEqual(decision.reasons, [
      "risk_snapshot_stale",
      "risk_block_not_canonical",
      "sequencer_feed_unavailable",
    ]);
  });

  it("closes when private-node canonicality validation stops refreshing", () => {
    const decision = evaluateRiskGate({
      ...healthyInput,
      now: new Date("2026-09-03T12:01:31.000Z"),
    });

    assert.equal(decision.executionEligible, false);
    assert.deepEqual(decision.reasons, ["risk_block_validation_stale"]);
  });

  it("closes while the latest collection attempt is incomplete", () => {
    const decision = evaluateRiskGate({
      ...healthyInput,
      attemptStatus: "started",
      snapshotBlockHash: null,
      snapshotBlockNumber: null,
      snapshotExecutionEligible: null,
      snapshotId: null,
      snapshotObservedAt: null,
      sourceCoversSnapshot: null,
    });

    assert.equal(decision.executionEligible, false);
    assert.deepEqual(decision.reasons, [
      "latest_risk_attempt_started",
      "risk_snapshot_missing",
    ]);
  });

  it("closes when private-node canonicality evidence stops refreshing", () => {
    const decision = evaluateRiskGate({
      ...healthyInput,
      now: new Date("2026-09-03T12:01:31.000Z"),
    });

    assert.equal(decision.executionEligible, false);
    assert.equal(decision.canonicalityAgeSeconds, 36);
    assert.deepEqual(decision.reasons, ["risk_block_validation_stale"]);
  });
});
