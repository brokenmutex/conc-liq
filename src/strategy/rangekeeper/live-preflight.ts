import assert from 'node:assert/strict';
import {nonfungiblePositionManagerReadAbi} from '../../nft/abi.js';
import type {RobinhoodClient} from '../../client.js';
import type {RangeKeeperConfig} from './config.js';
import {RangeKeeperChain} from './chain.js';
import {readRangeKeeperReferences} from './reference.js';
import {allocateRangeKeeperFunding} from './funding.js';
import {initialRangeKeeperState} from './config.js';
import {planRangeKeeper,rawValue} from './planner.js';
import {rangeKeeperCostEnvelope} from './cost.js';
import {simulateRangeKeeperCandidate} from './fork-simulator.js';
import {verifyRangeKeeperWalletCode} from './wallet-code.js';

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const min=(a:bigint,b:bigint)=>a<b?a:b;
export async function rangeKeeperConfirmedSource(client:RobinhoodClient,depth=64){
 const latest=await client.getBlock();assert(latest.number>BigInt(depth));
 const block=await client.getBlock({blockNumber:latest.number-BigInt(depth)});
 const age=Math.floor(Date.now()/1000)-Number(block.timestamp);
 assert(age>=0&&age<=180,'Confirmed source is stale or ahead of local clock');
 return {block:block.number,hash:block.hash,timestamp:Number(block.timestamp)};
}

/** Read-only launch proof. All old NFT IDs are checked at the same canonical
 * block; a count alone cannot rule out an unknown active NFT. */
export async function inspectRangeKeeperLaunch(input:{client:RobinhoodClient;config:RangeKeeperConfig;buildId:string;
 rpcUrl:string;anvilBinary:string;simulateFork:boolean}){
 const {client,config}=input,p=config.pool,operator=config.operator;
 assert(operator,'Launch profile needs an operator');
 const chain=new RangeKeeperChain(client,p,config.zeroAllowances),source=await rangeKeeperConfirmedSource(client);
 await chain.verify(source);
 await verifyRangeKeeperWalletCode(client,source,operator,config);
 const wallet=await chain.snapshot(source,operator,null);
 assert.equal(wallet.nftCount,BigInt(config.legacyRetiredTokenIds.length),'Unknown NFT ownership at launch');
 for(const id of config.legacyRetiredTokenIds){
  const tokenId=BigInt(id);
  const [owner,position]=await Promise.all([
   client.readContract({address:p.positionManager,abi:nonfungiblePositionManagerReadAbi,functionName:'ownerOf',args:[tokenId],blockNumber:source.block}),
   client.readContract({address:p.positionManager,abi:nonfungiblePositionManagerReadAbi,functionName:'positions',args:[tokenId],blockNumber:source.block}),
  ]);
  assert(same(owner,operator)&&position[7]===0n&&position[10]===0n&&position[11]===0n,
   `Legacy NFT ${id} has unresolved custody`);
 }
 assert(wallet.allowances.every(a=>a.amount===0n),'Pre-existing approval must be reconciled');
 const pendingNonce=await client.getTransactionCount({address:operator,blockTag:'pending'});
 assert.equal(pendingNonce,wallet.nonce,'Unresolved pending wallet nonce');
 const refs=await readRangeKeeperReferences(client,source,config);
 assert(refs.eligible&&refs.price0&&refs.price1&&refs.nativePrice,
  `Independent reference unavailable: ${refs.reasons.join(',')}`);
 const nativeCapRaw=config.nativeFundingValue*10n**18n/refs.nativePrice;
 const funding=allocateRangeKeeperFunding(config,
  {wallet0:wallet.wallet0,wallet1:wallet.wallet1,nativeWei:wallet.nativeWei,
   price0:refs.price0,price1:refs.price1,nativePrice:refs.nativePrice},
  {amount0:wallet.wallet0,amount1:wallet.wallet1,nativeWei:min(wallet.nativeWei,nativeCapRaw)});
 const latest=await client.getBlock();assert(latest.baseFeePerGas&&latest.baseFeePerGas>0n);
 const marketGasPriceWei=await client.getGasPrice();assert(marketGasPriceWei>0n);
 const quote=(token:0|1,amount:bigint)=>chain.quote(source,token,amount,refs.price0!,refs.price1!);
 const equity=funding.bookedStrategyValue;
 const baseObservation={block:source.block,hash:source.hash,timestamp:source.timestamp,tick:wallet.tick,
  sqrtPriceX96:wallet.sqrtPriceX96,continuity:'canonical' as const,wallet0:funding.allocation.amount0,
  wallet1:funding.allocation.amount1,released0:0n,released1:0n,nativeWei:funding.allocation.nativeWei,
  requiredExitReserveWei:config.limits.exitReserveWei,price0:refs.price0,price1:refs.price1,nativePrice:refs.nativePrice,
  position:null,pending:false,entryAllowed:true,safeExitRequired:false,executionReady:wallet.unlocked,
  liquiditySharePpm:0,actionCost:config.limits.maxActionCost,actionGasWei:0n,
  reservedCost:0n,rollingSpentCost:0n,campaignSpentCost:0n,campaignStartValue:equity,
  highWaterValue:equity,recenters:0};
 const planInput={state:initialRangeKeeperState(config,input.buildId),observation:baseObservation,
  limits:config.limits,spacing:p.tickSpacing,decimals0:p.decimals0,decimals1:p.decimals1,quoteToken:p.quoteToken,
  maxPoolDeviationPpm:config.referencePolicy.maxPoolDeviationPpm,quote,simulate:async()=>true};
 const preview=await planRangeKeeper(planInput);
 assert(preview.candidate,`No current feasible entry: ${preview.reason}`);
 const candidate=preview.candidate;
 const envelope=rangeKeeperCostEnvelope({candidate,limits:config.limits,baseFeePerGasWei:latest.baseFeePerGas,
  marketGasPriceWei,nativePriceValue:refs.nativePrice,existingPosition:false,poolAddress:p.pool});
 const share=candidate.liquidity*1_000_000n/(wallet.poolLiquidity+candidate.liquidity);
 assert(share<=BigInt(config.limits.maxLiquiditySharePpm),'Candidate LP share exceeds configured limit');
 const final=await planRangeKeeper({...planInput,observation:{...baseObservation,
  actionCost:envelope.actionCostValue,actionGasWei:envelope.actionGasWei,
  requiredExitReserveWei:envelope.requiredExitReserveWei,liquiditySharePpm:Number(share)},
  simulate:async frozen=>{
   if(!input.simulateFork)return true;
   await simulateRangeKeeperCandidate({rpcUrl:input.rpcUrl,anvilBinary:input.anvilBinary,source,
    pool:p,limits:config.limits,operator,candidate:frozen,activeTokenId:null,
    prices:{price0:refs.price0!,price1:refs.price1!}});return true;
  }});
 assert(final.candidate,`Candidate admission failed: ${final.reason}`);
 // Two economic actions are entry and one recenter. This funds both plus the
 // separate full-exit reserve; a 20% native margin absorbs modest fee drift.
 const recenterGasWei=(envelope.actionGasUnits+300_000n)*envelope.maxFeePerGasWei;
 const scopeGasWei=envelope.actionGasWei+(config.campaignScope.maxEconomicActions>1?recenterGasWei:0n);
 const nativeRequiredWei=envelope.requiredExitReserveWei+(scopeGasWei*6n+4n)/5n;
 const nativeShortfallWei=nativeRequiredWei>funding.allocation.nativeWei?nativeRequiredWei-funding.allocation.nativeWei:0n;
 const latestConfirmed=await client.getBlock({blockNumber:source.block});
 assert(same(latestConfirmed.hash,source.hash),'Preflight source reorged');
 return {source,operator,pool:p.pool,wallet,funding,reference:refs,candidate,envelope,
  preflightReason:final.reason,liquiditySharePpm:Number(share),nativeRequiredWei,nativeShortfallWei,
  strategyInventoryValue:rawValue(wallet.wallet0,refs.price0,p.decimals0)+rawValue(wallet.wallet1,refs.price1,p.decimals1),
  forkSimulated:input.simulateFork};
}
