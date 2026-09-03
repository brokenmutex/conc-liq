export interface CursorStatus {
  readonly block: string | null;
  readonly hash: string | null;
  readonly updatedAt: string | null;
}

export interface DashboardOverview {
  readonly activePositions: string;
  readonly chainId: number | null;
  readonly indexedEvents: string;
  readonly indexer: CursorStatus;
  readonly initializedTicks: string;
  readonly poolCount: string;
  readonly replay: CursorStatus;
  readonly risk: {
    readonly attemptCompletedAt: string | null;
    readonly attemptId: string | null;
    readonly attemptStartedAt: string | null;
    readonly attemptStatus: string | null;
    readonly block: string | null;
    readonly executionEligible: boolean | null;
    readonly observedAt: string | null;
    readonly reasons: readonly string[];
    readonly runId: string | null;
  };
  readonly serverTime: string;
  readonly streamKey: string;
  readonly sync: {
    readonly blockLag: string | null;
    readonly hashesMatch: boolean | null;
  };
}

export interface PoolRow {
  readonly activePositions: string;
  readonly eventCount: string;
  readonly fee: number;
  readonly initialized: boolean;
  readonly initializedTicks: string;
  readonly lastEventBlock: string | null;
  readonly liquidity: string;
  readonly mintCount: string;
  readonly poolAddress: string;
  readonly rwaSymbol: string;
  readonly sqrtPriceX96: string | null;
  readonly swapCount: string;
  readonly tick: number | null;
}

export interface ActivityBucket {
  readonly blockEnd: string;
  readonly blockStart: string;
  readonly burn: string;
  readonly collect: string;
  readonly flash: string;
  readonly initialize: string;
  readonly mint: string;
  readonly swap: string;
  readonly total: string;
}

export interface PositionCoverageRow {
  readonly activeLiquidity: string;
  readonly activePositions: string;
  readonly distinctOwners: string;
  readonly fee: number;
  readonly maxTickUpper: number | null;
  readonly minTickLower: number | null;
  readonly poolAddress: string;
  readonly rwaSymbol: string;
}

export interface AssetRiskRow {
  readonly answer: string | null;
  readonly corporateActionPending: boolean | null;
  readonly currentMultiplier: string | null;
  readonly executionEligible: boolean;
  readonly feedDecimals: number | null;
  readonly marketHours: string | null;
  readonly multiplierConsistent: boolean | null;
  readonly oracleAddress: string | null;
  readonly oracleAgeSeconds: string | null;
  readonly oraclePaused: boolean | null;
  readonly reasons: readonly string[];
  readonly registryStatus: string | null;
  readonly rwaSymbol: string;
  readonly tradingTradable: boolean | null;
  readonly uiMultiplier: string | null;
}

export interface RiskAttemptRow {
  readonly attemptedAt: string;
  readonly block: string | null;
  readonly completedAt: string | null;
  readonly error: string | null;
  readonly executionEligible: boolean | null;
  readonly id: string;
  readonly status: string;
}

export interface RiskSourceEvidence {
  readonly feedDirectory: {
    readonly fetchedAt: string | null;
    readonly sha256: string | null;
    readonly url: string | null;
  };
  readonly registry: {
    readonly fetchedAt: string | null;
    readonly sha256: string | null;
    readonly url: string | null;
  };
}

export interface DashboardSnapshot {
  readonly activity: readonly ActivityBucket[];
  readonly attempts: readonly RiskAttemptRow[];
  readonly overview: DashboardOverview;
  readonly pools: readonly PoolRow[];
  readonly positions: readonly PositionCoverageRow[];
  readonly refreshMs: number;
  readonly riskAssets: readonly AssetRiskRow[];
  readonly sources: RiskSourceEvidence;
}
