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
  RESEARCH_BUDGET_QUOTE,
  RESEARCH_HALF_WIDTH_FRACTIONS,
  RESEARCH_RETAINED_BUCKETS,
  RESEARCH_RETAINED_HOURS,
  RESEARCH_WINDOW_HOURS,
  repriceResearchSnapshot,
  sizeResearchCapitalForRange,
} from "../src/dashboard/research.js";
import { USDG } from "../src/constants.js";

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

  it("defaults to the setup form's 250 USDG capital",()=>{
    assert.equal(RESEARCH_BUDGET_QUOTE,250_000_000n);
  });

  it("recalculates exact V3 fee share and net from cached buckets at the selected capital",()=>{
    const sqrtPriceX96='79228162514264337593543950336';
    const series=Array.from({length:4},(_unused,index)=>({bucket:new Date(index*900_000).toISOString(),
      swaps:1,volumeQuote:'2000000',feesQuote:'100000000',meanLiquidity:'100000000',
      priceX18:'1000000000000000000',sqrtPriceX96,tickLast:0,
      tickMin:index===2?-1000:-1,tickMax:index===2?1000:1,
      validShare:index===1?null:1,deviationPpm:'0'}));
    const window={hours:1,windowSeconds:null,coveredSeconds:null,freshnessSeconds:null,
      maxGapSeconds:null,asOf:null,swapWindowSeconds:null,swapAsOf:null,swapAvailability:'available',
      observedBuckets:4,swaps:4,volumeQuote:'8000000',feesQuote:'400000000',meanLiquidity:'100000000',
      priceChangePpm:0,validShare:1,references:[],limitation:null};
    const base={snapshotId:'research:test:stable',generatedAt:'2026-09-29T00:00:00.000Z',
      asOf:'2026-09-29T00:00:00.000Z',sourceFreshness:{status:'fresh',asOf:'2026-09-29T00:00:00.000Z',
        ageSeconds:0,maxAgeSeconds:90},capitalQuoteRaw:'1000000000',streamKey:'test',budgetQuote:'1000000000',
      quoteDecimals:6,bucketMinutes:15,buckets:series.map(row=>row.bucket),
      costs:{mintBundleQuote:'1000000',exitBundleQuote:'1320000',roundTripQuote:'2320000'},
      pools:[{poolAddress:'0x1111111111111111111111111111111111111111',rwaSymbol:'AAA',fee:500,
        token0:USDG,token1:'0x2222222222222222222222222222222222222222',feeProtocol0:0,feeProtocol1:0,
        tickSpacing:10,quoteIsToken0:true,rwaDecimals:18,tick:0,sqrtPriceX96,priceX18:'1000000000000000000',
        liquidity:'100000000',observedAt:'2026-09-29T00:00:00.000Z',registryEnabled:true,
        stateStatus:'current',series,windows:[window],depth:[{tick:-10,liquidity:'1'},{tick:10,liquidity:'1'}],
        depthReferences:[]}]} as const;
    const fixedNow=Date.parse('2026-09-29T00:01:30.000Z');
    const baseCapital=repriceResearchSnapshot(base,RESEARCH_BUDGET_QUOTE,fixedNow);
    assert.deepEqual(baseCapital.sourceFreshness,{status:'fresh',asOf:base.asOf,ageSeconds:90,maxAgeSeconds:90});
    assert.equal(baseCapital.pools[0]!.windows[0]!.references[0]!.inRangeBuckets,2,
      'missing checkpoints and observed tick extremes remain excluded');
    const reference=repriceResearchSnapshot(base,1_000_000_000n,fixedNow).pools[0]!.windows[0]!.references[0]!;
    const selected=repriceResearchSnapshot(base,'250000000',fixedNow);
    const selectedReference=selected.pools[0]!.windows[0]!.references[0]!;
    assert.equal(selected.snapshotId,base.snapshotId);
    assert.equal(selected.capitalQuoteRaw,'250000000');
    assert.equal(selected.budgetQuote,'250000000');
    const expectedSizing=sizeResearchCapitalForRange({capitalQuoteRaw:250_000_000n,token0:USDG,
      token1:'0x2222222222222222222222222222222222222222',decimals0:6,decimals1:18,
      quoteToken:USDG,quoteDecimals:6,fee:500,currentTick:0,
      sqrtPriceX96:BigInt(sqrtPriceX96),tickLower:-10,tickUpper:10});
    assert.equal(selectedReference.liquidity,expectedSizing.liquidity);
    const poolLiquidity=100_000_000n,positionLiquidity=BigInt(expectedSizing.liquidity);
    const independentlyModeledFees=2n*(100_000_000n*positionLiquidity/(positionLiquidity+poolLiquidity));
    assert.equal(BigInt(selectedReference.modeledFeesQuote),independentlyModeledFees,
      'each eligible bucket uses Lposition/(Lposition+Lpool) with integer division');
    assert.notEqual(BigInt(selectedReference.modeledFeesQuote)*4n,BigInt(reference.modeledFeesQuote),
      'fee share is nonlinear because pool liquidity is in the denominator');
    assert.equal(BigInt(selectedReference.modeledNetQuote!),BigInt(selectedReference.modeledFeesQuote)-2_320_000n);
    assert.equal(BigInt(selectedReference.sharePpm!),positionLiquidity*1_000_000n/(positionLiquidity+poolLiquidity));
    assert.equal(selectedReference.aprPpm,
      Number(BigInt(selectedReference.modeledNetQuote!)*1_000_000n/250_000_000n)*8_760);
    assert.notEqual(selected.pools[0]!.depthReferences[0]!.liquidity,
      repriceResearchSnapshot(base,1_000_000_000n,fixedNow).pools[0]!.depthReferences[0]!.liquidity);

    const scenarioPool=(symbol:string,poolLiquidity:string,feePerBucket:string)=>({...base.pools[0]!,
      poolAddress:`0x${symbol}`,rwaSymbol:symbol,
      series:series.map(bucket=>({...bucket,validShare:1,meanLiquidity:poolLiquidity,
        feesQuote:feePerBucket,tickMin:-1,tickMax:1}))});
    const rankingBase={...base,pools:[scenarioPool('AAA','1000000000','10000000'),
      scenarioPool('BBB','1000000000000','40000000')]};
    const ranked=(capital:bigint)=>repriceResearchSnapshot(rankingBase,capital,fixedNow).pools.map(pool=>({
      symbol:pool.rwaSymbol,net:BigInt(pool.windows[0]!.references[0]!.modeledNetQuote!),
    })).sort((left,right)=>left.net>right.net?-1:left.net<right.net?1:0).map(row=>row.symbol);
    assert.deepEqual(ranked(250_000_000n),['AAA','BBB']);
    assert.deepEqual(ranked(1_000_000_000n),['BBB','AAA']);
    assert.equal(repriceResearchSnapshot(base,250_000_000n,fixedNow+1).sourceFreshness.status,'stale');
    assert.equal(repriceResearchSnapshot(base,250_000_000n,Date.parse(base.asOf)-1).sourceFreshness.status,'unavailable');
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
      "({ leagueRows, sortRows, priceAtTick, si, yAxis, depthQuote, condense, capitalQuoteRaw, formatCapitalRaw, freshnessLabel, MAX_BARS, protocolCut, WINDOWS });"
  ) as {
    MAX_BARS: number;
    capitalQuoteRaw(value: string): string | null;
    formatCapitalRaw(value: string): string;
    freshnessLabel(envelope: unknown, now?: number): string;
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

  it("parses Research capital as exact six-decimal USDG raw units within the setup bound",()=>{
    assert.equal(ui.capitalQuoteRaw('250'),'250000000');
    assert.equal(ui.capitalQuoteRaw('1'),'1000000');
    assert.equal(ui.capitalQuoteRaw('1.000001'),'1000001');
    assert.equal(ui.capitalQuoteRaw('1.5'),'1500000');
    assert.equal(ui.capitalQuoteRaw('100000'),'100000000000');
    assert.equal(ui.capitalQuoteRaw('0'),null);
    assert.equal(ui.capitalQuoteRaw('0.5'),null);
    assert.equal(ui.capitalQuoteRaw('100000.000001'),null);
    assert.equal(ui.capitalQuoteRaw('1.0000001'),null);
  });

  it("displays the full selected capital precision without rounding",()=>{
    assert.equal(ui.formatCapitalRaw('1250000'),'1.25');
    assert.equal(ui.formatCapitalRaw('375750000'),'375.75');
    assert.equal(ui.formatCapitalRaw('250000000'),'250');
  });

  it("ages canonical research evidence instead of leaving a cached fresh label frozen",()=>{
    const asOf='2026-09-29T00:00:00.000Z',stamp=Date.parse(asOf);
    const envelope={asOf,sourceFreshness:{status:'fresh',asOf,maxAgeSeconds:90}};
    assert.match(ui.freshnessLabel(envelope,stamp+90_000),/fresh · 1m 30s old/);
    assert.match(ui.freshnessLabel(envelope,stamp+91_000),/stale · 1m 31s old/);
    assert.match(ui.freshnessLabel({sourceFreshness:{status:'unavailable',asOf:null}},stamp),/unavailable/);
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
