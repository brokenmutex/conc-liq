import assert from 'node:assert/strict';
import {liquidityShare,liquidityShareAllowed} from './liquidity-share.js';
import { decodeFunctionResult, encodeFunctionData, type Address } from 'viem';
import { poolAbi } from '../abi.js';
import { NONFUNGIBLE_POSITION_MANAGER, USDG } from '../constants.js';
import { guardedCanaryPositionManagerAbi } from '../canary-plan/abi.js';
import { buildCanaryExit, decodeCanaryExit, readCanaryPosition } from '../canary-plan/exit.js';
import { principalAmounts, sqrtRatioAtTick } from '../backtest/principal.js';
import { replayPaperMint } from '../research/management-audit.js';
import { paperEntryRange, PAPER_NVDA, PAPER_POOL } from './engine.js';
import { PAPER_ACCOUNT, PAPER_ROUTER, PAPER_QUOTER, paperQuoterAbi, paperTokenAbi } from './execution-abi.js';
import { restorePaperPosition, type PaperExitInventory } from './execution-exit.js';
import type { PaperExecutionPolicy } from './execution.js';
import type { PaperFork } from './fork.js';

const NVDA = PAPER_NVDA as Address;
export interface PaperRecenterQuote {
  kind: 'outside_range_v1'; sourceBlock: string; sourceHash: string; quotedAt: string;
  oldRange: {tickLower:number;tickUpper:number;liquidity:string};
  tickLower: number; tickUpper: number; token: 0 | 1 | null;
  amountIn: string; minOut: string; minMint0: string; minMint1: string;
  adaptive?: {kind:'bounded_net_swap_v1';referenceSqrtPriceX96:string;maxAmountIn:string};
}

/** Find the single net trade funding the full portfolio in the fixed new range.
 * Quotes include the trade's fee and price impact. No liquidation to cash. */
export async function solveRecenterSwap(price: bigint, range: {tickLower:number;tickUpper:number}, cash: bigint, rwa: bigint,
  quote: (amount:bigint, token:0|1)=>Promise<{amountOut:bigint;price:bigint}>) {
  const ratio=(p:bigint,q:bigint,r:bigint)=>{
    const a=principalAmounts({sqrtPriceX96:p,...range,liquidity:10n**24n});
    return q*a.amount1-r*a.amount0;
  };
  const sign=ratio(price,cash,rwa);
  if(sign===0n)return {token:null,amount:0n,amountOut:0n,price} as const;
  const token:0|1=sign>0n?0:1;
  const evaluate=async(amount:bigint)=>{
    const fill=amount===0n?{amountOut:0n,price}:await quote(amount,token);
    const value=ratio(fill.price,cash+(token===0?-amount:fill.amountOut),rwa+(token===1?-amount:fill.amountOut));
    return {fill,crossed:token===0?value<=0n:value>=0n};
  };
  let lo=0n,hi=token===0?cash:rwa;
  assert(hi>0n&&(await evaluate(hi)).crossed,'Recenter ratio cannot be funded');
  while(lo<hi){const mid=(lo+hi)/2n;if((await evaluate(mid)).crossed)hi=mid;else lo=mid+1n;}
  const fill=(await evaluate(lo)).fill;
  assert(fill.amountOut>0n,'Recenter net swap rounds to zero');
  assert(fill.price>sqrtRatioAtTick(range.tickLower)&&fill.price<sqrtRatioAtTick(range.tickUpper),'Recenter swap leaves the new range');
  return {token,amount:lo,...fill};
}

export function assertRecenterPrice(price:bigint,reference:bigint,bps:number) {
  assert(price>0n&&reference>0n&&Number.isInteger(bps)&&bps>0&&bps<=500);
  // Token1/token0 squared-price bounds, frozen at the decision source.
  assert(price*price*10000n>=reference*reference*BigInt(10000-bps)&&
    price*price*10000n<=reference*reference*BigInt(10000+bps),'Recenter source price exceeds frozen slippage band');
}
export async function executionRecenterPlan(price:bigint,cash:bigint,rwa:bigint,intent:PaperRecenterQuote,bps:number,
 quote:(amount:bigint,token:0|1)=>Promise<{amountOut:bigint;price:bigint}>) {
 if(!intent.adaptive)return intent;
 assert.equal(intent.adaptive.kind,'bounded_net_swap_v1');
 assertRecenterPrice(price,BigInt(intent.adaptive.referenceSqrtPriceX96),bps);
 const plan=await solveRecenterSwap(price,intent,cash,rwa,quote);
 assert(plan.token===intent.token&&plan.token!==null,'Recenter net swap direction changed; requote required');
 assert(plan.amount<=BigInt(intent.adaptive.maxAmountIn),'Recenter input exceeds frozen inventory budget');
 assertRecenterPrice(plan.price,BigInt(intent.adaptive.referenceSqrtPriceX96),bps);
 assert(BigInt(intent.amountIn)>0n);
 // Keep the original minimum exchange rate even when the required input changes.
 const minOut=(plan.amount*BigInt(intent.minOut)+BigInt(intent.amountIn)-1n)/BigInt(intent.amountIn);
 assert(plan.amountOut>=minOut,'Frozen recenter swap minimum unavailable');
 const q=cash+(plan.token===0?-plan.amount:plan.amountOut),r=rwa+(plan.token===1?-plan.amount:plan.amountOut);
 const mint=replayPaperMint(plan.price,intent,q,r,0n);
 const minimum=(n:bigint)=>String(n*BigInt(10000-bps)/10000n);
 return {...intent,amountIn:String(plan.amount),minOut:String(minOut),minMint0:minimum(mint.amount0),minMint1:minimum(mint.amount1)};
}

async function remove(fork:PaperFork,policy:PaperExecutionPolicy,inventory:PaperExitInventory) {
  const restored=await restorePaperPosition(fork,policy,inventory);
  const {context,tokenId,position,principal,fees,before}=restored;
  const exit=buildCanaryExit({operator:PAPER_ACCOUNT,owner:PAPER_ACCOUNT,tokenId,
    source:{rwaSymbol:'NVDA',rwaAddress:NVDA,fee:500,token0:USDG,token1:NVDA},position,
    sqrtPriceX96:context.sourceSlot[0],blockTimestamp:fork.source.timestamp,slippageBps:policy.maxSlippageBps,ttlSeconds:policy.transactionTtlSeconds});
  const tx=await context.send('recenter_decrease_and_collect',NONFUNGIBLE_POSITION_MANAGER,exit.calldata);
  const released=decodeCanaryExit(tx.returnData),afterCollect=await context.balances();
  assert.equal(released.decreased0,principal.amount0);assert.equal(released.decreased1,principal.amount1);
  assert.equal(released.collected0-principal.amount0,fees[0]);assert.equal(released.collected1-principal.amount1,fees[1]);
  assert.equal(BigInt(afterCollect.quote),BigInt(before.quote)+released.collected0);
  assert.equal(BigInt(afterCollect.rwa),BigInt(before.rwa)+released.collected1);
  return {...restored,afterCollect};
}

export async function quotePaperRecenter(fork:PaperFork,policy:PaperExecutionPolicy,inventory:PaperExitInventory):Promise<PaperRecenterQuote> {
  assert.equal(policy.lpAllocationPpm,1000000);
  const {context,afterCollect}=await remove(fork,policy,inventory);
  const {local,sourceSlot}=context;
  const range=paperEntryRange({tick:sourceSlot[1],sqrtPriceX96:String(sourceSlot[0])},policy);
  const plan=await solveRecenterSwap(sourceSlot[0],range,BigInt(afterCollect.quote),BigInt(afterCollect.rwa),async(amount,token)=>{
    const q=await local.simulateContract({address:PAPER_QUOTER,abi:paperQuoterAbi,functionName:'quoteExactInputSingle',
      args:[{tokenIn:token===0?USDG:NVDA,tokenOut:token===0?NVDA:USDG,fee:500,amountIn:amount,sqrtPriceLimitX96:0n}]});
    return {amountOut:q.result[0],price:q.result[1]};
  });
  const cash=BigInt(afterCollect.quote)+(plan.token===0?-plan.amount:plan.amountOut);
  const rwa=BigInt(afterCollect.rwa)+(plan.token===1?-plan.amount:plan.amountOut);
  const mint=replayPaperMint(plan.price,range,cash,rwa,0n);
  assert(mint.liquidity>0n);
  const minimum=(n:bigint)=>String(n*BigInt(10000-policy.maxSlippageBps)/10000n);
  return {kind:'outside_range_v1',sourceBlock:String(fork.source.number),sourceHash:fork.source.hash,quotedAt:new Date().toISOString(),
    oldRange:{tickLower:inventory.tickLower,tickUpper:inventory.tickUpper,liquidity:inventory.liquidity},...range,
    token:plan.token,amountIn:String(plan.amount),minOut:minimum(plan.amountOut),minMint0:minimum(mint.amount0),minMint1:minimum(mint.amount1),
    ...(plan.token===null?{}:{adaptive:{kind:'bounded_net_swap_v1' as const,referenceSqrtPriceX96:String(sourceSlot[0]),maxAmountIn:plan.token===0?afterCollect.quote:afterCollect.rwa}})};
}

export async function simulatePaperRecenter(fork:PaperFork,policy:PaperExecutionPolicy,inventory:PaperExitInventory,intent:PaperRecenterQuote) {
  assert.equal(policy.lpAllocationPpm,1000000);
  assert.deepEqual(intent.oldRange,{tickLower:inventory.tickLower,tickUpper:inventory.tickUpper,liquidity:inventory.liquidity});
  assert(fork.source.number>BigInt(intent.sourceBlock),'Recenter requires a later source');
  const {context,afterCollect,before,tokenId}=await remove(fork,policy,inventory);
  const {local,send,approve,quoteSwap,swap,balances,transactions}=context;
  const range={tickLower:intent.tickLower,tickUpper:intent.tickUpper};
  const executionPlan=await executionRecenterPlan(context.sourceSlot[0],BigInt(afterCollect.quote),BigInt(afterCollect.rwa),intent,policy.maxSlippageBps,
    async(amount,token)=>{const q=await quoteSwap(token===0?USDG:NVDA,token===0?NVDA:USDG,amount);return {amountOut:BigInt(q.amountOut),price:BigInt(q.sqrtPriceAfter)};});
  let trade=null;
  if(intent.token!==null){
    const tokenIn=intent.token===0?USDG:NVDA,tokenOut=intent.token===0?NVDA:USDG;
    assert(BigInt(executionPlan.amountIn)>0n&&BigInt(executionPlan.amountIn)<=BigInt(intent.token===0?afterCollect.quote:afterCollect.rwa));
    const quote=await quoteSwap(tokenIn,tokenOut,BigInt(executionPlan.amountIn));
    assert(BigInt(quote.amountOut)>=BigInt(executionPlan.minOut),'Frozen recenter swap minimum unavailable');
    await approve(tokenIn,PAPER_ROUTER,BigInt(executionPlan.amountIn),'approve_recenter_swap');
    trade=await swap(intent.token===0?'recenter_buy_nvda':'recenter_sell_nvda',tokenIn,tokenOut,quote,executionPlan.minOut);
  } else assert.equal(executionPlan.amountIn,'0');
  const afterSwap=await balances();
  const slot=await local.readContract({address:PAPER_POOL as Address,abi:poolAbi,functionName:'slot0'});
  assert(slot[1]>=range.tickLower&&slot[1]<range.tickUpper,'Frozen recenter range is no longer active');
  const modeled=replayPaperMint(slot[0],range,BigInt(afterSwap.quote),BigInt(afterSwap.rwa),0n);
  assert(modeled.liquidity>0n);
  const depth=await local.readContract({address:PAPER_POOL as Address,abi:poolAbi,functionName:'liquidity'});
  const capacity=liquidityShare(modeled.liquidity,depth,policy);
  assert(liquidityShareAllowed(modeled.liquidity,depth,policy),'Recenter liquidity share exceeded');
  assert(modeled.amount0>=BigInt(executionPlan.minMint0)&&modeled.amount1>=BigInt(executionPlan.minMint1),'Frozen recenter mint minimum unavailable');
  await approve(USDG,NONFUNGIBLE_POSITION_MANAGER,BigInt(afterSwap.quote),'approve_recenter_mint_usdg');
  await approve(NVDA,NONFUNGIBLE_POSITION_MANAGER,BigInt(afterSwap.rwa),'approve_recenter_mint_nvda');
  const params={token0:USDG,token1:NVDA,fee:500,...range,amount0Desired:BigInt(afterSwap.quote),amount1Desired:BigInt(afterSwap.rwa),
    amount0Min:BigInt(executionPlan.minMint0),amount1Min:BigInt(executionPlan.minMint1),recipient:PAPER_ACCOUNT,deadline:fork.source.timestamp+BigInt(policy.transactionTtlSeconds)};
  const mint=await send('recenter_mint',NONFUNGIBLE_POSITION_MANAGER,encodeFunctionData({abi:guardedCanaryPositionManagerAbi,functionName:'mint',args:[params]}));
  const [newTokenId,liquidity,amount0,amount1]=decodeFunctionResult({abi:guardedCanaryPositionManagerAbi,functionName:'mint',data:mint.returnData});
  assert.equal(liquidity,modeled.liquidity);assert.equal(amount0,modeled.amount0);assert.equal(amount1,modeled.amount1);
  const after=await balances();assert.equal(after.quote,String(modeled.idle0));assert.equal(after.rwa,String(modeled.idle1));
  const old=await readCanaryPosition(local,tokenId,await local.getBlockNumber({cacheTime:0}));
  assert(old.liquidity===0n&&old.tokensOwed0===0n&&old.tokensOwed1===0n);
  const allowances=[];
  for(const token of [USDG,NVDA])for(const spender of [PAPER_ROUTER,NONFUNGIBLE_POSITION_MANAGER])
    allowances.push({token,spender,amount:String(await local.readContract({address:token,abi:paperTokenAbi,functionName:'allowance',args:[PAPER_ACCOUNT,spender]}))});
  const recenterTransactions=[...transactions];
  const gas=(txs:typeof transactions)=>String(txs.reduce((sum,tx)=>sum+BigInt(tx.estimate.totalFeeWei),0n));
  assert.equal(BigInt(before.native)-BigInt(after.native),transactions.reduce((sum,tx)=>sum+BigInt(tx.localGasUsed)*BigInt(tx.localEffectiveGasPriceWei),0n));
  // Preview a full cash exit on this same fork. It is a reserve, never a paid
  // recenter cost; real paper exits are simulated again at their later source.
  const fresh=await readCanaryPosition(local,newTokenId,await local.getBlockNumber({cacheTime:0}));
  const exit=buildCanaryExit({operator:PAPER_ACCOUNT,owner:PAPER_ACCOUNT,tokenId:newTokenId,
    source:{rwaSymbol:'NVDA',rwaAddress:NVDA,fee:500,token0:USDG,token1:NVDA},position:fresh,
    sqrtPriceX96:slot[0],blockTimestamp:fork.source.timestamp,slippageBps:policy.maxSlippageBps,ttlSeconds:policy.transactionTtlSeconds});
  await send('preview_decrease_and_collect',NONFUNGIBLE_POSITION_MANAGER,exit.calldata);
  const released=await balances();
  if(BigInt(released.rwa)>0n){const q=await quoteSwap(NVDA,USDG,BigInt(released.rwa));await approve(NVDA,PAPER_ROUTER,BigInt(released.rwa),'preview_approve_exit_swap');await swap('preview_sell_nvda',NVDA,USDG,q);}
  for(const item of allowances){
    const amount=await local.readContract({address:item.token,abi:paperTokenAbi,functionName:'allowance',args:[PAPER_ACCOUNT,item.spender]});
    if(amount>0n)await send('preview_revoke_exit_allowance',item.token,encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[item.spender,0n]}));
  }
  const exitTransactions=transactions.slice(recenterTransactions.length);
  const source=await fork.read('eth_getBlockByNumber',[fork.blockTag,false]) as {hash:string};assert.equal(source.hash.toLowerCase(),fork.source.hash.toLowerCase());
  return {scope:'paper_inventory_recenter' as const,executionEligible:false as const,broadcastAuthorized:false as const,
    computedAt:new Date().toISOString(),source:{block:String(fork.source.number),hash:fork.source.hash,timestamp:String(fork.source.timestamp)},
    policy,inventory,intent,executionPlan,trade,liquidityShare:capacity,position:{...range,liquidity:String(liquidity),minted0:String(amount0),minted1:String(amount1)},
    balances:{before,afterCollect,afterSwap,after},allowances,transactions:recenterTransactions,exitPreviewTransactions:exitTransactions,
    totalGasWei:gas(recenterTransactions),exitGasWei:gas(exitTransactions),upstream:fork.budget,
    limitations:['Hypothetical restored NFT and fee claims, not realized earnings','All-or-none paper acceptance of successful local simulation; submitted partial failures are not modeled','Native costs are fresh Nitro estimates, not receipts paid by this strategy']};
}
export type PaperRecenterSimulation=Awaited<ReturnType<typeof simulatePaperRecenter>>;
