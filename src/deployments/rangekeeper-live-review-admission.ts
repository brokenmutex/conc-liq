import {z} from 'zod';
import type {Pool} from 'pg';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {contentHash,rangeKeeperLimitsSchema} from './contracts.js';
import {parseRangeKeeperConfig,rangeKeeperConfigHash} from '../strategy/rangekeeper/config.js';
import {consumeReviewAndReserve as consumeStoreReviewAndReserve,liveWalletSourceNotBefore,lookupLiveJobByRequest,
 readReview as readStoreReview,readWalletState as readStoreWalletState,recordReview as recordStoreReview} from './live-wallet-store.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const uuid=z.uuid();
const sourceSchema=z.object({block:z.string().regex(/^(0|[1-9][0-9]*)$/),
 hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),timestamp:z.number().int().positive()}).strict();

/** The explicit operator admission request contains no wallet, key, calldata,
 * profile override, or allocation override. */
export const rangeKeeperLiveReviewAdmissionInputSchema=z.object({
 reviewId:uuid,reviewHash:hash,requestId:uuid,
}).strict();
export type RangeKeeperLiveReviewAdmissionInput=z.infer<typeof rangeKeeperLiveReviewAdmissionInputSchema>;

export type RangeKeeperLiveReviewPayload={
 schemaVersion:1;kind:'rangekeeper_live_setup_preflight';mode:'live';strategyId:'rangekeeper_v1';
 status:'indicative';profileId:string;profileHash:string;input:{capitalQuoteRaw:string;fullWidthSpacings:number;limits:unknown};
 profile:Record<string,unknown>;source:z.infer<typeof sourceSchema>;
 wallet:{id:string;address:string;source:z.infer<typeof sourceSchema>;nonce:string;
  token0:{balanceRaw:string;allocatedRaw:string;pendingRaw:string;freeRaw:string};
  token1:{balanceRaw:string;allocatedRaw:string;pendingRaw:string;freeRaw:string};
  native:{balanceWei:string;allocatedWei:string;pendingWei:string;exitReserveWei:string;freeWei:string};
  commitmentsHash:string;nftTokenIds:readonly string[]};
 requirements:{token0Raw:string;token1Raw:string;nativeWei:string;strategyAllocationValueUsdX18:string};
 range:Record<string,unknown>;candidate:Record<string,unknown>;references:Record<string,unknown>;
 policy:{config:Record<string,unknown>;configHash:string;parameters:Record<string,unknown>;parametersHash:string;
  broadcastEnabled:false;signer:null};costs:Record<string,unknown>;binding:Record<string,unknown>;
 missing:readonly string[];reason:'rangekeeper_live_execution_unavailable';
 actionAvailable:false;draftCreationAvailable:false;operationAcceptanceAvailable:false;executionEligible:false;
};

const preflightSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('rangekeeper_live_setup_preflight'),
 mode:z.literal('live'),strategyId:z.literal('rangekeeper_v1'),status:z.literal('indicative'),profileId:uuid,
 profileHash:hash,input:z.object({capitalQuoteRaw:z.string().regex(/^(0|[1-9][0-9]*)$/),
 fullWidthSpacings:z.number().int().positive(),limits:rangeKeeperLimitsSchema}).passthrough(),
 profile:z.record(z.string(),z.unknown()),source:sourceSchema,
 wallet:z.object({id:z.string().min(1),address:z.string().regex(/^0x[0-9a-fA-F]{40}$/),source:sourceSchema,
 nonce:z.string().regex(/^(0|[1-9][0-9]*)$/),nftTokenIds:z.array(z.string()),
 token0:z.object({balanceRaw:z.string(),allocatedRaw:z.string(),pendingRaw:z.string(),freeRaw:z.string()}).passthrough(),
 token1:z.object({balanceRaw:z.string(),allocatedRaw:z.string(),pendingRaw:z.string(),freeRaw:z.string()}).passthrough(),
 native:z.object({balanceWei:z.string(),allocatedWei:z.string(),pendingWei:z.string(),exitReserveWei:z.string(),freeWei:z.string()}).passthrough(),
 commitmentsHash:hash}).passthrough(),
 requirements:z.object({token0Raw:z.string(),token1Raw:z.string(),nativeWei:z.string(),
 strategyAllocationValueUsdX18:z.string()}).passthrough(),range:z.record(z.string(),z.unknown()),
 candidate:z.object({expiresAt:z.number().int().positive(),kind:z.string().min(1),amount0Desired:z.string().regex(/^(0|[1-9][0-9]*)$/),
  amount1Desired:z.string().regex(/^(0|[1-9][0-9]*)$/)}).passthrough(),
 references:z.object({price0:z.string().regex(/^[1-9][0-9]*$/),price1:z.string().regex(/^[1-9][0-9]*$/),
  nativePrice:z.string().regex(/^[1-9][0-9]*$/),proofHash:hash}).passthrough(),
 policy:z.object({config:z.record(z.string(),z.unknown()),configHash:hash,parameters:z.record(z.string(),z.unknown()),
 parametersHash:hash,broadcastEnabled:z.literal(false),signer:z.null()}).strict(),
 costs:z.object({status:z.literal('estimated'),provenance:z.literal('owned_fork_allocated_lifecycle_v1'),
  feasibility:z.literal('owned_fork_success'),scope:z.literal('entry_action_only_exit_gas_reserve_only'),
  actionCostScope:z.literal('entry_action_only'),exitEconomics:z.literal('unavailable'),
  syntheticNativeFunding:z.literal(true),actionGasWei:z.string().regex(/^[1-9][0-9]*$/),
  actionCostValue:z.string().regex(/^[1-9][0-9]*$/),completeExitGasWei:z.string().regex(/^[1-9][0-9]*$/),
  exitReserveWei:z.string().regex(/^[1-9][0-9]*$/)}).passthrough(),binding:z.record(z.string(),z.unknown()),missing:z.array(z.string()),
 reason:z.literal('rangekeeper_live_execution_unavailable'),actionAvailable:z.literal(false),
 draftCreationAvailable:z.literal(false),operationAcceptanceAvailable:z.literal(false),executionEligible:z.literal(false),
}).passthrough();

export type RangeKeeperLiveReviewRecord={reviewId:string;payload:unknown;payloadHash:string;buildId:string;
 source:z.infer<typeof sourceSchema>;walletGeneration:string;commitmentsHash:string;expiresAt:string;
 consumedByJob:string|null};
export type RangeKeeperLiveWalletState={wallet:string;generation:string;status:'available'|'blocked'|'uninitialized';
 source:z.infer<typeof sourceSchema>|null;snapshotHash:string|null;commitmentsHash:string|null;
 nonce:string|null;pendingNonce:string|null;nativeBalanceWei:string|null;
 tokens:readonly {address:string;balanceRaw:string}[]};

export type RangeKeeperLiveAdmissionCampaign={mode:'live';chainId:typeof ROBINHOOD_CHAIN_ID;wallet:string;
 marketProfileId:string;strategyId:'rangekeeper_v1';strategyVersion:'1.0.0';stateSchemaVersion:1;
 allocation:{token0Raw:string;token1Raw:string;nativeWei:string};config:Record<string,unknown>;
 configHash:string;baseline:Record<string,unknown>;source:z.infer<typeof sourceSchema>};
export type RangeKeeperLiveAdmissionReservation={campaign:RangeKeeperLiveAdmissionCampaign;
 allocation:{tokens:{address:string;amountRaw:string}[];nativeSpendWei:string;exitReserveWei:string;nftTokenIds:string[]};
 source:z.infer<typeof sourceSchema>;sourceGeneration:string;
 commitmentsHash:string;reviewId:string;reviewHash:string;buildId:string;requestId:string;requestDigest:string;
 payload:RangeKeeperLiveReviewPayload};

export type RangeKeeperLiveReviewAdmissionResult=
 |{status:'review_recorded';reviewId:string;reviewHash:string;expiresAt:string;payload:RangeKeeperLiveReviewPayload}
 |{status:'queued';campaignId:string;jobId:string;allocationId?:string;replayed:boolean;executionEligible:false;
   reason:'rangekeeper_live_execution_unavailable'}
 |{status:'unavailable';missing:readonly string[];actionAvailable:false;executionEligible:false}
 |{status:'request_conflict';requestId:string;missing:readonly ['live_request_id_conflict'];executionEligible:false};

/** Concrete adapter for the wallet-scoped PostgreSQL ledger. The caller still
 * supplies pinned canonical/fork revalidation; all writes go through the
 * transactionally locked store API. */
export function createRangeKeeperLiveReviewStoreAdapter(pool:Pool,serverWallet:string){
 const wallet=serverWallet.toLowerCase();
 const identity=(address:string)=>{
  if(address.toLowerCase()!==wallet)throw new Error('Server wallet identity mismatch');
  return {chainId:4663 as const,address:wallet};
 };
 return {
  async readWalletState(address:string){
   const state=await readStoreWalletState(pool,identity(address));
   return {wallet:state.address,generation:String(state.generation),status:state.status,source:state.source,
    snapshotHash:state.snapshotHash,commitmentsHash:state.commitmentsHash,nonce:state.nonce,
    pendingNonce:state.pendingNonce,nativeBalanceWei:state.nativeBalanceWei,tokens:state.tokens};
  },
  async recordReview(input:{wallet:string;reviewId:string;payload:RangeKeeperLiveReviewPayload;reviewHash:string;
   buildId:string;source:z.infer<typeof sourceSchema>;expiresAt:string;walletGeneration:string;commitmentsHash:string}){
   await recordStoreReview(pool,{...identity(input.wallet),reviewId:input.reviewId,payload:input.payload,
    payloadHash:input.reviewHash,buildId:input.buildId,source:input.source,expiresAt:input.expiresAt,
    walletGeneration:Number(input.walletGeneration),commitmentsHash:input.commitmentsHash});
  },
  async readReview(address:string,reviewId:string):Promise<RangeKeeperLiveReviewRecord|null>{
   const review=await readStoreReview(pool,{...identity(address),reviewId});
   return review?{reviewId:review.reviewId,payload:review.payload,payloadHash:review.payloadHash,buildId:review.buildId,
    source:review.source,walletGeneration:String(review.walletGeneration),commitmentsHash:review.commitmentsHash,
    expiresAt:new Date(review.expiresAt).toISOString(),consumedByJob:review.consumedByJob}:null;
  },
  async findRequest(address:string,requestId:string,requestDigest:string){
   try{const result=await lookupLiveJobByRequest(pool,{...identity(address),requestId,requestDigest});
    return result?{status:'found' as const,campaignId:result.campaignId,jobId:result.jobId,allocationId:result.allocationId}:null;
   }catch(error){if(idempotencyConflict(error))return {status:'conflict' as const};throw error;}
  },
  async consumeReviewAndReserve(input:RangeKeeperLiveAdmissionReservation,verifySource:(source:z.infer<typeof sourceSchema>)=>Promise<void>){
   const result=await consumeStoreReviewAndReserve(pool,{...identity(input.payload.wallet.address),
    requestId:input.requestId,requestDigest:input.requestDigest,reviewId:input.reviewId,reviewHash:input.reviewHash,
    campaign:input.campaign,allocation:input.allocation,payload:input.payload,buildId:input.buildId,verifySource});
   return {status:result.replayed?'replayed' as const:'reserved' as const,campaignId:result.campaignId,
    jobId:result.jobId,allocationId:result.allocationId};
  },
 };
}

const unavailable=(...missing:string[]):RangeKeeperLiveReviewAdmissionResult=>({status:'unavailable',
 missing:[...new Set(missing)],actionAvailable:false,executionEligible:false});
const raw=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value);
const safeHash=(value:unknown):string|null=>{try{return contentHash(value);}catch{return null;}};
const hasHash=(value:unknown,expected:unknown)=>typeof expected==='string'&&safeHash(value)===expected;
const idempotencyConflict=(error:unknown)=>error instanceof Error&&error.message.includes('IDEMPOTENCY_CONFLICT');
const equalSource=(a:unknown,b:unknown)=>{
 const left=sourceSchema.safeParse(a),right=sourceSchema.safeParse(b);
 return left.success&&right.success&&left.data.block===right.data.block&&
  left.data.hash.toLowerCase()===right.data.hash.toLowerCase()&&left.data.timestamp===right.data.timestamp;
};

function validatedPayload(value:unknown):RangeKeeperLiveReviewPayload|null{
 const parsed=preflightSchema.safeParse(value);if(!parsed.success)return null;
 const row=parsed.data;
 let kernel:ReturnType<typeof parseRangeKeeperConfig>;
 let kernelHash:string;
 try{kernel=parseRangeKeeperConfig(row.policy.config);kernelHash=rangeKeeperConfigHash(kernel).slice(2);}catch{return null;}
 const profile=row.profile as {pool?:unknown;fee?:unknown;tickSpacing?:unknown;token0?:unknown;token1?:unknown;
  quoteToken?:unknown;decimals0?:unknown;decimals1?:unknown};
 const pool=kernel.pool;
 if(kernelHash!==row.policy.configHash||kernel.broadcastEnabled||kernel.signer!==null||
  kernel.operator?.toLowerCase()!==row.wallet.address.toLowerCase()||kernel.limits.fullWidthSpacings!==row.input.fullWidthSpacings||
  safeHash(row.policy.parameters.limits)===null||safeHash(row.policy.parameters.limits)!==safeHash(row.input.limits)||
  row.policy.parameters.fullWidthSpacings!==row.input.fullWidthSpacings||profile.pool!==pool.pool||profile.fee!==pool.fee||
  profile.tickSpacing!==pool.tickSpacing||profile.token0!==pool.token0||profile.token1!==pool.token1||
  profile.quoteToken!==pool.quoteToken||profile.decimals0!==pool.decimals0||profile.decimals1!==pool.decimals1)return null;
 if(row.wallet.source.block!==row.source.block||row.wallet.source.hash.toLowerCase()!==row.source.hash.toLowerCase()||
  row.wallet.source.timestamp!==row.source.timestamp||row.binding.buildId===undefined||
  typeof row.binding.buildId!=='string'||!hash.safeParse(row.binding.buildId).success||
  row.binding.walletAddress!==row.wallet.address||row.binding.walletId!==row.wallet.id||
  row.binding.profileHash!==row.profileHash||row.binding.commitmentsHash!==row.wallet.commitmentsHash||
  row.binding.configHash!==row.policy.configHash||row.binding.source===undefined||
  !equalSource(row.binding.source,row.source)||
  !hasHash(row.costs,row.binding.costsHash)||!hasHash(row.requirements,row.binding.requirementsHash)||
  !hasHash({token0Raw:row.requirements.token0Raw,
   token1Raw:row.requirements.token1Raw,nativeWei:row.requirements.nativeWei},row.binding.finalAllocationHash)||
  row.binding.referenceProofHash!==row.references.proofHash||
  !hasHash(row.policy.parameters,row.policy.parametersHash)||
  row.policy.config.broadcastEnabled!==false||row.policy.config.signer!==null||
  !raw(row.requirements.token0Raw)||!raw(row.requirements.token1Raw)||!raw(row.requirements.nativeWei)||
  !raw(row.wallet.token0.balanceRaw)||!raw(row.wallet.token0.allocatedRaw)||!raw(row.wallet.token0.pendingRaw)||
  !raw(row.wallet.token0.freeRaw)||!raw(row.wallet.token1.balanceRaw)||!raw(row.wallet.token1.allocatedRaw)||
  !raw(row.wallet.token1.pendingRaw)||!raw(row.wallet.token1.freeRaw)||
  !raw(row.wallet.native.balanceWei)||!raw(row.wallet.native.allocatedWei)||!raw(row.wallet.native.pendingWei)||
  !raw(row.wallet.native.exitReserveWei)||!raw(row.wallet.native.freeWei))return null;
 const {reviewHash:bindingReviewHash,...bindingIdentity}=row.binding;
 if(!hasHash(bindingIdentity,bindingReviewHash))return null;
 const rawItems=[
  [row.wallet.token0.balanceRaw,row.wallet.token0.allocatedRaw,row.wallet.token0.pendingRaw,row.wallet.token0.freeRaw],
  [row.wallet.token1.balanceRaw,row.wallet.token1.allocatedRaw,row.wallet.token1.pendingRaw,row.wallet.token1.freeRaw],
  [row.wallet.native.balanceWei,row.wallet.native.allocatedWei,row.wallet.native.pendingWei,row.wallet.native.exitReserveWei,row.wallet.native.freeWei],
 ];
 if(rawItems.some(([balance,allocated,pending,...rest])=>BigInt(balance!)<BigInt(allocated!)+BigInt(pending!)+
  rest.slice(0,rest.length-(rest.length===2?1:0)).reduce((sum,v)=>sum+BigInt(v!),0n)))return null;
 // Validate available balances conservatively and bind the final allocation to
 // their exact source accounting. Token free is balance minus commitments;
 // native free additionally subtracts the pre-existing exit reserve.
 if(BigInt(row.wallet.token0.balanceRaw)!-BigInt(row.wallet.token0.allocatedRaw)-BigInt(row.wallet.token0.pendingRaw)!==
  BigInt(row.wallet.token0.freeRaw)||BigInt(row.wallet.token1.balanceRaw)-BigInt(row.wallet.token1.allocatedRaw)-
  BigInt(row.wallet.token1.pendingRaw)!==BigInt(row.wallet.token1.freeRaw)||
  BigInt(row.wallet.native.balanceWei)-BigInt(row.wallet.native.allocatedWei)-BigInt(row.wallet.native.pendingWei)-
  BigInt(row.wallet.native.exitReserveWei)!==BigInt(row.wallet.native.freeWei)||
  BigInt(row.requirements.token0Raw)>BigInt(row.wallet.token0.freeRaw)||
  BigInt(row.requirements.token1Raw)>BigInt(row.wallet.token1.freeRaw)||
  BigInt(row.requirements.nativeWei)>BigInt(row.wallet.native.freeWei))return null;
 if(row.costs.managementGasReserveWei!==undefined){
  if(!raw(row.costs.managementGasReserveWei)||!raw(row.costs.fundedManagementBundles))return null;
  const count=(row.policy.config.limits as {maxRecenters?:unknown})?.maxRecenters;
  if(typeof count!=='number'||!Number.isSafeInteger(count)||count<0)return null;
  const bundles=count===0?1n:BigInt(count);
  if(BigInt(row.costs.fundedManagementBundles)!==bundles||BigInt(row.costs.managementGasReserveWei)!==
   (BigInt(row.costs.actionGasWei)+BigInt(row.costs.completeExitGasWei))*bundles)return null;
 }
 return row as unknown as RangeKeeperLiveReviewPayload;
}

/** Persist an inert, exact setup review. This creates neither a campaign nor
 * an operation/job and requires a currently persisted successful wallet read. */
export async function recordRangeKeeperLiveSetupReview(input:{wallet:string;reviewId:string;payload:unknown},deps:{
 readWalletState:(wallet:string)=>Promise<RangeKeeperLiveWalletState|null>;
 recordReview:(row:{wallet:string;reviewId:string;payload:RangeKeeperLiveReviewPayload;reviewHash:string;
  buildId:string;source:z.infer<typeof sourceSchema>;expiresAt:string;walletGeneration:string;commitmentsHash:string})=>Promise<void>;
 now?:()=>number;
}):Promise<RangeKeeperLiveReviewAdmissionResult>{
 const payload=validatedPayload(input.payload),id=uuid.safeParse(input.reviewId);
 if(!payload||!id.success||payload.wallet.address.toLowerCase()!==input.wallet.toLowerCase())
  return unavailable('live_setup_review_payload_invalid');
 const buildId=payload.binding.buildId;
 if(typeof buildId!=='string'||!hash.safeParse(buildId).success)return unavailable('runtime_build_identity_unavailable');
 const expiry=(payload.candidate as {expiresAt?:unknown}).expiresAt;
 if(typeof expiry!=='number'||!Number.isSafeInteger(expiry)||expiry*1000<=(deps.now??Date.now)())
  return unavailable('live_setup_review_expired');
 const reviewHash=safeHash(payload);if(!reviewHash)return unavailable('live_setup_review_payload_not_json_safe');
 const expiresAt=new Date(expiry*1000).toISOString();
 let state:RangeKeeperLiveWalletState|null;
 try{state=await deps.readWalletState(input.wallet);}catch{return unavailable('live_wallet_state_unavailable');}
 if(!state||state.status!=='available'||!state.source||state.wallet.toLowerCase()!==input.wallet.toLowerCase()||
  !liveWalletSourceNotBefore(state.source,payload.source)||state.commitmentsHash!==payload.wallet.commitmentsHash||
  !state.snapshotHash||!hash.safeParse(state.snapshotHash).success||!raw(state.generation)||BigInt(state.generation)<=0n||
  state.nonce!==payload.wallet.nonce||state.pendingNonce!==payload.wallet.nonce||
  state.nativeBalanceWei!==payload.wallet.native.balanceWei||
  state.tokens.find(t=>t.address.toLowerCase()===String(payload.profile.token0).toLowerCase())?.balanceRaw!==payload.wallet.token0.balanceRaw||
  state.tokens.find(t=>t.address.toLowerCase()===String(payload.profile.token1).toLowerCase())?.balanceRaw!==payload.wallet.token1.balanceRaw)
  return unavailable('live_wallet_generation_or_commitments_changed');
 try{await deps.recordReview({wallet:input.wallet,reviewId:id.data,payload,reviewHash,buildId,source:payload.source,
  expiresAt,walletGeneration:state.generation,commitmentsHash:state.commitmentsHash!});}
 catch{return unavailable('live_setup_review_persistence_failed');}
 return {status:'review_recorded',reviewId:id.data,reviewHash,expiresAt,payload};
}

/** Frozen setup admission orchestration. The injected store method is the only
 * writer and must recheck/reserve against its locked current wallet snapshot. */
export async function admitRangeKeeperLiveSetup(rawInput:unknown,deps:{
 wallet:string;buildId:string;
 readReview:(wallet:string,reviewId:string)=>Promise<RangeKeeperLiveReviewRecord|null>;
 readWalletState:(wallet:string)=>Promise<RangeKeeperLiveWalletState|null>;
 revalidatePinned:(payload:RangeKeeperLiveReviewPayload)=>Promise<unknown>;
 findRequest:(wallet:string,requestId:string,requestDigest:string)=>Promise<null|{status:'conflict'}|
  {status:'found';campaignId:string;jobId:string;allocationId:string}>;
  consumeReviewAndReserve:(input:RangeKeeperLiveAdmissionReservation,
  verifySource:(source:z.infer<typeof sourceSchema>)=>Promise<void>)=>Promise<
  {status:'conflict'}|{status:'reserved'|'replayed';campaignId:string;jobId:string;allocationId:string}>;
 verifyCanonical:(source:z.infer<typeof sourceSchema>)=>Promise<void>;
 now?:()=>number;
}):Promise<RangeKeeperLiveReviewAdmissionResult>{
 const parsed=rangeKeeperLiveReviewAdmissionInputSchema.safeParse(rawInput);
 if(!parsed.success)return unavailable('live_setup_admission_input_invalid');
 const input=parsed.data,digest=contentHash({reviewId:input.reviewId,reviewHash:input.reviewHash});
 // A fast replay lookup precedes freshness checks so exact retries remain
 // idempotent after the short-lived source/review has expired.
 try{const prior=await deps.findRequest(deps.wallet,input.requestId,digest);
  if(prior?.status==='conflict')return {status:'request_conflict',requestId:input.requestId,
   missing:['live_request_id_conflict'],executionEligible:false};
  if(prior?.status==='found')return {status:'queued',campaignId:prior.campaignId,jobId:prior.jobId,
   allocationId:prior.allocationId,replayed:true,executionEligible:false,
   reason:'rangekeeper_live_execution_unavailable'};
 }catch(error){if(idempotencyConflict(error))return {status:'request_conflict',requestId:input.requestId,
   missing:['live_request_id_conflict'],executionEligible:false};
  return unavailable('live_idempotency_lookup_unavailable');}
 let record:RangeKeeperLiveReviewRecord|null;
 try{record=await deps.readReview(deps.wallet,input.reviewId);}catch{return unavailable('live_setup_review_lookup_unavailable');}
 if(!record||record.reviewId!==input.reviewId||record.payloadHash!==input.reviewHash||!hasHash(record.payload,input.reviewHash))
  return unavailable('live_setup_review_hash_mismatch');
 const payload=validatedPayload(record.payload);
 if(!payload)return unavailable('live_setup_review_payload_invalid');
 if(payload.wallet.address.toLowerCase()!==deps.wallet.toLowerCase())return unavailable('live_setup_wallet_identity_changed');
 if(record.buildId!==deps.buildId||payload.binding.buildId!==deps.buildId)
  return unavailable('live_setup_build_changed');
 if(record.consumedByJob)return unavailable('live_setup_review_already_consumed');
 const now=(deps.now??Date.now)();
 if(Date.parse(record.expiresAt)<=now||payload.source.timestamp*1000>now||now-payload.source.timestamp*1000>180_000||
  (payload.candidate as {expiresAt:number}).expiresAt*1000<=now)
  return unavailable('live_setup_review_expired_or_stale');
 if(!equalSource(record.source,payload.source)||record.commitmentsHash!==payload.wallet.commitmentsHash)
  return unavailable('live_setup_review_binding_malformed');
 if(Date.parse(record.expiresAt)>(payload.candidate as {expiresAt:number}).expiresAt*1000)
  return unavailable('live_setup_review_expiry_exceeds_candidate');
 let state:RangeKeeperLiveWalletState|null;
 try{state=await deps.readWalletState(deps.wallet);}catch{return unavailable('live_wallet_state_unavailable');}
 // Generation is a wallet content version, so equality plus matching commitments/nonce proves nothing the review
 // depends on changed. The persisted source may only have advanced; it must not move backwards, fork, or be non-canonical.
 if(!state||state.status!=='available'||state.wallet.toLowerCase()!==deps.wallet.toLowerCase()||
  state.generation!==record.walletGeneration||state.commitmentsHash!==record.commitmentsHash||
  !state.source||!liveWalletSourceNotBefore(state.source,payload.source)||state.nonce!==payload.wallet.nonce||
  state.pendingNonce!==payload.wallet.nonce)
  return unavailable('live_wallet_changed_since_review');
 if(!equalSource(state.source,payload.source)){
  try{await deps.verifyCanonical(state.source);}catch{return unavailable('live_wallet_changed_since_review');}
 }
 let fresh:RangeKeeperLiveSetupPayload;
 try{fresh=validatedPayload(await deps.revalidatePinned(payload)) as RangeKeeperLiveSetupPayload;
  if(!fresh)return unavailable('fresh_live_setup_revalidation_unavailable');}
 catch{return unavailable('fresh_live_setup_revalidation_unavailable');}
 if(!hasHash(fresh,input.reviewHash)||fresh.profileId!==payload.profileId||fresh.profileHash!==payload.profileHash||
  fresh.binding.buildId!==payload.binding.buildId||fresh.binding.configHash!==payload.binding.configHash||
  fresh.binding.candidateHash!==payload.binding.candidateHash||fresh.binding.costsHash!==payload.binding.costsHash||
  fresh.binding.referenceProofHash!==payload.binding.referenceProofHash||
  fresh.binding.commitmentsHash!==payload.binding.commitmentsHash||
  fresh.binding.finalAllocationHash!==payload.binding.finalAllocationHash||
  fresh.binding.requirementsHash!==payload.binding.requirementsHash||
  fresh.binding.sequenceHash!==payload.binding.sequenceHash||!equalSource(fresh.source,payload.source))
  return unavailable('live_setup_evidence_changed_since_review');
 const p=fresh.profile as {token0?:unknown;token1?:unknown};
 if(typeof p.token0!=='string'||typeof p.token1!=='string')return unavailable('live_setup_profile_malformed');
 const token0=p.token0,token1=p.token1;
 const config={...fresh.policy.parameters,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1};
 const campaign:RangeKeeperLiveAdmissionCampaign={mode:'live',chainId:ROBINHOOD_CHAIN_ID,wallet:deps.wallet,
  marketProfileId:fresh.profileId,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
  allocation:{token0Raw:fresh.requirements.token0Raw,token1Raw:fresh.requirements.token1Raw,
   nativeWei:fresh.requirements.nativeWei},config,configHash:contentHash(config),
  baseline:{requirements:fresh.requirements,references:fresh.references,source:fresh.source},
  source:fresh.source};
 const reservation:RangeKeeperLiveAdmissionReservation={campaign,
  allocation:{tokens:[{address:token0,amountRaw:fresh.requirements.token0Raw},
   {address:token1,amountRaw:fresh.requirements.token1Raw}],
   nativeSpendWei:String(BigInt(fresh.costs.actionGasWei as string)+BigInt(fresh.costs.managementGasReserveWei as string??'0')),
   exitReserveWei:fresh.costs.exitReserveWei as string,
   nftTokenIds:[]},
  source:fresh.source,sourceGeneration:record.walletGeneration,commitmentsHash:record.commitmentsHash,
  reviewId:record.reviewId,reviewHash:input.reviewHash,buildId:deps.buildId,requestId:input.requestId,
  requestDigest:digest,payload:fresh};
 if(!raw(reservation.allocation.nativeSpendWei)||!raw(reservation.allocation.exitReserveWei)||
  BigInt(reservation.allocation.nativeSpendWei)+BigInt(reservation.allocation.exitReserveWei)!==BigInt(fresh.requirements.nativeWei))
  return unavailable('live_setup_gas_allocation_malformed');
 let result:Awaited<ReturnType<typeof deps.consumeReviewAndReserve>>;
 try{result=await deps.consumeReviewAndReserve(reservation,deps.verifyCanonical);}catch(error){
  if(idempotencyConflict(error))return {status:'request_conflict',requestId:input.requestId,
   missing:['live_request_id_conflict'],executionEligible:false};
  return unavailable('live_wallet_atomic_reservation_failed');}
 if(result.status==='conflict')return {status:'request_conflict',requestId:input.requestId,
  missing:['live_request_id_conflict'],executionEligible:false};
 return {status:'queued',campaignId:result.campaignId,jobId:result.jobId,allocationId:result.allocationId,
  replayed:result.status==='replayed',executionEligible:false,reason:'rangekeeper_live_execution_unavailable'};
}

type RangeKeeperLiveSetupPayload=RangeKeeperLiveReviewPayload;
