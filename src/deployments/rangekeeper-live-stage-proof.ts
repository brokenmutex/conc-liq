import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPublicClient,http,type Hex} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {robinhoodChain} from '../constants.js';
import {openPaperFork} from '../paper/fork.js';
import {RangeKeeperChain,type RangeKeeperSource} from '../strategy/rangekeeper/chain.js';
import {rangeKeeperConfigHash,type RangeKeeperConfig} from '../strategy/rangekeeper/config.js';
import {authorizeRangeKeeperTx,encodeRangeKeeperTx,type RangeKeeperTxPlan} from '../strategy/rangekeeper/calldata.js';
import {mintedRangeKeeperTokenId,reconcileRangeKeeperAction} from '../strategy/rangekeeper/live-reconcile.js';
import type {RangeKeeperSnapshot} from '../strategy/rangekeeper/live-domain.js';
import {verifyRangeKeeperWalletCode} from '../strategy/rangekeeper/wallet-code.js';
import type {RangeKeeperWalletCampaignAllocation} from './rangekeeper-live-wallet-reconcile.js';
import {liveSetupEvidenceHash} from './rangekeeper-live-setup-simulation.js';

export interface RangeKeeperLiveStageProofRequest {
 campaignId:string;allocationId:string;revision:number;stage:string;buildId:string;
 profileHash:string;allocationHash:string;config:RangeKeeperConfig;source:RangeKeeperSource;
 plan:RangeKeeperTxPlan;beforePool:RangeKeeperSnapshot;allocation:RangeKeeperWalletCampaignAllocation;
 prices:{price0:bigint;price1:bigint;nativePrice:bigint};referenceProofHash:string;futureApprovalCap?:bigint;
 /** persistent_capped_v1: per-token raw ceiling an approval may reach (5x the initiating campaign's exposure). */
 allowanceCeiling?:readonly [bigint,bigint];
 /** True only for a retained close whose persisted campaign state is exit/stopped/retain. */
 exitSpendAllowed?:boolean;
}
export interface RangeKeeperLiveStageEvidence {
 schemaVersion:1;kind:'rangekeeper_live_owned_stage_v1';status:'success';
 campaignId:string;allocationId:string;revision:number;stage:string;buildId:string;
 source:{block:string;hash:Hex;timestamp:number};profileHash:string;allocationHash:string;
 configHash:string;referenceProofHash:string;planHash:string;calldataHash:string;beforeHash:string;requestHash:string;
 exitSpendAllowed:boolean;
 nonce:number;gasUsed:string;gasUnitsBound:string;maxFeePerGasWei:string;priorityFeePerGasWei:'0';
 stageGasWei:string;costValue:string;forkReceiptHash:string;evidenceHash:string;
 syntheticNativeFunding:true;expiresAt:number;
}
export interface RangeKeeperLiveStageProof {
 readonly kind:'rangekeeper_verified_live_stage_proof';readonly evidence:Readonly<RangeKeeperLiveStageEvidence>;
}
const proofs=new WeakMap<object,{requestHash:string;evidence:Readonly<RangeKeeperLiveStageEvidence>}>();
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const address=(a:string)=>a.toLowerCase();

function assertRequest(r:RangeKeeperLiveStageProofRequest){
 assert(r.config.operator&&same(r.config.operator,r.beforePool.operator));
 assert(r.config.broadcastEnabled===false&&r.config.signer===null,'Stage proof cannot contain a signing configuration');
 assert(r.campaignId===r.allocation.campaignId&&Number.isSafeInteger(r.revision)&&r.revision>0);
 assert(/^[A-Za-z0-9._:-]{1,64}$/.test(r.stage));
 for(const h of [r.buildId,r.profileHash,r.allocationHash,r.referenceProofHash])assert(/^[0-9a-f]{64}$/.test(h));
 assert(r.source.block===r.beforePool.source.block&&same(r.source.hash,r.beforePool.source.hash)&&
  r.source.timestamp===r.beforePool.source.timestamp,'Stage before image source differs');
 assert(r.prices.price0>0n&&r.prices.price1>0n&&r.prices.nativePrice>0n);
 const p=r.config.pool,allocation=r.allocation;
 const amount0=allocation.liquidByTokenAddress[address(p.token0)],amount1=allocation.liquidByTokenAddress[address(p.token1)];
 assert(amount0!==undefined&&amount1!==undefined&&amount0>=0n&&amount1>=0n&&
  amount0<=r.beforePool.wallet0&&amount1<=r.beforePool.wallet1,'Stage allocation exceeds canonical wallet tokens');
 if(r.exitSpendAllowed===true)assert(r.plan.kind==='withdraw'||r.plan.kind==='approve'&&r.plan.amount===0n,
  'Retained exit reserve is available only to withdraw/allowance-cleanup stages');
 assert(allocation.nativeSpendWei>=0n&&allocation.exitReserveWei>=0n&&
  allocation.nativeSpendWei+allocation.exitReserveWei<=r.beforePool.nativeWei,'Stage allocation exceeds canonical native');
 authorizeRangeKeeperTx(p,{operator:r.beforePool.operator,wallet0:amount0,wallet1:amount1,
  tick:r.beforePool.tick,sqrtPriceX96:r.beforePool.sqrtPriceX96,timestamp:r.source.timestamp,
  position:r.beforePool.position?{...r.beforePool.position,tokenId:r.beforePool.position.tokenId!}:null},r.plan,
  r.config.limits.maxSlippageBps,r.config.limits.fullWidthSpacings,r.futureApprovalCap??0n,r.allowanceCeiling);
}

/** Evidence construction is public for auditing/tests. This alone has no
 * authority: only the owned-fork runner can issue a branded capability. */
export function buildRangeKeeperLiveStageEvidence(r:RangeKeeperLiveStageProofRequest,measurement:{
 gasUsed:bigint;estimatedGas:bigint;baseFeePerGasWei:bigint;marketGasPriceWei:bigint;
 forkReceiptHash:string;now?:number;
}):RangeKeeperLiveStageEvidence{
 assertRequest(r);
 assert(measurement.gasUsed>0n&&measurement.gasUsed<=8_000_000n&&
  measurement.estimatedGas>0n&&measurement.estimatedGas<=8_000_000n);
 assert(measurement.baseFeePerGasWei>0n&&measurement.marketGasPriceWei>0n);
 assert(/^0x[0-9a-fA-F]{64}$/.test(measurement.forkReceiptHash));
 const units=ceil((measurement.gasUsed>measurement.estimatedGas?measurement.gasUsed:measurement.estimatedGas)*13n,10n);
 assert(units<=8_000_000n,'Stage padded gas exceeds bounded transaction size');
 const fee=ceil((measurement.baseFeePerGasWei>measurement.marketGasPriceWei?
  measurement.baseFeePerGasWei:measurement.marketGasPriceWei)*5n,4n),gasWei=units*fee;
 const gasLimit=r.allocation.nativeSpendWei+(r.exitSpendAllowed===true?r.allocation.exitReserveWei:0n);
 assert(gasWei<=gasLimit,r.exitSpendAllowed===true?'Retained close exceeds its scoped native allocation':
  'Stage would invade reserved exit gas');
 let swapCost=0n;
 if(r.plan.kind==='swap'){
  const p=r.config.pool,plan=r.plan;
  const input=plan.amountIn*(plan.token===0?r.prices.price0:r.prices.price1)/10n**BigInt(plan.token===0?p.decimals0:p.decimals1);
  const output=plan.minOut*(plan.token===0?r.prices.price1:r.prices.price0)/10n**BigInt(plan.token===0?p.decimals1:p.decimals0);
  const feeValue=input*BigInt(p.fee)/1_000_000n;
  const shortfall=input>output+feeValue?input-output-feeValue:0n;
  assert(shortfall<=r.config.limits.maxSwapShortfallValue,'Stage swap shortfall exceeds policy');
  swapCost=feeValue+shortfall;
 }
 const cost=ceil(gasWei*r.prices.nativePrice,10n**18n)+swapCost;
 // A retained exit is bounded by its scoped native allocation above, never by discretionary action budgets.
 if(r.exitSpendAllowed!==true)assert(cost<=r.config.limits.maxActionCost,'Stage cost exceeds reviewed action budget');
 const now=measurement.now??Date.now(),expiresAt=Math.min(now+90_000,
  (r.source.timestamp+r.config.limits.maxObservationGapSeconds)*1000);
 assert(expiresAt>now,'Stage canonical observation is stale');
 const body={schemaVersion:1 as const,kind:'rangekeeper_live_owned_stage_v1' as const,status:'success' as const,
  campaignId:r.campaignId,allocationId:r.allocationId,revision:r.revision,stage:r.stage,buildId:r.buildId,
  source:{block:String(r.source.block),hash:r.source.hash,timestamp:r.source.timestamp},
  profileHash:r.profileHash,allocationHash:r.allocationHash,configHash:rangeKeeperConfigHash(r.config).slice(2),
  exitSpendAllowed:r.exitSpendAllowed===true,
  referenceProofHash:r.referenceProofHash,planHash:liveSetupEvidenceHash(r.plan),
  calldataHash:liveSetupEvidenceHash(encodeRangeKeeperTx(r.config.pool,r.beforePool.operator,r.plan)),
  beforeHash:liveSetupEvidenceHash(r.beforePool),requestHash:liveSetupEvidenceHash(r),nonce:r.beforePool.nonce,
  gasUsed:String(measurement.gasUsed),gasUnitsBound:String(units),maxFeePerGasWei:String(fee),
  priorityFeePerGasWei:'0' as const,stageGasWei:String(gasWei),costValue:String(cost),
  forkReceiptHash:measurement.forkReceiptHash,syntheticNativeFunding:true as const,expiresAt};
 return {...body,evidenceHash:liveSetupEvidenceHash(body)};
}

/** Exact-call owned-fork evidence. The upstream dependency exposes only reads;
 * impersonation and all mutations terminate at the local isolated Anvil. */
export async function simulateRangeKeeperLiveStage(r:RangeKeeperLiveStageProofRequest,deps:{
 client:RobinhoodClient;rpcUrl:string;anvilBinary:string;
}):Promise<RangeKeeperLiveStageProof>{
 assertRequest(r);
 const frozen=structuredClone(r),requestHash=liveSetupEvidenceHash(frozen),p=frozen.config.pool;
 const verify=async()=>{
  const [chain,tip,header]=await Promise.all([deps.client.getChainId(),deps.client.getBlock(),
   deps.client.getBlock({blockNumber:frozen.source.block})]);
  assert(chain===4663&&tip.number>=frozen.source.block+64n&&same(header.hash,frozen.source.hash)&&
   Number(header.timestamp)===frozen.source.timestamp,'Stage canonical source changed or unconfirmed');
 };
 await verify();
 const chain=new RangeKeeperChain(deps.client,p,frozen.config.zeroAllowances);
 await chain.verify(frozen.source);
 await verifyRangeKeeperWalletCode(deps.client,frozen.source,frozen.beforePool.operator,frozen.config);
 const tokenId=frozen.beforePool.position?.tokenId??null;
 const actual=await chain.snapshot(frozen.source,frozen.beforePool.operator,tokenId);
 assert.equal(liveSetupEvidenceHash(actual),liveSetupEvidenceHash(frozen.beforePool),'Stage before image changed');
 assert.equal(await deps.client.getTransactionCount({address:actual.operator,blockTag:'pending'}),actual.nonce,
  'Stage wallet has an unresolved pending nonce');
 const [latest,marketFee]=await Promise.all([deps.client.getBlock(),deps.client.getGasPrice()]);
 assert(latest.baseFeePerGas&&latest.baseFeePerGas>0n&&marketFee>0n);
 const fork=await openPaperFork({source:{number:frozen.source.block,hash:frozen.source.hash,
  timestamp:BigInt(frozen.source.timestamp)},rpcUrl:deps.rpcUrl,anvilBinary:deps.anvilBinary,
  beforeRead:verify,deterministicClock:true,maxRequests:600,timeoutMs:120_000});
 try{
  const local=createPublicClient({chain:robinhoodChain,transport:http(fork.localUrl,{retryCount:0,timeout:15000})});
  assert(await local.getChainId()===4663);
  await fork.rpc('anvil_impersonateAccount',[actual.operator]);
  await fork.rpc('anvil_setBalance',[actual.operator,'0x56bc75e2d63100000']);
  const localChain=new RangeKeeperChain(local,p,frozen.config.zeroAllowances);
  const before=await localChain.snapshot(frozen.source,actual.operator,tokenId);
  const call=encodeRangeKeeperTx(p,actual.operator,frozen.plan);
  const estimatedGas=await local.estimateGas({account:actual.operator,to:call.to,data:call.data,value:0n});
  const fee=ceil((latest.baseFeePerGas>marketFee?latest.baseFeePerGas:marketFee)*5n,4n);
  const hash=await fork.rpc<Hex>('eth_sendTransaction',[{from:actual.operator,to:call.to,data:call.data,
   gas:'0x7a1200',maxFeePerGas:`0x${fee.toString(16)}`,maxPriorityFeePerGas:'0x0',value:'0x0'}]);
  const receipt=await local.waitForTransactionReceipt({hash});assert(receipt.status==='success','Owned fork stage reverted');
  const header=await local.getBlock({blockNumber:receipt.blockNumber});
  const afterId=frozen.plan.kind==='mint'?mintedRangeKeeperTokenId(p,actual.operator,receipt):tokenId;
  const after=await localChain.snapshot({block:header.number,hash:header.hash,timestamp:Number(header.timestamp)},actual.operator,afterId);
  const proof=reconcileRangeKeeperAction(p,{hash,plan:frozen.plan,before,intent:{id:randomUUID(),chainId:4663,
   operator:actual.operator,action:frozen.plan.kind,nonce:before.nonce,to:call.to,data:call.data,value:'0',
   gas:'8000000',maxFeePerGas:String(fee),maxPriorityFeePerGas:'0',sourceBlock:String(frozen.source.block),
   sourceHash:frozen.source.hash}},receipt,after);
  assert(proof.status==='success');
  for(const [wallet,token] of [[after.wallet0,p.token0],[after.wallet1,p.token1]] as const){
   const beforeBalance=same(token,p.token0)?actual.wallet0:actual.wallet1;
   assert(wallet>=beforeBalance-frozen.allocation.liquidByTokenAddress[address(token)]!,'Owned fork spent sibling tokens');
  }
  await verify();
  const evidence=buildRangeKeeperLiveStageEvidence(frozen,{gasUsed:receipt.gasUsed,estimatedGas,
   baseFeePerGasWei:latest.baseFeePerGas,marketGasPriceWei:marketFee,forkReceiptHash:receipt.transactionHash});
  assert(evidence.requestHash===requestHash);
  Object.freeze(evidence.source);Object.freeze(evidence);
  const capability=Object.freeze({kind:'rangekeeper_verified_live_stage_proof' as const,evidence});
  proofs.set(capability,{requestHash,evidence});return capability;
 }finally{await fork.close();}
}

/** Persisted JSON or caller-reported receipts never recreate this authority. */
export function consumeRangeKeeperLiveStageProof(capability:unknown,expected:RangeKeeperLiveStageProofRequest,
 options:{now?:()=>number}={}):Readonly<RangeKeeperLiveStageEvidence>{
 assert(capability&&typeof capability==='object','Owned stage capability unavailable');
 const proof=proofs.get(capability);assert(proof,'Owned stage capability absent or already consumed');
 assert(proof.requestHash===liveSetupEvidenceHash(expected),'Owned stage capability binding changed');
 assert((options.now??Date.now)()<proof.evidence.expiresAt,'Owned stage capability expired');
 proofs.delete(capability);return proof.evidence;
}
