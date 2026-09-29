import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseResearchCapital,
  parseResearchSummaryRequest,
  researchPoolDetailProjection,
  researchSummaryProjection,
  type ResearchDetailsRequest,
} from "../src/dashboard/research-api.js";
import type { ResearchSnapshot } from "../src/dashboard/research.js";
import { DashboardRepository } from "../src/dashboard/repository.js";
import { USDG } from "../src/constants.js";

test("research capital parser accepts exact whole-USDG bounds and rejects ambiguous forms", () => {
  assert.equal(parseResearchCapital(null), "250000000");
  assert.equal(parseResearchCapital("1000000"), "1000000");
  assert.equal(parseResearchCapital("1000001"), "1000001");
  assert.equal(parseResearchCapital("100000000000"), "100000000000");
  for (const invalid of ["0", "1", "999999", "100000000001", "-1000000",
    "+1000000", "1e6", "01000000", "", " 1000000"]) {
    assert.equal(parseResearchCapital(invalid), null, `${invalid} must be rejected`);
  }
  assert.equal(parseResearchSummaryRequest(new URLSearchParams(
    "capitalQuoteRaw=1000000&capitalQuoteRaw=2000000",
  )), null, "duplicate query values must be rejected");
});

const makeSnapshot = (): ResearchSnapshot => {
  const series = Array.from({ length: 672 }, (_, index) => ({
    bucket: new Date(Date.UTC(2026, 0, 1) + index * 900_000).toISOString(),
    swaps: index % 9,
    volumeQuote: "1200000",
    feesQuote: "1200",
    meanLiquidity: "9000000000000000000",
    priceX18: "1000000000000000000",
    sqrtPriceX96: "79228162514264337593543950336",
    tickLast: index,
    tickMin: index,
    tickMax: index + 1,
    validShare: 1,
    deviationPpm: "10",
  }));
  const pools = Array.from({ length: 15 }, (_, index) => ({
    poolAddress: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    rwaSymbol: `ASSET${index}`,
    fee: 500,
    token0: USDG,
    token1: "0x0000000000000000000000000000000000000002",
    feeProtocol0: 0,
    feeProtocol1: 0,
    tickSpacing: 10,
    quoteIsToken0: true,
    rwaDecimals: 18,
    tick: 0,
    sqrtPriceX96: "79228162514264337593543950336",
    priceX18: "1000000000000000000",
    liquidity: "9000000000000000000",
    observedAt: "2026-09-29T10:00:00.000Z",
    registryEnabled: true,
    stateStatus: "current" as const,
    series,
    windows: [{
      hours: 24,
      windowSeconds: 86400,
      coveredSeconds: 86400,
      freshnessSeconds: 0,
      maxGapSeconds: 30,
      asOf: "2026-09-29T10:00:00.000Z",
      swapWindowSeconds: 86400,
      swapAsOf: "2026-09-29T10:00:00.000Z",
      swapAvailability: "available",
      observedBuckets: 96,
      swaps: 96,
      volumeQuote: "115200000",
      feesQuote: "115200",
      meanLiquidity: "9000000000000000000",
      priceChangePpm: 10,
      validShare: 1,
      references: [{
        halfWidthTicks: 50,
        halfWidthPercent: 0.5,
        liquidity: "1000000000000000000",
        sharePpm: 100000,
        inRangeBuckets: 90,
        modeledFeesQuote: "50000",
        modeledNetQuote: "40000",
        aprPpm: 10,
      }],
      limitation: null,
    }],
    depth: Array.from({ length: 1_500 }, (_, tick) => ({
      tick: tick - 750,
      liquidity: String(tick * 10_000),
    })),
    depthReferences: [{ halfWidthTicks: 50, halfWidthPercent: 0.5,
      liquidity: "1000000000000000000" }],
  }));
  return {
    snapshotId: "research:stream:2026-09-29T10:00:00.000Z",
    generatedAt: "2026-09-29T10:00:01.000Z",
    asOf: "2026-09-29T10:00:00.000Z",
    sourceFreshness: { status: "fresh", asOf: "2026-09-29T10:00:00.000Z",
      ageSeconds: 1, maxAgeSeconds: 90 },
    capitalQuoteRaw: "250000000",
    streamKey: "stream",
    budgetQuote: "250000000",
    quoteDecimals: 6,
    bucketMinutes: 15,
    buckets: series.map((entry) => entry.bucket),
    costs: { mintBundleQuote: "1000", exitBundleQuote: "1000",
      roundTripQuote: "2000" },
    pools,
  };
};

test("compact summary plus selected detail preserve snapshot economics and cut repeated series", (t) => {
  const snapshot = makeSnapshot();
  const request: ResearchDetailsRequest = {
    poolAddress: snapshot.pools[0]!.poolAddress,
    capitalQuoteRaw: snapshot.capitalQuoteRaw,
    hours: 24,
    width: 0,
    snapshotId: snapshot.snapshotId,
  };
  const summary = researchSummaryProjection(snapshot);
  const detail = researchPoolDetailProjection(snapshot, request) as {
    snapshotId: string;
    generatedAt: string;
    asOf: string;
    capitalQuoteRaw: string;
    pool: (typeof snapshot.pools)[number];
  };
  assert.equal(summary.snapshotId, detail.snapshotId);
  assert.equal(summary.generatedAt, detail.generatedAt);
  assert.equal(summary.asOf, detail.asOf);
  assert.equal(summary.capitalQuoteRaw, detail.capitalQuoteRaw);
  assert.equal(summary.bucketCount, 672);
  assert.equal(summary.retainedHours, 168);
  assert.equal("series" in summary.pools[0]!, false);
  assert.equal("depth" in summary.pools[0]!, false);
  assert.equal("depthReferences" in summary.pools[0]!, false);
  assert.equal(detail.pool.series.length, 96);
  assert.equal(detail.pool.depth.length, 1_500);

  const summaryWindow = summary.pools[0]!.windows[0]!;
  const detailWindow = detail.pool.windows[0]!;
  assert.deepEqual(detailWindow, summaryWindow);
  assert.equal(detailWindow.references[0]!.modeledFeesQuote, "50000");
  assert.equal(detailWindow.references[0]!.modeledNetQuote, "40000");
  assert.equal(detail.pool.series.reduce((sum, bucket) => sum + BigInt(bucket.feesQuote!), 0n),
    96n * 1200n);

  const fullBytes = Buffer.byteLength(JSON.stringify(snapshot));
  const splitBytes = Buffer.byteLength(JSON.stringify(summary)) +
    Buffer.byteLength(JSON.stringify(detail));
  t.diagnostic(`synthetic full=${fullBytes}B, summary+24h-detail=${splitBytes}B, ` +
    `reduction=${(100 * (1 - splitBytes / fullBytes)).toFixed(1)}%; fixture only, not production data`);
  assert.ok(splitBytes < fullBytes * 0.2,
    `split payload ${splitBytes} B should be <20% of full ${fullBytes} B`);
});

test("repository reprices cached reads without SQL and rejects details after cache rollover", async (t) => {
  const base = makeSnapshot();
  const originalNow = Date.now;
  let now = Date.parse("2026-09-29T10:00:01.000Z");
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  let researchBuilds = 0;
  const repository = Object.create(DashboardRepository.prototype) as any;
  repository.config = { researchRefreshMs: 300_000 };
  repository.pool = { connect: async () => {
    researchBuilds += 1;
    throw new Error("unexpected_research_sql_build");
  } };
  repository.researchCache = { at: Date.now(), value: base };
  repository.researchInFlight = null;
  repository.researchCapitalCache = new Map();

  const summary250 = await repository.research("250000000");
  assert.equal(summary250.sourceFreshness.ageSeconds, 1);
  assert.equal(summary250.sourceFreshness.status, "fresh");
  const summary1000 = await repository.research("1000000000");
  assert.equal(summary250.snapshotId, base.snapshotId);
  assert.equal(summary1000.snapshotId, base.snapshotId);
  assert.equal(summary1000.capitalQuoteRaw, "1000000000");
  assert.equal(researchBuilds, 0, "capital changes must reprice cached inputs, not issue SQL");

  now += 91_000;
  const agedSummary = await repository.research("250000000");
  assert.equal(agedSummary.snapshotId, summary250.snapshotId);
  assert.equal(agedSummary.sourceFreshness.ageSeconds, 92);
  assert.equal(agedSummary.sourceFreshness.status, "stale");
  assert.equal(researchBuilds, 0, "ageing a cached projection must not rebuild research SQL");

  const input: ResearchDetailsRequest = {
    poolAddress: base.pools[0]!.poolAddress,
    capitalQuoteRaw: "1000000000",
    hours: 24,
    width: 0,
    snapshotId: summary1000.snapshotId,
  };
  const detail = await repository.researchDetails(input);
  assert.equal(detail.snapshotId, summary1000.snapshotId);
  assert.equal(detail.capitalQuoteRaw, summary1000.capitalQuoteRaw);
  assert.equal(detail.pool.windows[0]!.references[0]!.modeledNetQuote,
    summary1000.pools[0]!.windows[0]!.references[0]!.modeledNetQuote);
  assert.equal(researchBuilds, 0);
  assert.equal(detail.sourceFreshness.ageSeconds, 92);

  const next = { ...base, snapshotId: "research:stream:2026-09-29T10:05:00.000Z",
    generatedAt: "2026-09-29T10:05:01.000Z" };
  repository.researchCache = { at: Date.now() - 300_001, value: base };
  repository.researchInFlight = Promise.resolve(next);
  const rolled = await repository.researchDetails(input);
  assert.deepEqual(rolled, { error: "research_snapshot_changed" });
  assert.equal(researchBuilds, 0,
    "an expired detail request may share a concurrent refresh but never mix snapshots");
});
