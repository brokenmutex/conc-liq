import type {Address,Hex} from 'viem';

/** Amounts in this policy are raw token units. Values and costs are 1e18 units
 * of the configured reporting numeraire; native amounts are wei. */
export interface RangeKeeperPool {
 chainId:number;factory:Address;pool:Address;token0:Address;token1:Address;
 quoteToken:0|1;decimals0:number;decimals1:number;fee:number;tickSpacing:number;
 positionManager:Address;router:Address;quoter:Address;
 poolCodeHash:Hex;token0CodeHash:Hex;token1CodeHash:Hex;managerCodeHash:Hex;quoterCodeHash:Hex;
 reference0:string;reference1:string;nativeReference:string;numeraire:string;
}
export interface RangeKeeperLimits {
 fullWidthSpacings:number;maxDeploymentValue:bigint;minDeploymentPpm:number;
 maxSwapInputValue:bigint;maxSwapInputPpm:number;maxSwapShortfallValue:bigint;
 maxSlippageBps:number;maxActionCost:bigint;maxRollingCost:bigint;maxCampaignCost:bigint;
 maxExposurePpm:number;maxLossValue:bigint;maxDrawdownPpm:number;maxRecenters:number;
 maxLiquiditySharePpm:number;maxObservationGapSeconds:number;exitReserveWei:bigint;
}
export interface RangeKeeperObservation {
 block:bigint;hash:Hex;timestamp:number;tick:number;sqrtPriceX96:bigint;
 continuity:'canonical'|'gap'|'reorg';
 wallet0:bigint;wallet1:bigint;released0:bigint;released1:bigint;
 nativeWei:bigint;requiredExitReserveWei:bigint|null;price0:bigint|null;price1:bigint|null;nativePrice:bigint|null;
 position:null|{tokenId:string;tickLower:number;tickUpper:number;liquidity:bigint};
 pending:boolean;entryAllowed:boolean;safeExitRequired:boolean;
 executionReady:boolean;liquiditySharePpm:number|null;
 actionCost:bigint|null;actionGasWei:bigint|null;reservedCost:bigint;rollingSpentCost:bigint;campaignSpentCost:bigint;
 campaignStartValue:bigint;highWaterValue:bigint;recenters:number;
}
export interface RangeKeeperCandidate {
 kind:'entry'|'recenter';range:{tickLower:number;tickUpper:number};
 swap:null|{token:0|1;amountIn:bigint;quotedOut:bigint;minOut:bigint;priceAfter:bigint;feeValue:bigint;shortfallValue:bigint};
 amount0Desired:bigint;amount1Desired:bigint;amount0Min:bigint;amount1Min:bigint;
 liquidity:bigint;deployedValue:bigint;sourceBlock:bigint;sourceHash:Hex;expiresAt:number;
}
export interface RangeKeeperState {
 schemaVersion:1;policyId:'rangekeeper_v1';strategyVersion:'1.0.0';configHash:Hex;buildId:string;
 lastEligible:null|{block:bigint;hash:Hex;timestamp:number};
 exit:null|{tokenId:string;tickLower:number;tickUpper:number;block:bigint;hash:Hex;since:number;lastOutsideAt:number};
 confirmation:null|{candidate:RangeKeeperCandidate;firstBlock:bigint;firstHash:Hex;firstAt:number};
}
export interface RangeKeeperDecision {
 action:'wait'|'safety_exit'|'confirm'|'execute';reason:string;state:RangeKeeperState;
 candidate:RangeKeeperCandidate|null;remaining:{action:bigint;rolling:bigint;campaign:bigint;nativeWei:bigint};
}
