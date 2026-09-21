import assert from 'node:assert/strict';
import {rawValue} from './planner.js';
import type {RangeKeeperConfig} from './config.js';

export interface RangeKeeperFundingSnapshot {
 wallet0:bigint;wallet1:bigint;nativeWei:bigint;price0:bigint;price1:bigint;nativePrice:bigint;
}
/** Lock the campaign's raw allocation once. Excess pre-existing wallet funds
 * stay as named reserves and may never be counted as strategy income. */
export function allocateRangeKeeperFunding(config:RangeKeeperConfig,s:RangeKeeperFundingSnapshot,
 allocation:{amount0:bigint;amount1:bigint;nativeWei:bigint}){
 assert(s.price0>0n&&s.price1>0n&&s.nativePrice>0n,'Independent funding references required');
 assert(allocation.amount0>=0n&&allocation.amount1>=0n&&allocation.nativeWei>=0n);
 assert(allocation.amount0<=s.wallet0&&allocation.amount1<=s.wallet1&&allocation.nativeWei<=s.nativeWei,'Allocation exceeds custody');
 const strategyValue=rawValue(allocation.amount0,s.price0,config.pool.decimals0)+rawValue(allocation.amount1,s.price1,config.pool.decimals1);
 const nativeValue=rawValue(allocation.nativeWei,s.nativePrice,18);
 assert(strategyValue>0n&&nativeValue>0n,'Campaign needs inventory and native gas');
 assert(strategyValue<=config.strategyFundingValue,'Strategy allocation exceeds cap');
 assert(nativeValue<=config.nativeFundingValue,'Native allocation exceeds cap');
 assert(strategyValue+nativeValue<=config.campaignValue,'Aggregate allocation exceeds cap');
 return {reserve0:s.wallet0-allocation.amount0,reserve1:s.wallet1-allocation.amount1,
  reserveNativeWei:s.nativeWei-allocation.nativeWei,allocation:{...allocation},
  bookedStrategyValue:strategyValue,bookedNativeValue:nativeValue,totalBookedValue:strategyValue+nativeValue};
}

export function strategyBalances(wallet:{wallet0:bigint;wallet1:bigint;nativeWei:bigint},
 reserve:{reserve0:bigint;reserve1:bigint;reserveNativeWei:bigint}){
 assert(wallet.wallet0>=reserve.reserve0&&wallet.wallet1>=reserve.reserve1&&wallet.nativeWei>=reserve.reserveNativeWei,
  'Pre-existing wallet reserve was spent');
 return {amount0:wallet.wallet0-reserve.reserve0,amount1:wallet.wallet1-reserve.reserve1,
  nativeWei:wallet.nativeWei-reserve.reserveNativeWei};
}
