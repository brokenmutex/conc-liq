import type { Address, Hash } from "viem";

export interface TradingCapability {
  readonly fractional: string;
  readonly whole: string;
}

export interface TradingCapabilities {
  readonly extended?: TradingCapability;
  readonly market?: TradingCapability;
  readonly overnight?: TradingCapability;
}

export interface CanonicalAsset {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly address: Address;
  readonly decimals: number;
  readonly currentMultiplier: string;
  readonly isin: string | null;
  readonly pendingMultiplier: string | null;
  readonly pendingMultiplierEffectiveTime: string | null;
  readonly status: string;
  readonly tradingCapabilities: TradingCapabilities | null;
}

export interface VerifiedAsset extends CanonicalAsset {
  readonly onchainSymbol: string;
  readonly onchainDecimals: number;
  readonly codeHash: Hash;
}

export interface PoolSnapshot {
  readonly address: Address;
  readonly codeHash: Hash;
  readonly rwaSymbol: string;
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly liquidity: string;
  readonly sqrtPriceX96: string;
  readonly tick: number;
  readonly observationIndex: number;
  readonly observationCardinality: number;
  readonly observationCardinalityNext: number;
  readonly feeProtocol: number;
  readonly unlocked: boolean;
}

export interface ObserverSnapshot {
  readonly schemaVersion: 1;
  readonly chainId: number;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly blockTimestamp: string;
  readonly observedAt: string;
  readonly contracts: {
    readonly factory: Address;
    readonly factoryCodeHash: Hash;
    readonly positionManager: Address;
    readonly usdg: Address;
    readonly usdgSymbol: string;
    readonly usdgDecimals: number;
    readonly usdgCodeHash: Hash;
  };
  readonly assets: readonly VerifiedAsset[];
  readonly pools: readonly PoolSnapshot[];
}
