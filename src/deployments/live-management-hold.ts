import type {Pool,PoolClient} from 'pg';
import type {LiveWalletIdentity} from './live-wallet-store.js';

/** The management hold keeps the worker's holding observer (wallet refresh plus valuation mark) from moving the
 * wallet source or the campaign runtime state hash while an operator management review is being built or waits to be
 * admitted. Both moves would fail a frozen review's integrity checks, and nothing else is loosened.
 *
 * Two phases, no schema change:
 *  1. Preview in progress. The command service holds a session-level PostgreSQL advisory lock for the whole preview, on
 *     one dedicated connection that is never returned to the pool while locked. The observer takes the same lock
 *     (try-lock, never waits) around each wallet refresh plus mark, so the two are mutually exclusive in both orders.
 *  2. Review pending. The persisted review row (deployment_live_reviews: unexpired and not consumed by a job) is the
 *     hold; it ends at the review's own expiry or when admission consumes it.
 *
 * The lock is per wallet, not per campaign: the wallet snapshot is wallet-wide, so refreshing it for any campaign moves
 * the source every other campaign's pending review is pinned to. */
export const LIVE_MANAGEMENT_HOLD_KEY_PREFIX='conc-liq-live-management-hold';
/** Distinct from the wallet transaction lock key in live-wallet-store.ts. */
export const liveManagementHoldKey=(wallet:LiveWalletIdentity)=>
 `${LIVE_MANAGEMENT_HOLD_KEY_PREFIX}:${wallet.chainId}:${wallet.address.toLowerCase()}`;
/** The longest a preview may wait for an in-progress observer wallet refresh to finish. */
export const LIVE_MANAGEMENT_HOLD_WAIT_MS=10_000;
/** A preview that has not finished by now loses the hold: its connection is destroyed, which frees the lock. */
export const LIVE_MANAGEMENT_HOLD_MAX_MS=150_000;
export class LiveManagementHoldUnavailable extends Error{
 constructor(readonly reason:'live_management_hold_busy'|'live_management_hold_unavailable'){super(reason);}
}

/** Run an operator management preview under the wallet hold. The lock lives on a dedicated pooled connection that is
 * explicitly unlocked in `finally`; if the unlock cannot be confirmed (or the hold times out) the connection is destroyed
 * instead of being returned to the pool, and PostgreSQL drops a session lock when its session ends. */
export async function withLiveManagementPreviewHold<T>(pool:Pick<Pool,'connect'>,wallet:LiveWalletIdentity,fn:()=>Promise<T>,
 options:{waitMs?:number;maxHoldMs?:number}={}):Promise<T>{
 const key=liveManagementHoldKey(wallet),waitMs=Math.max(1,Math.trunc(options.waitMs??LIVE_MANAGEMENT_HOLD_WAIT_MS)),
  maxHoldMs=options.maxHoldMs??LIVE_MANAGEMENT_HOLD_MAX_MS;
 let client:PoolClient;
 try{client=await pool.connect();}catch{throw new LiveManagementHoldUnavailable('live_management_hold_unavailable');}
 let destroyed=false,timer:ReturnType<typeof setTimeout>|undefined;
 const destroy=()=>{if(destroyed)return;destroyed=true;if(timer)clearTimeout(timer);client.removeListener('error',onError);
  client.on('error',()=>{});client.release(true);};
 const onError=()=>destroy();
 client.on('error',onError);
 try{
  // lock_timeout bounds the wait for an in-progress observer refresh; the connection is dropped on any failure below.
  await client.query(`SELECT set_config('lock_timeout',$1,false)`,[`${waitMs}ms`]);
  await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
  await client.query(`SELECT set_config('lock_timeout','0',false)`);
 }catch(error){
  destroy();
  const code=(error as {code?:string})?.code;
  throw new LiveManagementHoldUnavailable(code==='55P03'||code==='57014'?'live_management_hold_busy':'live_management_hold_unavailable');
 }
 timer=setTimeout(destroy,maxHoldMs);timer.unref?.();
 try{return await fn();}
 finally{
  if(!destroyed){
   let unlocked=false;
   try{unlocked=(await client.query<{unlocked:boolean}>('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',[key])).rows[0]?.unlocked===true;}
   catch{unlocked=false;}
   if(unlocked){destroyed=true;if(timer)clearTimeout(timer);client.removeListener('error',onError);client.release();}
   else destroy();
  }
 }
}

export interface LiveWalletObservationLease{release():Promise<void>}
/** Observer side: take the wallet hold without waiting. Null means an operator preview is being generated, so the
 * observer must skip. The lock is held only for one campaign's refresh plus mark and always released in `release`. */
export async function tryAcquireLiveWalletObservationLease(pool:Pick<Pool,'connect'>,wallet:LiveWalletIdentity):
 Promise<LiveWalletObservationLease|null>{
 const key=liveManagementHoldKey(wallet),client=await pool.connect();let done=false;
 const onError=()=>{};client.on('error',onError);
 const finish=(destroy:boolean)=>{if(done)return;done=true;client.removeListener('error',onError);client.release(destroy);};
 try{
  const got=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0]?.locked===true;
  if(!got){finish(false);return null;}
 }catch(error){finish(true);throw error;}
 return {async release(){
  if(done)return;
  let unlocked=false;
  try{unlocked=(await client.query<{unlocked:boolean}>('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',[key])).rows[0]?.unlocked===true;}
  catch{unlocked=false;}
  finish(!unlocked);
 }};
}

/** True while an operator close review exists for the wallet that is unexpired and not consumed by a job. The review's
 * own expiry (source timestamp + 90 s) bounds the hold, so an abandoned review never stops marks for long. */
export async function liveWalletHasPendingManagementReview(db:Pick<Pool|PoolClient,'query'>,wallet:LiveWalletIdentity,
 nowMs:number=Date.now()):Promise<boolean>{
 const row=(await db.query<{pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM deployment_live_reviews WHERE chain_id=$1 AND wallet=$2
  AND consumed_by_job IS NULL AND expires_at>$3 AND payload->>'kind'='rangekeeper_live_management_review'
  AND payload->>'operationKind' IN('close_retain','close_convert')) AS pending`,
  [wallet.chainId,wallet.address.toLowerCase(),new Date(nowMs).toISOString()])).rows[0];
 return row?.pending===true;
}
