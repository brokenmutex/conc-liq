import {type Pool,type PoolClient} from 'pg';

const namespace='conc-liq:paper-static-convert-preparation';
export const paperPreparationLockName=(campaignId:string)=>`${namespace}:${campaignId}`;

export interface PaperPreparationLease {
 readonly campaignId:string;
 readonly expiresAt:Date;
 assertHealthy:()=>Promise<void>;
 retainUntil:(expiresAt:Date)=>void;
 release:()=>Promise<void>;
}

type OwnedLease=Omit<PaperPreparationLease,'expiresAt'>&{expiresAt:Date;client:PoolClient;
 hardExpiresAt:number;timer:NodeJS.Timeout};

/** Holds one bounded exclusive session lock while a trusted close preview is
 * sampled and reviewed. PostgreSQL drops it automatically if this session is
 * lost; callers release it on accept, cancel, request error, or expiry. */
export class PaperPreparationLeaseRegistry {
 private readonly leases=new Map<string,OwnedLease>();
 private closed=false;
 constructor(private readonly pool:Pool){}

 async acquire(campaignId:string,maxLifetimeMs=300_000):Promise<PaperPreparationLease>{
  if(this.closed)throw Error('paper_preparation_lease_registry_closed');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(campaignId)||
   !Number.isSafeInteger(maxLifetimeMs)||maxLifetimeMs<1_000||maxLifetimeMs>300_000)
   throw Error('paper_preparation_lease_input_invalid');
  if(this.leases.has(campaignId))throw Error('paper_preparation_lease_already_held');
  const client=await this.pool.connect();let lost=false,released=false;
  const onError=()=>{lost=true;};client.on('error',onError);
  try{
   const acquired=(await client.query<{acquired:boolean}>(
    'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
    [paperPreparationLockName(campaignId)])).rows[0]?.acquired;
   if(!acquired)throw Error('paper_preparation_lease_already_held');
  }catch(error){client.off('error',onError);client.release(true);throw error;}
  const hardExpiresAt=Date.now()+maxLifetimeMs;
  let exposed:OwnedLease;
  const release=async()=>{
   if(released)return;released=true;clearTimeout(exposed.timer);
   try{
    if(!lost){
     const unlocked=(await client.query<{unlocked:boolean}>(
      'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',
      [paperPreparationLockName(campaignId)])).rows[0]?.unlocked;
     if(!unlocked){lost=true;throw Error('paper_preparation_lease_release_failed');}
    }
   }catch(error){lost=true;throw error;}
   finally{
    client.off('error',onError);
    client.release(lost);
    if(this.leases.get(campaignId)===exposed)this.leases.delete(campaignId);
   }
  };
  const arm=(deadline:number)=>{
   clearTimeout(exposed.timer);
   exposed.timer=setTimeout(()=>{void release().catch(()=>{});},Math.max(1,deadline-Date.now()));
   exposed.timer.unref();
  };
  exposed={campaignId,client,hardExpiresAt,expiresAt:new Date(hardExpiresAt),timer:setTimeout(()=>{},1),
   async assertHealthy(){
    if(lost||released||Date.now()>=exposed.expiresAt.getTime()){
     await release().catch(()=>{});throw Error('paper_preparation_lease_lost');}
    try{await client.query('SELECT 1');}
    catch(error){lost=true;await release().catch(()=>{});
     throw Error('paper_preparation_lease_lost',{cause:error});}
    if(lost||released||Date.now()>=exposed.expiresAt.getTime()){
     await release().catch(()=>{});throw Error('paper_preparation_lease_lost');}
   },
   retainUntil(expiresAt:Date){
    const deadline=expiresAt.getTime();
    if(lost||released||!Number.isFinite(deadline)||deadline<=Date.now()||deadline>hardExpiresAt)
     throw Error('paper_preparation_lease_expiry_invalid');
    exposed.expiresAt=new Date(deadline);arm(deadline);
   },release};
  if(this.closed){await release();throw Error('paper_preparation_lease_registry_closed');}
  this.leases.set(campaignId,exposed);arm(hardExpiresAt);
  return exposed;
 }

 async release(campaignId:string){await this.leases.get(campaignId)?.release();}
 async isHealthy(campaignId:string){
  const lease=this.leases.get(campaignId);if(!lease)return false;
  try{await lease.assertHealthy();return true;}catch{return false;}
 }
 async close(){this.closed=true;
  const results=await Promise.allSettled([...this.leases.values()].map(lease=>lease.release()));
  const failed=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');
  if(failed)throw failed.reason;
 }
}

export interface PaperPreparationSharedLease {release:()=>Promise<void>}

/** Maintenance holds the shared session lock only around mutable sampling and
 * projection. Audits run before this guard, including while preparation holds
 * the exclusive lock. */
export async function acquirePaperPreparationSharedLease(pool:Pool,campaignId:string):
 Promise<PaperPreparationSharedLease|null>{
 const client=await pool.connect();let lost=false,released=false;
 const onError=()=>{lost=true;};client.on('error',onError);
 let acquired:boolean;
 try{
  acquired=(await client.query<{acquired:boolean}>(
   'SELECT pg_try_advisory_lock_shared(hashtextextended($1,0)) AS acquired',
   [paperPreparationLockName(campaignId)])).rows[0]?.acquired===true;
 }catch(error){client.off('error',onError);client.release(true);throw error;}
 if(!acquired){client.off('error',onError);client.release();return null;}
 return {async release(){
  if(released)return;released=true;
  try{
   if(!lost){
    const unlocked=(await client.query<{unlocked:boolean}>(
     'SELECT pg_advisory_unlock_shared(hashtextextended($1,0)) AS unlocked',
     [paperPreparationLockName(campaignId)])).rows[0]?.unlocked;
    if(!unlocked){lost=true;throw Error('paper_preparation_shared_lease_release_failed');}
   }
  }catch(error){lost=true;throw error;}
  finally{client.off('error',onError);client.release(lost);}
 }};
}
