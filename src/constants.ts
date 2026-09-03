import { defineChain, getAddress, type Address } from "viem";

export const ROBINHOOD_CHAIN_ID = 4663;

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Chain Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});

export const UNISWAP_V3_FACTORY = getAddress(
  "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
);

export const NONFUNGIBLE_POSITION_MANAGER = getAddress(
  "0x73991a25c818bf1f1128deaab1492d45638de0d3",
);

export const USDG = getAddress(
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
);

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export const DEFAULT_RWA_SYMBOLS = [
  "GLD",
  "SPY",
  "QQQ",
  "NVDA",
  "AAPL",
  "GOOGL",
  "MSFT",
] as const;

export const DEFAULT_FEE_TIERS = [100, 500, 3_000, 10_000] as const;
