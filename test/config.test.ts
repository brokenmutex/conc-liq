import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { loadRiskConfig } from "../src/risk/config.js";

describe("loadConfig", () => {
  it("loads safe defaults", () => {
    const config = loadConfig({});

    assert.equal(config.rpcUrl, "https://rpc.mainnet.chain.robinhood.com");
    assert.deepEqual(config.feeTiers, [100, 500, 3_000, 10_000]);
    assert.deepEqual(config.symbols, [
      "GLD",
      "SPY",
      "QQQ",
      "NVDA",
      "AAPL",
      "GOOGL",
      "MSFT",
    ]);
  });

  it("normalizes and deduplicates configured symbols and fee tiers", () => {
    const config = loadConfig({
      RWA_SYMBOLS: " spy,GLD,spy ",
      UNISWAP_V3_FEE_TIERS: "500,3000,500",
    });

    assert.deepEqual(config.symbols, ["SPY", "GLD"]);
    assert.deepEqual(config.feeTiers, [500, 3_000]);
  });

  it("rejects malformed fee tiers", () => {
    assert.throws(
      () => loadConfig({ UNISWAP_V3_FEE_TIERS: "500,nope" }),
      /UNISWAP_V3_FEE_TIERS/,
    );
  });
});

describe("loadRiskConfig", () => {
  it("uses a strict price-age ceiling and the live Chainlink directory", () => {
    const config = loadRiskConfig({});

    assert.equal(config.maxPriceAgeSeconds, 300);
    assert.equal(
      config.feedDirectoryUrl,
      "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json",
    );
  });

  it("normalizes the risk universe", () => {
    const config = loadRiskConfig({ RWA_SYMBOLS: "spy, GLD,spy" });
    assert.deepEqual(config.symbols, ["SPY", "GLD"]);
  });
});
