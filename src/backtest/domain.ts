export interface AccountingRunSource {
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly chainId: number;
  readonly observedAt: string;
  readonly runId: string;
}

export interface AccountingRunReference extends AccountingRunSource {
  readonly blockTimestamp: string;
}

export interface PoolIntervalInput {
  readonly activePositionsFrom: number;
  readonly activePositionsTo: number;
  readonly fee: number;
  readonly poolAddress: string;
  readonly rwaSymbol: string;
  readonly token0: string;
  readonly token1: string;
}

export interface PositionIntervalInput {
  readonly feeGrowthInside0LastFromX128: bigint;
  readonly feeGrowthInside0LastToX128: bigint;
  readonly feeGrowthInside1LastFromX128: bigint;
  readonly feeGrowthInside1LastToX128: bigint;
  readonly liquidityFrom: bigint;
  readonly liquidityTo: bigint;
  readonly ownerAddress: string;
  readonly pending0From: bigint;
  readonly pending0To: bigint;
  readonly pending1From: bigint;
  readonly pending1To: bigint;
  readonly poolAddress: string;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly touched: boolean;
}

export interface StableFeePoolBaseline {
  readonly accrued0: string;
  readonly accrued1: string;
  readonly activePositionsFrom: number;
  readonly activePositionsTo: number;
  readonly enteredPositions: number;
  readonly exitedPositions: number;
  readonly fee: number;
  readonly pairedActivePositions: number;
  readonly poolAddress: string;
  readonly rwaSymbol: string;
  readonly stablePositions: number;
  readonly token0: string;
  readonly token1: string;
  readonly touchedPositions: number;
}

export interface StableFeeBaseline {
  readonly blockDelta: string;
  readonly computedAt: string;
  readonly elapsedSeconds: number;
  readonly executionEligible: false;
  readonly from: AccountingRunReference;
  readonly limitations: readonly string[];
  readonly methodology: "stable_core_position_pending_delta";
  readonly pools: readonly StableFeePoolBaseline[];
  readonly schemaVersion: 1;
  readonly streamKey: string;
  readonly to: AccountingRunReference;
  readonly totals: {
    readonly enteredPositions: number;
    readonly exitedPositions: number;
    readonly pairedActivePositions: number;
    readonly stablePositions: number;
    readonly touchedPositions: number;
  };
}
