import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import type {LiveJob,LiveOutbox,VerifiedQueueReceipt} from './live-wallet-queue.js';
import {contentHash} from './contracts.js';
import {liveSetupEvidenceHash} from './rangekeeper-live-setup-simulation.js';
import {appendRangeKeeperLiveCampaignEventInTransaction,readRangeKeeperLiveCampaign} from './rangekeeper-live-campaign-store.js';
import {parseRangeKeeperJson,type RangeKeeperLiveState,type RangeKeeperSnapshot} from '../strategy/rangekeeper/live-domain.js';
import type {RangeKeeperTxPlan} from '../strategy/rangekeeper/calldata.js';
import type {RangeKeeperConfig} from '../strategy/rangekeeper/config.js';
import {rawValue} from '../strategy/rangekeeper/planner.js';
import {degradeRangeKeeperConvertExitToRetain,isRangeKeeperConvertExit} from './rangekeeper-live-campaign.js';

type Source={block:string;hash:string;timestamp:number};
type StoredReceipt={receipt:any;receiptHash:string;proofHash:string;source:Source};
type StoredEffects={proofHash:string;receiptHash:string;effects:any;source:Source;nonce:number|string;gasWei:string;afterWallet:any;afterPool:unknown;
 referenceValuation?:any;positionFeeEvidence?:any};
const lower=(s:string)=>s.toLowerCase();
const address=(s:unknown)=>typeof s==='string'&&/^0x[0-9a-fA-F]{40}$/.test(s);
const decimal=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v);
const hash64=(v:unknown)=>typeof v==='string'&&/^(0x)?[0-9a-fA-F]{64}$/.test(v);
const sameSource=(a:any,b:any)=>String(a?.block)===String(b?.block)&&String(a?.hash).toLowerCase()===String(b?.hash).toLowerCase()&&Number(a?.timestamp)===Number(b?.timestamp);
function validPositionFeeEvidence(value:any,source:Source,after:RangeKeeperSnapshot,reference:any):boolean{
 if(!value||value.kind!=='rangekeeper_live_position_fee_evidence_v1'||!sameSource(value.source,source)||
  !reference||!sameSource(reference.source,source)||value.referenceProofHash!==reference.proofHash||
  value.collectionSimulation!=='canonical_eth_call'||!after.position)return false;
 if(String(value.tokenId)!==String(after.position.tokenId)||String(value.liquidityRaw)!==String(after.position.liquidity))return false;
 const fields=['principal0Raw','principal1Raw','uncollected0Raw','uncollected1Raw','grossFee0Raw','grossFee1Raw','inventory0Raw','inventory1Raw'];
 return fields.every(key=>decimal(value[key]));
}

function parseSource(source:any):Source{
 assert(source&&decimal(String(source.block))&&/^0x[0-9a-fA-F]{64}$/.test(source.hash)&&Number.isSafeInteger(source.timestamp)&&source.timestamp>0,'Invalid persisted receipt source');
 return {block:String(source.block),hash:source.hash,timestamp:source.timestamp};
}

/** Compute accounting solely from receipt-block evidence. Authorization-time prices deliberately have no input here. */
export function deriveRangeKeeperReceiptCost(input:{
 plan:RangeKeeperTxPlan;before:RangeKeeperSnapshot;after:RangeKeeperSnapshot;gasWei:bigint;receiptHash:`0x${string}`;
 pool:RangeKeeperConfig['pool'];status:'success'|'reverted';
 valuation?:{source:Source;proofHash:string;price0:string;price1:string;nativePrice:string};
}):{gasValue:bigint|null;swapFeeValue:bigint|null;swapShortfallValue:bigint|null;actualSwapOutput:bigint|null}{
 const {plan,before,after}=input;let refs:null|{price0:bigint;price1:bigint;nativePrice:bigint}=null;
 if(input.valuation&&sameSource(input.valuation.source,after.source)&&hash64(input.valuation.proofHash)&&
  decimal(input.valuation.price0)&&decimal(input.valuation.price1)&&decimal(input.valuation.nativePrice)&&
  BigInt(input.valuation.price0)>0n&&BigInt(input.valuation.price1)>0n&&BigInt(input.valuation.nativePrice)>0n){
  refs={price0:BigInt(input.valuation.price0),price1:BigInt(input.valuation.price1),nativePrice:BigInt(input.valuation.nativePrice)};
 }
 const gasValue=refs?rawValue(input.gasWei,refs.nativePrice,18):null;
 let swapFeeValue:bigint|null=0n,swapShortfallValue:bigint|null=0n,actualSwapOutput:bigint|null=null;
 if(plan.kind==='swap'&&input.status==='success'){
  const inputIs0=plan.token===0,outputDelta=inputIs0?after.wallet1-before.wallet1:after.wallet0-before.wallet0;
  actualSwapOutput=outputDelta>0n?outputDelta:0n;
  if(refs&&actualSwapOutput>0n){
   const p=input.pool,inputPrice=inputIs0?refs.price0:refs.price1,outputPrice=inputIs0?refs.price1:refs.price0,
    inputDecimals=inputIs0?p.decimals0:p.decimals1,outputDecimals=inputIs0?p.decimals1:p.decimals0,
    inputValue=rawValue(plan.amountIn,inputPrice,inputDecimals),outputValue=rawValue(actualSwapOutput,outputPrice,outputDecimals);
   swapFeeValue=inputValue*BigInt(p.fee)/1_000_000n;
   const gap=inputValue-outputValue-swapFeeValue;swapShortfallValue=gap>0n?gap:0n;
  }else swapFeeValue=swapShortfallValue=null;
 }
 return {gasValue,swapFeeValue,swapShortfallValue,actualSwapOutput};
}

/** Apply one persisted, canonical receipt as a campaign event. This callback is safe to invoke again after a worker restart. */
export async function applyRangeKeeperLiveReceiptEffectInTransaction(client:PoolClient,input:{job:LiveJob;outbox:LiveOutbox;verified?:VerifiedQueueReceipt}){
 const {job,outbox}=input;
 assert(outbox.jobId===job.id&&outbox.stage.length>0,'Receipt job/stage binding mismatch');
 const row=(await client.query<any>(`SELECT o.*,a.authorization_json,a.authorization_hash,a.campaign_id auth_campaign_id,
   a.revision auth_revision,a.allocation_id auth_allocation_id,a.profile_id,a.profile_hash,a.allocation_hash,a.plan_hash,a.source_block auth_source_block,
   a.source_hash auth_source_hash,a.source_timestamp auth_source_timestamp,a.reference_proof_hash
  FROM deployment_live_stage_outbox o JOIN deployment_live_stage_authorizations a ON a.job_id=o.job_id AND a.stage=o.stage
  WHERE o.job_id=$1 AND o.stage=$2 AND o.chain_id=$3 AND o.wallet=$4 FOR UPDATE OF o,a`,
 [job.id,outbox.stage,job.chainId,lower(job.wallet)])).rows[0];
 assert(row,'Persisted stage authorization/receipt row is missing');
 assert(['confirmed','reverted'].includes(row.status)&&row.canonical_receipt_json&&row.effect_evidence_json,'Canonical receipt evidence is not persisted');
 const stored=typeof row.canonical_receipt_json==='string'?JSON.parse(row.canonical_receipt_json):row.canonical_receipt_json as StoredReceipt;
 const effects=typeof row.effect_evidence_json==='string'?JSON.parse(row.effect_evidence_json):row.effect_evidence_json as StoredEffects;
 const auth=typeof row.authorization_json==='string'?JSON.parse(row.authorization_json):row.authorization_json;
 const intent=typeof row.intent_json==='string'?JSON.parse(row.intent_json):row.intent_json;
 const plan=parseRangeKeeperJson<RangeKeeperTxPlan>(row.plan_json);
 const before=parseRangeKeeperJson<any>(row.before_json);
 assert.equal(contentHash(auth),row.authorization_hash,'Persisted authorization hash mismatch');
 assert.equal(auth.stage,outbox.stage);assert.equal(auth.campaignId,job.campaignId);assert.equal(Number(auth.revision),job.revision);
 assert.equal(auth.allocationId,job.allocationId);assert.equal(row.auth_campaign_id,job.campaignId);assert.equal(Number(row.auth_revision),job.revision);
 assert.equal(row.auth_allocation_id,job.allocationId);assert.equal(auth.planHash,liveSetupEvidenceHash(plan));assert.equal(row.plan_hash,liveSetupEvidenceHash(plan));
 assert.equal(effects.receiptHash,stored.receiptHash);assert.equal(effects.proofHash,stored.proofHash);
 assert.equal(effects.source.block,stored.source.block);assert.equal(effects.source.hash.toLowerCase(),stored.source.hash.toLowerCase());
 assert.equal(String(effects.nonce),String(Number(row.nonce)+1));assert.equal(String(stored.receipt?.transactionHash).toLowerCase(),String(row.signed_raw_hash).toLowerCase());
 assert.equal(liveSetupEvidenceHash(stored.receipt),stored.receiptHash,'Canonical receipt hash mismatch');
 assert.equal(String(stored.receipt?.status),row.status==='confirmed'?'success':'reverted');
 assert.equal(String(intent.sourceBlock),String(before.wallet.source.block));
 assert.equal(String(row.auth_source_block),String(intent.sourceBlock));assert.equal(String(row.auth_source_hash).toLowerCase(),String(intent.sourceHash).toLowerCase());
 assert.equal(Number(row.auth_source_timestamp),Number(before.wallet.source.timestamp));
 const source=parseSource(stored.source);assert(sameSource(source,effects.source),'Receipt/effect source mismatch');
 const after=parseRangeKeeperJson<RangeKeeperSnapshot>(effects.afterPool);
 const beforePool=before.snapshot as RangeKeeperSnapshot;
 assert(beforePool&&String(beforePool.source.block)===String(intent.sourceBlock)&&beforePool.source.hash.toLowerCase()===String(intent.sourceHash).toLowerCase()&&
  Number(beforePool.source.timestamp)===Number(row.auth_source_timestamp),'Persisted pool before image does not match signed source');
 assert(sameSource(after.source,source),'After-pool snapshot is not at the canonical receipt source');
 assert(lower(after.operator)===lower(job.wallet)&&lower(beforePool.operator)===lower(job.wallet),'Pool snapshot operator mismatch');
 assert(BigInt(after.nonce)===BigInt(row.nonce)+1n,'After-pool nonce is not the signed nonce plus one');
 assert.equal(stored.receiptHash,String((typeof row.canonical_receipt_json==='string'?JSON.parse(row.canonical_receipt_json):row.canonical_receipt_json).receiptHash));
 if(input.verified){
  assert.equal(input.verified.receiptHash,stored.receiptHash);assert.equal(input.verified.proofHash,stored.proofHash);
  assert.equal(input.verified.status,row.status==='confirmed'?'success':'reverted');assert(sameSource(input.verified.source,source));
 }
 const effectId=contentHash({jobId:job.id,stage:outbox.stage,receiptHash:stored.receiptHash});
 const persistedEvidenceHash=contentHash({canonicalReceipt:stored,effects});
 const valuation=effects.referenceValuation;
 const positionFeeEvidence=validPositionFeeEvidence(effects.positionFeeEvidence,source,after,valuation)?effects.positionFeeEvidence:null;
 const payload={schemaVersion:1,kind:'rangekeeper_live_stage_receipt_v1',jobId:job.id,stage:outbox.stage,receiptHash:stored.receiptHash,
  proofHash:stored.proofHash,status:row.status,source,planHash:liveSetupEvidenceHash(plan),authorizationHash:row.authorization_hash,
  referenceProofHash:row.reference_proof_hash,persistedEvidenceHash,positionFeeEvidence};
 const payloadHash=contentHash(payload);
 const prior=(await client.query<any>(`SELECT payload_hash,after_state_hash,sequence FROM deployment_live_runtime_events WHERE campaign_id=$1 AND revision=$2 AND effect_id=$3`,
  [job.campaignId,job.revision,effectId])).rows[0];
 if(prior){assert.equal(prior.payload_hash,payloadHash,'Receipt replay payload changed');
  const campaign=await readRangeKeeperLiveCampaign(client,{chainId:job.chainId,address:job.wallet,campaignId:job.campaignId,revision:job.revision});
  assert(campaign.state&&campaign.stateHash,'Campaign runtime state is unavailable on receipt replay');
  return {state:campaign.state,stateHash:campaign.stateHash,stateRevision:campaign.stateRevision,replayed:true,effectId};}
 const campaign=await readRangeKeeperLiveCampaign(client,{chainId:job.chainId,address:job.wallet,campaignId:job.campaignId,revision:job.revision});
 assert(campaign.state&&campaign.stateHash,'Campaign runtime state must be initialized before receipt effects');
 const state=structuredClone(campaign.state) as RangeKeeperLiveState;
 const gasWei=BigInt(effects.gasWei);assert(gasWei>=0n&&decimal(effects.gasWei),'Invalid measured gas amount');
 assert(gasWei===BigInt(stored.receipt?.gasUsed)*BigInt(stored.receipt?.effectiveGasPrice),'Stored gas differs from canonical receipt');
 const pricesValid=valuation&&sameSource(valuation.source,source)&&hash64(valuation.proofHash)&&
  decimal(valuation.price0)&&decimal(valuation.price1)&&decimal(valuation.nativePrice)&&BigInt(valuation.price0)>0n&&BigInt(valuation.price1)>0n&&BigInt(valuation.nativePrice)>0n;
 const cost=deriveRangeKeeperReceiptCost({plan,before:beforePool,after,gasWei,receiptHash:stored.receipt.transactionHash as `0x${string}`,pool:campaign.config.pool,
  status:row.status==='confirmed'?'success':'reverted',
  ...(pricesValid?{valuation}:{})});
 const {gasValue,swapFeeValue,swapShortfallValue}=cost;
 if(plan.kind==='swap'&&row.status==='confirmed')assert((cost.actualSwapOutput??0n)>0n,'Successful swap receipt lacks positive output-token balance delta');
 state.gasSpentWei+=gasWei;state.costEvents.push({hash:stored.receipt.transactionHash,block:BigInt(source.block),timestamp:source.timestamp,
  gasWei,gasValue,swapFeeValue,swapShortfallValue});state.last=after;
 if(row.status==='reverted'&&job.kind==='close_convert'&&plan.kind==='swap'&&isRangeKeeperConvertExit(state)&&state.activeTokenId===null){
  // The withdrawal is reconciled and the reverted sale's gas is booked above. Both tokens are in the wallet, so the exit
  // falls back to a retained close (allowance cleanup, then close) instead of halting with a recoverable position.
  const degraded=degradeRangeKeeperConvertExitToRetain(state,`swap_reverted:${outbox.stage}`.slice(0,120),after);
  degraded.lastReason=`convert_swap_reverted_degraded_to_retain:${outbox.stage}`.slice(0,200);
  Object.assign(state,degraded);
 }else if(row.status==='reverted'){
  state.phase='halted';state.haltReason=`transaction_reverted:${job.id}:${outbox.stage}`;state.lastReason=state.haltReason;
 }else if(plan.kind==='withdraw'){
  const collection=effects.effects;assert(collection&&decimal(collection.fee0)&&decimal(collection.fee1),'Withdrawal fee collection evidence is missing');
  state.collectedFee0+=BigInt(collection.fee0);state.collectedFee1+=BigInt(collection.fee1);state.retiredTokenIds.push(String(plan.tokenId));
  state.activeTokenId=null;state.withdrawDone=true;state.lastReason='withdraw_collected';
 }else if(plan.kind==='swap'){
  if(state.phase==='entry'||state.phase==='recenter'){state.swapDone=true;state.swapConfirmedAt=source.timestamp;}state.lastReason='swap_confirmed';
 }else if(plan.kind==='mint'){
  assert(after.position,'Successful mint lacks canonical position state');assert(campaign.allocation.nftTokenIds.includes(String(after.position.tokenId)),
   'Minted NFT is not allocated to this campaign');
  assert(state.activeTokenId===null||state.activeTokenId===after.position.tokenId,'Mint conflicts with active campaign NFT');
  state.activeTokenId=after.position.tokenId;state.economicActions++;if(state.phase==='recenter')state.recenters++;
  state.phase='holding';state.candidate=null;state.swapDone=false;state.swapConfirmedAt=null;state.withdrawDone=false;state.reservedActionCost=0n;state.lastReason='mint_confirmed';
 }else state.lastReason='approval_confirmed';
 const result=await appendRangeKeeperLiveCampaignEventInTransaction(client,{chainId:job.chainId,address:job.wallet,campaignId:job.campaignId,
  revision:job.revision,effectId,kind:'stage_receipt',expectedStateHash:campaign.stateHash,state,source,receiptHash:stored.receipt?.transactionHash,payload});
 return {...result,effectId};
}
