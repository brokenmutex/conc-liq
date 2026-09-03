import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectCanonicalAssets, type RegistryPayload } from "../src/registry.js";

const registry: RegistryPayload = {
  assets: [
    {
      currentMultiplier: "1.000000000000000000",
      deployments: [
        {
          chainId: 4663,
          contractAddress: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
          networkName: "Robinhood Chain",
        },
      ],
      id: "spy-id",
      isin: "US78462F1030",
      pendingMultiplier: "",
      status: "ASSET_STATUS_ACTIVE",
      tokenDecimals: 18,
      tokenName: "SPDR S&P 500 ETF Trust • Robinhood Token",
      tokenSymbol: "SPY",
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
    },
  ],
};

describe("selectCanonicalAssets", () => {
  it("selects the canonical deployment and preserves requested order", () => {
    const result = selectCanonicalAssets(registry, ["spy"]);

    assert.equal(result.length, 1);
    assert.equal(result[0]?.symbol, "SPY");
    assert.equal(
      result[0]?.address,
      "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
    );
    assert.equal(result[0]?.pendingMultiplier, null);
    assert.equal(result[0]?.isin, "US78462F1030");
    assert.equal(
      result[0]?.tradingCapabilities?.overnight?.whole,
      "TRADING_STATUS_TRADABLE",
    );
  });

  it("fails closed when a requested symbol is missing", () => {
    assert.throws(
      () => selectCanonicalAssets(registry, ["SPY", "GLD"]),
      /missing.*GLD/i,
    );
  });
});
