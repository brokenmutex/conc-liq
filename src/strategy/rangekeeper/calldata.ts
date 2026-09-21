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
 * must also bind this calldata to a canonical source, nonce, and gas envelope. */
export function authorizeRangeKeeperTx(pool:RangeKeeperPool,wallet:RangeKeeperWallet,plan:RangeKeeperTxPlan,slippageBps:number,fullWidthSpacings:number,futureApprovalCap=0n){
 assert(Number.isInteger(slippageBps)&&slippageBps>0&&slippageBps<=50);
 const token=(index:0|1)=>index===0?pool.token0:pool.token1;
 const available=(index:0|1)=>index===0?wallet.wallet0:wallet.wallet1;
 if(plan.kind==='approve'){
  assert(futureApprovalCap>=0n);
  assert(plan.amount>=0n&&plan.amount<=available(plan.token)+futureApprovalCap,
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
  const amounts=principalAmounts({...p,sqrtPriceX96:wallet.sqrtPriceX96});
  const haircut=10_000n-BigInt(slippageBps);
  assert(plan.min0>=amounts.amount0*haircut/10_000n&&plan.min1>=amounts.amount1*haircut/10_000n,'Withdrawal minimum weakened');
 }
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
