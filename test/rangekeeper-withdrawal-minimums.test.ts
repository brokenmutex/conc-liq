import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {principalAmounts} from '../src/backtest/principal.js';
import {rangeKeeperWithdrawalMinimums} from '../src/strategy/rangekeeper/calldata.js';

// Live campaign 87be13f6, NFT 1412233: the recenter withdrawal planned at block 83491159 (tick 221915, just above the
// range) reverted with "Price slippage check" at block 83491571 after the pool moved 7 ticks back inside it (221908).
const position={liquidity:1_477_854_712_733_235n,tickLower:221710,tickUpper:221910};
const planned=5217517243231785823442084710923899n,executed=5215915422424581581723049599445525n;

describe('RangeKeeper withdrawal minimums',()=>{
 it('reproduces the live revert with the old per-token haircut and accepts the same burn with the price band',()=>{
  const atPlan=principalAmounts({...position,sqrtPriceX96:planned}),atExec=principalAmounts({...position,sqrtPriceX96:executed});
  const oldMin1=atPlan.amount1*9_950n/10_000n;
  assert.equal(oldMin1,963_245_652_633_148_922n,'matches the reverted transaction amount1Min');
  assert(atExec.amount1<oldMin1,'the 2-tick re-entry burns less token1 than the old minimum');
  const band=rangeKeeperWithdrawalMinimums(position,planned,50);
  assert(atExec.amount0>=band.min0&&atExec.amount1>=band.min1,'the band minimums accept the executed burn');
 });
 it('never exceeds the amounts at the observed price and still bounds a move beyond the band',()=>{
  for(const sqrtPriceX96 of [planned,executed,principalAmounts({...position,sqrtPriceX96:executed}).sqrtRatioLowerX96+10n**28n]){
   const at=principalAmounts({...position,sqrtPriceX96}),band=rangeKeeperWithdrawalMinimums(position,sqrtPriceX96,50);
   assert(band.min0<=at.amount0&&band.min1<=at.amount1);
  }
  // In range, a price 1% below the observation (well past the 0.5% band) burns less token1 than the minimum.
  const mid=5_211_000_000_000_000_000_000_000_000_000_000n,band=rangeKeeperWithdrawalMinimums(position,mid,50);
  const lower=principalAmounts({...position,sqrtPriceX96:mid*9_950n/10_000n});
  assert(lower.amount1<band.min1,'a manipulated burn price outside the band still reverts');
  assert.deepEqual(rangeKeeperWithdrawalMinimums(position,mid,0),{min0:principalAmounts({...position,sqrtPriceX96:mid}).amount0,
   min1:principalAmounts({...position,sqrtPriceX96:mid}).amount1},'zero slippage keeps exact minimums');
 });
});
