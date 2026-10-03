import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import type {Pool,PoolClient} from 'pg';
import type {Hex} from 'viem';
import {contentHash} from './contracts.js';
import {applyWalletSnapshotInTransaction,readCommitments,readReview,withLiveWalletTransaction,type LiveWalletIdentity} from './live-wallet-store.js';
import {liveWalletCommitmentFingerprint} from './live-wallet-commitment-projection.js';
import {pilotIntentSchema,verifyPilotSignature,type PilotIntent} from '../live-pilot/journal.js';
import {parseRangeKeeperJson,rangeKeeperJson} from '../strategy/rangekeeper/live-domain.js';

export type LiveJobKind='open'|'pause'|'resume'|'change_range'|'close_retain'|'close_convert';
export type LiveJobStatus='queued'|'preflighting'|'executing'|'confirming'|'reconciling'|'succeeded'|'rejected'|'blocked'|'cancelled';
export interface LiveJob {id:string;chainId:4663;wallet:string;campaignId:string;revision:number;allocationId:string;reviewId:string;
 kind:LiveJobKind;status:LiveJobStatus;priority:number;payload:unknown;payloadHash:string;buildId:string;idempotencyKey:string;
 requestDigest:string;leaseToken:string|null;leaseUntil:string|null;attempt:number;resumeStage:string|null}
export interface LiveOutbox {jobId:string;stage:string;intent:PilotIntent;plan:unknown;before:unknown;nonce:string;status:'prepared'|'signed'|'confirmed'|'reverted'|'cancelled'|'blocked';raw:Hex|null;hash:Hex|null;receipt:unknown|null;effects:unknown|null;cleanup:unknown|null}
export interface VerifiedQueueReceipt {
 receipt:unknown;receiptHash:string;proofHash:string;effects:unknown;gasWei:bigint;status:'success'|'reverted';source:{block:bigint;hash:`0x${string}`;timestamp:number};
 afterPool?:unknown;referenceValuation?:unknown;
 positionFeeEvidence?:unknown|null;
 afterWallet:{operator:string;source:{block:bigint;hash:`0x${string}`;timestamp:number};nonce:number;pendingNonce:number;nativeWei:bigint;tokens:Record<string,bigint>;nftTokenIds:string[];allowances:{token:string;spender:string;amount:bigint}[]};
 nextLiquidByTokenAddress:Record<string,bigint>;nextNativeSpendWei:bigint;nextExitReserveWei:bigint;nextNftTokenIds:string[];retiredNftTokenIds:string[];
 positionManager:string;position:{tokenId:bigint;owner:string;token0:string;token1:string;fee:number;tickLower:number;tickUpper:number;liquidity:bigint;tokensOwed0:bigint;tokensOwed1:bigint}|null;
}
export interface LiveWalletQueueAdapters {
 /** Rebuild and authorize the next strategy action from persisted campaign state and canonical wallet evidence. */
 authorizeStage:(client:PoolClient,input:{job:LiveJob;stage:string;intent:PilotIntent;plan:unknown;allocation:unknown;walletState:unknown})=>Promise<{
  intent:PilotIntent;plan:unknown;pool:unknown;authorization?:unknown;before:{walletGeneration:number;wallet:unknown;allocation:unknown;snapshot?:unknown}}>;
 /** Persist the strategy capability with the outbox under the same wallet lock. */
 persistStageAuthorization?:(client:PoolClient,input:{job:LiveJob;outbox:LiveOutbox;authorized:Awaited<ReturnType<LiveWalletQueueAdapters['authorizeStage']>>})=>Promise<void>;
 /** Must call reconcileRangeKeeperWalletReceipt with canonical readers and persisted before image. */
 reconcile:(client:PoolClient,input:{job:LiveJob;outbox:LiveOutbox;allocation:unknown;walletState:unknown})=>Promise<VerifiedQueueReceipt>;
 /** Apply campaign state/cost effects in the receipt's allocation transaction. */
 afterReceipt?:(client:PoolClient,input:{job:LiveJob;outbox:LiveOutbox;verified:VerifiedQueueReceipt})=>Promise<void>;
 /** Must reread canonical allowances/source and prove terminal operation custody; never trust caller fields. */
 verifyCleanup:(client:PoolClient,input:{job:LiveJob;allocation:unknown;walletState:unknown})=>Promise<{allowances:{token:string;spender:string;amount:string}[];allocationHash:string;source:{block:string;hash:string;timestamp:number};noPendingAction:true;custodyState:'managed'|'closed_empty'}>;
}
const terminal=new Set<LiveJobStatus>(['succeeded','rejected','blocked','cancelled']);
const lower=(s:string)=>s.toLowerCase();
const EXIT_KINDS=['pause','resume','close_retain','close_convert'];
/** Parked or blocked work is retried no sooner than this after it last yielded the wallet. */
const PARKED_RETRY_SECONDS=30;
/** Unresolved wallet transactions: an unsigned intent, signed bytes without a canonical receipt, or a blocked row. */
const UNRESOLVED_OUTBOX_SQL=`EXISTS(SELECT 1 FROM deployment_live_stage_outbox WHERE chain_id=$1 AND wallet=$2 AND
 (status IN('prepared','signed','blocked') OR (signed_raw IS NOT NULL AND canonical_receipt_json IS NULL)))`;
export interface LiveWalletLane {
 /** A job is between or inside stages and owns the wallet until it finishes, yields or blocks. */
 inflight:boolean;
 /** A transaction may exist whose canonical outcome is not yet attributed; the nonce lane is not clean. */
 unresolved:boolean;
 /** The named campaign already has queued, running or blocked queue work. */
 campaignWork:boolean;
}
/** Observation writers and management admission may proceed beside queued work and campaign-local blocked work
 * that holds no unresolved transaction, but never beside an in-flight job or an unresolved transaction. */
export async function readLiveWalletLane(db:Pick<Pool|PoolClient,'query'>,wallet:LiveWalletIdentity,campaignId?:string):Promise<LiveWalletLane>{
 const row=(await db.query<any>(`SELECT
  EXISTS(SELECT 1 FROM deployment_live_jobs WHERE chain_id=$1 AND wallet=$2 AND status IN('preflighting','executing','confirming','reconciling')) AS inflight,
  ${UNRESOLVED_OUTBOX_SQL} AS unresolved,
  ($3::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM deployment_live_jobs WHERE chain_id=$1 AND wallet=$2 AND campaign_id=$3::uuid AND
   status IN('queued','preflighting','executing','confirming','reconciling','blocked'))) AS campaign_work`,
  [wallet.chainId,lower(wallet.address),campaignId??null])).rows[0];
 return {inflight:row?.inflight===true,unresolved:row?.unresolved===true,campaignWork:row?.campaign_work===true};
}
/** NFT custody uses a canonical lowercase key even when trusted ABI/config
 * evidence carries the checksummed address spelling. */
export function normalizeLiveCustodyPositionManager(value:string):string{
 assert(/^0x[0-9a-fA-F]{40}$/.test(value),'Verified position manager address is malformed');
 return value.toLowerCase();
}
const jsonSafe=(value:unknown):unknown=>typeof value==='bigint'?value.toString():Array.isArray(value)?value.map(jsonSafe):value&&typeof value==='object'?Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([k,v])=>[k,jsonSafe(v)])):value;
function job(r:any):LiveJob{return {id:r.id,chainId:4663,wallet:r.wallet,campaignId:r.campaign_id,revision:Number(r.revision),allocationId:r.allocation_id,reviewId:r.review_id,
 kind:r.kind,status:r.status,priority:Number(r.priority),payload:r.payload,payloadHash:r.payload_hash,buildId:r.build_id,idempotencyKey:r.idempotency_key,
 requestDigest:r.request_digest,leaseToken:r.lease_token,leaseUntil:r.lease_until?new Date(r.lease_until).toISOString():null,attempt:Number(r.attempt),resumeStage:r.resume_stage};}
function outbox(r:any):LiveOutbox{return {jobId:r.job_id,stage:r.stage,intent:r.intent_json,plan:parseRangeKeeperJson(r.plan_json),before:parseRangeKeeperJson(r.before_json),nonce:String(r.nonce),status:r.status,raw:r.signed_raw,hash:r.signed_raw_hash,receipt:r.canonical_receipt_json,effects:r.effect_evidence_json,cleanup:r.allowance_cleanup_json};}
const selectJob=`SELECT * FROM deployment_live_jobs`;
async function owned(c:PoolClient,wallet:LiveWalletIdentity,id:string,token:string){
 const r=(await c.query<any>(`${selectJob} WHERE id=$1 AND chain_id=$2 AND wallet=$3 FOR UPDATE`,[id,wallet.chainId,lower(wallet.address)])).rows[0];
 assert(r,'Unknown live job');assert(r.lease_token===token&&r.lease_until&&new Date(r.lease_until).valueOf()>Date.now(),'Lease lost or expired');return job(r);
}

/** Durable single-wallet queue. This module persists verified bytes but has no signing or publishing method. */
export class LiveWalletQueue {
 constructor(private readonly pool:Pool,private readonly adapters:LiveWalletQueueAdapters){
  assert(adapters&&typeof adapters.authorizeStage==='function'&&typeof adapters.reconcile==='function'&&typeof adapters.verifyCleanup==='function',
   'Strategy authorization, canonical reconciliation, and cleanup adapters are mandatory');
 }

 /** Extend the current fenced lease; this never acquires or changes ownership. */
 async renewLease(wallet:LiveWalletIdentity,id:string,token:string,leaseMs=30_000){
  assert(Number.isInteger(leaseMs)&&leaseMs>=1000&&leaseMs<=300_000);
  return withLiveWalletTransaction(this.pool,wallet,async c=>{
   await owned(c,wallet,id,token);
   const r=await c.query<any>(`UPDATE deployment_live_jobs SET lease_until=clock_timestamp()+($4::text||' milliseconds')::interval,
    updated_at=clock_timestamp() WHERE id=$1 AND wallet=$2 AND lease_token=$3 RETURNING *`,
    [id,lower(wallet.address),token,leaseMs]);
   assert.equal(r.rowCount,1,'Lease ownership changed');return job(r.rows[0]);
  });
 }

 /** Yield a completed receipt turn without releasing this job's wallet-wide
  * ownership. The active reconciling row remains ahead of queued campaigns. */
 async yieldAfterConfirmedReceipt(wallet:LiveWalletIdentity,id:string,stage:string,token:string){
  return withLiveWalletTransaction(this.pool,wallet,async c=>{
   const current=await owned(c,wallet,id,token);assert.equal(current.status,'reconciling');
   const receipt=(await c.query<any>(`SELECT status,canonical_receipt_json,effect_evidence_json FROM deployment_live_stage_outbox
    WHERE job_id=$1 AND stage=$2 AND chain_id=$3 AND wallet=$4 FOR UPDATE`,[id,stage,wallet.chainId,lower(wallet.address)])).rows[0];
   assert(receipt?.status==='confirmed'&&receipt.canonical_receipt_json&&receipt.effect_evidence_json,
    'Only a fully attributed successful receipt can yield its lease');
   const unresolved=(await c.query<any>(`SELECT EXISTS(SELECT 1 FROM deployment_live_stage_outbox WHERE chain_id=$1 AND wallet=$2
    AND status IN('prepared','signed','blocked')) AS yes`,[wallet.chainId,lower(wallet.address)])).rows[0]?.yes;
   assert.equal(unresolved,false,'Unresolved action must retain its active lease');
   const updated=await c.query<any>(`UPDATE deployment_live_jobs SET lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE id=$1 AND chain_id=$2 AND wallet=$3 AND lease_token=$4 AND status='reconciling' RETURNING id`,
    [id,wallet.chainId,lower(wallet.address),token]);
   assert.equal(updated.rowCount,1,'Lease ownership changed while yielding');
   return {jobId:id,status:'reconciling' as const,yielded:true as const};
  });
 }

 /** Enqueue a management action against an existing campaign allocation. The
  * management review is single-use; this creates no campaign or reservation. */
 async enqueue(input:LiveWalletIdentity&{campaignId:string;revision:number;allocationId:string;reviewId:string;kind:'change_range'|'close_retain';
  priority?:number;payload:unknown;buildId:string;idempotencyKey:string;requestDigest:string}):Promise<{
   campaignId:string;jobId:string;allocationId:string;status:string;replayed:boolean;
 }>{
  assert(input.kind==='change_range'||input.kind==='close_retain');
  assert(Number.isSafeInteger(input.revision)&&input.revision>0&&/^[0-9a-f]{64}$/.test(input.buildId)&&
   /^[0-9a-f]{64}$/.test(input.requestDigest)&&/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey));
  assert(Number.isInteger(input.priority??0)&&(input.priority??0)>=0&&(input.priority??0)<=100);
  const payloadHash=contentHash(input.payload);assert(input.payload&&typeof input.payload==='object'&&
   (input.payload as any).kind==='rangekeeper_live_management_review'&&
   (input.payload as any).operationKind===input.kind&&payloadHash.length===64,'Management job payload is malformed');
  return withLiveWalletTransaction(this.pool,input,async c=>{
   const w=lower(input.address);
   const prior=(await c.query<any>(`SELECT id,campaign_id,allocation_id,status,request_digest FROM deployment_live_jobs
    WHERE chain_id=$1 AND wallet=$2 AND idempotency_key=$3 FOR UPDATE`,[input.chainId,w,input.idempotencyKey])).rows[0];
   if(prior){if(prior.request_digest!==input.requestDigest)throw new Error('IDEMPOTENCY_CONFLICT');
    assert(prior.campaign_id===input.campaignId&&prior.allocation_id===input.allocationId,'Idempotent management job binding changed');
    return {campaignId:prior.campaign_id,jobId:prior.id,allocationId:prior.allocation_id,status:prior.status,replayed:true};}
   const walletState=(await c.query<any>(`SELECT generation,status,source_block,source_hash,source_timestamp,commitments_hash
    FROM deployment_live_wallets WHERE chain_id=$1 AND wallet=$2 FOR UPDATE`,[input.chainId,w])).rows[0];
   assert(walletState?.status==='available','Live wallet is unavailable');
   // Siblings may have queued or campaign-local blocked work; only an in-flight job, an unresolved
   // transaction, or pending work for this same campaign makes the frozen review unsafe to admit.
   const lane=await readLiveWalletLane(c,input,input.campaignId);
   assert(!lane.inflight&&!lane.unresolved&&!lane.campaignWork,'Management admission requires a quiescent wallet queue');
   const campaign=(await c.query<any>(`SELECT c.lifecycle,c.current_revision,c.market_profile_id,p.profile_hash,
    r.strategy_id,r.config revision_config,r.config_hash revision_config_hash,a.state allocation_state,a.allocation_hash,
    m.config_hash,m.state_hash,m.state_revision
    FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=$2
    JOIN deployment_live_allocations a ON a.id=$3 AND a.campaign_id=c.id AND a.revision=r.revision AND a.chain_id=c.chain_id AND a.wallet=c.wallet
    JOIN deployment_live_campaign_runtime m ON m.campaign_id=c.id AND m.revision=r.revision
    WHERE c.id=$1 AND c.chain_id=$4 AND lower(c.wallet)=$5 FOR UPDATE OF c,r,a,m`,
    [input.campaignId,input.revision,input.allocationId,input.chainId,w])).rows[0];
   assert(campaign&&campaign.lifecycle==='active'&&campaign.current_revision===input.revision&&campaign.strategy_id==='rangekeeper_v1'&&
    campaign.allocation_state==='active','Management action requires the current active RangeKeeper allocation');
   const payload=input.payload as any;
   assert(payload.campaignId===input.campaignId&&payload.revision===input.revision&&payload.allocationId===input.allocationId&&
    payload.profileId===campaign.market_profile_id&&payload.profileHash===campaign.profile_hash&&payload.configHash===campaign.config_hash&&
    contentHash(campaign.revision_config)===campaign.revision_config_hash&&
    payload.runtimeStateHash===campaign.state_hash&&payload.stateRevision===Number(campaign.state_revision)&&
    payload.buildId===input.buildId&&payload.wallet?.address?.toLowerCase()===w&&
    payload.wallet?.generation===Number(walletState.generation)&&payload.wallet?.commitmentsHash===walletState.commitments_hash&&
    String(payload.source?.block)===String(walletState.source_block)&&String(payload.source?.hash).toLowerCase()===String(walletState.source_hash).toLowerCase()&&
    Number(payload.source?.timestamp)===Number(walletState.source_timestamp),
    'Management review no longer matches wallet/campaign state');
   const review=await readReview(c,{chainId:input.chainId,address:w,reviewId:input.reviewId});
   assert(review&&review.consumedByJob===null&&review.payloadHash===payloadHash&&review.buildId===input.buildId&&
    review.source.block===String(walletState.source_block)&&review.source.hash.toLowerCase()===String(walletState.source_hash).toLowerCase()&&
    review.source.timestamp===Number(walletState.source_timestamp)&&review.walletGeneration===Number(walletState.generation)&&
    review.commitmentsHash===walletState.commitments_hash,'Management review is missing, consumed, or stale');
   const dbNow=(await c.query<any>('SELECT clock_timestamp() AS now')).rows[0].now as Date;
   assert(dbNow.valueOf()<new Date(review.expiresAt).valueOf(),'Management review expired');
   const id=randomUUID();
   await c.query(`INSERT INTO deployment_live_jobs(id,chain_id,wallet,campaign_id,revision,allocation_id,review_id,kind,status,priority,
    payload,payload_hash,build_id,idempotency_key,request_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12,$13,$14)`,
    [id,input.chainId,w,input.campaignId,input.revision,input.allocationId,input.reviewId,input.kind,input.priority??0,
     input.payload,payloadHash,input.buildId,input.idempotencyKey,input.requestDigest]);
   const consumed=await c.query(`UPDATE deployment_live_reviews SET consumed_by_job=$2 WHERE id=$1 AND consumed_by_job IS NULL`,[input.reviewId,id]);
   assert.equal(consumed.rowCount,1,'Management review was consumed concurrently');
   return {campaignId:input.campaignId,jobId:id,allocationId:input.allocationId,status:'queued',replayed:false};
  });
 }

 /** Expired active work always resumes before a new operation. Within queued work, exits win and campaigns rotate to the FIFO tail.
  * A campaign-local block (no unresolved transaction) yields the single active slot to waiting sibling work. */
 async claimNext(wallet:LiveWalletIdentity,leaseMs=30_000,retry=0):Promise<{job:LiveJob;leaseToken:string;outbox:LiveOutbox|null}|null>{
  assert(Number.isInteger(leaseMs)&&leaseMs>=1000&&leaseMs<=300_000);
  try{return await withLiveWalletTransaction(this.pool,wallet,async c=>{
   const w=lower(wallet.address),active=(await c.query<any>(`${selectJob} WHERE chain_id=$1 AND wallet=$2 AND status IN('preflighting','executing','confirming','reconciling','blocked') ORDER BY updated_at LIMIT 1 FOR UPDATE`,[wallet.chainId,w])).rows[0];
   const queuedPick=async(excludeCampaign:string|null)=>(await c.query<any>(`${selectJob} WHERE chain_id=$1 AND wallet=$2 AND status='queued'
     AND ($3::uuid IS NULL OR campaign_id<>$3::uuid) AND (attempt=0 OR updated_at<=clock_timestamp()-($4::text||' seconds')::interval)
     ORDER BY CASE WHEN kind IN('pause','resume','close_retain','close_convert') THEN 0 ELSE 1 END,priority DESC,fairness_sequence LIMIT 1 FOR UPDATE SKIP LOCKED`,
     [wallet.chainId,w,excludeCampaign,String(PARKED_RETRY_SECONDS)])).rows[0];
   const walletAvailable=async()=>(await c.query<any>(`SELECT status FROM deployment_live_wallets WHERE chain_id=$1 AND wallet=$2`,[wallet.chainId,w])).rows[0]?.status==='available';
   let row=active,yielded=false;
   if(active?.status==='blocked'&&await walletAvailable()){
    const unresolved=(await c.query<any>(`SELECT ${UNRESOLVED_OUTBOX_SQL} AS yes`,[wallet.chainId,w])).rows[0]?.yes===true;
    if(!unresolved){
     // Nothing is signed or prepared, so the block is local to this campaign. Exits outrank a discretionary block;
     // otherwise a blocked job gives way to any other campaign's work and returns behind it.
     const sibling=await queuedPick(active.campaign_id);
     if(sibling&&(EXIT_KINDS.includes(sibling.kind)||!EXIT_KINDS.includes(active.kind))){
      await c.query(`UPDATE deployment_live_jobs SET status='queued',lease_token=NULL,lease_until=NULL,completed_at=NULL,
       fairness_sequence=nextval(pg_get_serial_sequence('deployment_live_jobs','fairness_sequence')),updated_at=clock_timestamp() WHERE id=$1`,[active.id]);
      row=sibling;yielded=true;
     }
    }
   }
   if(active&&!yielded){
    if(active.status==='blocked'&&!active.lease_token){
     const pending=(await c.query<any>(`SELECT * FROM deployment_live_stage_outbox WHERE job_id=$1 AND status IN('prepared','signed','blocked') ORDER BY created_at DESC LIMIT 1`,[active.id])).rows[0];
     if(!pending)return null;
    } else if(active.lease_until&&new Date(active.lease_until).valueOf()>Date.now())return null;
   } else if(!active) {
    if(!await walletAvailable())return null;
    row=await queuedPick(null);
    if(!row)return null;
   }
   const token=randomUUID(),status:LiveJobStatus=row.status==='queued'?'preflighting':row.status==='blocked'?'reconciling':row.status;
   const r=await c.query<any>(`UPDATE deployment_live_jobs SET status=$2,lease_token=$3,lease_until=clock_timestamp()+($4::text||' milliseconds')::interval,
    attempt=attempt+1,updated_at=clock_timestamp(),completed_at=NULL WHERE id=$1 RETURNING *`,[row.id,status,token,leaseMs]);
   // Fairness: move other queued jobs from this campaign behind peers after it receives a turn.
   if(!active||yielded)await c.query(`UPDATE deployment_live_jobs SET fairness_sequence=nextval(pg_get_serial_sequence('deployment_live_jobs','fairness_sequence'))
     WHERE chain_id=$1 AND wallet=$2 AND campaign_id=$3 AND id<>$4 AND status='queued'`,[wallet.chainId,w,row.campaign_id,row.id]);
   const pending=(await c.query<any>(`SELECT * FROM deployment_live_stage_outbox WHERE job_id=$1 AND status<>'cancelled' ORDER BY created_at DESC LIMIT 1`,[row.id])).rows[0];
   return {job:job(r.rows[0]),leaseToken:token,outbox:pending?outbox(pending):null};
  });}catch(error){if(retry<3&&(error as {code?:string})?.code==='40001')return this.claimNext(wallet,leaseMs,retry+1);throw error;}
 }

 /** `retryAfterMs` re-times a blocked job's retained lease so it is retried soon after a transient condition
  * instead of waiting out the whole worker lease; ownership is unchanged. */
 async transition(wallet:LiveWalletIdentity,id:string,token:string,status:Extract<LiveJobStatus,'executing'|'confirming'|'reconciling'|'blocked'|'rejected'>,resumeStage?:string,retryAfterMs?:number){
  assert(retryAfterMs===undefined||(status==='blocked'&&Number.isInteger(retryAfterMs)&&retryAfterMs>=0&&retryAfterMs<=300_000),'Retry delay applies only to a blocked job');
  return withLiveWalletTransaction(this.pool,wallet,async c=>{const current=await owned(c,wallet,id,token);
   assert(!terminal.has(current.status)||current.status==='blocked');
   if(status==='rejected'){
    const unsafe=(await c.query<any>(`SELECT EXISTS(SELECT 1 FROM deployment_live_stage_outbox WHERE job_id=$1 AND
      (signed_raw IS NOT NULL OR status NOT IN('cancelled'))) AS unsafe`,[id])).rows[0]?.unsafe;
    assert(unsafe===false,'A signed, unresolved, or unreconciled action cannot be rejected');
   }
   const completed=['blocked','rejected'].includes(status);
   const retrySql=retryAfterMs===undefined?'':",lease_until=clock_timestamp()+($7::text||' milliseconds')::interval";
   const r=await c.query<any>(`UPDATE deployment_live_jobs SET status=$4,resume_stage=coalesce($5,resume_stage),completed_at=CASE WHEN $6 THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()${retrySql}
    WHERE id=$1 AND wallet=$2 AND lease_token=$3 RETURNING *`,[id,lower(wallet.address),token,status,resumeStage??null,completed,...(retryAfterMs===undefined?[]:[String(retryAfterMs)])]);assert.equal(r.rowCount,1);return job(r.rows[0]);});
 }

 /** The persisted before image must bind the observed generation and the exact wallet/allocation snapshot. */
 async prepareStage(wallet:LiveWalletIdentity,id:string,token:string,input:{stage:string;intent:PilotIntent;plan:unknown}):Promise<LiveOutbox>{
  assert(/^[A-Za-z0-9._:-]{1,64}$/.test(input.stage));const intent=pilotIntentSchema.parse(input.intent),planJson=JSON.parse(rangeKeeperJson(input.plan)),hash=contentHash(planJson);
  return withLiveWalletTransaction(this.pool,wallet,async c=>{const current=await owned(c,wallet,id,token);assert(['preflighting','executing','reconciling'].includes(current.status));
   assert(intent.operator.toLowerCase()===lower(wallet.address)&&intent.chainId===wallet.chainId,'Intent wallet mismatch');
   const state=(await c.query<any>(`SELECT generation,status,nonce,pending_nonce,native_balance_wei,source_block,source_hash,source_timestamp FROM deployment_live_wallets WHERE chain_id=$1 AND wallet=$2 FOR UPDATE`,[wallet.chainId,lower(wallet.address)])).rows[0];
   assert(state&&state.status==='available','Wallet snapshot is not available');assert(String(state.nonce)===String(intent.nonce)&&String(state.pending_nonce)===String(intent.nonce),'Wallet nonce is not canonical');
   assert(String(state.source_block)===intent.sourceBlock&&String(state.source_hash).toLowerCase()===intent.sourceHash.toLowerCase(),'Intent source differs from persisted wallet source');
   const allocationRow=(await c.query<any>(`SELECT source_generation,source_hash FROM deployment_live_allocations WHERE id=$1 FOR UPDATE`,[current.allocationId])).rows[0];
   assert(allocationRow&&Number(allocationRow.source_generation)>0&&Number(allocationRow.source_generation)<=Number(state.generation),
    'Allocation generation is newer than the canonical wallet snapshot');
   const allocation=(await c.query<any>(`SELECT * FROM deployment_live_allocations WHERE id=$1`,[current.allocationId])).rows[0];
   const authorized=await this.adapters.authorizeStage(c,{job:current,stage:input.stage,intent,plan:input.plan,allocation,walletState:state});
   assert(contentHash(authorized.intent)===contentHash(intent)&&contentHash(JSON.parse(rangeKeeperJson(authorized.plan)))===hash,
    'Proposed transaction differs from persisted campaign strategy authorization');
   assert(authorized.before.wallet&&authorized.before.allocation&&authorized.pool&&authorized.before.walletGeneration===Number(state.generation),
    'Canonical wallet, allocation, and pool before image is required');
   const bw=authorized.before.wallet as any,ba=authorized.before.allocation as any;
   assert(String(bw.operator).toLowerCase()===lower(wallet.address)&&String(bw.source?.block)===String(state.source_block)&&
    String(bw.source?.hash).toLowerCase()===String(state.source_hash).toLowerCase()&&Number(bw.source?.timestamp)===Number(state.source_timestamp)&&
    Number(bw.nonce)===Number(state.nonce)&&Number(bw.pendingNonce)===Number(state.pending_nonce)&&
    String(bw.nativeWei)===String(state.native_balance_wei),'Before wallet differs from persisted canonical snapshot');
   const dbTokens=(await c.query<any>(`SELECT token_address,balance_raw FROM deployment_live_wallet_tokens WHERE chain_id=$1 AND wallet=$2 ORDER BY token_address`,[wallet.chainId,lower(wallet.address)])).rows;
   const beforeTokens=bw.tokens as Record<string,bigint>;
   assert(dbTokens.length===Object.keys(beforeTokens).length&&dbTokens.every(t=>beforeTokens[t.token_address]!==undefined&&String(beforeTokens[t.token_address])===String(t.balance_raw)),
    'Before wallet token balances differ from persisted canonical snapshot');
   assert(ba.campaignId===current.campaignId,'Before allocation belongs to a different campaign');
   const allocationRows=(await c.query<any>(`SELECT token_address,allocated_raw FROM deployment_live_allocation_tokens WHERE allocation_id=$1 ORDER BY token_address`,[current.allocationId])).rows;
   const beforeAllocation=ba.liquidByTokenAddress as Record<string,bigint>;
   assert(allocationRows.length===Object.keys(beforeAllocation).length&&allocationRows.every(t=>beforeAllocation[t.token_address]!==undefined&&String(beforeAllocation[t.token_address])===String(t.allocated_raw)),
    'Before campaign allocation differs from persisted reservation');
   assert(String(ba.nativeSpendWei)===String(allocation.native_spend_wei)&&String(ba.exitReserveWei)===String(allocation.exit_reserve_wei),
    'Before campaign native reserve differs from persisted allocation');
   const allocationNfts=(await c.query<any>(`SELECT token_id FROM deployment_live_nft_custody WHERE allocation_id=$1 AND status='active' ORDER BY token_id`,[current.allocationId])).rows.map((r:any)=>String(r.token_id));
   assert(JSON.stringify(allocationNfts)===JSON.stringify((ba.nftTokenIds as string[]).map(String).sort()),'Before campaign NFT custody differs from allocation ledger');
   await owned(c,wallet,id,token);
   const frozenPlan=JSON.parse(rangeKeeperJson(authorized.plan)),frozenBefore=JSON.parse(rangeKeeperJson({...authorized.before,pool:authorized.before.snapshot??authorized.pool,planHash:hash,
    ...(authorized.authorization?{authorization:authorized.authorization}:{})}));
   const old=(await c.query<any>(`SELECT * FROM deployment_live_stage_outbox WHERE job_id=$1 AND stage=$2 FOR UPDATE`,[id,input.stage])).rows[0];
   if(old){assert.equal(contentHash({intent:old.intent_json,plan:old.plan_json,before:old.before_json}),contentHash({intent,plan:frozenPlan,before:frozenBefore}),'Stage already frozen differently');return outbox(old);}
   const r=await c.query<any>(`INSERT INTO deployment_live_stage_outbox(job_id,stage,chain_id,wallet,intent_json,plan_json,before_json,nonce,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'prepared') RETURNING *`,[id,input.stage,wallet.chainId,lower(wallet.address),jsonSafe(intent),frozenPlan,frozenBefore,String(intent.nonce)]);
   if(authorized.authorization){
    assert(this.adapters.persistStageAuthorization,'Strategy authorization persistence is mandatory');
    await this.adapters.persistStageAuthorization(c,{job:current,outbox:outbox(r.rows[0]),authorized});
   }
   await c.query(`UPDATE deployment_live_jobs SET status='executing',resume_stage=$2,updated_at=clock_timestamp() WHERE id=$1`,[id,input.stage]);return outbox(r.rows[0]);
  });
 }

 async recordSigned(wallet:LiveWalletIdentity,id:string,stage:string,token:string,raw:Hex){
  return withLiveWalletTransaction(this.pool,wallet,async c=>{await owned(c,wallet,id,token);
   const r=(await c.query<any>(`SELECT * FROM deployment_live_stage_outbox WHERE job_id=$1 AND stage=$2 FOR UPDATE`,[id,stage])).rows[0];assert(r,'Unknown outbox stage');
   const hash=await verifyPilotSignature(pilotIntentSchema.parse(r.intent_json),raw);if(r.status==='signed'){assert.equal(r.signed_raw,raw.toLowerCase(),'Different signed bytes already persisted');assert.equal(r.signed_raw_hash,hash);return outbox(r);}
   assert.equal(r.status,'prepared','Only a prepared stage can be signed');
   const updated=await c.query<any>(`UPDATE deployment_live_stage_outbox SET signed_raw=$3,signed_raw_hash=$4,status='signed',updated_at=clock_timestamp() WHERE job_id=$1 AND stage=$2 AND status='prepared' RETURNING *`,[id,stage,raw.toLowerCase(),hash]);assert.equal(updated.rowCount,1);return outbox(updated.rows[0]);
  });
 }

 /** Unsigned intent cancellation frees its nonce. Persisted signed bytes can never be cancelled or replaced. */
 async cancelPrepared(wallet:LiveWalletIdentity,id:string,stage:string,token:string){
  return withLiveWalletTransaction(this.pool,wallet,async c=>{await owned(c,wallet,id,token);const r=await c.query(`UPDATE deployment_live_stage_outbox SET status='cancelled',updated_at=clock_timestamp() WHERE job_id=$1 AND stage=$2 AND status='prepared' AND signed_raw IS NULL`,[id,stage]);assert.equal(r.rowCount,1,'Cannot cancel signed or resolved outbox');});
 }

 /** Queued follow-up work has no transaction or new reservation to recover. */
 async cancelQueued(wallet:LiveWalletIdentity,id:string){
  return withLiveWalletTransaction(this.pool,wallet,async c=>{
   const r=(await c.query<any>(`SELECT * FROM deployment_live_jobs WHERE id=$1 AND chain_id=$2 AND wallet=$3 FOR UPDATE`,[id,wallet.chainId,lower(wallet.address)])).rows[0];
   assert(r&&r.status==='queued'&&r.kind!=='open','Only unclaimed follow-up work can be cancelled');
   const hasOutbox=(await c.query<any>(`SELECT EXISTS(SELECT 1 FROM deployment_live_stage_outbox WHERE job_id=$1) AS yes`,[id])).rows[0]?.yes;
   assert(hasOutbox===false,'Queued work with a persisted action cannot be cancelled');
   await c.query(`UPDATE deployment_live_jobs SET status='cancelled',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[id]);
   return {jobId:id,status:'cancelled' as const};
  });
 }

 async readPersistedRaw(wallet:LiveWalletIdentity,id:string,stage:string):Promise<{raw:Hex;hash:Hex;intent:PilotIntent}|null>{
  return withLiveWalletTransaction(this.pool,wallet,async c=>{const r=(await c.query<any>(`SELECT signed_raw,signed_raw_hash,intent_json FROM deployment_live_stage_outbox WHERE job_id=$1 AND stage=$2 AND chain_id=$3 AND wallet=$4`,[id,stage,wallet.chainId,lower(wallet.address)])).rows[0];
   if(!r?.signed_raw)return null;const hash=await verifyPilotSignature(pilotIntentSchema.parse(r.intent_json),r.signed_raw as Hex);assert.equal(hash,r.signed_raw_hash,'Persisted raw/hash mismatch');return {raw:r.signed_raw,hash,intent:r.intent_json};});
 }

 /** Invoke the configured canonical reducer and atomically persist its whole-wallet attribution. */
 async reconcileStage(wallet:LiveWalletIdentity,id:string,stage:string,token:string){
  return withLiveWalletTransaction(this.pool,wallet,async c=>{
   const current=await owned(c,wallet,id,token);
   const row=(await c.query<any>(`SELECT * FROM deployment_live_stage_outbox WHERE job_id=$1 AND stage=$2 FOR UPDATE`,[id,stage])).rows[0];assert(row?.signed_raw,'Receipt must reconcile a persisted signed action');
   if(row.canonical_receipt_json)return outbox(row);
   assert(['signed','blocked'].includes(row.status));
   const state=(await c.query<any>(`SELECT * FROM deployment_live_wallets WHERE chain_id=$1 AND wallet=$2 FOR UPDATE`,[wallet.chainId,lower(wallet.address)])).rows[0];
   assert(state&&(state.status==='available'||state.status==='blocked'),'Wallet snapshot is not initialized');
   const allocation=(await c.query<any>(`SELECT * FROM deployment_live_allocations WHERE id=$1 AND chain_id=$2 AND wallet=$3 FOR UPDATE`,[current.allocationId,wallet.chainId,lower(wallet.address)])).rows[0];assert(allocation);
   const allocationTokens=(await c.query<any>(`SELECT token_address,allocated_raw,pending_spend_raw FROM deployment_live_allocation_tokens WHERE allocation_id=$1 ORDER BY token_address FOR UPDATE`,[current.allocationId])).rows;
   const verified=await this.adapters.reconcile(c,{job:current,outbox:outbox(row),allocation:{...allocation,tokens:allocationTokens},walletState:state}) as VerifiedQueueReceipt;
   assert(/^[0-9a-f]{64}$/.test(verified.receiptHash)&&/^[0-9a-f]{64}$/.test(verified.proofHash));
   assert(verified.afterWallet.operator.toLowerCase()===lower(wallet.address)&&verified.afterWallet.nonce===Number(row.nonce)+1,'Reducer wallet/nonce binding mismatch');
   assert(verified.source.block===verified.afterWallet.source.block&&verified.source.hash.toLowerCase()===verified.afterWallet.source.hash.toLowerCase(),'Reducer source mismatch');
   const before=parseRangeKeeperJson<any>(row.before_json);assert(Number(before.walletGeneration)===Number(state.generation),'Persisted before generation is stale');
   assert(verified.source.block>BigInt(before.wallet.source.block)&&verified.afterWallet.pendingNonce===verified.afterWallet.nonce,
    'Receipt source or pending nonce is not canonical');
   assert(BigInt(before.wallet.nativeWei)-verified.afterWallet.nativeWei===verified.gasWei,'Whole-wallet native delta does not equal canonical gas');
   assert(BigInt(before.allocation.nativeSpendWei)+BigInt(before.allocation.exitReserveWei)-verified.gasWei===
    verified.nextNativeSpendWei+verified.nextExitReserveWei,'Campaign native attribution does not conserve gas spend');
   const walletTokenRows=(await c.query<any>(`SELECT token_address FROM deployment_live_wallet_tokens WHERE chain_id=$1 AND wallet=$2 ORDER BY token_address`,[wallet.chainId,lower(wallet.address)])).rows;
   assert(walletTokenRows.length===Object.keys(before.wallet.tokens).length&&walletTokenRows.length===Object.keys(verified.afterWallet.tokens).length&&
    walletTokenRows.every(t=>t.token_address in verified.afterWallet.tokens),'Reducer wallet token scope changed');
   const oldManaged=(before.allocation.nftTokenIds as string[]).map(String),newManaged=verified.nextNftTokenIds.map(String),retiredIds=verified.retiredNftTokenIds.map(String);
   const expectedWalletNfts=(before.wallet.nftTokenIds as string[]).map(String);
   expectedWalletNfts.push(...newManaged.filter(n=>!oldManaged.includes(n)));
   assert(JSON.stringify([...expectedWalletNfts].sort())===JSON.stringify([...verified.afterWallet.nftTokenIds.map(String)].sort()),'Reducer NFT delta differs from whole-wallet snapshot');
   const nextTokens=Object.entries(verified.nextLiquidByTokenAddress).map(([address,value])=>({address:address.toLowerCase(),value}));
   assert(nextTokens.length===allocationTokens.length&&nextTokens.every(t=>typeof t.value==='bigint'&&t.value>=0n),'Reducer allocation token scope changed');
   for(const t of nextTokens){const r=await c.query(`UPDATE deployment_live_allocation_tokens SET allocated_raw=$3,pending_spend_raw=0
     WHERE allocation_id=$1 AND token_address=$2`,[current.allocationId,t.address,t.value.toString()]);assert.equal(r.rowCount,1,'Reducer returned an unknown allocation token');}
   assert(verified.nextNativeSpendWei>=0n&&verified.nextExitReserveWei>=0n);
   await c.query(`UPDATE deployment_live_allocations SET native_spend_wei=$2,pending_native_spend_wei=0,exit_reserve_wei=$3,
     source_hash=$4,updated_at=clock_timestamp() WHERE id=$1`,[current.allocationId,verified.nextNativeSpendWei.toString(),verified.nextExitReserveWei.toString(),verified.source.hash]);
   const manager=normalizeLiveCustodyPositionManager(verified.positionManager);
   const managed=[...verified.nextNftTokenIds],retired=[...verified.retiredNftTokenIds];
   assert(new Set([...managed,...retired]).size===managed.length+retired.length&&managed.length<=1,'Unexpected RangeKeeper NFT custody set');
   const ownedNfts=(await c.query<any>(`SELECT position_manager,token_id FROM deployment_live_nft_custody WHERE allocation_id=$1 FOR UPDATE`,[current.allocationId])).rows;
   for(const n of ownedNfts)if(retired.includes(String(n.token_id))){const r=await c.query(`UPDATE deployment_live_nft_custody SET status='retired_empty',liquidity=0,tokens_owed0=0,tokens_owed1=0,source_block=$5,source_hash=$6,source_timestamp=$7
     WHERE allocation_id=$1 AND position_manager=$2 AND token_id=$3 AND chain_id=$4`,[current.allocationId,n.position_manager,String(n.token_id),wallet.chainId,String(verified.source.block),verified.source.hash,verified.source.timestamp]);assert.equal(r.rowCount,1,'Retired NFT ownership changed');}
   if(managed.length){const p=verified.position;assert(p&&String(p.tokenId)===managed[0]&&p.owner.toLowerCase()===lower(wallet.address),'Managed NFT lacks canonical position evidence');
    const existing=ownedNfts.some(n=>String(n.token_id)===managed[0]);
   if(existing){const r=await c.query(`UPDATE deployment_live_nft_custody SET status='active',liquidity=$5,tokens_owed0=$6,tokens_owed1=$7,source_block=$8,source_hash=$9,source_timestamp=$10 WHERE allocation_id=$1 AND position_manager=$2 AND token_id=$3 AND chain_id=$4`,
    [current.allocationId,manager,managed[0],wallet.chainId,p.liquidity.toString(),p.tokensOwed0.toString(),p.tokensOwed1.toString(),String(verified.source.block),verified.source.hash,verified.source.timestamp]);assert.equal(r.rowCount,1,'Managed NFT ownership changed');}
    else await c.query(`INSERT INTO deployment_live_nft_custody(chain_id,wallet,position_manager,token_id,allocation_id,campaign_id,status,liquidity,tokens_owed0,tokens_owed1,source_block,source_hash,source_timestamp)
     VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11,$12)`,[wallet.chainId,lower(wallet.address),manager,managed[0],current.allocationId,current.campaignId,p.liquidity.toString(),p.tokensOwed0.toString(),p.tokensOwed1.toString(),String(verified.source.block),verified.source.hash,verified.source.timestamp]);
   }
   const commitmentsHash=liveWalletCommitmentFingerprint(await readCommitments(c,wallet));
   const nextState=await applyWalletSnapshotInTransaction(c,{...wallet,source:{block:String(verified.source.block),hash:verified.source.hash,timestamp:verified.source.timestamp},
    nonce:String(verified.afterWallet.nonce),pendingNonce:String(verified.afterWallet.pendingNonce),nativeBalanceWei:verified.afterWallet.nativeWei.toString(),
    tokens:Object.entries(verified.afterWallet.tokens).map(([address,balance])=>({address:address.toLowerCase(),balanceRaw:balance.toString()})),commitmentsHash,status:'available',
    effectProof:{priorSnapshotHash:state.snapshot_hash,operationId:contentHash({jobId:id,stage}),evidenceHash:verified.proofHash}});
   const allocationHash=contentHash({tokens:nextTokens.map(t=>({address:t.address,amountRaw:t.value.toString()})).sort((a,b)=>a.address.localeCompare(b.address)),
    nativeSpendWei:verified.nextNativeSpendWei.toString(),exitReserveWei:verified.nextExitReserveWei.toString(),nftTokenIds:[...managed,...retired].sort()});
   await c.query(`UPDATE deployment_live_allocations SET source_generation=$2,allocation_hash=$3,updated_at=clock_timestamp() WHERE id=$1`,[current.allocationId,nextState.generation,allocationHash]);
   const status=verified.status==='success'?'confirmed':'reverted';
   const evidence={proofHash:verified.proofHash,receiptHash:verified.receiptHash,effects:jsonSafe(verified.effects),source:{block:String(verified.source.block),hash:verified.source.hash,timestamp:verified.source.timestamp},
    nonce:verified.afterWallet.nonce,gasWei:verified.gasWei.toString(),afterWallet:jsonSafe(verified.afterWallet),
    ...(verified.afterPool?{afterPool:JSON.parse(rangeKeeperJson(verified.afterPool))}:{}),
    ...(verified.referenceValuation?{referenceValuation:jsonSafe(verified.referenceValuation)}:{}),
    ...(verified.positionFeeEvidence!==undefined?{positionFeeEvidence:jsonSafe(verified.positionFeeEvidence)}:{})};
   const persisted=await c.query<any>(`UPDATE deployment_live_stage_outbox SET status=$3,canonical_receipt_json=$4,effect_evidence_json=$5,updated_at=clock_timestamp()
    WHERE job_id=$1 AND stage=$2 RETURNING *`,[id,stage,status,jsonSafe({receipt:verified.receipt,receiptHash:verified.receiptHash,proofHash:verified.proofHash,source:evidence.source}),jsonSafe(evidence)]);
   await c.query(`UPDATE deployment_live_jobs SET status=$2,completed_at=CASE WHEN $2='blocked' THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp() WHERE id=$1`,[id,verified.status==='success'?'reconciling':'blocked']);
   if(this.adapters.afterReceipt)await this.adapters.afterReceipt(c,{job:current,outbox:outbox(persisted.rows[0]),verified});
   return outbox(persisted.rows[0]);
  });
 }

 /** Explicit success cleanup proof is required before releasing queue ownership. */
 async finish(wallet:LiveWalletIdentity,id:string,token:string){
  return withLiveWalletTransaction(this.pool,wallet,async c=>{const current=await owned(c,wallet,id,token);
   const allocation=(await c.query<any>(`SELECT * FROM deployment_live_allocations WHERE id=$1 FOR UPDATE`,[current.allocationId])).rows[0];assert(allocation);
   const state=(await c.query<any>(`SELECT * FROM deployment_live_wallets WHERE chain_id=$1 AND wallet=$2 FOR UPDATE`,[wallet.chainId,lower(wallet.address)])).rows[0];
   const proof=await this.adapters.verifyCleanup(c,{job:current,allocation,walletState:state});
   assert(proof.noPendingAction===true&&/^[0-9a-f]{64}$/.test(proof.allocationHash)&&proof.allowances.length>0&&proof.allowances.length<=64,
    'Nonempty canonical cleanup evidence is required');
   assert(proof.allowances.every(a=>/^(0|[1-9][0-9]*)$/.test(a.amount)&&BigInt(a.amount)===0n));
   assert(proof.allocationHash===allocation.allocation_hash,'Cleanup allocation hash mismatch');
   assert(String(proof.source.block)===String(state.source_block)&&proof.source.hash.toLowerCase()===String(state.source_hash).toLowerCase()&&
    proof.source.timestamp===Number(state.source_timestamp),'Cleanup evidence source is not the persisted wallet source');
   // A recenter that settled into a retained exit finishes as a close; its cleanup adapter proves that from campaign state.
   assert(current.kind.startsWith('close_')?proof.custodyState==='closed_empty':
    proof.custodyState==='managed'||current.kind==='change_range'&&proof.custodyState==='closed_empty',
    'Job-specific terminal custody proof is missing');
   const unresolved=(await c.query<any>(`SELECT count(*)::int n FROM deployment_live_stage_outbox WHERE job_id=$1 AND status IN('prepared','signed','blocked')`,[id])).rows[0].n;
   assert.equal(unresolved,0,'Pending or unknown action owns wallet');
   const walletPending=(await c.query<any>(`SELECT count(*)::int n FROM deployment_live_stage_outbox WHERE chain_id=$1 AND wallet=$2 AND status IN('prepared','signed','blocked')`,[wallet.chainId,lower(wallet.address)])).rows[0].n;
   assert.equal(walletPending,0,'Another wallet action remains unresolved');
   // A cancelled unsigned intent never reached the chain; it is superseded by a replacement stage.
   const badReceipt=(await c.query<any>(`SELECT count(*)::int n FROM deployment_live_stage_outbox WHERE job_id=$1 AND status NOT IN('confirmed','cancelled')`,[id])).rows[0].n;
   assert.equal(badReceipt,0,'Only successfully reconciled actions can finish');
   const finalStage=(await c.query<any>(`SELECT stage FROM deployment_live_stage_outbox WHERE job_id=$1 AND status='confirmed' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[id])).rows[0];
   assert(finalStage,'No canonical transaction receipt exists for this job');
   const actual=(await c.query<any>(`SELECT allocation_hash FROM deployment_live_allocations WHERE id=$1 AND chain_id=$2 AND wallet=$3 FOR UPDATE`,[current.allocationId,wallet.chainId,lower(wallet.address)])).rows[0];
   assert(actual&&actual.allocation_hash===proof.allocationHash,'Allocation accounting proof mismatch');
   const cleanup={...proof,verified:true};
   await c.query(`UPDATE deployment_live_stage_outbox SET allowance_cleanup_json=$3,updated_at=clock_timestamp() WHERE job_id=$1 AND stage=$2`,[id,finalStage.stage,jsonSafe(cleanup)]);
   await c.query(`UPDATE deployment_live_jobs SET status='succeeded',lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[id]);
   return {jobId:id,status:'succeeded' as const,cleanup};
  });
 }
}
