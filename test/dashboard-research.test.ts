import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  depthCurve,
  halfWidthTicksForFraction,
  lpFeeOfGross,
  quoteValueOfRwa,
  RESEARCH_BUCKET_MINUTES,
  RESEARCH_BUCKETS_PER_HOUR,
  RESEARCH_HALF_WIDTH_FRACTIONS,
  RESEARCH_RETAINED_BUCKETS,
  RESEARCH_RETAINED_HOURS,
  RESEARCH_WINDOW_HOURS,
} from "../src/dashboard/research.js";

describe("research read model", () => {
  it("values an 18-decimal RWA amount in six-decimal USDG", () => {
    // One whole RWA token at 250.5 USDG is 250.50 USDG at six decimals.
    assert.equal(
      quoteValueOfRwa(10n ** 18n, 250_500_000_000_000_000_000n, 18),
      250_500_000n,
    );
    assert.equal(quoteValueOfRwa(0n, 250_500_000_000_000_000_000n, 18), 0n);
  });

  it("rounds a half-width out to the pool grid and never below one spacing", () => {
    // 0.5% is about 50 ticks, which is already a multiple of the 500-tier grid.
    assert.equal(halfWidthTicksForFraction(0.005, 10), 50);
    // The 3000 tier cannot express 50, so it rounds out to one spacing.
    assert.equal(halfWidthTicksForFraction(0.005, 60), 60);
    // The 10000 tier rounds 1% out to its single 200-tick step.
    assert.equal(halfWidthTicksForFraction(0.01, 200), 200);
    for (const fraction of RESEARCH_HALF_WIDTH_FRACTIONS) {
      assert.equal(halfWidthTicksForFraction(fraction, 60) % 60, 0);
    }
  });

  it("pays liquidity the fee left after the protocol's divisor", () => {
    // v3 keeps feeAmount/feeProtocol for the protocol, so a 4 leaves three
    // quarters for liquidity and a 6 leaves five sixths.
    assert.equal(lpFeeOfGross(1_000n, 4), 750n);
    assert.equal(lpFeeOfGross(1_200n, 6), 1_000n);
    // A pool that never set one pays the whole fee to liquidity.
    assert.equal(lpFeeOfGross(1_000n, 0), 1_000n);
    // The division truncates toward the protocol's side, as the pool's does.
    assert.equal(lpFeeOfGross(7n, 4), 6n);
    assert.equal(lpFeeOfGross(0n, 4), 0n);
    // Fees never grow, whatever the divisor.
    for (const divisor of [0, 4, 5, 6, 7, 8, 9, 10]) {
      assert.ok(lpFeeOfGross(1_000_000n, divisor) <= 1_000_000n);
    }
  });

  it("accumulates active liquidity from the lowest initialized tick", () => {
    const curve = depthCurve([
      { tick: -100, liquidityNet: 500n },
      { tick: 0, liquidityNet: 200n },
      { tick: 100, liquidityNet: -200n },
      { tick: 200, liquidityNet: -500n },
    ]);
    assert.deepEqual(curve.map((point) => point.liquidity), [
      "500",
      "700",
      "500",
      "0",
    ]);
  });

  it("offers the windows the position API already accepts", () => {
    assert.deepEqual([...RESEARCH_WINDOW_HOURS], [0.25, 1, 6, 24, 168]);
  });

  it("keeps a grain every window tiles in whole buckets", () => {
    // A grain that did not divide an hour would leave the shortest window
    // straddling a partial bucket, which the slice arithmetic cannot express.
    assert.equal(RESEARCH_BUCKETS_PER_HOUR, 60 / RESEARCH_BUCKET_MINUTES);
    assert.ok(Number.isInteger(RESEARCH_BUCKETS_PER_HOUR));
    for (const hours of RESEARCH_WINDOW_HOURS) {
      assert.ok(
        Number.isInteger(hours * RESEARCH_BUCKETS_PER_HOUR),
        `the ${hours}h window does not tile the grain`,
      );
    }
    // The 15-minute window is one chart bucket; its exact event count and
    // checkpoint coverage remain separate from bucket-based economics.
    assert.equal(RESEARCH_WINDOW_HOURS[0]! * RESEARCH_BUCKETS_PER_HOUR, 1);
    assert.deepEqual(
      [...RESEARCH_WINDOW_HOURS].map((hours) => hours * RESEARCH_BUCKETS_PER_HOUR),
      [1, 4, 24, 96, 672],
    );
  });

  it("retains the same span at the finer grain", () => {
    assert.equal(
      RESEARCH_RETAINED_BUCKETS,
      RESEARCH_RETAINED_HOURS * RESEARCH_BUCKETS_PER_HOUR,
    );
    assert.equal(RESEARCH_RETAINED_BUCKETS, 672);
  });

  it("spans the half-widths in ascending order from a near-spacing range", () => {
    const fractions = [...RESEARCH_HALF_WIDTH_FRACTIONS];
    assert.deepEqual(fractions, [...fractions].sort((a, b) => a - b));
    assert.ok(fractions.length >= 5, "a three-point set cannot show the occupancy curve");
    // The narrowest must still be expressible on the finest grid in use.
    assert.equal(halfWidthTicksForFraction(fractions[0]!, 10), 10);
    // The widest must clear a weekend gap on the coarsest tier.
    assert.ok(halfWidthTicksForFraction(fractions.at(-1)!, 200) >= 400);
  });
});

describe("research view semantics", () => {
  const source = readFileSync(
    new URL("../dashboard/research.js", import.meta.url),
    "utf8",
  ).replace(/^load\(\);\s*$/m, "");
  const ui = runInNewContext(
    `const document = { addEventListener() {} };\n${source}\n` +
      "({ leagueRows, sortRows, priceAtTick, si, yAxis, depthQuote, condense, MAX_BARS, protocolCut, WINDOWS });"
  ) as {
    MAX_BARS: number;
    WINDOWS: readonly (readonly [number, string])[];
    protocolCut(pool: { feeProtocol0: number; feeProtocol1: number }): string;
    condense(
      series: readonly {
        bucket: string;
        feesQuote: string;
        priceX18: string | null;
      }[],
    ): { bucket: string; feesQuote: string; priceX18: string | null }[];
    si(value: number | null): string;
    depthQuote(
      liquidity: number,
      reference: { liquidity: string } | null,
      budgetQuote: string,
    ): number | null;
    yAxis(
      geometry: {
        width: number;
        height: number;
        padding: { top: number; right: number; bottom: number; left: number };
      },
      label: (fraction: number) => string,
    ): string;
    leagueRows(source: unknown, hours: number, width: number): {
      key: string;
      swaps: number | null;
      volume: number | null;
      fees: number | null;
      net: number | null;
      inRange: number | null;
      gate: number | null;
    }[];
    sortRows(
      rows: readonly { key: string; net: number | null }[],
      column: string,
      descending: boolean,
    ): { key: string; net: number | null }[];
    priceAtTick(
      pool: { priceX18: string; tick: number; quoteIsToken0: boolean },
      tick: number,
    ): number;
  };

  const pool = (
    symbol: string,
    net: string | null,
    inRangeBuckets: number,
  ) => ({
    poolAddress: `0x${symbol}`,
    rwaSymbol: symbol,
    fee: 500,
    tickSpacing: 10,
    quoteIsToken0: true,
    tick: 0,
    priceX18: (10n ** 18n).toString(),
    windows: [{
      hours: 24,
      swaps: 10 as number | null,
      swapAvailability: "available",
      volumeQuote: "1000000",
      feesQuote: "500000",
      validShare: 0.5,
      references: [{
        halfWidthTicks: 10,
        halfWidthPercent: 0.1,
        sharePpm: 1_000,
        inRangeBuckets,
        modeledFeesQuote: "900000",
        modeledNetQuote: net,
        aprPpm: net === null ? null : 250_000,
      }],
    }],
    series: [],
    depth: [],
  });

  it("reports an unavailable modeled net rather than substituting zero", () => {
    const rows = ui.leagueRows(
      {
        pools: [pool("AAA", null, 48)],
        bucketMinutes: 15,
        buckets: new Array(672),
      },
      24,
      0,
    );
    assert.equal(rows[0]!.net, null);
    // 48 of the 24-hour window's 96 quarter-hour buckets held the range.
    assert.equal(rows[0]!.inRange, 0.5);
  });

  it("keeps exact swap availability separate from bucket economics", () => {
    const rowPool = pool("AAA", "3000000", 48);
    rowPool.windows[0]!.swapAvailability = "incomplete";
    rowPool.windows[0]!.swaps = null;
    const rows = ui.leagueRows({
      pools: [rowPool],
      bucketMinutes: 15,
      buckets: new Array(672),
    }, 24, 0);
    assert.equal(rows[0]!.swaps, null);
    assert.equal(rows[0]!.net, 3);
    assert.deepEqual(
      Array.from(ui.WINDOWS, ([hours, label]) => [hours, label]),
      [[0.25, "15m"], [1, "1h"], [6, "6h"], [24, "24h"], [168, "7d"]],
    );
  });

  it("sorts unavailable values last in both directions", () => {
    const rows = ui.leagueRows({
      pools: [pool("AAA", null, 1), pool("BBB", "3000000", 1), pool("CCC", "1000000", 1)],
      bucketMinutes: 15,
      buckets: new Array(672),
    }, 24, 0);
    // The rows come from the script's own realm, so they are copied back into
    // a host array before the strict comparison.
    assert.deepEqual(
      Array.from(ui.sortRows(rows, "net", true), (row) => row.key),
      ["BBB-500", "CCC-500", "AAA-500"],
    );
    assert.deepEqual(
      Array.from(ui.sortRows(rows, "net", false), (row) => row.key),
      ["CCC-500", "BBB-500", "AAA-500"],
    );
  });

  it("folds a long series into bars the plot can still separate", () => {
    const series = Array.from({ length: 672 }, (_unused, index) => ({
      bucket: new Date(index * 900_000).toISOString(),
      feesQuote: "100",
      priceX18: index % 4 === 3 ? null : String(index),
    }));
    const folded = ui.condense(series);
    // 672 quarter-hours over a 200-bar budget folds four at a time, which is
    // the hourly series the page drew before the grain was refined.
    assert.equal(folded.length, 168);
    assert.ok(folded.length <= ui.MAX_BARS);
    // Fees add across a fold rather than being sampled from it.
    assert.equal(folded[0]!.feesQuote, "400");
    assert.equal(
      folded.reduce((total, bar) => total + Number(bar.feesQuote), 0),
      672 * 100,
    );
    // The fold is labelled by the bucket it opens on.
    assert.equal(folded[1]!.bucket, series[4]!.bucket);
    // Every fold here ends on an absent price, so it reports the last one it
    // actually observed rather than dropping the point out of the line.
    assert.equal(folded[0]!.priceX18, "2");
  });

  it("leaves a series the plot can already separate untouched", () => {
    const series = Array.from({ length: 96 }, (_unused, index) => ({
      bucket: new Date(index * 900_000).toISOString(),
      feesQuote: "100",
      priceX18: String(index),
    }));
    assert.equal(ui.condense(series), series);
  });

  it("reports no price for a fold that observed none", () => {
    const series = Array.from({ length: 672 }, (_unused, index) => ({
      bucket: new Date(index * 900_000).toISOString(),
      feesQuote: "0",
      priceX18: null,
    }));
    assert.equal(ui.condense(series)[0]!.priceX18, null);
  });

  it("states the protocol's share rather than the divisor it is stored as", () => {
    assert.equal(ui.protocolCut({ feeProtocol0: 4, feeProtocol1: 4 }), "25.0%");
    assert.equal(ui.protocolCut({ feeProtocol0: 6, feeProtocol1: 6 }), "16.7%");
    assert.equal(ui.protocolCut({ feeProtocol0: 0, feeProtocol1: 0 }), "0.0%");
    // The legs are set independently, so a split pool reports the range.
    assert.equal(ui.protocolCut({ feeProtocol0: 4, feeProtocol1: 6 }), "16.7–25.0%");
    assert.equal(ui.protocolCut({ feeProtocol0: 0, feeProtocol1: 4 }), "0.0–25.0%");
  });

  it("names magnitudes past the ceiling Intl compact notation stops at", () => {
    // Intl renders pool-scale liquidity as "13,800,000T", which reads as noise.
    assert.equal(ui.si(1.38e19), "13.8E");
    assert.equal(ui.si(6.7e15), "6.7P");
    assert.equal(ui.si(4.2e6), "4.2M");
    assert.equal(ui.si(930), "930");
    assert.equal(ui.si(0), "0");
    assert.equal(ui.si(null), "—");
    // An empty series leaves a non-finite peak; the axis must not print it.
    assert.equal(ui.si(Infinity), "—");
  });

  it("labels three gridlines inside the plot area", () => {
    const geometry = {
      width: 520,
      height: 230,
      padding: { top: 12, right: 54, bottom: 26, left: 54 },
    };
    const markup = ui.yAxis(geometry, (fraction) => `${fraction}`);
    assert.equal(markup.match(/<line /g)?.length, 3);
    const labels = [...markup.matchAll(/<text[^>]*y="([\d.]+)"[^>]*>([^<]*)</g)];
    assert.deepEqual(labels.map((match) => match[2]), ["0", "0.5", "1"]);
    for (const match of labels) {
      const y = Number(match[1]);
      assert.ok(y >= geometry.padding.top && y <= geometry.height, `label escaped the plot at y=${y}`);
    }
  });

  it("prices pool depth as the USDG a same-width position would deploy", () => {
    const reference = { liquidity: "1000000000000000" };
    // Ten times the reference liquidity costs ten budgets to match.
    assert.equal(ui.depthQuote(1e16, reference, "1000000000"), 10_000);
    assert.equal(ui.depthQuote(0, reference, "1000000000"), 0);
    // Without a sizing to scale against the axis must fall back, not divide.
    assert.equal(ui.depthQuote(1e16, null, "1000000000"), null);
    assert.equal(ui.depthQuote(1e16, { liquidity: "0" }, "1000000000"), null);
    assert.equal(ui.depthQuote(Infinity, reference, "1000000000"), null);
  });

  it("inverts the tick-to-price direction when USDG is token0", () => {
    const quoteToken0 = { priceX18: (10n ** 18n).toString(), tick: 0, quoteIsToken0: true };
    const quoteToken1 = { ...quoteToken0, quoteIsToken0: false };
    assert.ok(ui.priceAtTick(quoteToken0, 100) < 1);
    assert.ok(ui.priceAtTick(quoteToken1, 100) > 1);
  });
});
