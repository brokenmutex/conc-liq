import assert from 'node:assert/strict';
import {sqrtRatioAtTick} from '../../backtest/principal.js';
import {principalAmounts} from '../../backtest/principal.js';
import {strategyBalances} from './funding.js';
import {sizeRangeKeeperMint} from './planner.js';
import type {RangeKeeperConfig} from './config.js';
import type {RangeKeeperChain} from './chain.js';
import type {RangeKeeperTxPlan} from './calldata.js';
import type {RangeKeeperLiveState,RangeKeeperSnapshot} from './live-domain.js';

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const haircut=(n:bigint,bps:number)=>n*(10_000n-BigInt(bps))/10_000n;
export class RangeKeeperStaleCandidateError extends Error {}
export class RangeKeeperMintUnavailableError extends Error {}

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
 const grant=(i:0|1,kind:'router'|'positionManager',needed:bigint,futureCap?:bigint):RangeKeeperTxPlan|null=>{
  const available=i===0?funds.amount0:funds.amount1,cap=futureCap??available;
  assert(needed>=0n&&needed<=cap&&cap>=available);
  const current=allowance(i,kind);
  if(current>=needed)return null;
  // Grant the current strategy inventory once, so a fresh quote that needs
  // slightly more input does not incur a reset and second approval.
  return {kind:'approve',token:i,spender:kind,amount:current>0n?0n:cap};
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
  const after0=c.swap.token===0?funds.amount0-c.swap.amountIn:funds.amount0+quote.amountOut;
  const after1=c.swap.token===1?funds.amount1-c.swap.amountIn:funds.amount1+quote.amountOut;
  const projected=sizeRangeKeeperMint(quote.priceAfter,c.range,after0,after1,
   prices.price0,prices.price1,p.decimals0,p.decimals1,l.maxDeploymentValue);
  if(projected.mint.liquidity===0n||
   projected.deployed<l.maxDeploymentValue*BigInt(l.minDeploymentPpm)/1_000_000n||
   projected.deployed>l.maxDeploymentValue)
   throw new RangeKeeperStaleCandidateError('Current quote cannot fund approved range');
  // Approve both mint legs before the swap. At a 40-tick width, waiting for
  // manager approvals after the swap cost the historical mint its feasible
  // price window. The acquired leg has a finite $250 raw-token cap even
  // though the wallet does not own it yet.
  const acquired:0|1=c.swap.token===0?1:0;
  const acquiredPrice=acquired===0?prices.price0:prices.price1;
  const acquiredDecimals=acquired===0?p.decimals0:p.decimals1;
  assert(acquiredPrice>0n);
  const acquiredCap=l.maxDeploymentValue*10n**BigInt(acquiredDecimals)/acquiredPrice;
  const futureCap=acquired===0?(funds.amount0>acquiredCap?funds.amount0:acquiredCap):
   (funds.amount1>acquiredCap?funds.amount1:acquiredCap);
  const managerInput=grant(c.swap.token,'positionManager',c.swap.token===0?funds.amount0:funds.amount1);
  if(managerInput)return managerInput;
  const managerOutput=grant(acquired,'positionManager',acquired===0?c.amount0Desired:c.amount1Desired,futureCap);
  if(managerOutput)return managerOutput;
  const approval=grant(c.swap.token,'router',c.swap.amountIn);if(approval)return approval;
  return {kind:'swap',token:c.swap.token,amountIn:c.swap.amountIn,
   minOut:haircut(quote.amountOut,l.maxSlippageBps),deadline};
 }
 if(s.tick<c.range.tickLower||s.tick>=c.range.tickUpper||
  s.sqrtPriceX96<=sqrtRatioAtTick(c.range.tickLower)||s.sqrtPriceX96>=sqrtRatioAtTick(c.range.tickUpper))
  throw new RangeKeeperMintUnavailableError('Frozen mint range no longer contains price');
 // A stage can take longer than the 90-second confirmation window. Once a
 // swap or withdrawal has changed custody, reprice only this same range and
 // never repeat a completed swap to restore a guessed ratio.
 // After a completed swap, use the actual strategy inventory in this same
 // range. Idle USDG can rescue a narrow mint as the token ratio moves; the
 // cap below still prevents more than $250 from entering LP.
 const available0=c.swap?funds.amount0:c.amount0Desired;
 const available1=c.swap?funds.amount1:c.amount1Desired;
 assert(available0<=funds.amount0&&available1<=funds.amount1,'Frozen mint allocation unavailable');
 const {desired0,desired1,mint,deployed}=sizeRangeKeeperMint(s.sqrtPriceX96,c.range,available0,available1,
  prices.price0,prices.price1,p.decimals0,p.decimals1,l.maxDeploymentValue);
 const floor=l.maxDeploymentValue*BigInt(l.minDeploymentPpm)/1_000_000n;
 if(mint.liquidity===0n||deployed<floor||deployed>l.maxDeploymentValue)
  throw new RangeKeeperMintUnavailableError('Repriced mint misses deployment bounds');
 const refreshed={...c,amount0Desired:desired0,amount1Desired:desired1,
  amount0Min:haircut(mint.amount0,l.maxSlippageBps),amount1Min:haircut(mint.amount1,l.maxSlippageBps),
  liquidity:mint.liquidity,deployedValue:deployed,sourceBlock:s.source.block,sourceHash:s.source.hash,
  expiresAt:s.source.timestamp+90};
 const approval0=grant(0,'positionManager',desired0);if(approval0)return approval0;
 const approval1=grant(1,'positionManager',desired1);if(approval1)return approval1;
 return {kind:'mint',candidate:refreshed,deadline};
}
