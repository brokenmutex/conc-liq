import type {Pool,PoolClient} from 'pg';
import {readWalletState,type LiveWalletIdentity} from './live-wallet-store.js';
import {assertLiveRuntimeSchemaReady,assertPositionManagerWalletTransferSchemaReady} from '../storage/compatibility.js';

/** Exclusive advisory lease held by the one supervised live wallet worker that
 * has a configured signer and publisher. The command runtime reads the granted
 * lock in pg_locks; it never takes a competing probe lock. Keep separate from
 * paper locks 18727 and 18728. */
export const LIVE_WORKER_READINESS_LOCK=[4663,18729] as const;
export const LIVE_WORKER_SNAPSHOT_MAX_AGE_SECONDS=180;

export type LiveWorkerReadinessLease={assertHealthy:()=>Promise<void>;release:()=>Promise<void>};

/** A process-lifetime session lease. PostgreSQL releases it automatically if
 * the dedicated connection is lost, so a dead worker cannot look ready. Take
 * it only after startup checks pass and execution is explicitly configured. */
export async function acquireLiveWorkerReadinessLease(pool:Pool):Promise<LiveWorkerReadinessLease>{
 const client:PoolClient=await pool.connect();let lost=false,released=false;
 const onError=()=>{lost=true;};
 client.on('error',onError);
 try{
  const acquired=(await client.query<{acquired:boolean}>(
   'SELECT pg_try_advisory_lock($1::int,$2::int) AS acquired',[...LIVE_WORKER_READINESS_LOCK])).rows[0]?.acquired;
  if(acquired!==true)throw Error('another live wallet worker holds the readiness lease');
 }catch(error){client.removeListener('error',onError);client.release(true);throw error;}
 return {
  async assertHealthy(){
   if(lost||released)throw Error('live worker readiness lease lost');
   try{await client.query('SELECT 1');}
   catch(error){lost=true;throw Error('live worker readiness lease lost',{cause:error});}
  },
  async release(){
   if(released)return;released=true;client.removeListener('error',onError);
   try{if(!lost)await client.query('SELECT pg_advisory_unlock($1::int,$2::int)',[...LIVE_WORKER_READINESS_LOCK]);}
   finally{client.release(lost);}
  },
 };
}

export interface LiveWorkerReadiness {ready:boolean;missing:string[]}

/** Command-side proof that a supervised, execution-configured worker is
 * connected and the shared wallet snapshot is canonical and fresh. */
export async function readLiveWorkerReadiness(db:Pick<Pool,'query'>,wallet:LiveWalletIdentity,
 now:()=>number=Date.now):Promise<LiveWorkerReadiness>{
 const missing:string[]=[];
 try{
  await assertLiveRuntimeSchemaReady(db);
  await assertPositionManagerWalletTransferSchemaReady(db);
 }catch{return {ready:false,missing:['live_runtime_or_wallet_history_schema_unavailable']};}
 try{
  const held=(await db.query<{ready:boolean}>(`
   SELECT EXISTS(SELECT 1 FROM pg_locks
    WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
     AND classid=$1::oid AND objid=$2::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted) AS ready`,
   [...LIVE_WORKER_READINESS_LOCK])).rows[0]?.ready;
  if(held!==true)missing.push('live_wallet_worker_not_connected');
 }catch{missing.push('live_wallet_worker_readiness_probe_failed');}
 try{
  const state=await readWalletState(db as Pool,wallet),current=Math.floor(now()/1000);
  if(state.status!=='available'||!state.source||!state.snapshotHash||!state.commitmentsHash||state.nonce===null||
   state.pendingNonce!==state.nonce)missing.push('canonical_wallet_snapshot_unavailable');
  else if(state.source.timestamp>current+5||current-state.source.timestamp>LIVE_WORKER_SNAPSHOT_MAX_AGE_SECONDS)
   missing.push('canonical_wallet_snapshot_stale');
 }catch{missing.push('canonical_wallet_snapshot_unavailable');}
 return {ready:missing.length===0,missing};
}
