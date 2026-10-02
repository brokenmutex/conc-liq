import assert from 'node:assert/strict';
import {decodeFunctionResult,type Address,type Hash} from 'viem';
import {createRobinhoodClient} from '../client.js';
import {poolAbi} from '../abi.js';
import {guardedCanaryPositionManagerAbi} from '../canary-plan/abi.js';
import {readCanaryPosition} from '../canary-plan/exit.js';
import {principalAmounts} from '../backtest/principal.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {encodeRangeKeeperTx,type RangeKeeperTxPlan} from '../strategy/rangekeeper/calldata.js';
import type {RangeKeeperCandidate,RangeKeeperLimits} from '../strategy/rangekeeper/domain.js';
import {readRangeKeeperReferences} from '../strategy/rangekeeper/reference.js';
import {openPaperFork} from '../paper/fork.js';
import {simulatePaperTransaction,type PaperTransaction} from '../paper/execution-gas.js';
import {PAPER_ACCOUNT,paperRouterAbi,paperTokenAbi} from '../paper/execution-abi.js';
import {USDG} from '../constants.js';
import {restorePaperPosition} from '../paper/execution-exit.js';
import {replayPaperMint} from '../v3/position-math.js';
import {contentHash} from './contracts.js';
import {referenceProofHash} from './market-profile.js';
import type {PaperOpenFrame} from './paper-preview.js';
import type {RangeKeeperPaperRecenterSnapshot} from './rangekeeper-paper-recenter-model.js';
import {parseRangeKeeperPaperCandidate} from './rangekeeper-paper-persistence.js';
import {rangeKeeperPaperCandidateHash} from './rangekeeper-paper-cost.js';
import {assertRangeKeeperTerminalReferenceMatch,rangeKeeperPaperTerminalAllowances,
 rangeKeeperPaperWithdrawalMinimum} from './rangekeeper-paper-gas-sampler.js';

export interface RangeKeeperPaperRecenterSimulation {
 status:'matched';source:PaperOpenFrame['source'];candidateHash:string;simulationHash:string;allowancesCleared:true;
 withdrawal:{amount0:string;amount1:string};collected:{amount0:string;amount1:string};
 swap:null|{token:0|1;amountIn:string;quotedOut:string;minOut:string;amountOut:string;
  priceAfter:string;feeValue:string;shortfallValue:string;source:PaperOpenFrame['source']};
 inventory:{position:{tickLower:number;tickUpper:number;liquidity:string};idle:{token0:string;token1:string}};
 mintSqrtPriceX96:string;fundingBeforeSwap:{token0:string;token1:string};
 modeledCosts:{status:'provisional';expectedValue:string;boundValue:string;expectedWei:string;
  boundWei:string;requiredReserveWei:string;marketGasPriceWei:string;gasPriceBoundWei:string};stages:readonly PaperTransaction[];
}
const simulations=new WeakMap<object,string>();
export function assertRangeKeeperPaperRecenterSimulation(value:unknown):asserts value is RangeKeeperPaperRecenterSimulation {
 assert(value&&typeof value==='object'&&simulations.get(value)===contentHash(value),
  'rangekeeper_paper_recenter_simulation_capability_invalid');
}
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;

/** Executes only on an owned, source-pinned local fork. The immutable opening
 * model remains the baseline; the latest epoch supplies all spendable tokens. */
export async function simulateRangeKeeperPaperRecenter(input:{snapshot:RangeKeeperPaperRecenterSnapshot;
 frame:PaperOpenFrame;candidate:RangeKeeperCandidate;policyLimits:RangeKeeperLimits;rpcUrl:string;
 marketGasPriceWei:bigint;beforeRead?:()=>Promise<void>}):Promise<RangeKeeperPaperRecenterSimulation>{
 const {snapshot,frame,candidate:c,policyLimits:limits}=input,draft=snapshot.draft,p=draft.profile.pool,
  previous=snapshot.previousMark,old=parseRangeKeeperPaperCandidate(previous.candidate),
  inventory=previous.inventory as {position:{tickLower:number;tickUpper:number;liquidity:string};idle:{token0:string;token1:string}},
  kernel=previous.kernelSnapshot as {nativeWei:string};
 assert(!snapshot.pending&&snapshot.currentEpoch===previous.epoch&&c.kind==='recenter');
 assert.equal(p.chainId,4663);assert(same(p.token0,USDG)||same(p.token1,USDG));
 assert(frame.referenceEligible&&frame.referenceProof&&frame.price0&&frame.price1&&frame.nativePrice&&
  referenceProofHash(frame.referenceProof)===frame.referenceProofHash,'Recenter reference unavailable');
 assert(c.sourceBlock===BigInt(frame.source.block)&&same(c.sourceHash,frame.source.hash)&&
  c.expiresAt===frame.source.timestamp+90,'Recenter candidate source mismatch');
 assert(old.liquidity===BigInt(inventory.position.liquidity)&&old.range.tickLower===inventory.position.tickLower&&
  old.range.tickUpper===inventory.position.tickUpper,'Recenter current position mismatch');
 assert(input.marketGasPriceWei>0n&&BigInt(kernel.nativeWei)>0n,'Recenter gas funding unavailable');
 const candidateHash=rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:draft.revision,
  profileHash:draft.profileHash,configHash:draft.configHash,source:frame.source,
  referenceProofHash:frame.referenceProofHash,candidate:c});
 const source={number:BigInt(frame.source.block),hash:frame.source.hash as Hash,timestamp:BigInt(frame.source.timestamp)},
  chainSource={block:source.number,hash:source.hash,timestamp:frame.source.timestamp},
  fork=await openPaperFork({source,rpcUrl:input.rpcUrl,beforeRead:input.beforeRead??(async()=>{}),
   maxRequests:2000,timeoutMs:300_000,deterministicClock:true});
 let stage='source_verification';
 try{
  const local=createRobinhoodClient(fork.localUrl,30_000,{retryCount:0}),chain=new RangeKeeperChain(local,p);
  await chain.verify(chainSource);
  assertRangeKeeperTerminalReferenceMatch(frame,await readRangeKeeperReferences(local,chainSource,draft.profile));
  const slot=await local.readContract({address:p.pool,abi:poolAbi,functionName:'slot0'}),
   liquidity=await local.readContract({address:p.pool,abi:poolAbi,functionName:'liquidity'});
  assert.equal(slot[0],frame.sqrtPriceX96);assert.equal(slot[1],frame.tick);assert.equal(liquidity,frame.poolLiquidity);
  const empty=await chain.snapshot(chainSource,PAPER_ACCOUNT,null);
  assert(empty.wallet0===0n&&empty.wallet1===0n&&empty.nftCount===0n&&empty.allowances.every(x=>x.amount===0n),
   'Recenter fixture account is not empty');
  let allowance={manager0:0n,manager1:0n,router0:0n,router1:0n};
  if(previous.epoch===0){
   const open=snapshot.openMark.model;
   const original=rangeKeeperPaperTerminalAllowances({candidate:old,fundingBeforeSwap:{token0:draft.allocation.token0Raw,token1:draft.allocation.token1Raw},
    mintSqrtPriceX96:old.swap?.priceAfter??BigInt(open.poolState.sqrtPriceX96),referencePrice0:BigInt(open.reference.price0!),
    referencePrice1:BigInt(open.reference.price1!),decimals0:p.decimals0,decimals1:p.decimals1,
    maxDeploymentValue:limits.maxDeploymentValue});
   assert.equal(original.idle0,BigInt(inventory.idle.token0));assert.equal(original.idle1,BigInt(inventory.idle.token1));
   allowance=original;
  }
  const allowances=[{token:p.token0,spender:p.positionManager,amount:String(allowance.manager0)},
   {token:p.token1,spender:p.positionManager,amount:String(allowance.manager1)},
   {token:p.token0,spender:p.router,amount:String(allowance.router0)},
   {token:p.token1,spender:p.router,amount:String(allowance.router1)}];
  stage='position_restoration';
  const restored=await restorePaperPosition(fork,{market:{symbol:'RangeKeeper',
   rwa:(same(p.token0,USDG)?p.token1:p.token0) as Address,pool:p.pool,fee:p.fee,tickSpacing:p.tickSpacing,
   rwaDecimals:same(p.token0,USDG)?p.decimals1:p.decimals0},budgetQuote:'10000000000',
   halfWidthSpacings:1,maxLiquiditySharePpm:10_000,maxSlippageBps:limits.maxSlippageBps,transactionTtlSeconds:300},
   {...inventory.position,idle0:inventory.idle.token0,idle1:inventory.idle.token1,fee0:'0',fee1:'0',
    allowances,nativeBalanceWei:kernel.nativeWei});
  const stages:PaperTransaction[]=[];
  const send=async(action:string,plan:RangeKeeperTxPlan)=>{
   const call=encodeRangeKeeperTx(p,PAPER_ACCOUNT,plan),tx=await simulatePaperTransaction(fork,
    {action,to:call.to,calldata:call.data},PAPER_ACCOUNT,{measuredGas:true});
   assert.equal(tx.sourceBlock,frame.source.block);assert(same(tx.sourceHash,frame.source.hash));stages.push(tx);return tx;
  };
  const balances=async()=>Promise.all([p.token0,p.token1].map(token=>local.readContract({address:token,
   abi:paperTokenAbi,functionName:'balanceOf',args:[PAPER_ACCOUNT]}))) as Promise<[bigint,bigint]>;
  const deadline=source.timestamp+300n;
  const withdraw=async(action:string,tokenId:bigint,position:{liquidity:bigint;tickLower:number;tickUpper:number},price:bigint)=>{
   const principal=principalAmounts({...position,sqrtPriceX96:price});
   await send(action,{kind:'withdraw',tokenId,liquidity:position.liquidity,
    min0:rangeKeeperPaperWithdrawalMinimum(principal.amount0,limits.maxSlippageBps),
    min1:rangeKeeperPaperWithdrawalMinimum(principal.amount1,limits.maxSlippageBps),deadline});return principal;
  };
  const cleanup=async(prefix:string)=>{
   for(const spender of ['router','positionManager'] as const)for(const token of [0,1] as const)
    await send(`${prefix}_${spender}_token${token}`,{kind:'approve',token,spender,amount:0n});
  };
  await fork.rpc('anvil_impersonateAccount',[PAPER_ACCOUNT]);
  stage='withdrawal';
  const principal=await withdraw('recenter_withdraw_collect',restored.tokenId,
   {liquidity:old.liquidity,...old.range},frame.sqrtPriceX96),funding=await balances();
  assert.equal(funding[0],BigInt(inventory.idle.token0)+principal.amount0);
  assert.equal(funding[1],BigInt(inventory.idle.token1)+principal.amount1);
  const available=[...funding] as [bigint,bigint];
  let swap:RangeKeeperPaperRecenterSimulation['swap']=null;
  if(c.swap){
   stage='swap_quote';
   const s=c.swap,q=await chain.quote(chainSource,s.token,s.amountIn,frame.price0,frame.price1);
   assert.equal(q.amountOut,s.quotedOut);assert.equal(q.priceAfter,s.priceAfter);
   assert.equal(q.feeValue,s.feeValue);assert.equal(q.shortfallValue,s.shortfallValue);
   assert(s.amountIn>0n&&available[s.token]>=s.amountIn&&s.shortfallValue<=limits.maxSwapShortfallValue);
   assert.equal(s.minOut,s.quotedOut*(10_000n-BigInt(limits.maxSlippageBps))/10_000n);
   stage='swap';
   await send('recenter_swap_approve',{kind:'approve',token:s.token,spender:'router',amount:s.amountIn});
   const tx=await send('recenter_swap',{kind:'swap',token:s.token,amountIn:s.amountIn,minOut:s.minOut,deadline}),
    returns=decodeFunctionResult({abi:paperRouterAbi,functionName:'multicall',data:tx.returnData});
   assert.equal(returns.length,1);assert.equal(decodeFunctionResult({abi:paperRouterAbi,
    functionName:'exactInputSingle',data:returns[0]!}),s.quotedOut);
   available[s.token]-=s.amountIn;available[s.token===0?1:0]+=s.quotedOut;
   assert.deepEqual(await balances(),available);
   swap={token:s.token,amountIn:String(s.amountIn),quotedOut:String(s.quotedOut),minOut:String(s.minOut),
    amountOut:String(s.quotedOut),priceAfter:String(s.priceAfter),feeValue:String(s.feeValue),
    shortfallValue:String(s.shortfallValue),source:frame.source};
  }
  stage='mint';
  const mintPrice=c.swap?.priceAfter??frame.sqrtPriceX96,
   mint=replayPaperMint(mintPrice,c.range,c.amount0Desired,c.amount1Desired,0n);
  assert.equal((await local.readContract({address:p.pool,abi:poolAbi,functionName:'slot0'}))[0],mintPrice);
  assert.equal(mint.liquidity,c.liquidity);assert(c.amount0Desired<=available[0]&&c.amount1Desired<=available[1]);
  for(const token of [0,1] as const)await send(`recenter_mint_approve_token${token}`,{kind:'approve',token,
   spender:'positionManager',amount:token===0?c.amount0Desired:c.amount1Desired});
  const minted=await send('recenter_mint',{kind:'mint',candidate:c,deadline}),
   [tokenId,newLiquidity,amount0,amount1]=decodeFunctionResult({abi:guardedCanaryPositionManagerAbi,
    functionName:'mint',data:minted.returnData});
  assert.equal(newLiquidity,c.liquidity);assert.equal(amount0,mint.amount0);assert.equal(amount1,mint.amount1);
  const idle=await balances();assert.equal(idle[0],available[0]-amount0);assert.equal(idle[1],available[1]-amount1);
  stage='result_inventory';
  await cleanup('recenter_cleanup');
  const snapshotNow=async()=>{const block=await local.getBlock({blockTag:'latest'});return chain.snapshot({
   block:block.number,hash:block.hash,timestamp:Number(block.timestamp)},PAPER_ACCOUNT,tokenId);};
  const end=await snapshotNow();assert.equal(end.nftCount,2n);assert(end.allowances.every(x=>x.amount===0n));
  assert.equal(end.position?.liquidity,c.liquidity);assert.equal(end.position.tickLower,c.range.tickLower);
  assert.equal(end.position.tickUpper,c.range.tickUpper);
  const oldPosition=await readCanaryPosition(local,restored.tokenId,end.source.block);
  assert(same(oldPosition.owner,PAPER_ACCOUNT)&&oldPosition.liquidity===0n&&
   oldPosition.tokensOwed0===0n&&oldPosition.tokensOwed1===0n);
  stage='exit_reserve';
  const actionStageCount=stages.length;
  const reservePrincipal=await withdraw('reserve_withdraw_collect',tokenId,{liquidity:c.liquidity,...c.range},mintPrice);
  await cleanup('reserve_cleanup');
  const reserveEnd=await snapshotNow();assert.equal(reserveEnd.nftCount,2n);
  assert(reserveEnd.allowances.every(x=>x.amount===0n)&&reserveEnd.position?.liquidity===0n&&
   reserveEnd.position.tokensOwed0===0n&&reserveEnd.position.tokensOwed1===0n);
  assert.equal(reserveEnd.wallet0,idle[0]+reservePrincipal.amount0);
  assert.equal(reserveEnd.wallet1,idle[1]+reservePrincipal.amount1);
  const pinned=await fork.read('eth_getBlockByNumber',[fork.blockTag,false]) as {hash:string};
  assert(same(pinned.hash,source.hash),'Recenter source changed during simulation');
  stage='cost_bounds';
  const gas=(rows:readonly PaperTransaction[])=>rows.reduce((sum,row)=>sum+BigInt(row.estimate.gas),0n),
   boundGas=(rows:readonly PaperTransaction[])=>rows.reduce((sum,row)=>sum+ceil(BigInt(row.estimate.gas)*13n,10n),0n),
   action=stages.slice(0,actionStageCount),reserve=stages.slice(actionStageCount),price=input.marketGasPriceWei,
   boundPrice=ceil(price*5n,4n),expectedWei=gas(action)*price,boundWei=boundGas(action)*boundPrice,
   reserveWei=boundGas(reserve)*boundPrice,requiredReserveWei=reserveWei>limits.exitReserveWei?reserveWei:limits.exitReserveWei,
   swapCost=(c.swap?.feeValue??0n)+(c.swap?.shortfallValue??0n);
  assert(BigInt(kernel.nativeWei)>=boundWei+requiredReserveWei,'Recenter would consume exit reserve');
  const transition={source:frame.source,candidateHash,priorMarkHash:previous.markHash,allowancesCleared:true as const,
   withdrawal:{amount0:String(principal.amount0),amount1:String(principal.amount1)},
   collected:{amount0:String(principal.amount0),amount1:String(principal.amount1)},swap,
   inventory:{position:{...c.range,liquidity:String(c.liquidity)},idle:{token0:String(idle[0]),token1:String(idle[1])}},
   mintSqrtPriceX96:String(mintPrice),fundingBeforeSwap:{token0:String(funding[0]),token1:String(funding[1])}};
  const simulationHash=contentHash({...transition,stages:stages.map(row=>({action:row.action,to:row.to,
   calldata:row.calldata,returnData:row.returnData,gas:row.estimate.gas}))});
  const result:RangeKeeperPaperRecenterSimulation={status:'matched',...transition,simulationHash,stages,
   modeledCosts:{status:'provisional',expectedValue:String(ceil(expectedWei*frame.nativePrice,10n**18n)+swapCost),
    boundValue:String(ceil(boundWei*frame.nativePrice,10n**18n)+swapCost),expectedWei:String(expectedWei),
    boundWei:String(boundWei),requiredReserveWei:String(requiredReserveWei),
    marketGasPriceWei:String(price),gasPriceBoundWei:String(boundPrice)}};
  simulations.set(result,contentHash(result));return result;
 }catch(error){
  const code=`rangekeeper_paper_recenter_${stage}_failed`;
  throw Object.assign(new Error(code,{cause:error}),{code});
 }finally{await fork.close();}
}
