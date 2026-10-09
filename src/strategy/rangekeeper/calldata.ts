import assert from 'node:assert/strict';
import {encodeFunctionData,type Address} from 'viem';
import {guardedCanaryPositionManagerAbi} from '../../canary-plan/abi.js';
import {canaryExitAbi} from '../../canary-plan/exit.js';
import {paperRouterAbi,paperTokenAbi} from '../../paper/execution-abi.js';
import {principalAmounts} from '../../backtest/principal.js';
import {replayPaperMint} from '../../research/management-audit.js';
import type {RangeKeeperCandidate,RangeKeeperPool} from './domain.js';

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const UINT128_MAX=(1n<<128n)-1n;
export type RangeKeeperTxPlan=
 |{kind:'approve';token:0|1;spender:'router'|'positionManager';amount:bigint}
 |{kind:'swap';token:0|1;amountIn:bigint;minOut:bigint;deadline:bigint}
 |{kind:'mint';candidate:RangeKeeperCandidate;deadline:bigint}
 |{kind:'withdraw';tokenId:bigint;liquidity:bigint;min0:bigint;min1:bigint;deadline:bigint};
export interface RangeKeeperWallet {
 operator:Address;wallet0:bigint;wallet1:bigint;tick:number;sqrtPriceX96:bigint;timestamp:number;
 position:null|{tokenId:bigint;owner:Address;token0:Address;token1:Address;fee:number;tickLower:number;tickUpper:number;liquidity:bigint};
}

/** Semantic authorization is mandatory immediately before signing. The caller
 * must also bind this calldata to a canonical source, nonce, and gas envelope.
 * `allowanceCeiling` (persistent_capped_v1) lets an approval reach its per-token cap above the current inventory. */
export function authorizeRangeKeeperTx(pool:RangeKeeperPool,wallet:RangeKeeperWallet,plan:RangeKeeperTxPlan,slippageBps:number,fullWidthSpacings:number,futureApprovalCap=0n,
 allowanceCeiling?:readonly [bigint,bigint]){
 assert(Number.isInteger(slippageBps)&&slippageBps>0&&slippageBps<=50);
 const token=(index:0|1)=>index===0?pool.token0:pool.token1;
 const available=(index:0|1)=>index===0?wallet.wallet0:wallet.wallet1;
 if(plan.kind==='approve'){
  assert(futureApprovalCap>=0n);
  assert(plan.amount>=0n&&(plan.amount<=available(plan.token)+futureApprovalCap||
   allowanceCeiling!==undefined&&plan.amount<=allowanceCeiling[plan.token]),
   'Approval exceeds available or bounded future strategy token');
  assert(futureApprovalCap===0n||plan.spender==='positionManager',
   'Only position-manager approval may anticipate swap inventory');
  return;
 }
 assert(plan.deadline>BigInt(wallet.timestamp)&&plan.deadline<=BigInt(wallet.timestamp+300),'Transaction deadline invalid');
 if(plan.kind==='swap'){
  assert(plan.amountIn>0n&&plan.amountIn<=available(plan.token));assert(plan.minOut>0n);
  assert(!wallet.position||wallet.position.liquidity===0n,'Swap before withdrawal');
 }else if(plan.kind==='mint'){
  const c=plan.candidate,r=c.range;
  assert(c.sourceBlock>=0n&&wallet.tick>=r.tickLower&&wallet.tick<r.tickUpper);
  assert(r.tickUpper-r.tickLower===fullWidthSpacings*pool.tickSpacing,'Mint width differs from campaign');
  assert(r.tickLower%pool.tickSpacing===0&&r.tickUpper%pool.tickSpacing===0);
  assert(c.amount0Desired>0n&&c.amount1Desired>0n&&c.amount0Desired<=wallet.wallet0&&c.amount1Desired<=wallet.wallet1);
  assert(!wallet.position||wallet.position.liquidity===0n,'Mint before withdrawal');
  const m=replayPaperMint(wallet.sqrtPriceX96,r,c.amount0Desired,c.amount1Desired,0n);
  assert(m.liquidity>0n&&m.liquidity>=c.liquidity,'Mint liquidity below frozen minimum');
  const haircut=10_000n-BigInt(slippageBps);
  assert(c.amount0Min>=m.amount0*haircut/10_000n&&c.amount1Min>=m.amount1*haircut/10_000n,'Mint minimum weakened');
 }else{
  const p=wallet.position;
  assert(p&&p.tokenId===plan.tokenId&&same(p.owner,wallet.operator)&&same(p.token0,token(0))&&same(p.token1,token(1))&&p.fee===pool.fee);
  assert(plan.liquidity===p.liquidity&&plan.liquidity>0n);
  const floor=rangeKeeperWithdrawalMinimums(p,wallet.sqrtPriceX96,slippageBps);
  assert(plan.min0>=floor.min0&&plan.min1>=floor.min1,'Withdrawal minimum weakened');
 }
}

const isqrt=(n:bigint)=>{if(n<2n)return n;let x=n,y=(x+1n)>>1n;while(y<x){x=y;y=(x+n/x)>>1n;}return x;};
/** Withdrawal minimums that hold anywhere within ±slippageBps of the observed price. A per-token haircut at the exact
 * price reverts on a few-tick move whenever the position sits at a range edge (where recenters and exits happen),
 * because a burn's composition shifts while its value barely does. The price band still bounds a manipulated burn. */
export function rangeKeeperWithdrawalMinimums(position:{liquidity:bigint;tickLower:number;tickUpper:number},sqrtPriceX96:bigint,slippageBps:number){
 assert(Number.isSafeInteger(slippageBps)&&slippageBps>=0&&slippageBps<10_000,'Invalid withdrawal slippage');
 const bps=BigInt(slippageBps),one=10n**18n,
  edge=(f:bigint)=>sqrtPriceX96*isqrt(f*one*one/10_000n)/one,
  low=principalAmounts({...position,sqrtPriceX96:edge(10_000n-bps)}),high=principalAmounts({...position,sqrtPriceX96:edge(10_000n+bps)});
 // token0 falls and token1 rises with price, so each minimum is that token's amount at the adverse band edge.
 return {min0:high.amount0,min1:low.amount1};
}

export function encodeRangeKeeperTx(pool:RangeKeeperPool,operator:Address,plan:RangeKeeperTxPlan){
 const token=(index:0|1)=>index===0?pool.token0:pool.token1;
 if(plan.kind==='approve')return {to:token(plan.token),data:encodeFunctionData({abi:paperTokenAbi,functionName:'approve',
  args:[plan.spender==='router'?pool.router:pool.positionManager,plan.amount]})};
 if(plan.kind==='swap'){
  const swap=encodeFunctionData({abi:paperRouterAbi,functionName:'exactInputSingle',args:[{tokenIn:token(plan.token),tokenOut:token(plan.token===0?1:0),
   fee:pool.fee,recipient:operator,amountIn:plan.amountIn,amountOutMinimum:plan.minOut,sqrtPriceLimitX96:0n}]});
  return {to:pool.router,data:encodeFunctionData({abi:paperRouterAbi,functionName:'multicall',args:[plan.deadline,[swap]]})};
 }
 if(plan.kind==='mint'){
  const c=plan.candidate;
  return {to:pool.positionManager,data:encodeFunctionData({abi:guardedCanaryPositionManagerAbi,functionName:'mint',args:[{
   token0:pool.token0,token1:pool.token1,fee:pool.fee,tickLower:c.range.tickLower,tickUpper:c.range.tickUpper,
   amount0Desired:c.amount0Desired,amount1Desired:c.amount1Desired,amount0Min:c.amount0Min,amount1Min:c.amount1Min,
   recipient:operator,deadline:plan.deadline}]})};
 }
 const calls=[encodeFunctionData({abi:canaryExitAbi,functionName:'decreaseLiquidity',args:[{
  tokenId:plan.tokenId,liquidity:plan.liquidity,amount0Min:plan.min0,amount1Min:plan.min1,deadline:plan.deadline}]}),
  encodeFunctionData({abi:canaryExitAbi,functionName:'collect',args:[{tokenId:plan.tokenId,recipient:operator,amount0Max:UINT128_MAX,amount1Max:UINT128_MAX}]})];
 return {to:pool.positionManager,data:encodeFunctionData({abi:canaryExitAbi,functionName:'multicall',args:[calls]})};
}
