import type {PoolClient} from 'pg';
import {allocationSchema} from '../deployments/contracts.js';
import {contentHash} from '../deployments/contracts.js';
import {paperAccountingSchema,paperConversionAccountingV2Schema,paperConversionAccountingV3Schema,
 PAPER_ACCOUNTING_POLICY,PAPER_CONVERSION_ACCOUNTING_POLICY_V2,PAPER_CONVERSION_ACCOUNTING_POLICY_V3,
 RANGEKEEPER_PAPER_ACCOUNTING_POLICY,rangeKeeperPaperAccountingSchema,
 rangeKeeperPaperReferenceProofFresh,
 type PaperAccounting,type PaperConversionAccountingV2,type PaperConversionAccountingV3,
 type RangeKeeperPaperAccounting}
 from '../deployments/paper-accounting.js';
import {marketProfileSchema,referenceProofHash,type MarketProfile} from '../deployments/market-profile.js';
import {amountsForLiquidity,sqrtRatioAtTick} from '../backtest/principal.js';
import {positionWindow,type PositionPoint} from './position-performance.js';
import {parseRangeKeeperJson,rangeKeeperJson,type RangeKeeperLiveState} from '../strategy/rangekeeper/live-domain.js';
import {rangeKeeperPinnedSemanticProofHash} from '../deployments/rangekeeper-live-review-runtime.js';
import {classifyReferenceBasis,poolImpliedValue,valueInventory,
 type ReferenceBasis,type ReferenceBasisKind} from './reference-basis.js';

const WAD=10n**18n,Q192=1n<<192n;
const micro=(value:string|null)=>value===null?null:String(BigInt(value)/10n**12n);
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&
 !Array.isArray(value)?value as Record<string,unknown>:{};
const decimal=(value:unknown):string|null=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)?value:null;
const sourceTime=(provenance:unknown):string|null=>{
 const n=record(record(provenance).source).timestamp;
 return typeof n==='number'&&Number.isSafeInteger(n)&&n>0?new Date(n*1000).toISOString():null;
};
const sameSource=(a:unknown,b:unknown)=>{
 const x=record(a),y=record(b);
 return String(x.block)===String(y.block)&&String(x.hash).toLowerCase()===String(y.hash).toLowerCase()&&
  Number(x.timestamp)===Number(y.timestamp);
};
const symbol=(reference:string)=>reference.split('/')[0]??reference;

interface DeploymentRow {
 id:string;mode:'paper'|'live';lifecycle:string;range_state:string;current_revision:number;created_at:Date;
 closed_at:Date|null;allocation:unknown;runtime_identity:unknown;profile:unknown;strategy_id:string;config:unknown;
 mark_id:string|null;mark_at:Date|null;source_block:string|null;source_hash:string|null;
 inventory:unknown;economics:unknown;provenance:unknown;initial_value:string|null;
 operation_id:string|null;operation_kind:string|null;operation_status:string|null;
 operation_stage:string|null;operation_reason:string|null;operation_updated_at:Date|null;
 accounting_snapshot:unknown;accounting_hash:string|null;
 rangekeeper_accounting_snapshot?:unknown;rangekeeper_accounting_hash?:string|null;
 rk_previous_mark_id?:string|null;rk_previous_mark_at?:Date|null;rk_previous_source_block?:string|null;
 rk_previous_source_hash?:string|null;rk_previous_inventory?:unknown;rk_previous_economics?:unknown;
 rk_previous_provenance?:unknown;rk_previous_accounting_snapshot?:unknown;rk_previous_accounting_hash?:string|null;
 rk_previous_invalidated_at?:Date|null;
 live_mark_payload?:unknown;live_mark_payload_hash?:string|null;live_mark_block?:string|null;
 live_mark_hash?:string|null;live_mark_timestamp?:string|number|null;live_runtime_state?:unknown;
 live_runtime_state_hash?:string|null;live_runtime_revision?:number|null;live_runtime_profile_hash?:string|null;
 live_runtime_config_hash?:string|null;live_profile_id?:string|null;
 live_runtime_status?:string|null;live_job_id?:string|null;live_job_kind?:string|null;
 live_job_status?:string|null;live_job_resume_stage?:string|null;live_job_attempt?:number|null;
 live_job_created_at?:Date|null;live_job_updated_at?:Date|null;live_outbox_stage?:string|null;
 live_outbox_nonce?:string|null;live_outbox_hash?:string|null;live_outbox_status?:string|null;
 conversion_accounting_snapshot:unknown;conversion_accounting_hash:string|null;
 accounting_invalidated_at:Date|null;accounting_invalidation_reason:string|null;
}
interface DeploymentMark {
 id:string;at:Date;source_block:string|null;source_hash:string|null;
 inventory:unknown;economics:unknown;provenance:unknown;
 accounting_snapshot:unknown;accounting_hash:string|null;
 rangekeeper_accounting_snapshot?:unknown;rangekeeper_accounting_hash?:string|null;
 conversion_accounting_snapshot:unknown;conversion_accounting_hash:string|null;
 accounting_invalidated_at:Date|null;accounting_invalidation_reason:string|null;
}
type LiveMarkModel={payload:any;state:RangeKeeperLiveState;source:{block:string;hash:string;timestamp:number};
 amounts:[string,string];navQuote:string|null;passiveQuote:string|null;feesQuote:string|null;gasQuote:string|null;swapCostQuote:string|null;
 pnlQuote:string|null;alphaQuote:string|null;epoch:number;sqrt:string|null;tick:number|null;tickLower:number|null;
 tickUpper:number|null;hasPosition:boolean;feeEvidenceAvailable:boolean;nativeWei:string;referencesAvailable:boolean;missing:string[];
 feeRaw:[string,string];costEvents:any[];referenceBasis:ReferenceBasis;nativeTotalWei:string};
function liveMarkModel(row:DeploymentRow,profile:MarketProfile,history=false):LiveMarkModel|null{
 try{
  if(contentHash(row.live_mark_payload)!==row.live_mark_payload_hash)return null;
  const stored=parseRangeKeeperJson<any>(row.live_mark_payload),runtime=parseRangeKeeperJson<RangeKeeperLiveState>(row.live_runtime_state),
   payload=stored?.kind==='rangekeeper_live_valuation_mark_v1'?stored:stored?.terminalValuation;
  const state=payload?.accountingState??runtime;
  if(!payload||!state||payload.kind!=='rangekeeper_live_valuation_mark_v1'||payload.schemaVersion!==1||
   payload.campaignId!==row.id||
   Number(payload.revision)!==row.current_revision||
   payload.profileHash!==contentHash(profile)||payload.profileId!==row.live_profile_id||
   payload.configHash!==row.live_runtime_config_hash||
   !history&&(Number(row.live_runtime_revision)!==row.current_revision||
    payload.profileHash!==row.live_runtime_profile_hash||!runtime||
    contentHash(JSON.parse(rangeKeeperJson(runtime)))!==row.live_runtime_state_hash||
    payload.runtimeStateHash!==row.live_runtime_state_hash||!sameSource(payload.source,runtime.last?.source))||
   !sameSource(payload.source,{block:row.live_mark_block,hash:row.live_mark_hash,timestamp:Number(row.live_mark_timestamp)})||
   !sameSource(payload.source,payload.snapshot?.source)||
   String(payload.snapshot?.operator).toLowerCase()!==String(runtime?.operator??payload.snapshot?.operator).toLowerCase()||
   (history&&payload.accountingState==null))return null;
  const allocation=record(payload.allocation),liquid=record(allocation.liquidByTokenAddress),pool=profile.pool,
   amount0=decimal(liquid[pool.token0.toLowerCase()]??liquid[pool.token0]),
   amount1=decimal(liquid[pool.token1.toLowerCase()]??liquid[pool.token1]),
   native=decimal(allocation.nativeSpendWei),exitReserve=decimal(allocation.exitReserveWei),
   refs=record(payload.referenceValuation),fee=record(payload.positionFeeEvidence),snapshot=record(payload.snapshot),
   position=record(snapshot.position),hasPosition=position.tokenId!=null;
  if(amount0===null||amount1===null||native===null||exitReserve===null||
   !['available','unavailable'].includes(String(refs.status)))return null;
  const evidence=record(refs.evidence),prices={price0:String(refs.price0),price1:String(refs.price1),nativePrice:String(refs.nativePrice)};
  // The reference is bound to this mark's source when every identity and hash check passes. Freshness is judged
  // separately: a bound reference whose oracle is past its age limit can still be valued at its last answer.
  const bound=refs.status==='available'&&sameSource(payload.source,refs.source)&&
   /^[0-9a-f]{64}$/.test(String(refs.proofHash))&&[refs.price0,refs.price1,refs.nativePrice].every(v=>{const d=decimal(v);return d!==null&&BigInt(d)>0n;})&&
   evidence.kind==='rangekeeper_live_independent_reference_v1'&&evidence.campaignId===row.id&&
   Number(evidence.revision)===row.current_revision&&evidence.profileHash===payload.profileHash&&
   sameSource(evidence.source,payload.source)&&contentHash(evidence.prices)===contentHash(prices)&&
   evidence.semanticProofHash===refs.proofHash&&rangeKeeperPinnedSemanticProofHash({profileHash:payload.profileHash,
    source:payload.source,references:prices,referenceProof:evidence.referenceProof})===refs.proofHash;
  const fresh=bound&&rangeKeeperPaperReferenceProofFresh(evidence.referenceProof,Array.isArray(refs.missing)?refs.missing:[]);
  const classified=bound?classifyReferenceBasis({proof:evidence.referenceProof,reasons:[],
   sourceTimestamp:Number(payload.source.timestamp),persistedPrices:prices}):null;
  const referenceBasis:ReferenceBasis=fresh?{...(classified??{feeds:[],asOf:null,freshnessReasons:[],structuralReasons:[]}),
   kind:'oracle_fresh',prices:{price0:BigInt(prices.price0),price1:BigInt(prices.price1),nativePrice:BigInt(prices.nativePrice)}}:
   classified??{kind:'unavailable',prices:null,feeds:[],asOf:null,freshnessReasons:[],
    structuralReasons:Array.isArray(refs.missing)&&refs.missing.length?refs.missing.map(String):['independent_reference_unavailable']};
  let refsAvailable=fresh||referenceBasis.kind==='last_oracle_price';
  let principal0='0',principal1='0',fee0='0',fee1='0',feeEvidenceValid=!hasPosition&&state.phase!=='holding';
  if(hasPosition){
   if(fee.kind!=='rangekeeper_live_position_fee_evidence_v1'||!sameSource(payload.source,fee.source)||
    fee.referenceProofHash!==refs.proofHash||String(fee.tokenId)!==String(position.tokenId)||
    String(fee.liquidityRaw)!==String(position.liquidity)||fee.collectionSimulation!=='canonical_eth_call'||
    decimal(fee.principal0Raw)===null||decimal(fee.principal1Raw)===null||
    decimal(fee.uncollected0Raw)===null||decimal(fee.uncollected1Raw)===null||
    decimal(fee.grossFee0Raw)===null||decimal(fee.grossFee1Raw)===null||
    decimal(fee.inventory0Raw)===null||decimal(fee.inventory1Raw)===null||
    BigInt(String(fee.principal0Raw))+BigInt(String(fee.uncollected0Raw))!==BigInt(String(fee.inventory0Raw))||
    BigInt(String(fee.principal1Raw))+BigInt(String(fee.uncollected1Raw))!==BigInt(String(fee.inventory1Raw)))return null;
   principal0=String(fee.inventory0Raw);principal1=String(fee.inventory1Raw);
   fee0=String(fee.grossFee0Raw);fee1=String(fee.grossFee1Raw);
   feeEvidenceValid=true;
  }else if(state.phase==='closed'){
   fee0=String(state.collectedFee0);fee1=String(state.collectedFee1);
  }
  const total0=BigInt(amount0)+BigInt(principal0),total1=BigInt(amount1)+BigInt(principal1),
   nativeTotal=BigInt(native)+BigInt(exitReserve);
  let navQuote:string|null=null,passiveQuote:string|null=null,feesQuote:string|null=null,gasQuote:string|null=null,swapCostQuote:string|null=null,
   pnlQuote:string|null=null,alphaQuote:string|null=null;
  if(refsAvailable&&feeEvidenceValid){
   const p0=BigInt(String(refs.price0)),p1=BigInt(String(refs.price1)),pn=BigInt(String(refs.nativePrice)),
    value=(a:bigint,b:bigint,n:bigint)=>a*p0/10n**BigInt(pool.decimals0)+b*p1/10n**BigInt(pool.decimals1)+n*pn/WAD;
   navQuote=String(value(total0,total1,nativeTotal));
   passiveQuote=String(value(state.initial0,state.initial1,state.initialNativeWei));
   feesQuote=String(BigInt(fee0)*p0/10n**BigInt(pool.decimals0)+
    BigInt(fee1)*p1/10n**BigInt(pool.decimals1));
   gasQuote=state.costEvents.some((event:any)=>event.gasValue===null)?null:
    String(state.costEvents.reduce((sum:bigint,event:any)=>sum+(event.gasValue??0n),0n));
   swapCostQuote=state.costEvents.some((event:any)=>event.swapFeeValue===null||event.swapShortfallValue===null)?null:
    String(state.costEvents.reduce((sum:bigint,event:any)=>sum+(event.swapFeeValue??0n)+(event.swapShortfallValue??0n),0n));
   const initialCapitalValue=(state as RangeKeeperLiveState&{initialCapitalValue?:unknown}).initialCapitalValue,
    initialCapital=decimal(initialCapitalValue==null?null:String(initialCapitalValue));
   pnlQuote=initialCapital===null?null:String(BigInt(navQuote)-BigInt(initialCapital));
   alphaQuote=String(BigInt(navQuote)-BigInt(passiveQuote));
  }
  return {payload,state,source:{block:String(payload.source.block),hash:String(payload.source.hash),timestamp:Number(payload.source.timestamp)},
   referenceBasis,nativeTotalWei:String(nativeTotal),
   amounts:[String(total0),String(total1)],navQuote,passiveQuote,feesQuote,gasQuote,swapCostQuote,pnlQuote,alphaQuote,
   epoch:Number.isSafeInteger(payload.epoch)&&payload.epoch>=0?payload.epoch:
    Number.isSafeInteger(state.epoch)&&state.epoch>=0?state.epoch:0,sqrt:decimal(typeof snapshot.sqrtPriceX96==='bigint'?String(snapshot.sqrtPriceX96):snapshot.sqrtPriceX96),
   tick:typeof snapshot.tick==='number'?snapshot.tick:null,hasPosition,
   tickLower:hasPosition&&typeof position.tickLower==='number'?position.tickLower:null,
   tickUpper:hasPosition&&typeof position.tickUpper==='number'?position.tickUpper:null,
   nativeWei:String(nativeTotal),referencesAvailable:refsAvailable&&feeEvidenceValid,feeEvidenceAvailable:feeEvidenceValid,
   feeRaw:[fee0,fee1],costEvents:Array.isArray(state.costEvents)?state.costEvents:[],
   missing:[...new Set([...(Array.isArray(payload.missing)?payload.missing:[]),...(refsAvailable?[]:['independent_reference_unavailable']),
    ...(feeEvidenceValid?[]:['position_fee_evidence_unavailable'])])]};
 }catch{return null;}
}
export type LiveLifecycle='queued'|'opening'|'holding'|'recentering'|'closing'|'closed'|'blocked';
const LIVE_IN_FLIGHT=['queued','preflighting','executing','confirming','reconciling'];
/** Stage names are `${plan.kind}:${hash}`; only the leading kind is meaningful to an operator. */
export const liveStageKind=(stage:unknown):string|null=>{
 const kind=typeof stage==='string'?stage.split(':')[0]:null;
 return kind&&/^[a-z][a-z_]{0,31}$/.test(kind)?kind:null;
};
const txHash=(value:unknown):string|null=>typeof value==='string'&&/^0x[0-9a-fA-F]{64}$/.test(value)?value:null;
export interface LiveJobView{id:string;kind:string;status:string;inFlight:boolean;stage:string|null;
 stageKind:string|null;stageStatus:string|null;nonce:string|null;txHash:string|null;attempt:number|null;
 createdAt:string|null;updatedAt:string|null}
/** Campaign lifecycle for a live RangeKeeper row. The campaign table only moves through
 * opening/active/blocked/closed for live work, so recentering and closing come from the
 * current queue job and, when no job is in flight, from the persisted runtime phase. */
export function deriveLiveLifecycle(input:{campaignLifecycle:string;runtimeStatus?:string|null;
 phase?:string|null;job?:Pick<LiveJobView,'kind'|'status'>|null}):LiveLifecycle{
 const {campaignLifecycle,runtimeStatus,phase,job}=input;
 if(campaignLifecycle==='closed'||runtimeStatus==='closed'||phase==='closed')return 'closed';
 if(campaignLifecycle==='blocked'||runtimeStatus==='blocked'||phase==='halted'||job?.status==='blocked')return 'blocked';
 if(job&&LIVE_IN_FLIGHT.includes(job.status)){
  if(job.kind==='open')return job.status==='queued'?'queued':'opening';
  if(job.kind==='change_range')return 'recentering';
  if(job.kind==='close_retain'||job.kind==='close_convert')return 'closing';
 }
 if(campaignLifecycle==='closing'||phase==='exit')return 'closing';
 if(campaignLifecycle==='changing'||phase==='recenter')return 'recentering';
 if(campaignLifecycle==='opening'||phase==='entry'){
  // A rejected or cancelled opening job leaves nothing running; do not report it as healthy progress.
  return job?.kind==='open'&&['rejected','cancelled'].includes(job.status)?'blocked':'opening';
 }
 return 'holding';
}
function verifiedLiveRuntime(row:DeploymentRow):RangeKeeperLiveState|null{
 if(row.live_runtime_state==null||Number(row.live_runtime_revision)!==row.current_revision)return null;
 try{
  const state=parseRangeKeeperJson<RangeKeeperLiveState>(row.live_runtime_state);
  return contentHash(JSON.parse(rangeKeeperJson(state)))===row.live_runtime_state_hash?state:null;
 }catch{return null;}
}
const liveJobView=(row:DeploymentRow):LiveJobView|null=>{
 if(!row.live_job_id||!row.live_job_kind||!row.live_job_status)return null;
 const stage=row.live_outbox_stage??row.live_job_resume_stage??null;
 return {id:row.live_job_id,kind:row.live_job_kind,status:row.live_job_status,
  inFlight:LIVE_IN_FLIGHT.includes(row.live_job_status),stage,stageKind:liveStageKind(stage),
  stageStatus:row.live_outbox_status??null,nonce:decimal(row.live_outbox_nonce??null),
  txHash:txHash(row.live_outbox_hash),attempt:Number.isSafeInteger(row.live_job_attempt)?Number(row.live_job_attempt):null,
  createdAt:row.live_job_created_at instanceof Date?row.live_job_created_at.toISOString():null,
  updatedAt:row.live_job_updated_at instanceof Date?row.live_job_updated_at.toISOString():null};
};
/** Everything the operator sees for a live campaign that does not need a valuation mark. Values
 * the evidence cannot prove stay null; nothing is zero-filled. */
function liveCampaignView(row:DeploymentRow,model:LiveMarkModel|null){
 const runtime=model?.state??verifiedLiveRuntime(row),job=liveJobView(row),phase=runtime?.phase??null;
 const lifecycle=deriveLiveLifecycle({campaignLifecycle:row.lifecycle,runtimeStatus:row.live_runtime_status,phase,job});
 const last=record(runtime?.last),lastPosition=record(last.position),
  fallbackLiquidity=lastPosition.liquidity,
  fallbackHas=!model&&lastPosition.tokenId!=null&&(typeof fallbackLiquidity==='bigint'?fallbackLiquidity>0n:
   decimal(fallbackLiquidity)!==null&&BigInt(String(fallbackLiquidity))>0n);
 const hasPosition=model?model.hasPosition:fallbackHas;
 const tickLower=model?model.tickLower:fallbackHas&&Number.isInteger(lastPosition.tickLower)?Number(lastPosition.tickLower):null,
  tickUpper=model?model.tickUpper:fallbackHas&&Number.isInteger(lastPosition.tickUpper)?Number(lastPosition.tickUpper):null,
  tick=model?model.tick:Number.isInteger(last.tick)?Number(last.tick):null;
 const modelToken=model?.payload?.snapshot?.position?.tokenId,
  nftId=model?(modelToken==null?null:String(modelToken)):fallbackHas?String(lastPosition.tokenId):null;
 const rangeState=!hasPosition?'no_liquidity':tick===null||tickLower===null||tickUpper===null?'unknown':
  tick>=tickLower&&tick<tickUpper?'inside':'outside';
 const haltReason=typeof runtime?.haltReason==='string'&&runtime.haltReason?runtime.haltReason:null;
 const blockedReason=lifecycle!=='blocked'?null:haltReason??
  (job?.status==='blocked'?`job_blocked${job.stageKind?`:${job.stageKind}`:''}`:
   job&&['rejected','cancelled'].includes(job.status)?`job_${job.status}`:
   typeof runtime?.lastReason==='string'&&runtime.lastReason?runtime.lastReason:'blocked_reason_unavailable');
 const allocation=allocationSchema.safeParse(row.allocation);
 return {lifecycle,phase,job,blockedReason,nftId,hasPosition,tickLower,tickUpper,tick,rangeState,
  allocation:allocation.success?allocation.data:null,
  recenters:runtime&&Number.isSafeInteger(runtime.recenters)?runtime.recenters:null,
  paidGasWei:runtime&&typeof runtime.gasSpentWei==='bigint'?String(runtime.gasSpentWei):null,
  runtimeVerified:runtime!==null};
}
const LIVE_STATUS:Record<LiveLifecycle,(range:string)=>string>={
 queued:()=>'waiting',opening:()=>'waiting',recentering:()=>'recentring',closing:()=>'exiting',
 closed:()=>'closed',blocked:()=>'blocked',
 holding:range=>range==='inside'?'open':range==='outside'?'outside':'unknown'};
const key=(mode:string,id:string)=>`${mode}-dep-${id}`;
const parseKey=(id:string)=>{
 const match=/^(paper|live)-dep-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(id);
 return match?{mode:match[1]!,id:match[2]!}:null;
};
const poolPrice=(sqrt:bigint,p:MarketProfile['pool'])=>{
 if(sqrt<=0n)return null;
 const n=p.quoteToken===0?Q192*10n**BigInt(p.decimals1)*WAD:
  sqrt*sqrt*10n**BigInt(p.decimals0)*WAD;
 const d=p.quoteToken===0?sqrt*sqrt*10n**BigInt(p.decimals0):
  Q192*10n**BigInt(p.decimals1);
 return String(n/d);
};
const rangePrices=(lower:number,upper:number,p:MarketProfile['pool'])=>
 [poolPrice(sqrtRatioAtTick(lower),p),poolPrice(sqrtRatioAtTick(upper),p)]
  .filter((v):v is string=>v!==null).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
const rkOpenModel=(provenance:unknown)=>{
 const p=record(provenance),booked=record(p.confirmedOpen),model=record(booked.model);
 return p.classification==='rangekeeper_paper_open_v1'&&
  booked.kind==='rangekeeper_paper_confirmed_open_v1'&&booked.status==='booked'&&
  booked.openingBooked===true&&booked.bookingClass==='provisional_mark_and_capital_ledger'&&
  typeof p.modelHash==='string'&&/^[0-9a-f]{64}$/.test(p.modelHash)&&
  booked.modelHash===p.modelHash&&contentHash(model)===p.modelHash&&
  contentHash(record(model.source))===contentHash(record(p.source))&&
  record(model.reference).proofHash===p.referenceProofHash?model:null;
};
const markPoolState=(provenance:unknown)=>record(record(provenance).poolState??rkOpenModel(provenance)?.poolState);
const rkOpenBalances=(inventory:unknown,provenance:unknown)=>{
 const model=rkOpenModel(provenance),inv=record(inventory),position=record(inv.position),
  idle=record(inv.idle),candidate=record(model?.candidate),range=record(candidate.range),
  amount0=decimal(position.amount0Minted),amount1=decimal(position.amount1Minted),
  idle0=decimal(idle.token0),idle1=decimal(idle.token1);
 if(!model||inv.classification!=='rangekeeper_paper_open_v1'||
  position.liquidity!==candidate.liquidity||position.tickLower!==range.tickLower||
  position.tickUpper!==range.tickUpper||amount0===null||amount1===null||
  idle0===null||idle1===null)return null;
 return {token0Raw:String(BigInt(amount0)+BigInt(idle0)),
  token1Raw:String(BigInt(amount1)+BigInt(idle1))};
};
const rkObservedBalances=(inventory:unknown,provenance:unknown)=>{
 const inv=record(inventory),prov=record(provenance),position=record(inv.position),idle=record(inv.idle),
  state=markPoolState(prov),sqrt=decimal(state.sqrtPriceX96),liquidity=decimal(position.liquidity),
  lower=typeof position.tickLower==='number'?position.tickLower:null,
  upper=typeof position.tickUpper==='number'?position.tickUpper:null,
  idle0=decimal(idle.token0),idle1=decimal(idle.token1);
 if(!['rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1','rangekeeper_paper_close_retain_v1'].includes(String(prov.classification))||
  sqrt===null||liquidity===null||lower===null||upper===null||idle0===null||idle1===null)return null;
 try{
  const principal=amountsForLiquidity({liquidity:BigInt(liquidity),sqrtPriceX96:BigInt(sqrt),
   sqrtRatioAX96:sqrtRatioAtTick(lower),sqrtRatioBX96:sqrtRatioAtTick(upper)});
  return {token0Raw:String(principal.amount0+BigInt(idle0)),token1Raw:String(principal.amount1+BigInt(idle1))};
 }catch{return null;}
};
const referencePrice=(provenance:unknown,p:MarketProfile['pool'])=>{
 const reference=record(record(provenance).reference),risk=decimal(p.quoteToken===0?reference.price1:reference.price0),
  quote=decimal(p.quoteToken===0?reference.price0:reference.price1);
 return risk!==null&&quote!==null&&BigInt(quote)>0n?String(BigInt(risk)*WAD/BigInt(quote)):null;
};
const tokenReferenceValue=(amount0:string|null,amount1:string|null,provenance:unknown,
 p:MarketProfile['pool'])=>{
 const reference=record(record(provenance).reference),price0=decimal(reference.price0),
  price1=decimal(reference.price1);
 if(amount0===null||amount1===null||price0===null||price1===null)return null;
 return String(BigInt(amount0)*BigInt(price0)/10n**BigInt(p.decimals0)+
  BigInt(amount1)*BigInt(price1)/10n**BigInt(p.decimals1));
};
const principalValue=(inventory:Record<string,unknown>,economics:Record<string,unknown>,
 provenance:unknown,p:MarketProfile['pool'])=>{
 const recorded=decimal(economics.principalOnlyValue);
 if(recorded!==null)return recorded;
 const lower=record(inventory.knownLowerBound),retained=record(inventory.retainedPrincipalLowerBound);
 return tokenReferenceValue(decimal(lower.token0Raw)??decimal(retained.token0Raw),
  decimal(lower.token1Raw)??decimal(retained.token1Raw),provenance,p);
};
const accounting=(row:DeploymentRow|DeploymentMark,campaignId:string):PaperAccounting|null=>{
 if(row.accounting_invalidated_at)return null;
 const parsed=paperAccountingSchema.safeParse(row.accounting_snapshot);
 return parsed.success&&row.accounting_hash===contentHash(parsed.data)&&
  parsed.data.campaignId===campaignId&&parsed.data.sourceMarkId===
   ('mark_id' in row?row.mark_id:row.id)&&
  parsed.data.source.block===row.source_block&&
   parsed.data.source.hash.toLowerCase()===row.source_hash?.toLowerCase()?parsed.data:null;
};
const rangeKeeperAccounting=(row:DeploymentRow|DeploymentMark,campaignId:string,
 profile:MarketProfile):RangeKeeperPaperAccounting|null=>{
 if(row.accounting_invalidated_at||row.rangekeeper_accounting_snapshot==null)return null;
 const parsed=rangeKeeperPaperAccountingSchema.safeParse(row.rangekeeper_accounting_snapshot),
  sourceBlock=row.source_block,sourceHash=row.source_hash,
  markProvenance=record(row.provenance),markReference=record(markProvenance.reference??
   record(markProvenance.valuation).reference),
  referenceUnavailable=record(markProvenance.valuation).referenceUnavailable;
 if(!parsed.success)return null;
 try{
 const markKind=markProvenance.classification==='rangekeeper_paper_open_v1'?'open':
  markProvenance.classification==='rangekeeper_paper_mark_v1'?'valuation':
  markProvenance.classification==='rangekeeper_paper_recenter_v1'?'recenter':
  markProvenance.classification==='rangekeeper_paper_close_retain_v1'?'close_retain':
  markProvenance.classification==='rangekeeper_paper_close_convert_v1'?'close_convert':null,
  markEpoch=Number.isInteger(markProvenance.epoch)?markProvenance.epoch:
   Number.isInteger(record(markProvenance.currentEpoch).epoch)?record(markProvenance.currentEpoch).epoch:0;
 if(!markKind)return null;
 const referencesPositive=[parsed.data.reference.price0,parsed.data.reference.price1,
  parsed.data.reference.nativePrice].every((value):value is string=>
   value!==null&&decimal(value)!==null&&BigInt(value)>0n);
 const proofMatches=parsed.data.reference.proof!==null&&
  referenceProofHash(parsed.data.reference.proof)===parsed.data.reference.proofHash&&
  parsed.data.reference.proofHash===markReference.proofHash&&
  contentHash(parsed.data.reference.proof)===contentHash(markReference.proof),
  matchingReference=parsed.data.reference.price0===markReference.price0&&
   parsed.data.reference.price1===markReference.price1&&parsed.data.reference.nativePrice===markReference.nativePrice;
 if(row.rangekeeper_accounting_hash!==contentHash(parsed.data)||
  parsed.data.policyVersion!==RANGEKEEPER_PAPER_ACCOUNTING_POLICY||
  parsed.data.campaignId!==campaignId||parsed.data.sourceMarkId!==('mark_id' in row?row.mark_id:row.id)||
  parsed.data.markKind!==markKind||parsed.data.epoch!==markEpoch||
  parsed.data.source.block!==sourceBlock||parsed.data.source.hash.toLowerCase()!==sourceHash?.toLowerCase()||
  contentHash(parsed.data.source)!==contentHash(markProvenance.source)||
  parsed.data.profileHash!==contentHash(profile)||parsed.data.reference.proof===null||
  (parsed.data.reference.eligible&&Array.isArray(referenceUnavailable)&&referenceUnavailable.length>0)||
  (parsed.data.reference.eligible&&(!referencesPositive||
   !rangeKeeperPaperReferenceProofFresh(parsed.data.reference.proof,
    Array.isArray(referenceUnavailable)?referenceUnavailable:[])))||
  (!parsed.data.reference.eligible&&[
   parsed.data.economics.netNavQuote,parsed.data.economics.passiveQuote,
   parsed.data.economics.absolutePnlQuote,parsed.data.economics.alphaQuote,
   parsed.data.economics.cumulativeFeeValueQuote,parsed.data.economics.intervalFeeAccrualQuote,
  ].some(value=>value!==null))||
  !proofMatches||!matchingReference)return null;
 return parsed.data;
 }catch{return null;}
};
const conversionAccounting=(row:DeploymentRow|DeploymentMark,campaignId:string,
 runtimeIdentity:unknown):PaperConversionAccountingV2|PaperConversionAccountingV3|null=>{
 if(row.accounting_invalidated_at)return null;
 const v2=paperConversionAccountingV2Schema.safeParse(row.conversion_accounting_snapshot),
  v3=paperConversionAccountingV3Schema.safeParse(row.conversion_accounting_snapshot),
  parsed=v3.success?v3.data:v2.success?v2.data:null;
 if(!parsed||row.conversion_accounting_hash!==contentHash(parsed)||
  runtimeIdentity===null||contentHash(parsed.runtimeIdentity)!==contentHash(runtimeIdentity)||
  parsed.campaignId!==campaignId||parsed.markKind!=='close_convert'||
  parsed.sourceMarkId!==('mark_id' in row?row.mark_id:row.id)||
  parsed.source.block!==row.source_block||
  parsed.source.hash.toLowerCase()!==row.source_hash?.toLowerCase()||
  parsed.conversion===null)return null;
 if(parsed.policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY_V3){
  const gas=parsed.conversion.gasEvidence,costs=record(record(row.provenance).modeledCosts);
  if(gas.reportHash!==record(row.provenance).prestateReportHash||
   gas.reportHash!==costs.reportHash||gas.scopeHash!==costs.scopeHash||
   gas.sequenceHash!==costs.sequenceHash||gas.sizeBand!==costs.sizeBand||
   contentHash(gas.profileIds)!==contentHash(costs.stages && Array.isArray(costs.stages)?
    costs.stages.map(item=>record(item).profileId):[]))return null;
 }
 const conversions=parsed.flows.filter(flow=>flow.kind==='modeled_conversion'),
  capitalOut=parsed.flows.filter(isCapitalOut),
  conversion=parsed.conversion,flow=conversions[0],assets=new Set(capitalOut.map(item=>item.asset));
 return conversions.length===1&&capitalOut.length===3&&assets.size===3&&
  ['token0','token1','native'].every(asset=>assets.has(asset as 'token0'|'token1'|'native'))&&
  flow?.quoteHash===conversion.quoteHash&&flow.fromAsset===conversion.fromAsset&&
  flow.toAsset===conversion.toAsset&&flow.fromAmountRaw===conversion.inputAmountRaw&&
  flow.expectedToAmountRaw===conversion.expectedOutputRaw&&
  flow.minimumToAmountRaw===conversion.minimumOutputRaw?parsed:null;
};
const isConvertedClose=(provenance:unknown)=>
 ['paper_model_converted_close','rangekeeper_paper_close_convert_v1']
  .includes(String(record(provenance).classification));
type PaperCapitalOut={kind:'modeled_capital_out';asset:'token0'|'token1'|'native';
 amountRaw:string;valueQuote:string};
const isCapitalOut=(flow:(PaperConversionAccountingV2|PaperConversionAccountingV3)['flows'][number]):flow is PaperCapitalOut=>
 flow.kind==='modeled_capital_out';
type DashboardAccounting=PaperAccounting|PaperConversionAccountingV2|PaperConversionAccountingV3|
 RangeKeeperPaperAccounting;
const modeledExposure=(model:DashboardAccounting,
 p:MarketProfile['pool'])=>{
 const risk=p.quoteToken===0?1:0,r=model.reference;
 if(r.price0===null||r.price1===null)return null;
 const value0=BigInt(model.inventory.token0Raw)*BigInt(r.price0)/10n**BigInt(p.decimals0),
  value1=BigInt(model.inventory.token1Raw)*BigInt(r.price1)/10n**BigInt(p.decimals1);
 return value0+value1>0n?String((risk===0?value0:value1)*1_000_000n/(value0+value1)):null;
};

/** Older dashboard databases may not have the new ledger migration. */
export async function readDeploymentRows(db:PoolClient):Promise<DeploymentRow[]>{
 const present=(await db.query<{present:string|null}>(
  "SELECT to_regclass('deployment_campaigns')::text AS present")).rows[0]?.present;
 if(!present)return [];
 const hasAccounting=(await db.query<{present:string|null}>(
  "SELECT to_regclass('deployment_paper_accounting')::text AS present")).rows[0]?.present;
 const hasFeeEvidence=(await db.query<{present:string|null}>(
  "SELECT to_regclass('deployment_paper_fee_evidence')::text AS present")).rows[0]?.present;
 const hasInvalidations=hasAccounting&&(await db.query<{present:string|null}>(
  "SELECT to_regclass('deployment_paper_accounting_invalidations')::text AS present")).rows[0]?.present;
 const hasLiveJobs=(await db.query<{present:string|null}>(
  "SELECT to_regclass('deployment_live_jobs')::text AS present")).rows[0]?.present;
 const hasLiveRuntime=(await db.query<{present:string|null}>(
  "SELECT to_regclass('deployment_live_campaign_runtime')::text AS present")).rows[0]?.present&&
  (await db.query<{present:string|null}>("SELECT to_regclass('deployment_live_runtime_events')::text AS present")).rows[0]?.present;
 const rows=(await db.query<DeploymentRow>(`
  SELECT c.id,c.mode,c.lifecycle,c.range_state,c.current_revision,c.created_at,c.closed_at,c.allocation,
   c.runtime_identity,
   ${hasLiveJobs?`live_job.id::text AS live_job_id,live_job.kind AS live_job_kind,live_job.status AS live_job_status,
    live_job.resume_stage AS live_job_resume_stage,live_job.attempt AS live_job_attempt,
    live_job.created_at AS live_job_created_at,live_job.updated_at AS live_job_updated_at,
    live_job.outbox_stage AS live_outbox_stage,live_job.outbox_nonce AS live_outbox_nonce,
    live_job.outbox_hash AS live_outbox_hash,live_job.outbox_status AS live_outbox_status,`:
    `NULL::text AS live_job_id,NULL::text AS live_job_kind,NULL::text AS live_job_status,
    NULL::text AS live_job_resume_stage,NULL::integer AS live_job_attempt,
    NULL::timestamptz AS live_job_created_at,NULL::timestamptz AS live_job_updated_at,
    NULL::text AS live_outbox_stage,NULL::text AS live_outbox_nonce,
    NULL::text AS live_outbox_hash,NULL::text AS live_outbox_status,`}
   ${hasLiveRuntime?`live.status AS live_runtime_status,live.profile_id::text AS live_profile_id,live.profile_hash AS live_runtime_profile_hash,
    live.config_hash AS live_runtime_config_hash,live.revision AS live_runtime_revision,
    live.state_json AS live_runtime_state,live.state_hash AS live_runtime_state_hash,
    live_mark.payload AS live_mark_payload,live_mark.payload_hash AS live_mark_payload_hash,
    live_mark.source_block::text AS live_mark_block,live_mark.source_hash AS live_mark_hash,
    live_mark.source_timestamp AS live_mark_timestamp,`:
    `NULL::text AS live_runtime_status,NULL::text AS live_profile_id,NULL::text AS live_runtime_profile_hash,NULL::text AS live_runtime_config_hash,
    NULL::integer AS live_runtime_revision,NULL::jsonb AS live_runtime_state,NULL::text AS live_runtime_state_hash,
    NULL::jsonb AS live_mark_payload,NULL::text AS live_mark_payload_hash,NULL::text AS live_mark_block,
    NULL::text AS live_mark_hash,NULL::bigint AS live_mark_timestamp,`}
   p.profile,r.strategy_id,r.config,m.id::text AS mark_id,m.at AS mark_at,
   m.source_block::text,m.source_hash,m.inventory,m.economics,m.provenance,
   capital.initial_value,${hasAccounting?'a.snapshot AS accounting_snapshot,a.snapshot_hash AS accounting_hash,'+
   'rk_a.snapshot AS rangekeeper_accounting_snapshot,rk_a.snapshot_hash AS rangekeeper_accounting_hash,'+
    'rk_previous.id::text AS rk_previous_mark_id,rk_previous.at AS rk_previous_mark_at,'+
    'rk_previous.source_block::text AS rk_previous_source_block,rk_previous.source_hash AS rk_previous_source_hash,'+
    'rk_previous.inventory AS rk_previous_inventory,rk_previous.economics AS rk_previous_economics,'+
    'rk_previous.provenance AS rk_previous_provenance,rk_previous.snapshot AS rk_previous_accounting_snapshot,'+
    'rk_previous.snapshot_hash AS rk_previous_accounting_hash,rk_previous.invalidated_at AS rk_previous_invalidated_at,'+
    'a2.snapshot AS conversion_accounting_snapshot,a2.snapshot_hash AS conversion_accounting_hash,':
    'NULL::jsonb AS accounting_snapshot,NULL::text AS accounting_hash,'+
    'NULL::jsonb AS rangekeeper_accounting_snapshot,NULL::text AS rangekeeper_accounting_hash,'+
    'NULL::text AS rk_previous_mark_id,NULL::timestamptz AS rk_previous_mark_at,'+
    'NULL::text AS rk_previous_source_block,NULL::text AS rk_previous_source_hash,'+
    'NULL::jsonb AS rk_previous_inventory,NULL::jsonb AS rk_previous_economics,'+
    'NULL::jsonb AS rk_previous_provenance,NULL::jsonb AS rk_previous_accounting_snapshot,NULL::text AS rk_previous_accounting_hash,NULL::timestamptz AS rk_previous_invalidated_at,'+
    'NULL::jsonb AS conversion_accounting_snapshot,NULL::text AS conversion_accounting_hash,'}
   ${hasInvalidations?'invalidated.recorded_at AS accounting_invalidated_at,invalidated.reason AS accounting_invalidation_reason,':
    'NULL::timestamptz AS accounting_invalidated_at,NULL::text AS accounting_invalidation_reason,'}
   latest_operation.id::text AS operation_id,latest_operation.kind AS operation_kind,
   latest_operation.status AS operation_status,latest_operation.stage AS operation_stage,
   latest_operation.reason AS operation_reason,latest_operation.updated_at AS operation_updated_at
  FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
  JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
  LEFT JOIN LATERAL (SELECT id,at,source_block,source_hash,inventory,economics,provenance
   FROM deployment_marks WHERE campaign_id=c.id ORDER BY id DESC LIMIT 1) m ON TRUE
  LEFT JOIN LATERAL (SELECT sum(value_raw)::text AS initial_value FROM deployment_ledger
   WHERE campaign_id=c.id AND kind='capital_in') capital ON TRUE
  LEFT JOIN LATERAL (SELECT id,kind,status,stage,reason,updated_at FROM ${hasLiveJobs?`(
   SELECT id,campaign_id,kind,status,stage,reason,updated_at FROM deployment_operations
   UNION ALL SELECT id,campaign_id,kind,status,resume_stage AS stage,NULL::text AS reason,updated_at FROM deployment_live_jobs
  ) operations`:'deployment_operations'}
  WHERE campaign_id=c.id AND (c.lifecycle<>'blocked' OR status='blocked')
   ORDER BY updated_at DESC,id DESC LIMIT 1) latest_operation ON TRUE
  ${hasLiveJobs?`LEFT JOIN LATERAL (SELECT j.id,j.kind,j.status,j.resume_stage,j.attempt,j.created_at,j.updated_at,
    o.stage AS outbox_stage,o.nonce::text AS outbox_nonce,o.signed_raw_hash AS outbox_hash,o.status AS outbox_status
    FROM deployment_live_jobs j LEFT JOIN LATERAL (SELECT stage,nonce,signed_raw_hash,status
     FROM deployment_live_stage_outbox WHERE job_id=j.id AND status<>'cancelled'
     ORDER BY created_at DESC,nonce DESC LIMIT 1) o ON TRUE
    WHERE j.campaign_id=c.id AND c.mode='live'
    ORDER BY (j.status IN ('queued','preflighting','executing','confirming','reconciling','blocked')) DESC,
     j.created_at DESC,j.fairness_sequence DESC LIMIT 1) live_job ON TRUE`:''}
  ${hasLiveRuntime?`LEFT JOIN deployment_live_campaign_runtime live ON live.campaign_id=c.id AND live.revision=c.current_revision
   LEFT JOIN LATERAL (SELECT payload,payload_hash,source_block,source_hash,source_timestamp FROM deployment_live_runtime_events
    WHERE campaign_id=c.id AND revision=c.current_revision AND
     ((kind='mark' AND payload->>'kind'='rangekeeper_live_valuation_mark_v1') OR
      (kind='closed' AND payload->'terminalValuation'->>'kind'='rangekeeper_live_valuation_mark_v1'))
    ORDER BY sequence DESC LIMIT 1) live_mark ON TRUE`:''}
  ${hasAccounting?`LEFT JOIN deployment_paper_accounting a ON a.campaign_id=c.id
   AND a.source_mark_id=m.id AND a.policy_version='${PAPER_ACCOUNTING_POLICY}'
   LEFT JOIN deployment_paper_accounting rk_a ON rk_a.campaign_id=c.id
    AND rk_a.source_mark_id=m.id AND rk_a.policy_version='rangekeeper_paper_observed_flow_v1'
   LEFT JOIN LATERAL (SELECT pm.id,pm.at,pm.source_block,pm.source_hash,pm.inventory,pm.economics,
    pm.provenance,pa.snapshot,pa.snapshot_hash,
    ${hasInvalidations?`(SELECT i.recorded_at FROM deployment_paper_accounting_invalidations i
     JOIN deployment_paper_accounting bad ON bad.id=i.accounting_id
     WHERE i.campaign_id=c.id AND bad.source_mark_id<=pm.id ORDER BY bad.source_mark_id LIMIT 1)`:'NULL::timestamptz'} AS invalidated_at
    FROM deployment_marks pm
    JOIN deployment_paper_accounting pa ON pa.campaign_id=pm.campaign_id AND pa.source_mark_id=pm.id
     AND pa.policy_version='rangekeeper_paper_observed_flow_v1'
    WHERE pm.campaign_id=c.id AND pm.revision=c.current_revision AND pm.id<m.id AND
     pm.at<=m.at AND pm.source_block IS NOT NULL AND m.source_block IS NOT NULL AND pm.source_block<=m.source_block AND
     c.mode='paper' AND r.strategy_id='rangekeeper_v1' AND c.lifecycle='active' AND
     COALESCE(pm.provenance->>'epoch',pm.provenance->'currentEpoch'->>'epoch','0')=
      COALESCE(m.provenance->>'epoch',m.provenance->'currentEpoch'->>'epoch','0') AND
     pm.provenance->>'classification' IN ('rangekeeper_paper_open_v1','rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1') AND
     (pm.inventory->'position'->>'liquidity')=(m.inventory->'position'->>'liquidity') AND
     (pm.inventory->'position'->>'tickLower')=(m.inventory->'position'->>'tickLower') AND
     (pm.inventory->'position'->>'tickUpper')=(m.inventory->'position'->>'tickUpper') AND
     COALESCE((pm.inventory->'position'->>'liquidity')::numeric,0)>0
     ${hasInvalidations?`AND NOT EXISTS(SELECT 1 FROM deployment_paper_accounting_invalidations i
      JOIN deployment_paper_accounting bad ON bad.id=i.accounting_id
      WHERE i.campaign_id=c.id AND bad.source_mark_id<=pm.id)`:''}
    ORDER BY pm.id DESC LIMIT 1) rk_previous ON TRUE
   LEFT JOIN LATERAL (SELECT (array_agg(snapshot))[1] AS snapshot,
    (array_agg(snapshot_hash))[1] AS snapshot_hash FROM deployment_paper_accounting
    WHERE campaign_id=c.id AND source_mark_id=m.id AND policy_version IN
     ('${PAPER_CONVERSION_ACCOUNTING_POLICY_V2}','${PAPER_CONVERSION_ACCOUNTING_POLICY_V3}')
    HAVING count(*)=1) a2 ON TRUE`:''}
  ${hasInvalidations?`LEFT JOIN LATERAL (
   SELECT i.recorded_at,i.reason FROM deployment_paper_accounting_invalidations i
   JOIN deployment_paper_accounting bad ON bad.id=i.accounting_id
   WHERE i.campaign_id=c.id AND bad.source_mark_id<=m.id
   ORDER BY bad.source_mark_id LIMIT 1) invalidated ON TRUE`:''}
  WHERE c.lifecycle<>'draft' AND NOT (c.mode='paper' AND c.lifecycle='closed'
   AND c.predecessor_campaign_id IS NULL AND c.predecessor_schema IS NULL
   AND r.strategy_id='static_manual_v1'
   AND r.revision=1 AND NOT EXISTS(SELECT 1 FROM deployment_operations o WHERE o.campaign_id=c.id)
   AND NOT EXISTS(SELECT 1 FROM deployment_marks dm WHERE dm.campaign_id=c.id)
   AND NOT EXISTS(SELECT 1 FROM deployment_ledger dl WHERE dl.campaign_id=c.id)
   AND NOT EXISTS(SELECT 1 FROM deployment_wallet_reservations wr WHERE wr.campaign_id=c.id)
   AND ${hasAccounting?'NOT EXISTS(SELECT 1 FROM deployment_paper_accounting pa WHERE pa.campaign_id=c.id)':'TRUE'}
   AND ${hasFeeEvidence?'NOT EXISTS(SELECT 1 FROM deployment_paper_fee_evidence fe WHERE fe.campaign_id=c.id)':'TRUE'})
   ORDER BY c.created_at DESC,c.id LIMIT 1001`)).rows;
 if(rows.length>1000)throw Error('Deployment position overview exceeds bounded row limit');
 return rows;
}

/** Reason codes recorded with a RangeKeeper paper mark when its reference was withheld. */
const markReferenceReasons=(provenance:unknown):unknown[]=>{
 const p=record(provenance),recorded=record(p.valuation).referenceUnavailable??p.referenceUnavailable;
 return Array.isArray(recorded)?recorded:[];
};
type PoolView=MarketProfile['pool'];
const bigOrZero=(value:unknown)=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)?BigInt(value):0n;
/** The accounting snapshot's own formulas, applied to the last oracle answers instead of a fresh reference. Only
 * called for a snapshot whose reference was withheld solely for freshness. */
function heldPaperEconomics(model:RangeKeeperPaperAccounting,allocation:{token0Raw:string;token1Raw:string;nativeWei:string},
 prices:{price0:bigint;price1:bigint;nativePrice:bigint},pool:PoolView){
 const amounts={token0Raw:bigOrZero(model.inventory.token0Raw),token1Raw:bigOrZero(model.inventory.token1Raw),
  nativeWei:bigOrZero(model.inventory.nativeWei)};
 const nav=valueInventory(amounts,prices,pool),
  passive=valueInventory({token0Raw:bigOrZero(allocation.token0Raw),token1Raw:bigOrZero(allocation.token1Raw),
   nativeWei:bigOrZero(allocation.nativeWei)},prices,pool),
  fees=valueInventory({token0Raw:bigOrZero(model.inventory.fee0Raw),token1Raw:bigOrZero(model.inventory.fee1Raw),nativeWei:0n},prices,pool),
  initial=model.economics.initialCapitalQuote;
 return {initialCapitalQuote:initial,netNavQuote:String(nav),passiveQuote:String(passive),
  absolutePnlQuote:initial===null?null:String(nav-BigInt(initial)),alphaQuote:String(nav-passive),
  cumulativeFeeValueQuote:String(fees),intervalFeeAccrualQuote:null,cumulativeGasExpenseQuote:null,markGasExpenseQuote:null};
}
const exposureAt=(amounts:{token0Raw:bigint;token1Raw:bigint},prices:{price0:bigint;price1:bigint},pool:PoolView)=>{
 const v0=amounts.token0Raw*prices.price0/10n**BigInt(pool.decimals0),v1=amounts.token1Raw*prices.price1/10n**BigInt(pool.decimals1),sum=v0+v1;
 return sum>0n?String((pool.quoteToken===0?v1:v0)*1_000_000n/sum):null;
};
/** The valuation block every RangeKeeper position carries: which oracle basis the headline numbers use, the age of
 * those prices, and the secondary pool-implied (indicative) NAV. */
function valuationView(input:{basis:ReferenceBasis|null;kind:ReferenceBasisKind;pool:PoolView;
 amounts:{token0Raw:bigint;token1Raw:bigint;nativeWei:bigint}|null;sqrtPriceX96:bigint|null;
 symbols:[string,string]}){
 const {basis,pool}=input,usable=(name:'token0'|'token1'|'native')=>{
  const price=basis?.feeds.find(feed=>feed.name===name)?.price;return price?BigInt(price):null;};
 const implied=input.amounts?poolImpliedValue({amounts:input.amounts,sqrtPriceX96:input.sqrtPriceX96,pool,
  quoteUsdX18:usable(pool.quoteToken===0?'token0':'token1'),nativeUsdX18:usable('native')}):null;
 return {basis:input.kind,
  priceAsOf:basis?.asOf?.updatedAt??null,priceAgeAtMarkSeconds:basis?.asOf?.ageSeconds??null,
  feeds:(basis?.feeds??[]).map(feed=>({name:feed.name,symbol:feed.name==='native'?'ETH':input.symbols[feed.name==='token0'?0:1],
   state:feed.state,updatedAt:feed.updatedAt,ageSeconds:feed.ageSeconds,strategyBasis:feed.strategyBasis})),
  freshnessReasons:basis?.freshnessReasons??[],structuralReasons:basis?.structuralReasons??[],
  poolImplied:implied?{navQuote:micro(String(implied.valueX18)),priceQuoteX18:String(implied.priceQuoteX18)}:null};
}

export function deploymentPosition(row:DeploymentRow){
 const profile=marketProfileSchema.parse(row.profile),p=profile.pool;
 const allocation=allocationSchema.parse(row.allocation),inventory=record(row.inventory),
  provenance=record(row.provenance),economics=record(row.economics),state=markPoolState(provenance),
  rkBalances=rkOpenBalances(inventory,provenance)??rkObservedBalances(inventory,provenance),
  conversionClose=isConvertedClose(provenance),
  conversionModel=row.mode==='paper'&&conversionClose?
   conversionAccounting(row,row.id,row.runtime_identity):null,
  latestRangeKeeperModel=row.mode==='paper'&&row.strategy_id==='rangekeeper_v1'?
   rangeKeeperAccounting(row,row.id,profile):null,
  priorMarkBounded=decimal(row.rk_previous_mark_id)!==null&&decimal(row.mark_id)!==null&&
   BigInt(String(row.rk_previous_mark_id))<BigInt(String(row.mark_id))&&
   decimal(row.rk_previous_source_block)!==null&&decimal(row.source_block)!==null&&
   BigInt(String(row.rk_previous_source_block))<=BigInt(String(row.source_block))&&
   row.rk_previous_mark_at instanceof Date&&row.mark_at instanceof Date&&row.rk_previous_mark_at<=row.mark_at,
  previousMarkRow:DeploymentRow|null=priorMarkBounded&&row.rk_previous_mark_id&&row.rk_previous_mark_at&&
   row.rk_previous_source_block&&row.rk_previous_source_hash?{...row,mark_id:row.rk_previous_mark_id,
    mark_at:row.rk_previous_mark_at,source_block:row.rk_previous_source_block,source_hash:row.rk_previous_source_hash,
    inventory:row.rk_previous_inventory,economics:row.rk_previous_economics,provenance:row.rk_previous_provenance,
    rangekeeper_accounting_snapshot:row.rk_previous_accounting_snapshot,
    rangekeeper_accounting_hash:row.rk_previous_accounting_hash,
    accounting_invalidated_at:row.rk_previous_invalidated_at??null,
    accounting_invalidation_reason:row.rk_previous_invalidated_at?'previous_accounting_invalidated':null}:null,
  previousRangeKeeperModel=!latestRangeKeeperModel&&row.rangekeeper_accounting_snapshot==null&&previousMarkRow?
   rangeKeeperAccounting(previousMarkRow,row.id,profile):null,
  previousSnapshotUsable=previousRangeKeeperModel!==null&&previousRangeKeeperModel.reference.eligible&&
   Date.now()-previousRangeKeeperModel.source.timestamp*1000>0,
  rangeKeeperModel=latestRangeKeeperModel??(previousSnapshotUsable?previousRangeKeeperModel:null),
  economicsFallback=rangeKeeperModel!==null&&rangeKeeperModel===previousRangeKeeperModel,
  liveModel=row.mode==='live'&&row.strategy_id==='rangekeeper_v1'?liveMarkModel(row,profile):null,
  liveView=row.mode==='live'&&row.strategy_id==='rangekeeper_v1'?liveCampaignView(row,liveModel):null,
  model=row.mode==='paper'?(rangeKeeperModel??(conversionClose?conversionModel:accounting(row,row.id))):null;
 // Display-only valuation basis for the latest RangeKeeper paper snapshot. A snapshot that withheld its economics
 // only because an oracle is past its age limit is valued at the last oracle answers; structural failures stay unavailable.
 const paperRk=row.mode==='paper'&&row.strategy_id==='rangekeeper_v1'&&latestRangeKeeperModel!==null?latestRangeKeeperModel:null,
  paperClassified=paperRk?classifyReferenceBasis({proof:paperRk.reference.proof,reasons:markReferenceReasons(provenance),
   sourceTimestamp:paperRk.source.timestamp,persistedPrices:paperRk.reference}):null,
  paperBasis:ReferenceBasis|null=paperRk&&paperClassified?(paperRk.reference.eligible?{...paperClassified,kind:'oracle_fresh',
   prices:paperClassified.prices??{price0:BigInt(paperRk.reference.price0!),price1:BigInt(paperRk.reference.price1!),
    nativePrice:BigInt(paperRk.reference.nativePrice!)}}:paperClassified):null,
  paperHeld=paperRk&&paperBasis?.kind==='last_oracle_price'&&paperBasis.prices?paperBasis.prices:null,
  heldEconomics=paperRk&&paperHeld?heldPaperEconomics(paperRk,allocation,paperHeld,profile.pool):null,
  modelEconomics=(heldEconomics&&model===paperRk?heldEconomics:model?.economics??null) as
   Record<string,string|null>|null;
 const riskIndex=p.quoteToken===0?1:0,reference=riskIndex===0?p.reference0:p.reference1,
  quoteRef=p.quoteToken===0?p.reference0:p.reference1;
 const isRangeKeeper=row.mode==='paper'&&row.strategy_id==='rangekeeper_v1',
  modelReferenceEligible=model&&(!('eligible' in model.reference)||model.reference.eligible===true),
  tokens=[{address:p.token0,symbol:symbol(p.reference0),decimals:p.decimals0,
  allocatedRaw:allocation.token0Raw,amountRaw:row.mode==='live'?liveModel?.amounts[0]??null:liveModel?.amounts[0]??model?.inventory.token0Raw??
   (['rangekeeper_paper_open_v1','rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1'].includes(String(provenance.classification))?rkBalances?.token0Raw??null:decimal(inventory.token0Raw)),
  lowerBoundRaw:row.mode==='live'?liveModel?.amounts[0]??null:decimal(record(inventory.knownLowerBound).token0Raw)??
   decimal(record(inventory.retainedPrincipalLowerBound).token0Raw)},
  {address:p.token1,symbol:symbol(p.reference1),decimals:p.decimals1,
  allocatedRaw:allocation.token1Raw,amountRaw:row.mode==='live'?liveModel?.amounts[1]??null:liveModel?.amounts[1]??model?.inventory.token1Raw??
   (['rangekeeper_paper_open_v1','rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1'].includes(String(provenance.classification))?rkBalances?.token1Raw??null:decimal(inventory.token1Raw)),
   lowerBoundRaw:row.mode==='live'?liveModel?.amounts[1]??null:decimal(record(inventory.knownLowerBound).token1Raw)??
    decimal(record(inventory.retainedPrincipalLowerBound).token1Raw)}];
 const position=record(inventory.position),liquidity=decimal(position.liquidity),
  tickLower=liveView?liveView.tickLower:typeof position.tickLower==='number'?position.tickLower:null,
  tickUpper=liveView?liveView.tickUpper:typeof position.tickUpper==='number'?position.tickUpper:null,
  hasLiquidity=liveView?liveView.hasPosition:liquidity!==null&&BigInt(liquidity)>0n;
 const tick=liveView?liveView.tick:typeof state.tick==='number'?state.tick:null,
  sqrt=liveModel?.sqrt??decimal(state.sqrtPriceX96),liveAt=Number(row.live_mark_timestamp),
  sourceAt=liveModel?new Date(liveModel.source.timestamp*1000).toISOString():
   row.mode==='live'&&Number.isSafeInteger(liveAt)&&liveAt>0?new Date(liveAt*1000).toISOString():sourceTime(provenance);
 const status=liveView?LIVE_STATUS[liveView.lifecycle](liveView.rangeState):
  row.lifecycle==='closed'?'closed':row.lifecycle==='blocked'?'blocked':
  row.lifecycle==='closing'?'exiting':row.lifecycle==='changing'?'changing':
  row.lifecycle==='paused'?'paused':row.lifecycle==='opening'?'waiting':
  !hasLiquidity?'waiting':row.range_state==='inside'?'open':
  row.range_state==='outside'?'outside':'unknown';
 const reasons:string[]=[];
 if(liveModel)reasons.push(...liveModel.missing);
 if((liveModel?.referenceBasis??paperBasis)?.kind==='last_oracle_price')reasons.push('valued_at_last_oracle_price');
 if(liveView){
  if(!liveModel&&['holding','recentering','closing'].includes(liveView.lifecycle))reasons.push('live_valuation_unavailable');
 }else if(!row.mark_id)reasons.push('first_model_mark_unavailable');
 if(hasLiquidity&&(liveView?liveView.rangeState:row.range_state)==='outside')reasons.push(
  row.strategy_id==='static_manual_v1'?'outside_range_manual_hold':'outside_range_observed');
 if(sourceAt&&Date.now()-Date.parse(sourceAt)>180000)reasons.push('source_stale');
 if(!sourceAt&&!['opening','closed'].includes(row.lifecycle))reasons.push('source_unavailable');
 if(liveView?liveView.lifecycle==='blocked':row.lifecycle==='blocked')reasons.push('operation_blocked');
 if(!liveView&&!model&&(economics.netNav===undefined||economics.netNav===null))
  reasons.push('net_economics_unavailable');
 if(row.accounting_invalidated_at)reasons.push('paper_accounting_canonical_anchor_changed');
 if((row.accounting_snapshot||row.rangekeeper_accounting_snapshot)&&!model&&!row.accounting_invalidated_at)
  reasons.push('paper_accounting_integrity');
 const costs=record(provenance.modeledCosts),close=record(costs.closeRetain),
  rkReferenceEligible=rangeKeeperModel?.reference.eligible===true;
 const lowerBoundValue=row.mode==='live'?null:isRangeKeeper&&!rkReferenceEligible?null:
   principalValue(inventory,economics,provenance,p),
  passiveTokenValue: string|null = row.mode==='live'?micro(liveModel?.passiveQuote??null):economicsFallback&&rangeKeeperModel?
   micro(rangeKeeperModel.economics.passiveQuote):isRangeKeeper&&!rkReferenceEligible?null:
   tokenReferenceValue(allocation.token0Raw,allocation.token1Raw,provenance,p);
 const conversion=conversionModel?.conversion??null,
  conversionCapitalOut=conversionModel?.flows.filter(isCapitalOut).map(flow=>({
   asset:flow.asset,amountRaw:flow.amountRaw,valueQuote:micro(flow.valueQuote),
  }))??null;
 return {id:key(row.mode,row.id),label:`${row.strategy_id==='rangekeeper_v1'?'RK':'Manual'}-${row.id.slice(0,8)}`,
  mode:row.mode,asset:symbol(reference),quote:symbol(quoteRef),fee:p.fee,
  quoteIsToken0:p.quoteToken===0,hasLiquidity,status,
  history:liveView?liveView.lifecycle==='closed':row.lifecycle==='closed',
  initialQuote:liveModel?micro(decimal((liveModel.state as RangeKeeperLiveState&{initialCapitalValue?:unknown}).initialCapitalValue==null?
   null:String((liveModel.state as RangeKeeperLiveState&{initialCapitalValue?:unknown}).initialCapitalValue))):rangeKeeperModel?micro(rangeKeeperModel.economics.initialCapitalQuote):micro(row.initial_value),
  navQuote:micro(liveModel?.navQuote??modelEconomics?.netNavQuote??null),
  holdQuote:micro(liveModel?.passiveQuote??modelEconomics?.passiveQuote??null),
  feesQuote:micro(liveModel?.feesQuote??modelEconomics?.cumulativeFeeValueQuote??null),
  gasQuote:micro(liveModel?.gasQuote??modelEconomics?.cumulativeGasExpenseQuote??null),
  swapQuote:liveModel?micro(liveModel.swapCostQuote):conversionClose?micro(conversion?.modeledSwapCostQuote??null):model&&!rangeKeeperModel?'0':null,
  exitEstimateQuote:conversionClose?micro(conversion?.boundGasCostQuote??null):micro(decimal(close.boundValue)),
  drawdownPpm:null,
  createdAt:row.created_at.toISOString(),endedAt:row.closed_at?.toISOString()??null,
  sourceAt,heartbeatAt:row.mode==='live'&&Number.isSafeInteger(liveAt)&&liveAt>0?new Date(liveAt*1000).toISOString():row.mark_at?.toISOString()??null,reasons,
  economicsSourceAt:economicsFallback&&rangeKeeperModel?new Date(rangeKeeperModel.source.timestamp*1000).toISOString():null,
  invalidatedAt:row.accounting_invalidated_at?.toISOString()??null,
  reserveQuote:null,strategy:{...record(row.config),live:row.mode==='live'},
  range:hasLiquidity&&tickLower!==null&&tickUpper!==null?rangePrices(tickLower,tickUpper,p):null,
  priceQuoteX18:sqrt?poolPrice(BigInt(sqrt),p):null,
  referencePriceQuoteX18:liveModel?liveModel.referencesAvailable?referencePrice({reference:{price0:liveModel.payload.referenceValuation.price0,
   price1:liveModel.payload.referenceValuation.price1}},p):null:economicsFallback&&rangeKeeperModel?.reference.eligible?
    referencePrice({reference:{price0:rangeKeeperModel.reference.price0,price1:rangeKeeperModel.reference.price1}},p):
    paperHeld?referencePrice({reference:{price0:String(paperHeld.price0),price1:String(paperHeld.price1)}},p):
    isRangeKeeper&&!rkReferenceEligible?null:referencePrice(provenance,p),
  inventory:{tokens,exposurePpm:liveModel&&liveModel.referencesAvailable?(()=>{
    const r=liveModel.payload.referenceValuation,v0=BigInt(liveModel.amounts[0])*BigInt(r.price0)/10n**BigInt(p.decimals0),
     v1=BigInt(liveModel.amounts[1])*BigInt(r.price1)/10n**BigInt(p.decimals1),sum=v0+v1;
    return sum?String((p.quoteToken===0?v1:v0)*1_000_000n/sum):null;
   })():paperHeld&&paperRk&&model===paperRk?exposureAt({token0Raw:bigOrZero(paperRk.inventory.token0Raw),
    token1Raw:bigOrZero(paperRk.inventory.token1Raw)},paperHeld,p):model&&modelReferenceEligible?modeledExposure(model,p):null,
   nativeWei:row.mode==='live'?liveModel?.nativeWei??null:liveModel?.nativeWei??model?.inventory.nativeWei??decimal(inventory.nativeWei),
   principalOnlyValue:micro(lowerBoundValue),passiveTokenValue:micro(passiveTokenValue)},
  tokenId:liveView?liveView.nftId:null,
  valuation:row.strategy_id==='rangekeeper_v1'?valuationView({pool:p,symbols:[symbol(p.reference0),symbol(p.reference1)],
   basis:liveModel?liveModel.referenceBasis:paperBasis,
   kind:liveModel?liveModel.referenceBasis.kind:paperBasis?paperBasis.kind:economicsFallback?'oracle_fresh':'unavailable',
   amounts:liveModel?{token0Raw:BigInt(liveModel.amounts[0]),token1Raw:BigInt(liveModel.amounts[1]),nativeWei:BigInt(liveModel.nativeTotalWei)}:
    paperRk&&model===paperRk?{token0Raw:bigOrZero(paperRk.inventory.token0Raw),token1Raw:bigOrZero(paperRk.inventory.token1Raw),
     nativeWei:bigOrZero(paperRk.inventory.nativeWei)}:null,
   sqrtPriceX96:sqrt?BigInt(sqrt):null}):null,
  accounting:liveModel?.navQuote!==null&&liveModel?.navQuote!==undefined?'recorded':model?'provisional':row.accounting_invalidated_at?'invalid':'unavailable',
  nextAction:(liveView?liveView.lifecycle==='closed':row.lifecycle==='closed')?null:
   liveView&&['queued','opening'].includes(liveView.lifecycle)?'Live opening queued; inventory and costs await canonical receipts':
   liveView?.lifecycle==='recentering'?'Automatic recenter in progress; value and range update after canonical receipts':
   liveView?.lifecycle==='closing'?'Retain-only close in progress; value is final only after canonical receipts':
   liveView?.lifecycle==='blocked'?'Live management is blocked; no further action runs until the recorded reason is resolved':
   liveModel?.navQuote!==null&&liveModel?.navQuote!==undefined?'Canonical live NAV and fee inventory from a source-bound observation; paid gas is separately recorded':
   row.mode==='live'?'Canonical live position observed; independent reference or complete fee evidence is unavailable':
   model?'Provisional modeled scenario; earned fees and paid costs remain unobserved':
    'Reference-valued principal is recorded; fee and paid-cost evidence is pending',
  deployment:{campaignId:row.id,chainId:p.chainId,pool:p.pool,strategyId:row.strategy_id,
   lifecycle:row.lifecycle,rangeState:liveView?liveView.rangeState:row.range_state,revision:row.current_revision,
   operation:liveView?.job?{id:liveView.job.id,kind:liveView.job.kind,status:liveView.job.status,
    stage:liveView.job.stage,reason:liveView.blockedReason,updatedAt:liveView.job.updatedAt}:
    {id:row.operation_id,kind:row.operation_kind,status:row.operation_status,
    stage:row.operation_stage,reason:row.operation_reason??liveView?.blockedReason??null,
    updatedAt:row.operation_updated_at?.toISOString()??null},
   ...(liveView?{live:{lifecycle:liveView.lifecycle,phase:liveView.phase,job:liveView.job,
    blockedReason:liveView.blockedReason,nftId:liveView.nftId,
    range:{state:liveView.rangeState,tick:liveView.tick,tickLower:liveView.tickLower,tickUpper:liveView.tickUpper},
    allocation:liveView.allocation,recenters:liveView.recenters,paidGasWei:liveView.paidGasWei,
    runtimeVerified:liveView.runtimeVerified,valuationAvailable:liveModel?.navQuote!=null}}:{}),
   sourceBlock:liveModel?.source.block??row.source_block,sourceHash:liveModel?.source.hash??row.source_hash,
   rangekeeper:row.strategy_id==='rangekeeper_v1'?{
    currentEpoch:Number.isInteger(provenance.epoch)?provenance.epoch:
     Number.isInteger(record(provenance.currentEpoch).epoch)?record(provenance.currentEpoch).epoch:0,
    latestMarkId:row.mark_id,latestMarkHash:row.mark_id?contentHash({revision:row.current_revision,
     source_block:row.source_block,source_hash:row.source_hash,inventory:row.inventory,
     economics:row.economics,provenance:row.provenance}):null,
    latestClassification:provenance.classification??null,
    recenterAvailable:false,...(economicsFallback?{economicsPendingCurrentMark:true,economicsMarkId:row.rk_previous_mark_id,
     economicsSourceAt:new Date(rangeKeeperModel!.source.timestamp*1000).toISOString()}:{}),
    ...(liveModel?{valuationCurrent:liveModel.referencesAvailable,
     epoch:liveModel.epoch,feeEvidenceAvailable:liveModel.feeEvidenceAvailable,missing:liveModel.missing}: {})}:null,
   token0:tokens[0],token1:tokens[1],poolTick:tick,
   lowerBoundValue:micro(lowerBoundValue),passiveTokenValue:micro(passiveTokenValue),
   conversionAccountingStatus:conversionClose?(conversionModel?'available':'unavailable'):'not_applicable',
   accounting:liveModel?{policyVersion:'rangekeeper_live_receipt_v1',classification:'canonical_receipt_backed',
    referenceEligible:liveModel.referencesAvailable,feesAvailable:liveModel.feeEvidenceAvailable,
    cumulativeGasWei:String(liveModel.state.gasSpentWei),paidGasAvailable:true,
    limitations:['live_receipt_inventory_and_source_bound_reference','gas_is_measured_receipt_cost',
     'incomplete_or_stale_reference_withholds_quote_economics']}:model?{policyVersion:model.policyVersion,classification:model.classification,
    feeEvidenceId:model.feeEvidence?.id??null,limitations:model.limitations,
    referenceEligible:'eligible' in model.reference?model.reference.eligible:null,
    retainedModeledFees:'fee0Raw' in model.inventory?{token0Raw:model.inventory.fee0Raw,
     token1Raw:model.inventory.fee1Raw}:null,
    modeledCosts:'modeledCosts' in model?{cumulativeBoundValue:micro(model.modeledCosts.cumulativeBoundValue),
     cumulativeBoundWei:model.modeledCosts.cumulativeBoundWei,paidCostsAvailable:false}:null,
    conversion:conversion?{fromAsset:conversion.fromAsset,toAsset:conversion.toAsset,inputAmountRaw:conversion.inputAmountRaw,
     expectedOutputRaw:conversion.expectedOutputRaw,minimumOutputRaw:conversion.minimumOutputRaw,
     expectedProceedsQuote:micro(conversion.expectedProceedsQuote),minimumProceedsQuote:micro(conversion.minimumProceedsQuote),
     modeledSwapCostQuote:micro(conversion.modeledSwapCostQuote),expectedGasCostQuote:micro(conversion.expectedGasCostQuote),
     boundGasCostQuote:micro(conversion.boundGasCostQuote)}:null,capitalOut:conversionCapitalOut}:null,
   accountingInvalidation:row.accounting_invalidated_at?{
    reason:row.accounting_invalidation_reason,at:row.accounting_invalidated_at.toISOString()}:null,
   unavailable:liveModel?liveModel.missing:model?model.limitations:['fee_capture','paid_gas','net_nav','alpha']}};
}

const point=(mark:DeploymentMark,profile:MarketProfile,
 allocation:{token0Raw:string;token1Raw:string;nativeWei:string},campaignId:string,
 runtimeIdentity:unknown):PositionPoint=>{
 const inv=record(mark.inventory),prov=record(mark.provenance),economics=record(mark.economics),
  sourceAt=sourceTime(prov),state=markPoolState(prov),sqrt=decimal(state.sqrtPriceX96),
  conversionClose=isConvertedClose(prov),
  rkBalances=rkOpenBalances(inv,prov)??rkObservedBalances(inv,prov),
  model=rangeKeeperAccounting(mark,campaignId,profile)??(conversionClose?
   conversionAccounting(mark,campaignId,runtimeIdentity):accounting(mark,campaignId)),
  position=record(inv.position),lower=typeof position.tickLower==='number'?position.tickLower:null,
  upper=typeof position.tickUpper==='number'?position.tickUpper:null,
  tick=typeof state.tick==='number'?state.tick:null;
 // RangeKeeper marks whose reference was withheld only for freshness are charted at the last oracle answers.
 const rkModel=model&&'markKind' in model&&model.policyVersion===RANGEKEEPER_PAPER_ACCOUNTING_POLICY?
   model as RangeKeeperPaperAccounting:null,
  heldBasis=rkModel&&!rkModel.reference.eligible?classifyReferenceBasis({proof:rkModel.reference.proof,
   reasons:markReferenceReasons(mark.provenance),sourceTimestamp:rkModel.source.timestamp,persistedPrices:rkModel.reference}):null,
  heldPrices=heldBasis?.kind==='last_oracle_price'?heldBasis.prices:null,
  pointEconomics=(rkModel&&heldPrices?heldPaperEconomics(rkModel,allocation,heldPrices,profile.pool):model?.economics??null) as
   Record<string,string|null>|null;
 if(!sourceAt||!mark.source_block||!mark.source_hash)throw Error('Deployment mark source unavailable');
 const kind=prov.classification,action=kind==='paper_model_provisional'||kind==='rangekeeper_paper_open_v1'?'enter':
  kind==='paper_model_partial_close'||kind==='paper_model_converted_close'||
   kind==='rangekeeper_paper_close_retain_v1'||kind==='rangekeeper_paper_close_convert_v1'?'exit':
   kind==='rangekeeper_paper_recenter_v1'?'recenter':'mark';
 if(!['paper_model_provisional','paper_model_principal_valuation','paper_model_partial_close',
  'rangekeeper_paper_open_v1',
  'paper_model_converted_close','rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1',
  'rangekeeper_paper_close_retain_v1','rangekeeper_paper_close_convert_v1'].includes(String(kind)))
  throw Error('Deployment mark classification unavailable');
 return {id:mark.id,sourceAt,observedAt:mark.at.toISOString(),block:mark.source_block,
  action,status:action==='exit'?'closed':'open',
  ...(kind==='rangekeeper_paper_recenter_v1'&&Number.isInteger(prov.epoch)?{epoch:prov.epoch,
   previousEpoch:prov.previousEpoch,candidateHash:prov.candidateHash}:{}),
  economicNavQuote:micro(pointEconomics?.netNavQuote??null),
  holdQuote:micro(pointEconomics?.passiveQuote??null),
  ...(rkModel?{valuationBasis:rkModel.reference.eligible?'oracle_fresh':heldBasis?.kind??'unavailable'}:{}),
  priceQuoteX18:sqrt?poolPrice(BigInt(sqrt),profile.pool):null,
  referencePriceQuoteX18:kind?.toString().startsWith('rangekeeper_paper_')&&
   (!model||!('eligible' in model.reference)||model.reference.eligible!==true)?
    (heldPrices?referencePrice({reference:{price0:String(heldPrices.price0),price1:String(heldPrices.price1)}},profile.pool):null):
   referencePrice(prov,profile.pool),
  exposurePpm:model&&(!('eligible' in model.reference)||model.reference.eligible===true)?
   modeledExposure(model,profile.pool):rkModel&&heldPrices?exposureAt({token0Raw:bigOrZero(rkModel.inventory.token0Raw),
    token1Raw:bigOrZero(rkModel.inventory.token1Raw)},heldPrices,profile.pool):null,
  inRange:tick!==null&&lower!==null&&upper!==null&&tick>=lower&&tick<upper,
  tickLower:lower,tickUpper:upper,
  rangeQuoteX18:lower!==null&&upper!==null?rangePrices(lower,upper,profile.pool):null,
  tokenBalances:[{address:profile.pool.token0,
   amountRaw:model?.inventory.token0Raw??
    (['rangekeeper_paper_open_v1','rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1'].includes(String(kind))?rkBalances?.token0Raw??null:decimal(inv.token0Raw)),
   lowerBoundRaw:decimal(record(inv.knownLowerBound).token0Raw)??
    decimal(record(inv.retainedPrincipalLowerBound).token0Raw)},
   {address:profile.pool.token1,
    amountRaw:model?.inventory.token1Raw??
     (['rangekeeper_paper_open_v1','rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1'].includes(String(kind))?rkBalances?.token1Raw??null:decimal(inv.token1Raw)),
    lowerBoundRaw:decimal(record(inv.knownLowerBound).token1Raw)??
     decimal(record(inv.retainedPrincipalLowerBound).token1Raw)}],
  principalOnlyValue:micro(kind?.toString().startsWith('rangekeeper_paper_')&&!model?null:
   principalValue(inv,economics,prov,profile.pool)),
  passiveTokenValue:micro(kind?.toString().startsWith('rangekeeper_paper_')&&!model?null:
   tokenReferenceValue(allocation.token0Raw,allocation.token1Raw,prov,profile.pool)),
  feesThisIntervalQuote:micro(model?.economics.intervalFeeAccrualQuote??null),
  gasThisMarkQuote:micro(model?.economics.markGasExpenseQuote??null),
  swapThisMarkQuote:model&&(model.policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY_V2||
   model.policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY_V3)?
   micro(model.economics.modeledSwapCostQuote):model&&
    model.policyVersion!==RANGEKEEPER_PAPER_ACCOUNTING_POLICY?'0':null,
  swapsThisMark:model&&(model.policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY_V2||
   model.policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY_V3)?1:0,
  drawdownPpm:null};
};

function livePoint(model:LiveMarkModel,profile:MarketProfile,previous:LiveMarkModel|null):PositionPoint{
 const {payload,state,source}=model,p=profile.pool,refs=record(payload.referenceValuation),
  sourceAt=new Date(source.timestamp*1000).toISOString(),closed=state.phase==='closed',
  previousFees=previous?.feeRaw??['0','0'],feeDelta0=BigInt(model.feeRaw[0])-BigInt(previousFees[0]),
  feeDelta1=BigInt(model.feeRaw[1])-BigInt(previousFees[1]),feeEligible=model.referencesAvailable&&
   feeDelta0>=0n&&feeDelta1>=0n,
  feeValue=feeEligible?String(feeDelta0*BigInt(String(refs.price0))/10n**BigInt(p.decimals0)+
   feeDelta1*BigInt(String(refs.price1))/10n**BigInt(p.decimals1)):null,
  previousBlock=previous?BigInt(previous.source.block):-1n,
  intervalCosts=model.costEvents.filter((event:any)=>BigInt(event.block)>previousBlock&&BigInt(event.block)<=BigInt(source.block)),
  gasValue=intervalCosts.some((event:any)=>event.gasValue===null)?null:
   String(intervalCosts.reduce((sum:bigint,event:any)=>sum+(event.gasValue??0n),0n)),
  swapValues=intervalCosts.map((event:any)=>event.swapFeeValue===null||event.swapShortfallValue===null?null:
   event.swapFeeValue+event.swapShortfallValue),
  swapValue=swapValues.some((value:bigint|null)=>value===null)?null:String(swapValues.reduce((sum:bigint,value:bigint|null)=>sum+(value??0n),0n)),
  tickLower=model.tickLower,tickUpper=model.tickUpper,tick=model.tick,
  tokenBalances=[{address:p.token0,amountRaw:model.amounts[0],lowerBoundRaw:model.amounts[0]},
   {address:p.token1,amountRaw:model.amounts[1],lowerBoundRaw:model.amounts[1]}],
  p0=decimal(refs.price0),p1=decimal(refs.price1),exposure=model.referencesAvailable&&p0&&p1?
   (()=>{const v0=BigInt(model.amounts[0])*BigInt(p0)/10n**BigInt(p.decimals0),v1=BigInt(model.amounts[1])*BigInt(p1)/10n**BigInt(p.decimals1),sum=v0+v1;
    return sum?String((p.quoteToken===0?v1:v0)*1_000_000n/sum):null;})():null;
 return {id:`live-mark-${source.block}-${source.hash.slice(2,10)}`,sourceAt,observedAt:sourceAt,block:source.block,
  action:closed?'exit':'mark',status:closed?'closed':'open',economicNavQuote:micro(model.navQuote),holdQuote:micro(model.passiveQuote),
  priceQuoteX18:model.sqrt?poolPrice(BigInt(model.sqrt),p):null,
  referencePriceQuoteX18:model.referencesAvailable?referencePrice({reference:{price0:refs.price0,price1:refs.price1}},p):null,
  exposurePpm:exposure,inRange:tick!==null&&tickLower!==null&&tickUpper!==null&&tick>=tickLower&&tick<tickUpper,
  tickLower,tickUpper,rangeQuoteX18:tickLower!==null&&tickUpper!==null?rangePrices(tickLower,tickUpper,p):null,
  tokenBalances,principalOnlyValue:null,passiveTokenValue:micro(model.passiveQuote),feesThisIntervalQuote:micro(feeValue),
  gasThisMarkQuote:micro(gasValue),swapThisMarkQuote:micro(swapValue),swapsThisMark:intervalCosts.some((event:any)=>event.swapFeeValue!==0n)?1:0,
  drawdownPpm:null,epoch:model.epoch,sourceHash:source.hash,feesCumulativeQuote:model.feesQuote,
  cumulativeGasQuote:model.gasQuote,accounting:model.referencesAvailable?'receipt_backed':'unavailable',
  valuationBasis:model.referenceBasis.kind,missing:model.missing};
}

/** Live work is journaled in the shared-wallet queue, not in deployment_operations. A database
 * that predates the queue returns an empty history rather than failing. Ordering uses typed
 * columns (numeric nonce, bigserial sequence) so 999 sorts before 1000. */
/** Descending order for bigint identifiers carried as text; never compare them as strings. */
const newestFirst=(a:string|null,b:string|null)=>{
 const x=BigInt(a??'-1'),y=BigInt(b??'-1');return x===y?0:x>y?-1:1;
};
export async function readLiveActivity(db:Pick<PoolClient,'query'>,campaignId:string,since:Date){
 const present=(await db.query<{present:string|null}>(
  "SELECT to_regclass('deployment_live_jobs')::text AS present")).rows[0]?.present;
 if(!present)return {events:[],recenterAttempts:0,swaps:0};
 const jobs=(await db.query<{id:string;kind:string;status:string;resume_stage:string|null;attempt:number;
  created_at:Date;updated_at:Date;sequence:string}>(`
  SELECT id::text,kind,status,resume_stage,attempt,created_at,updated_at,fairness_sequence::text AS sequence
  FROM deployment_live_jobs WHERE campaign_id=$1 AND created_at>=$2
  ORDER BY created_at DESC,fairness_sequence DESC LIMIT 1001`,[campaignId,since])).rows;
 const stages=(await db.query<{job_id:string;stage:string;nonce:string;hash:string|null;status:string;
  created_at:Date;kind:string}>(`
  SELECT o.job_id::text,o.stage,o.nonce::text,o.signed_raw_hash AS hash,o.status,o.created_at,j.kind
  FROM deployment_live_stage_outbox o JOIN deployment_live_jobs j ON j.id=o.job_id
  WHERE j.campaign_id=$1 AND o.created_at>=$2 ORDER BY o.created_at DESC,o.nonce DESC LIMIT 1001`,
  [campaignId,since])).rows;
 if(jobs.length>1000||stages.length>1000)throw Error('Live deployment activity exceeds bounded window limit');
 const events=[...jobs.map(job=>({id:job.id,kind:'job' as const,at:job.created_at.toISOString(),
   action:job.kind,status:job.status,stage:liveStageKind(job.resume_stage),reason:null,block:null,hash:null,
   nonce:null,jobId:job.id,attempt:Number.isSafeInteger(job.attempt)?job.attempt:null,sequence:job.sequence,
   scope:'deployment_live'})),
  ...stages.map(stage=>({id:`${stage.job_id}:${stage.stage}`,kind:'stage' as const,at:stage.created_at.toISOString(),
   action:liveStageKind(stage.stage)??'stage',status:stage.status,stage:liveStageKind(stage.stage),reason:null,block:null,
   hash:txHash(stage.hash),nonce:decimal(stage.nonce),jobId:stage.job_id,attempt:null,sequence:null,
   scope:'deployment_live'}))]
  .sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||(a.kind===b.kind?0:a.kind==='stage'?-1:1)||
   newestFirst(a.nonce,b.nonce)||newestFirst(a.sequence,b.sequence));
 return {events,recenterAttempts:jobs.filter(job=>job.kind==='change_range').length,
  swaps:stages.filter(stage=>liveStageKind(stage.stage)==='swap'&&stage.status==='confirmed').length};
}

export async function readDeploymentDetail(db:PoolClient,row:DeploymentRow,hours:number){
 const position=deploymentPosition(row),now=Date.now(),ended=position.endedAt?Date.parse(position.endedAt):NaN,
  windowEnd=hours===0&&Number.isFinite(ended)&&ended<=now?ended:now,
  cutoff=hours===0?0:Math.floor((windowEnd-hours*3600000)/1000),cutoffAt=hours===0?new Date(0):new Date(windowEnd-hours*3600000),
  profile=marketProfileSchema.parse(row.profile),allocation=allocationSchema.parse(row.allocation);
 const hasAccounting=(await db.query<{present:string|null}>(
  "SELECT to_regclass('deployment_paper_accounting')::text AS present")).rows[0]?.present;
 const hasInvalidations=hasAccounting&&(await db.query<{present:string|null}>(
  "SELECT to_regclass('deployment_paper_accounting_invalidations')::text AS present")).rows[0]?.present;
 const marks=(await db.query<DeploymentMark>(`
  SELECT m.id::text,m.at,m.source_block::text,m.source_hash,m.inventory,m.economics,m.provenance,
   ${hasAccounting?'a.snapshot AS accounting_snapshot,a.snapshot_hash AS accounting_hash,'+
    'rk_a.snapshot AS rangekeeper_accounting_snapshot,rk_a.snapshot_hash AS rangekeeper_accounting_hash,'+
    'a2.snapshot AS conversion_accounting_snapshot,a2.snapshot_hash AS conversion_accounting_hash':
    'NULL::jsonb AS accounting_snapshot,NULL::text AS accounting_hash,'+
    'NULL::jsonb AS rangekeeper_accounting_snapshot,NULL::text AS rangekeeper_accounting_hash,'+
    'NULL::jsonb AS conversion_accounting_snapshot,NULL::text AS conversion_accounting_hash'},
   ${hasInvalidations?'invalidated.recorded_at AS accounting_invalidated_at,invalidated.reason AS accounting_invalidation_reason':
    'NULL::timestamptz AS accounting_invalidated_at,NULL::text AS accounting_invalidation_reason'}
  FROM deployment_marks m
  ${hasAccounting?`LEFT JOIN deployment_paper_accounting a ON a.campaign_id=m.campaign_id
   AND a.source_mark_id=m.id AND a.policy_version='${PAPER_ACCOUNTING_POLICY}'
   LEFT JOIN deployment_paper_accounting rk_a ON rk_a.campaign_id=m.campaign_id
    AND rk_a.source_mark_id=m.id AND rk_a.policy_version='rangekeeper_paper_observed_flow_v1'
   LEFT JOIN LATERAL (SELECT (array_agg(snapshot))[1] AS snapshot,
    (array_agg(snapshot_hash))[1] AS snapshot_hash FROM deployment_paper_accounting
    WHERE campaign_id=m.campaign_id AND source_mark_id=m.id AND policy_version IN
     ('${PAPER_CONVERSION_ACCOUNTING_POLICY_V2}','${PAPER_CONVERSION_ACCOUNTING_POLICY_V3}')
    HAVING count(*)=1) a2 ON TRUE`:''}
  ${hasInvalidations?`LEFT JOIN LATERAL (
   SELECT i.recorded_at,i.reason FROM deployment_paper_accounting_invalidations i
   JOIN deployment_paper_accounting bad ON bad.id=i.accounting_id
   WHERE i.campaign_id=m.campaign_id AND bad.source_mark_id<=m.id
   ORDER BY bad.source_mark_id LIMIT 1) invalidated ON TRUE`:''}
  WHERE m.campaign_id=$1 AND (m.provenance->'source'->>'timestamp')::bigint >= $2
  ORDER BY m.id LIMIT 30001`,[row.id,cutoff])).rows;
 if(marks.length>30000)throw Error('Deployment mark history exceeds bounded window limit');
 let points:PositionPoint[];
 if(row.mode==='live'&&row.strategy_id==='rangekeeper_v1'){
  const hasLiveEvents=(await db.query<{present:string|null}>("SELECT to_regclass('deployment_live_runtime_events')::text AS present")).rows[0]?.present;
  if(hasLiveEvents){
   const events=(await db.query<any>(`SELECT payload,payload_hash,source_block::text AS source_block,source_hash,
    source_timestamp FROM deployment_live_runtime_events WHERE campaign_id=$1 AND revision=$2 AND
     ((kind='mark' AND payload->>'kind'='rangekeeper_live_valuation_mark_v1') OR
      (kind='closed' AND payload->'terminalValuation'->>'kind'='rangekeeper_live_valuation_mark_v1')) AND source_timestamp >= $3
    ORDER BY sequence LIMIT 30001`,[row.id,row.current_revision,cutoff])).rows;
   if(events.length>30000)throw Error('Live RangeKeeper mark history exceeds bounded window limit');
   const models=events.map(event=>liveMarkModel({...row,live_mark_payload:event.payload,
    live_mark_payload_hash:event.payload_hash,live_mark_block:event.source_block,live_mark_hash:event.source_hash,
    live_mark_timestamp:event.source_timestamp},profile,true)).filter((item):item is LiveMarkModel=>item!==null);
   let previous:LiveMarkModel|null=null;
   points=models.map(model=>{const result=livePoint(model,profile,previous);previous=model;return result;});
  }else points=[];
 }else points=marks.map(mark=>point(mark,profile,allocation,row.id,row.runtime_identity));
 const start=points.reduce((earliest,p)=>{const at=Date.parse(p.sourceAt);return Number.isFinite(at)?Math.min(earliest,at):earliest;},Date.parse(position.createdAt)),
  windowHours=hours===0?Math.max(1,(windowEnd-start)/3600000):hours;
 const baseline=position.initialQuote??'0';
 // A window beginning after entry has no opening capital flow in its selected
 // marks. Let the first visible mark establish the interval baseline.
 const window=positionWindow(points,windowHours,windowEnd,baseline,
  points[0]?.action==='enter'?position.createdAt:new Date(0).toISOString());
 const hasValues=points.some(point=>point.economicNavQuote!==null),hasLiveBaseline=row.mode!=='live'||position.initialQuote!==null;
 const performance=hasValues?hasLiveBaseline?window:{...window,rows:window.rows.map(item=>({...item,
  netPnlQuote:null,alphaQuote:null,returnBpsPerHour:null}))}:
  {...window,rows:window.rows.map(item=>({...item,netPnlQuote:null,alphaQuote:null,
   feeIncomeQuote:null,gasQuote:null,swapCostQuote:null,returnBpsPerHour:null}))};
 const events=(await db.query<{id:string;at:Date;kind:string;status:string;stage:string;reason:string|null;
  source_block:string|null}>(`
  SELECT o.id::text,o.created_at AS at,o.kind,o.status,o.stage,o.reason,
   m.source_block::text FROM deployment_operations o LEFT JOIN LATERAL
    (SELECT source_block FROM deployment_marks WHERE campaign_id=o.campaign_id
     AND provenance->>'operationId'=o.id::text ORDER BY id DESC LIMIT 1) m ON TRUE
  WHERE o.campaign_id=$1 AND o.created_at>=$2 ORDER BY o.created_at DESC,o.id LIMIT 1001`,
  [row.id,cutoffAt])).rows;
 if(events.length>1000)throw Error('Deployment activity exceeds bounded window limit');
 const activity=[...events.map(event=>({id:event.id,
  at:event.at.toISOString(),action:event.kind,status:event.status,stage:event.stage,
  reason:event.reason,block:event.source_block,hash:null,
  scope:'deployment_paper_model'})),...marks.filter(mark=>
   record(mark.provenance).classification==='paper_model_principal_valuation').map(mark=>({
   id:`mark-${mark.id}`,at:mark.at.toISOString(),action:'valuation',status:'recorded',
   stage:'principal_only',reason:null,block:mark.source_block,hash:null,
   scope:'deployment_paper_model'}))].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
 const live=row.mode==='live'?await readLiveActivity(db,row.id,cutoffAt):null;
 const rangeKeeperSwaps=marks.filter(mark=>{
  const provenance=record(mark.provenance),kind=provenance.classification;
  const amount=kind==='rangekeeper_paper_recenter_v1'?record(provenance.swap).amountIn:
   kind==='rangekeeper_paper_close_convert_v1'?record(record(mark.inventory).conversion).inputAmount:
    kind==='rangekeeper_paper_open_v1'?record(record(rkOpenModel(provenance)?.candidate).swap).amountIn:null;
  const raw=decimal(amount);return raw!==null&&BigInt(raw)>0n;
 }).length;
 return {position,performance,events:live?live.events:activity,
  counts:live?{recenters:position.deployment.live?.recenters??null,recenterAttempts:live.recenterAttempts,
   swaps:live.swaps}:
  {recenters:marks.filter(mark=>record(mark.provenance).classification==='rangekeeper_paper_recenter_v1').length,
   recenterAttempts:events.filter(event=>event.kind==='change_range').length,
   swaps:rangeKeeperSwaps+(position.deployment.conversionAccountingStatus==='available'?1:0)},
  limitations:position.accounting==='provisional'?
   ['Provisional fixed-flow paper scenario: lower integer fee allocation and scoped fork gas estimates. These are not earned fees or paid costs.',
    'Execution delay, failures and counterfactual flow changes remain unmodeled. Incomplete marks stay blank.']:
   position.accounting==='invalid'?
   ['Modeled paper history was revoked after a saved source anchor changed. Original marks and accounting snapshots remain append-only.',
    'Economics from the revoked snapshot and every dependent later snapshot are unavailable.']:
   ['Principal and idle tokens use recorded independent references. Earned fees, paid gas, native balance, net NAV and alpha are unavailable.',
    'Value and inventory charts leave incomplete series blank. Source gaps are not interpolated.',
    'Provisional fork gas is an estimate, not an expense that was paid.']};
}

export async function readDeploymentByKey(db:PoolClient,keyValue:string):Promise<DeploymentRow|null>{
 const parsed=parseKey(keyValue);if(!parsed)return null;
 const rows=await readDeploymentRows(db);
 return rows.find(row=>row.id===parsed.id&&row.mode===parsed.mode)??null;
}
