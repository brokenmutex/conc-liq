import assert from 'node:assert/strict';
import {sqrtRatioAtTick} from '../../backtest/principal.js';
import {principalAmounts} from '../../backtest/principal.js';
import {replayPaperMint} from '../../research/management-audit.js';
import {strategyBalances} from './funding.js';
import {rawValue} from './planner.js';
import type {RangeKeeperConfig} from './config.js';
import type {RangeKeeperChain} from './chain.js';
import type {RangeKeeperTxPlan} from './calldata.js';
import type {RangeKeeperLiveState,RangeKeeperSnapshot} from './live-domain.js';

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const haircut=(n:bigint,bps:number)=>n*(10_000n-BigInt(bps))/10_000n;
export class RangeKeeperStaleCandidateError extends Error {}

export async function nextRangeKeeperStage(state:RangeKeeperLiveState,s:RangeKeeperSnapshot,
 config:RangeKeeperConfig,chain:RangeKeeperChain,prices:{price0:bigint;price1:bigint}):Promise<RangeKeeperTxPlan|null>{
 const p=config.pool,l=config.limits;
 const funds=strategyBalances(s,{reserve0:state.reserve0,reserve1:state.reserve1,reserveNativeWei:state.reserveNativeWei});
 const token=(i:0|1)=>i===0?p.token0:p.token1;
 const spender=(kind:'router'|'positionManager')=>kind==='router'?p.router:p.positionManager;
 const allowance=(i:0|1,kind:'router'|'positionManager')=>{
  const a=s.allowances.find(a=>same(a.token,token(i))&&same(a.spender,spender(kind)));
  assert(a,'Configured allowance pair missing');return a.amount;
 };
 const grant=(i:0|1,kind:'router'|'positionManager',needed:bigint):RangeKeeperTxPlan|null=>{
  const available=i===0?funds.amount0:funds.amount1;assert(needed>=0n&&needed<=available);
  const current=allowance(i,kind);
  if(current>=needed)return null;
  return {kind:'approve',token:i,spender:kind,amount:current>0n?0n:needed};
 };
 const deadline=BigInt(s.source.timestamp+300);
 if(state.phase==='exit'){
  const pos=s.position;
  if(pos&&pos.liquidity>0n){
   assert(state.activeTokenId===pos.tokenId,'Exit NFT identity changed');
   const a=principalAmounts({...pos,sqrtPriceX96:s.sqrtPriceX96});
   return {kind:'withdraw',tokenId:pos.tokenId!,liquidity:pos.liquidity,
    min0:haircut(a.amount0,l.maxSlippageBps),min1:haircut(a.amount1,l.maxSlippageBps),deadline};
  }
  const risky:0|1=p.quoteToken===0?1:0;
  const amount=risky===0?funds.amount0:funds.amount1;
  if(amount>0n){
   // Do not sell a verified asset into a detached or manipulated pool.
   const poolPrice1=((1n<<192n)*10n**BigInt(p.decimals1)*prices.price0)/
    (s.sqrtPriceX96*s.sqrtPriceX96*10n**BigInt(p.decimals0));
   const deviation=poolPrice1>prices.price1?poolPrice1-prices.price1:prices.price1-poolPrice1;
   assert(deviation*1_000_000n<=prices.price1*BigInt(config.referencePolicy.maxPoolDeviationPpm),
    'Exit pool/reference deviation');
   const approval=grant(risky,'router',amount);if(approval)return approval;
   const quote=await chain.quote(s.source,risky,amount,prices.price0,prices.price1);
   assert(quote.amountOut>0n&&quote.shortfallValue<=l.maxSwapShortfallValue,'Exit quote unavailable or excessive shortfall');
   return {kind:'swap',token:risky,amountIn:amount,minOut:haircut(quote.amountOut,l.maxSlippageBps),deadline};
  }
  for(const i of [0,1] as const)for(const kind of ['router','positionManager'] as const)
   if(allowance(i,kind)>0n)return {kind:'approve',token:i,spender:kind,amount:0n};
  return null;
 }
 if(state.phase==='holding'){
  // Cleanup is part of the completed economic action, never a fee harvest.
  for(const i of [0,1] as const)for(const kind of ['router','positionManager'] as const)
   if(allowance(i,kind)>0n)return {kind:'approve',token:i,spender:kind,amount:0n};
  return null;
 }
 if(state.phase!=='entry'&&state.phase!=='recenter')return null;
 const c=state.candidate;if(!c)return null;
 const pos=s.position;
 if(pos&&pos.liquidity>0n){
  assert(state.phase==='recenter'&&state.activeTokenId===pos.tokenId,'Ordinary withdrawal identity');
  const a=principalAmounts({...pos,sqrtPriceX96:s.sqrtPriceX96});
  return {kind:'withdraw',tokenId:pos.tokenId!,liquidity:pos.liquidity,
   min0:haircut(a.amount0,l.maxSlippageBps),min1:haircut(a.amount1,l.maxSlippageBps),deadline};
 }
 if(c.swap&&!state.swapDone){
  const available=c.swap.token===0?funds.amount0:funds.amount1;
  assert(c.swap.amountIn<=available,'Frozen swap input unavailable');
  // Approval confirmations can outlive the 90-second candidate window. The
  // amount/range stay frozen, but output and price impact must be requoted at
  // every canonical submission source.
  const quote=await chain.quote(s.source,c.swap.token,c.swap.amountIn,prices.price0,prices.price1);
  if(quote.amountOut<=0n||quote.shortfallValue>l.maxSwapShortfallValue)
   throw new RangeKeeperStaleCandidateError('Current swap quote is unavailable or too costly');
  if(quote.priceAfter<=sqrtRatioAtTick(c.range.tickLower)||quote.priceAfter>=sqrtRatioAtTick(c.range.tickUpper))
   throw new RangeKeeperStaleCandidateError('Current swap would leave the approved range');
  // The planner spends from the capped allocation, leaving wallet surplus idle.
  // Rescaling the whole wallet after the swap changes the planned token ratio.
  const inventoryValue=rawValue(funds.amount0,prices.price0,p.decimals0)+rawValue(funds.amount1,prices.price1,p.decimals1);
  const fraction=inventoryValue>l.maxDeploymentValue?l.maxDeploymentValue*1_000_000n/inventoryValue:1_000_000n;
  const base0=funds.amount0*fraction/1_000_000n,base1=funds.amount1*fraction/1_000_000n;
  if(c.swap.amountIn>(c.swap.token===0?base0:base1))
   throw new RangeKeeperStaleCandidateError('Frozen swap exceeds capped allocation');
  const after0=c.swap.token===0?base0-c.swap.amountIn:base0+quote.amountOut;
  const after1=c.swap.token===1?base1-c.swap.amountIn:base1+quote.amountOut;
  const projected=replayPaperMint(quote.priceAfter,c.range,after0,after1,0n);
  const projectedValue=rawValue(projected.amount0,prices.price0,p.decimals0)+rawValue(projected.amount1,prices.price1,p.decimals1);
  if(projectedValue<l.maxDeploymentValue*BigInt(l.minDeploymentPpm)/1_000_000n||
   projectedValue>l.maxDeploymentValue)
   throw new RangeKeeperStaleCandidateError('Current quote cannot fund approved range');
  const approval=grant(c.swap.token,'router',c.swap.amountIn);if(approval)return approval;
  return {kind:'swap',token:c.swap.token,amountIn:c.swap.amountIn,
   minOut:haircut(quote.amountOut,l.maxSlippageBps),deadline};
 }
 assert(s.tick>=c.range.tickLower&&s.tick<c.range.tickUpper,'Frozen mint range no longer contains price');
 assert(s.sqrtPriceX96>sqrtRatioAtTick(c.range.tickLower)&&s.sqrtPriceX96<sqrtRatioAtTick(c.range.tickUpper));
 // A stage can take longer than the 90-second confirmation window. Once a
 // swap or withdrawal has changed custody, reprice only this same range and
 // never repeat a completed swap to restore a guessed ratio.
 // Preserve the approved capped inventory after a swap. In particular, the
 // unspent wallet surplus must not dilute the acquired leg at mint time.
 const desired0=c.swap?(funds.amount0<c.amount0Desired?funds.amount0:c.amount0Desired):c.amount0Desired;
 const desired1=c.swap?(funds.amount1<c.amount1Desired?funds.amount1:c.amount1Desired):c.amount1Desired;
 assert(desired0<=funds.amount0&&desired1<=funds.amount1,'Frozen mint allocation unavailable');
 const mint=replayPaperMint(s.sqrtPriceX96,c.range,desired0,desired1,0n);
 const deployed=rawValue(mint.amount0,prices.price0,p.decimals0)+rawValue(mint.amount1,prices.price1,p.decimals1);
 const floor=l.maxDeploymentValue*BigInt(l.minDeploymentPpm)/1_000_000n;
 assert(mint.liquidity>0n&&deployed>=floor&&deployed<=l.maxDeploymentValue,'Repriced mint misses deployment bounds');
 const refreshed={...c,amount0Desired:desired0,amount1Desired:desired1,
  amount0Min:haircut(mint.amount0,l.maxSlippageBps),amount1Min:haircut(mint.amount1,l.maxSlippageBps),
  liquidity:mint.liquidity,deployedValue:deployed,sourceBlock:s.source.block,sourceHash:s.source.hash,
  expiresAt:s.source.timestamp+90};
 const approval0=grant(0,'positionManager',desired0);if(approval0)return approval0;
 const approval1=grant(1,'positionManager',desired1);if(approval1)return approval1;
 return {kind:'mint',candidate:refreshed,deadline};
}
