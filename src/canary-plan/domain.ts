import type { Address, Hash, Hex } from "viem";
import type { RiskGateDecision } from "../risk/gate.js";
import type { RpcHealthGateStatus } from "../rpc-health/domain.js";
import type { CanaryEntryReadiness } from "./entry-readiness.js";

export interface GuardedCanaryPolicy {
  readonly budgetCapQuote: bigint;
  readonly budgetQuote: bigint;
  readonly halfWidthSpacings: number;
  readonly maxLiquiditySharePpm: bigint;
  readonly maxOracleDeviationPpm: bigint;
  readonly slippageBps: number;
  readonly ttlSeconds: number;
}

export interface GuardedCanarySource {
  readonly assetRiskExecutionEligible: boolean;
  readonly assetRiskReasons: readonly string[];
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly blockTimestamp: string;
  readonly capturedAt: string;
  readonly chainId: number;
  readonly checkpointRunId: string;
  readonly fee: number;
  readonly poolAddress: Address;
  readonly poolDeviationPpm: bigint | null;
  readonly poolLiquidity: bigint;
  readonly poolSqrtPriceX96: bigint;
  readonly poolStatus: "excluded" | "valid";
  readonly poolTick: number;
  readonly poolUnlocked: boolean;
  readonly riskRunId: string;
  readonly rwaAddress: Address;
  readonly rwaSymbol: string;
  readonly streamKey: string;
  readonly targetSetHash: Hash;
  readonly token0: Address;
  readonly token1: Address;
  readonly tokenDecimals: number;
}

export interface GuardedCanaryTokenState {
  readonly address: Address;
  readonly allowance: bigint;
  readonly balance: bigint;
  readonly decimals: number;
  readonly symbol: string;
}

export interface GuardedCanaryChainState {
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly blockTimestamp: bigint;
  readonly chainId: number;
  readonly factoryPool: Address;
  readonly gasPriceWei: bigint;
  readonly managerFactory: Address;
  readonly nativeBalance: bigint;
  readonly pool: {
    readonly address: Address;
    readonly fee: number;
    readonly liquidity: bigint;
    readonly sqrtPriceX96: bigint;
    readonly tick: number;
    readonly tickSpacing: number;
    readonly token0: Address;
    readonly token1: Address;
    readonly unlocked: boolean;
  };
  readonly token0: GuardedCanaryTokenState;
  readonly token1: GuardedCanaryTokenState;
}

export interface GuardedCanaryTransaction {
  readonly amount0Desired: string;
  readonly amount0Min: string;
  readonly amount1Desired: string;
  readonly amount1Min: string;
  readonly calldata: Hex;
  readonly deadline: string;
  readonly fee: number;
  readonly positionManager: Address;
  readonly recipient: Address;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly token0: Address;
  readonly token1: Address;
  readonly value: "0";
}

export interface GuardedCanaryDraft {
  readonly entryReadiness: CanaryEntryReadiness | null;
  readonly approvalHash: string;
  readonly assumptions: readonly string[];
  readonly balances: {
    readonly gasPriceWei: string;
    readonly native: string;
    readonly token0: GuardedCanaryTokenState & {
      readonly required: string;
    };
    readonly token1: GuardedCanaryTokenState & {
      readonly required: string;
    };
  };
  readonly broadcastAuthorized: false;
  readonly candidateLiquidity: string;
  readonly checkpointAgeSeconds: number | null;
  readonly createdAt: string;
  readonly executionEligible: false;
  readonly idleQuote: string;
  readonly liquiditySharePpm: string;
  readonly methodology: "guarded_v3_mint_preflight_v1";
  readonly operator: Address;
  readonly policy: {
    readonly budgetCapQuote: string;
    readonly budgetQuote: string;
    readonly halfWidthSpacings: number;
    readonly maxLiquiditySharePpm: string;
    readonly maxOracleDeviationPpm: string;
    readonly slippageBps: number;
    readonly ttlSeconds: number;
  };
  readonly reasons: readonly string[];
  readonly riskGate: RiskGateDecision;
  readonly rpcHealth: RpcHealthGateStatus;
  readonly schemaVersion: 1;
  readonly source: {
    readonly blockHash: Hash;
    readonly blockNumber: string;
    readonly blockTimestamp: string;
    readonly checkpointRunId: string;
    readonly poolAddress: Address;
    readonly poolDeviationPpm: string | null;
    readonly riskRunId: string;
    readonly rwaSymbol: string;
    readonly streamKey: string;
    readonly targetSetHash: Hash;
  };
  readonly transaction: GuardedCanaryTransaction;
}

export interface GuardedCanarySimulation {
  readonly amount0: string;
  readonly amount1: string;
  readonly error: string | null;
  readonly liquidity: string;
  readonly returnData: Hex | null;
  readonly succeeded: boolean;
  readonly tokenId: string;
}

export interface GuardedCanaryGasEstimate {
  readonly error: string | null;
  readonly gas: string | null;
  readonly succeeded: boolean;
}

export interface GuardedCanaryPlan extends GuardedCanaryDraft {
  readonly estimatedGasCostWei: string | null;
  readonly gasEstimate: GuardedCanaryGasEstimate;
  readonly manualApprovalCandidate: boolean;
  readonly preflightReasons: readonly string[];
  readonly simulation: GuardedCanarySimulation;
  readonly status: "manual_approval_candidate" | "preflight_rejected";
}
