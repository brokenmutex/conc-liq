import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  depthCurve,
  halfWidthTicksForFraction,
  quoteValueOfRwa,
  RESEARCH_HALF_WIDTH_FRACTIONS,
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
    assert.deepEqual([...RESEARCH_WINDOW_HOURS], [1, 6, 24, 168]);
  });
});

describe("research view semantics", () => {
  const source = readFileSync(
    new URL("../dashboard/research.js", import.meta.url),
    "utf8",
  ).replace(/^load\(\);\s*$/m, "");
  const ui = runInNewContext(
    `const document = { addEventListener() {} };\n${source}\n` +
      "({ leagueRows, sortRows, priceAtTick });",
  ) as {
    leagueRows(source: unknown, hours: number, width: number): {
      key: string;
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
    inRangeHours: number,
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
      swaps: 10,
      volumeQuote: "1000000",
      feesQuote: "500000",
      validShare: 0.5,
      references: [{
        halfWidthTicks: 10,
        halfWidthPercent: 0.1,
        sharePpm: 1_000,
        inRangeHours,
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
      { pools: [pool("AAA", null, 12)], hours: new Array(168) },
      24,
      0,
    );
    assert.equal(rows[0]!.net, null);
    assert.equal(rows[0]!.inRange, 0.5);
  });

  it("sorts unavailable values last in both directions", () => {
    const rows = ui.leagueRows({
      pools: [pool("AAA", null, 1), pool("BBB", "3000000", 1), pool("CCC", "1000000", 1)],
      hours: new Array(168),
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

  it("inverts the tick-to-price direction when USDG is token0", () => {
    const quoteToken0 = { priceX18: (10n ** 18n).toString(), tick: 0, quoteIsToken0: true };
    const quoteToken1 = { ...quoteToken0, quoteIsToken0: false };
    assert.ok(ui.priceAtTick(quoteToken0, 100) < 1);
    assert.ok(ui.priceAtTick(quoteToken1, 100) > 1);
  });
});
