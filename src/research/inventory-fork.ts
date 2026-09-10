import assert from 'node:assert/strict';
import {decodeFunctionResult,encodeFunctionData,type Address} from 'viem';
import {NONFUNGIBLE_POSITION_MANAGER,USDG} from '../constants.js';
import {guardedCanaryPositionManagerAbi} from '../canary-plan/abi.js';
import {buildCanaryExit,decodeCanaryExit,readCanaryPosition} from '../canary-plan/exit.js';
import {PAPER_NVDA,PAPER_POOL} from '../paper/engine.js';
import {PAPER_ACCOUNT,PAPER_ROUTER} from '../paper/execution-abi.js';
import {restorePaperPosition,type PaperExitInventory} from '../paper/execution-exit.js';
import type {PaperExecutionPolicy} from '../paper/execution.js';
import type {PaperFork} from '../paper/fork.js';
import type {PaperTransaction} from '../paper/execution-gas.js';
import type {SwapSource} from './swap.js';
import {balancedRecenterPlan} from './inventory-management.js';
import {poolAbi} from '../abi.js';
import {historicalSwapQuote,positionAmounts} from './portfolio-math.js';

/** Research-only intervention. All writes use the owned fork's transport. */
export async function simulateInventoryRecenter(fork:PaperFork,policy:PaperExecutionPolicy,inventory:PaperExitInventory,
 market:SwapSource,preserve=false,onTransaction?:(tx:PaperTransaction)=>void){
 const restored=await restorePaperPosition(fork,policy,inventory,onTransaction);
 const {context,tokenId,position,principal,fees,before}=restored;
 const {local,sourceSlot,balances,send,approve,quoteSwap,swap,transactions}=context;
 assert.equal(sourceSlot[0],market.price);assert.equal(sourceSlot[1],market.tick);
 const exit=buildCanaryExit({operator:PAPER_ACCOUNT,owner:PAPER_ACCOUNT,tokenId,
  source:{rwaSymbol:'NVDA',rwaAddress:PAPER_NVDA as Address,fee:500,token0:USDG,token1:PAPER_NVDA as Address},position,
  sqrtPriceX96:sourceSlot[0],blockTimestamp:fork.source.timestamp,slippageBps:policy.maxSlippageBps,ttlSeconds:policy.transactionTtlSeconds});
 const removed=await send('decrease_and_collect',NONFUNGIBLE_POSITION_MANAGER,exit.calldata),released=decodeCanaryExit(removed.returnData);
 assert.equal(released.decreased0,principal.amount0);assert.equal(released.decreased1,principal.amount1);
 assert.equal(released.collected0-principal.amount0,fees[0]);assert.equal(released.collected1-principal.amount1,fees[1]);
 const afterCollect=await balances();
 assert.equal(BigInt(afterCollect.quote),BigInt(before.quote)+released.collected0);
 assert.equal(BigInt(afterCollect.rwa),BigInt(before.rwa)+released.collected1);
 const plan=balancedRecenterPlan(market,BigInt(afterCollect.quote),BigInt(afterCollect.rwa),policy.halfWidthSpacings*10,policy.lpAllocationPpm??800000,preserve);
 let trade=null;
 if(plan.swap&&plan.token!==null){
  const tokenIn=plan.token===0?USDG:PAPER_NVDA as Address,tokenOut=plan.token===0?PAPER_NVDA as Address:USDG;
  const quote=await quoteSwap(tokenIn,tokenOut,plan.amount);
  assert.equal(quote.amountOut,String(plan.swap.amountOut),'Historical depth quote differs from fork quoter');
  await approve(tokenIn,PAPER_ROUTER,plan.amount,'approve_recenter_swap');
  trade=await swap(plan.token===0?'recenter_buy_nvda':'recenter_sell_nvda',tokenIn,tokenOut,quote);
 }
 const afterSwap=await balances(),slot=await local.readContract({address:PAPER_POOL as Address,abi:poolAbi,functionName:'slot0'});
 assert.equal(slot[0],plan.price);assert.equal(slot[1],plan.tick);
 await approve(USDG,NONFUNGIBLE_POSITION_MANAGER,BigInt(afterSwap.quote)-plan.reserve,'approve_recenter_mint_usdg');
 await approve(PAPER_NVDA as Address,NONFUNGIBLE_POSITION_MANAGER,BigInt(afterSwap.rwa),'approve_recenter_mint_nvda');
 const params={token0:USDG,token1:PAPER_NVDA as Address,fee:500,...plan.range,
  amount0Desired:BigInt(afterSwap.quote)-plan.reserve,amount1Desired:BigInt(afterSwap.rwa),
  amount0Min:plan.mint.amount0*BigInt(10000-policy.maxSlippageBps)/10000n,amount1Min:plan.mint.amount1*BigInt(10000-policy.maxSlippageBps)/10000n,
  recipient:PAPER_ACCOUNT,deadline:fork.source.timestamp+BigInt(policy.transactionTtlSeconds)};
 const mint=await send('recenter_mint',NONFUNGIBLE_POSITION_MANAGER,encodeFunctionData({abi:guardedCanaryPositionManagerAbi,functionName:'mint',args:[params]}));
 const [newTokenId,liquidity,amount0,amount1]=decodeFunctionResult({abi:guardedCanaryPositionManagerAbi,functionName:'mint',data:mint.returnData});
 assert.equal(liquidity,plan.mint.liquidity);assert.equal(amount0,plan.mint.amount0);assert.equal(amount1,plan.mint.amount1);
 const after=await balances();assert.equal(after.quote,String(plan.mint.idle0));assert.equal(after.rwa,String(plan.mint.idle1));
 const old=await readCanaryPosition(local,tokenId,await local.getBlockNumber({cacheTime:0}));
 const fresh=await readCanaryPosition(local,newTokenId,await local.getBlockNumber({cacheTime:0}));
 assert.equal(old.liquidity,0n);assert.equal(old.tokensOwed0,0n);assert.equal(old.tokensOwed1,0n);assert.equal(fresh.liquidity,liquidity);
 const nativeSpent=transactions.reduce((n,t)=>n+BigInt(t.localGasUsed)*BigInt(t.localEffectiveGasPriceWei),0n);
 assert.equal(BigInt(before.native)-BigInt(after.native),nativeSpent);
 const source=await fork.read('eth_getBlockByNumber',[fork.blockTag,false]) as {hash:string};assert.equal(source.hash.toLowerCase(),fork.source.hash.toLowerCase());
 return {scope:'historical_inventory_recenter_local_fork',executionEligible:false,broadcastAuthorized:false,computedAt:new Date().toISOString(),
  source:{block:String(fork.source.number),hash:fork.source.hash,timestamp:String(fork.source.timestamp)},policy,inventory,preserve,
  plan,trade,balances:{before,afterCollect,afterSwap,after},oldTokenId:String(tokenId),newTokenId:String(newTokenId),
  position:{...plan.range,liquidity:String(liquidity),minted0:String(amount0),minted1:String(amount1)},transactions,
  totalGasWei:String(transactions.reduce((n,t)=>n+BigInt(t.estimate.totalFeeWei),0n)),upstream:fork.budget,
  limitations:['Pinned historical source and hypothetical restored NFT; no strategy profitability claim',
   'Actual local calls and Nitro estimates with prestate overrides; no mainnet transaction receipts',
   'A single intervention, with no intervening third-party transactions']};
}

/** Bounded research probe: remove 25 percent of liquidity, sell collected NVDA,
 * and retain the rest in its existing range. This is not a deployed policy. */
export async function simulateInventoryTrim(fork:PaperFork,policy:PaperExecutionPolicy,inventory:PaperExitInventory,
 market:SwapSource,onTransaction?:(tx:PaperTransaction)=>void){
 const {context,tokenId,position,fees,before}=await restorePaperPosition(fork,policy,inventory,onTransaction);
 const {local,sourceSlot,balances,send,approve,quoteSwap,swap,transactions}=context;
 const burned=position.liquidity/4n,remaining=position.liquidity-burned;assert(burned>0n);
 const exit=buildCanaryExit({operator:PAPER_ACCOUNT,owner:PAPER_ACCOUNT,tokenId,
  source:{rwaSymbol:'NVDA',rwaAddress:PAPER_NVDA as Address,fee:500,token0:USDG,token1:PAPER_NVDA as Address},
  position:{...position,liquidity:burned},sqrtPriceX96:sourceSlot[0],blockTimestamp:fork.source.timestamp,slippageBps:policy.maxSlippageBps,ttlSeconds:policy.transactionTtlSeconds});
 const removed=await send('trim_and_collect',NONFUNGIBLE_POSITION_MANAGER,exit.calldata),released=decodeCanaryExit(removed.returnData);
 assert.equal(released.decreased0,exit.expectedPrincipal0);assert.equal(released.decreased1,exit.expectedPrincipal1);
 assert.equal(released.collected0-released.decreased0,fees[0]);assert.equal(released.collected1-released.decreased1,fees[1]);
 const afterCollect=await balances();assert.equal(BigInt(afterCollect.quote),BigInt(before.quote)+released.collected0);assert.equal(BigInt(afterCollect.rwa),BigInt(before.rwa)+released.collected1);
 const amount=BigInt(afterCollect.rwa),quote=await quoteSwap(PAPER_NVDA as Address,USDG,amount);
 // The retained hypothetical LP must be added to depth for its own swap.
 const augmented={...market,liquidity:market.liquidity+(market.tick>=position.tickLower&&market.tick<position.tickUpper?remaining:0n),net:(tick:number)=>market.net(tick)+(tick===position.tickLower?remaining:tick===position.tickUpper?-remaining:0n)};
 const modeled=historicalSwapQuote(augmented,amount,1);assert(modeled.fullyFilled&&modeled.passesSlippage);assert.equal(String(modeled.amountOut),quote.amountOut);
 await approve(PAPER_NVDA as Address,PAPER_ROUTER,amount,'approve_trim_swap');const trade=await swap('trim_sell_nvda',PAPER_NVDA as Address,USDG,quote);
 const after=await balances(),slot=await local.readContract({address:PAPER_POOL as Address,abi:poolAbi,functionName:'slot0'});
 assert.equal(slot[0],modeled.sqrtPriceAfter);assert.equal(after.rwa,'0');assert.equal(BigInt(after.quote),BigInt(afterCollect.quote)+modeled.amountOut);
 const retained=await readCanaryPosition(local,tokenId,await local.getBlockNumber({cacheTime:0}));assert.equal(retained.liquidity,remaining);
 const principalAfter=positionAmounts(slot[0],position,remaining,false);
 assert.equal(BigInt(before.native)-BigInt(after.native),transactions.reduce((n,t)=>n+BigInt(t.localGasUsed)*BigInt(t.localEffectiveGasPriceWei),0n));
 const source=await fork.read('eth_getBlockByNumber',[fork.blockTag,false]) as {hash:string};assert.equal(source.hash.toLowerCase(),fork.source.hash.toLowerCase());
 return {scope:'historical_inventory_trim_local_fork',executionEligible:false,broadcastAuthorized:false,computedAt:new Date().toISOString(),
  source:{block:String(fork.source.number),hash:fork.source.hash,timestamp:String(fork.source.timestamp)},policy,inventory,burnedLiquidity:String(burned),remainingLiquidity:String(remaining),principalAfter,priceAfter:String(slot[0]),trade,balances:{before,afterCollect,after},transactions,
  totalGasWei:String(transactions.reduce((n,t)=>n+BigInt(t.estimate.totalFeeWei),0n)),upstream:fork.budget,
  limitations:['Single 25 percent trim proof; no optimal threshold or future fee benefit claim','Retained LP can earn marginal fees on its own sale; these are not realized in principalAfter','Owned historical fork and Nitro estimates; no mainnet receipt']};
}
