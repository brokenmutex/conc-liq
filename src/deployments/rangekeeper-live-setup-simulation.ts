import assert from 'node:assert/strict';
import type {Address,Hex} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {simulateRangeKeeperCandidate} from '../strategy/rangekeeper/fork-simulator.js';
import type {RangeKeeperCandidate,RangeKeeperLimits} from '../strategy/rangekeeper/domain.js';
import {contentHash} from './contracts.js';
import type {MarketProfile} from './market-profile.js';
import type {PaperOpenFrame} from './paper-preview.js';

export interface LiveSetupSimulationRequest {
 profile:MarketProfile;source:PaperOpenFrame['source'];operator:Address;
 candidate:RangeKeeperCandidate;allocation:{token0Raw:string;token1Raw:string;nativeWei:string};
 limits:RangeKeeperLimits;prices:{price0:bigint;price1:bigint;nativePrice:bigint};
 baseFeePerGasWei:bigint;marketGasPriceWei:bigint;
}
const normalized=(value:unknown)=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v));
export const liveSetupEvidenceHash=(value:unknown)=>contentHash(normalized(value));
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;

/** Measure entry costs and gas for a complete conversion exit at one source.
 * Exit conversion fees and price shortfall are not included in entry cost.
 * Local native funding enables measurement; canonical gas availability is
 * checked separately by preflight and never inferred from the local fork. */
export function buildLiveSetupSimulationEvidence(request:LiveSetupSimulationRequest,
 report:Awaited<ReturnType<typeof simulateRangeKeeperCandidate>>){
 assert.equal(report.source.block.toString(),request.source.block);
 assert.equal(report.source.hash.toLowerCase(),request.source.hash.toLowerCase());
 assert.equal(report.source.timestamp,request.source.timestamp);
 assert(report.createdTokenId&&report.createdTokenId>0n,'Fork mint receipt is missing');
 assert(request.baseFeePerGasWei>0n&&request.marketGasPriceWei>0n&&request.prices.nativePrice>0n);
 const stages=report.gasByStage;
 assert(stages.some(s=>s.phase==='entry'&&s.kind==='mint')&&
  stages.some(s=>s.phase==='exit'&&s.kind==='withdraw'),'Complete fork lifecycle is missing');
 assert(stages.every(s=>['entry','exit'].includes(s.phase)&&['approve','swap','mint','withdraw'].includes(s.kind)&&
  s.gasUsed>0n&&s.gasUsed<=8_000_000n),'Fork gas stages are invalid');
 const maxFeePerGasWei=ceil((request.baseFeePerGasWei>request.marketGasPriceWei?
  request.baseFeePerGasWei:request.marketGasPriceWei)*5n,4n);
 const gasByStage=stages.map(s=>{const estimate=s.estimatedGas??s.gasUsed;
  assert(estimate>0n&&estimate<=8_000_000n,'Fork gas estimate is invalid');
  return {phase:s.phase,kind:s.kind,gasUsed:String(s.gasUsed),estimatedGas:String(estimate),
   gasUnitsBound:String(ceil((estimate>s.gasUsed?estimate:s.gasUsed)*13n,10n))};});
 const units=(phase:'entry'|'exit')=>gasByStage.filter(s=>s.phase===phase)
  .reduce((n,s)=>n+BigInt(s.gasUnitsBound),0n);
 const actionGasWei=units('entry')*maxFeePerGasWei,completeExitGasWei=units('exit')*maxFeePerGasWei,
  exitReserveWei=completeExitGasWei>request.limits.exitReserveWei?completeExitGasWei:request.limits.exitReserveWei;
 const swap=request.candidate.swap;
 assert(!swap||swap.feeValue>=0n&&swap.shortfallValue>=0n);
 const estimatedCostValue=ceil(actionGasWei*request.prices.nativePrice,10n**18n)+
  (swap?swap.feeValue+swap.shortfallValue:0n);
 const candidateHash=liveSetupEvidenceHash(request.candidate),profileHash=contentHash(request.profile),
  allocationHash=contentHash(request.allocation),limitsHash=liveSetupEvidenceHash(request.limits);
 const binding={source:request.source,operator:request.operator.toLowerCase(),profileHash,candidateHash,
  allocationHash,limitsHash,gasByStage,createdTokenId:String(report.createdTokenId)};
 return {status:'success' as const,source:request.source,candidateHash,profileHash,allocationHash,limitsHash,
  sequenceHash:contentHash(binding),gasByStage,maxFeePerGasWei:String(maxFeePerGasWei),
  actionGasWei:String(actionGasWei),completeExitGasWei:String(completeExitGasWei),
  estimatedCostValue:String(estimatedCostValue),exitReserveWei:String(exitReserveWei),
  provenance:'owned_fork_allocated_lifecycle_v1' as const,syntheticNativeFunding:true as const};
}

/** Main-chain dependency has only canonical reads; all transactions occur in
 * a disposable owned fork without loading any key or publishing client. */
export async function simulateLiveSetupCandidate(request:LiveSetupSimulationRequest,deps:{
 client:RobinhoodClient;rpcUrl:string;anvilBinary:string;
 runFork?:typeof simulateRangeKeeperCandidate;
}){
 const verify=async()=>{
  const [chainId,latest,pinned]=await Promise.all([deps.client.getChainId(),deps.client.getBlock(),
   deps.client.getBlock({blockNumber:BigInt(request.source.block)})]);
  assert.equal(chainId,request.profile.pool.chainId,'Fork review chain changed');
  assert(latest.number>=BigInt(request.source.block)+64n,'Fork review source is not confirmed');
  assert.equal(pinned.hash.toLowerCase(),request.source.hash.toLowerCase(),'Fork review source changed');
  assert.equal(Number(pinned.timestamp),request.source.timestamp);
 };
 await verify();
 const report=await (deps.runFork??simulateRangeKeeperCandidate)({rpcUrl:deps.rpcUrl,
  anvilBinary:deps.anvilBinary,source:{block:BigInt(request.source.block),hash:request.source.hash as Hex,
   timestamp:request.source.timestamp},pool:request.profile.pool,limits:request.limits,
  operator:request.operator,candidate:request.candidate,activeTokenId:null,
  prices:request.prices,allocation:{amount0:BigInt(request.allocation.token0Raw),
   amount1:BigInt(request.allocation.token1Raw)},
  rehearseExit:{maxPoolDeviationPpm:request.profile.referencePolicy.maxPoolDeviationPpm}});
 await verify();
 return buildLiveSetupSimulationEvidence(request,report);
}
