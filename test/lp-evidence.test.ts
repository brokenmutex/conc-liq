import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, type Hex } from "viem";
import { researchPositionManagerAbi, decodeResearchActionPath } from "../src/research/action-path.js";
import { historicalReferenceAt, type PublishedOracleRound } from "../src/research/historical-reference.js";
import type { OracleFeedMetadata } from "../src/risk/domain.js";

describe("historical reference publication", () => {
  const feed: OracleFeedMetadata = { address: `0x${"1".repeat(40)}`, baseAsset: "NVDA", quoteAsset: "USD", decimals: 8,
    heartbeatSeconds: 86400, marketHours: "us_equities_24/5", name: "NVDA / USD", productTypeCode: "primaryTokenizedPrice" };
  const round: PublishedOracleRound = { blockNumber: 10, blockHash: `0x${"2".repeat(64)}`, availableAt: 120,
    state: { answer: "20000000000", answeredInRound: "1", roundId: "1", startedAt: "100", updatedAt: "100",
      decimals: 8, description: "RHNVDA / USD", codeHash: `0x${"3".repeat(64)}` } };
  const quote = { ...round, state: { ...round.state, answer: "100000000", description: "USDG / USD" } };
  const input = { maxAgeSeconds: 300, rwaFeed: feed, quoteFeed: { ...feed, baseAsset: "USDG", name: "USDG / USD" },
    rwaRounds: [round], quoteRounds: [quote], poolPriceX18: 200n * 10n ** 18n };
  it("does not expose an answer before its publication block even if updatedAt is earlier", () => {
    assert.equal(historicalReferenceAt({ ...input, at: 110 }).available, false);
    assert.equal(historicalReferenceAt({ ...input, at: 120 }).available, true);
  });
  it("preserves the existing inclusive maximum age and inclusive five-percent bounds", () => {
    for (const price of [190n, 210n]) assert.equal(historicalReferenceAt({ ...input, at: 400, poolPriceX18: price * 10n ** 18n }).band!.inside, true);
    assert.equal(historicalReferenceAt({ ...input, at: 401 }).available, false);
    assert.equal(historicalReferenceAt({ ...input, at: 400, poolPriceX18: 210n * 10n ** 18n + 1n }).band!.inside, false);
  });
  it("requires both feeds and does not refresh age from repeated reads", () => {
    assert.equal(historicalReferenceAt({ ...input, at: 200, quoteRounds: [] }).available, false);
    const reread = { ...round, blockNumber: 20, availableAt: 390 };
    const r = historicalReferenceAt({ ...input, rwaRounds: [round, reread], at: 401 });
    assert(r.reasons.includes("rwa_oracle_price_stale")); assert.equal(r.executionEligible, false);
  });
});

describe("whole transaction LP action paths", () => {
  const recipient = `0x${"1".repeat(40)}` as const, max = (1n << 128n) - 1n;
  const decrease = (liquidity = 100n) => encodeFunctionData({ abi: researchPositionManagerAbi, functionName: "decreaseLiquidity",
    args: [{ tokenId: 1n, liquidity, amount0Min: 0n, amount1Min: 0n, deadline: 1000n }] });
  const collect = (tokenId = 1n, amount0Max = max) => encodeFunctionData({ abi: researchPositionManagerAbi, functionName: "collect",
    args: [{ tokenId, recipient, amount0Max, amount1Max: max }] });
  const bundle = (data: readonly Hex[]) => encodeFunctionData({ abi: researchPositionManagerAbi, functionName: "multicall", args: [data] });
  it("recognizes a decrease/collect path and decodes nested multicalls", () => {
    const path = decodeResearchActionPath(bundle([bundle([decrease()]), collect()]));
    assert(path.simpleExit); assert.equal(path.sequence, "decreaseLiquidity,collect");
  });
  it("rejects zero-liquidity pokes, wrong NFT collection, partial collection and reversed calls", () => {
    for (const calls of [[decrease(0n), collect()], [decrease(), collect(2n)], [decrease(), collect(1n, 1n)], [collect(), decrease()]]) {
      assert.equal(decodeResearchActionPath(bundle(calls)).simpleExit, false);
    }
  });
  it("keeps unknown inner calls opaque and safely handles NFT-only burns", () => {
    assert.equal(decodeResearchActionPath(bundle([decrease(), collect(), "0xdeadbeef"])).known, false);
    const burn = encodeFunctionData({ abi: researchPositionManagerAbi, functionName: "burn", args: [1n] });
    assert.equal(decodeResearchActionPath(burn).simpleExit, false);
    let deep: Hex = decrease(); for (let i = 0; i < 6; i++) deep = bundle([deep]);
    assert.throws(() => decodeResearchActionPath(deep), /bound/);
  });
});
