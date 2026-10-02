import pg,{type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {createRobinhoodClient,type RobinhoodClient} from './client.js';
import {maintainCanonicalPaperScenario} from './deployments/paper-maintenance.js';
import {maintainRangeKeeperPaperObservation} from './deployments/rangekeeper-paper-maintenance.js';
import {prepareRangeKeeperPaperRecenterPreview} from './deployments/rangekeeper-paper-recenter-runtime.js';
import {loadRuntimeIdentity} from './runtime/identity.js';
import {verifyCanonicalPaperAnchors} from './deployments/paper-canonical-anchors.js';
import {processOnePaperOperation} from './deployments/paper-operation-worker.js';
import {safePaperDiagnosticFailure} from './deployments/paper-diagnostic.js';
import {DeploymentConflict,DeploymentStore,PAPER_OPERATION_NOTIFY_CHANNEL,
 PAPER_OPERATION_READINESS_LOCK} from './deployments/store.js';
import {log} from './logger.js';

const envSchema=z.object({
 DATABASE_URL:z.string().min(1),
 ROBINHOOD_READ_HTTP_URL:z.url(),
 PAPER_FORK_RPC_URL:z.url().optional(),
 DEPLOYMENT_RPC_TIMEOUT_MS:z.coerce.number().int().min(1000).max(30000).default(12000),
 DEPLOYMENT_PAPER_WORKER_INTERVAL_MS:z.coerce.number().int().min(10000).max(300000).default(60000),
 DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS:z.coerce.number().int().min(1).max(100).default(20),
 DEPLOYMENT_PAPER_WORKER_MAX_STEPS:z.coerce.number().int().min(1).max(100).default(8),
 DEPLOYMENT_PAPER_OPERATION_WORKER:z.enum(['0','1']).default('0'),
 DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS:z.coerce.number().int().min(1).max(20).default(4),
});

const lockKey=[4663,18727];
// The maintenance path can hold the process readiness lease, pass lock and
// campaign preparation lease while fee replay borrows a fourth session.
const PAPER_WORKER_INDEXER_POOL_MAX=4;
const PAPER_OPERATION_SHORT_POLL_MS=2_000;
export type PaperOperationReadinessLease={assertHealthy:()=>Promise<void>;
 waitForOperation:(durationMs:number,signal:AbortSignal)=>Promise<void>;release:()=>Promise<void>};

/** A process-lifetime session lease. PostgreSQL releases the shared advisory
 * lock automatically if this dedicated connection is lost. */
export async function acquirePaperOperationReadinessLease(indexer:pg.Pool):Promise<PaperOperationReadinessLease>{
 const client:PoolClient=await indexer.connect();let lost=false,released=false,notificationPending=false;
 const waiters=new Set<()=>void>();
 const wake=(notification:boolean)=>{
  if(notification)notificationPending=true;
  for(const waiter of [...waiters])waiter();
 };
 const onError=()=>{lost=true;wake(false);};
 const onNotification=(message:{channel?:string})=>{
  if(message.channel===PAPER_OPERATION_NOTIFY_CHANNEL)wake(true);
 };
 client.on('error',onError);
 client.on('notification',onNotification);
 try{
  const acquired=(await client.query<{acquired:boolean}>(
   'SELECT pg_try_advisory_lock_shared($1::int,$2::int) AS acquired',
   [...PAPER_OPERATION_READINESS_LOCK])).rows[0]?.acquired;
  if(!acquired)throw Error('could not acquire paper operation readiness lease');
  await client.query(`LISTEN ${PAPER_OPERATION_NOTIFY_CHANNEL}`);
 }catch(error){
  client.removeListener('error',onError);client.removeListener('notification',onNotification);
  client.release(true);throw error;
 }
 return {
  async assertHealthy(){
   if(lost||released)throw Error('paper operation readiness lease lost');
   try{await client.query('SELECT 1');}
   catch(error){lost=true;throw Error('paper operation readiness lease lost',{cause:error});}
  },
  async waitForOperation(durationMs,signal){
   if(!Number.isFinite(durationMs)||durationMs<=0||signal.aborted||lost||notificationPending){
    notificationPending=false;return;
   }
   await new Promise<void>(resolve=>{
    let settled=false;
    const finish=()=>{
     if(settled)return;settled=true;clearTimeout(timer);
     signal.removeEventListener('abort',finish);waiters.delete(finish);
     notificationPending=false;resolve();
    };
    const timer=setTimeout(finish,durationMs);
    waiters.add(finish);signal.addEventListener('abort',finish,{once:true});
    if(notificationPending||lost||signal.aborted)finish();
   });
  },
  async release(){
   if(released)return;released=true;
   try{
    if(!lost){
     await client.query(`UNLISTEN ${PAPER_OPERATION_NOTIFY_CHANNEL}`);
     const unlocked=(await client.query<{unlocked:boolean}>(
      'SELECT pg_advisory_unlock_shared($1::int,$2::int) AS unlocked',
      [...PAPER_OPERATION_READINESS_LOCK])).rows[0]?.unlocked;
     if(!unlocked){lost=true;throw Error('paper operation readiness lease release failed');}
    }
   }catch(error){lost=true;throw error;}
   finally{
    for(const waiter of [...waiters])waiter();
    client.removeListener('error',onError);client.removeListener('notification',onNotification);
    client.release(lost);
   }
  },
 };
}
export type PaperCampaignRow={id:string;lifecycle:'active'|'paused'|'closing'|'closed'|'blocked';
 strategy_id?:'static_manual_v1'|'rangekeeper_v1'};
export interface RangeKeeperAutomaticPassResult {
 status:string;reason?:string;markId?:string;source?:{block:string};
 decision?:unknown;nextObservationAt?:number|null;operationId?:string;
}
export function nextPaperMaintenanceAt(now:number,intervalMs:number,nextObservationAt?:number|null){
 return Number.isFinite(nextObservationAt)?
  Math.min(now+intervalMs,Math.max(now+1_000,nextObservationAt!)):now+intervalMs;
}
// A bare error class name cannot tell an operator which invariant failed: every
// assertion in the fee replay path logged the single token 'AssertionError',
// so a transient indexer lag and a real integrity violation were indistinguishable
// in the journal. safePaperDiagnosticFailure maps known assertion messages to
// bounded codes and still never returns arbitrary message text.
const failureCode=(error:unknown)=>error instanceof DeploymentConflict?error.code:
 safePaperDiagnosticFailure(error);

// Keep the cursor outside a pass so a large closed history cannot pin every
// pass to the same oldest campaigns. Each query is bounded, including the
// wrap query; the cursor is advanced even when an individual audit fails.
let campaignCursor:string|null=null;
export function advancePaperCampaignCursor(page:readonly PaperCampaignRow[],cursor:string|null){
 return page.length?page[page.length-1]!.id:cursor;
}

/** A single bounded, signer-free audit/projection pass. Its session lock
 * prevents two copies of this worker from scanning the same campaign set. */
export async function runPaperMaintenancePass(store:DeploymentStore,
 chain:RobinhoodClient,indexer:pg.Pool,maxCampaigns:number,maxSteps:number,diagnostics=false,
 runRangeKeeperAutomatic?:(campaignId:string,observationOnly:boolean)=>Promise<RangeKeeperAutomaticPassResult>){
 if(!Number.isSafeInteger(maxCampaigns)||maxCampaigns<1||maxCampaigns>100||
  !Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>100)
  throw Error('Paper worker budget invalid');
 const lock=await indexer.connect();
 try{
  const acquired=(await lock.query<{acquired:boolean}>(
   'SELECT pg_try_advisory_lock($1::int,$2::int) AS acquired',lockKey)).rows[0]?.acquired;
  if(!acquired)return {status:'busy' as const,processed:0,invalidated:0,failed:0,
   preparationSkipped:0};
  try{
   const after=(await lock.query<PaperCampaignRow>(`
    SELECT c.id::text,c.lifecycle,r.strategy_id FROM deployment_campaigns c
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    WHERE c.mode='paper' AND ((r.strategy_id='static_manual_v1'
      AND c.lifecycle IN ('active','paused','closing','closed','blocked')) OR
      (r.strategy_id='rangekeeper_v1' AND c.lifecycle IN ('active','paused')))
      AND ($1::uuid IS NULL OR c.id>$1::uuid)
    ORDER BY c.id
    LIMIT $2`,[campaignCursor,maxCampaigns])).rows;
   // A keyset scan lets PostgreSQL stop after the page instead of sorting all
   // eligible history. Wrap once when the tail contains fewer than the budget.
   const wrapped=campaignCursor!==null&&after.length<maxCampaigns?
    (await lock.query<PaperCampaignRow>(`
     SELECT c.id::text,c.lifecycle,r.strategy_id FROM deployment_campaigns c
     JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
     WHERE c.mode='paper' AND ((r.strategy_id='static_manual_v1'
       AND c.lifecycle IN ('active','paused','closing','closed','blocked')) OR
       (r.strategy_id='rangekeeper_v1' AND c.lifecycle IN ('active','paused')))
       AND c.id<=$1::uuid
     ORDER BY c.id
     LIMIT $2`,[campaignCursor,maxCampaigns-after.length])).rows:[];
   const campaigns=after.concat(wrapped);
   campaignCursor=advancePaperCampaignCursor(campaigns,campaignCursor);
   let invalidated=0,failed=0,preparationSkipped=0,nextObservationAt:number|undefined;
   for(const campaign of campaigns){
    try{
     if(campaign.strategy_id==='rangekeeper_v1'){
      if(runRangeKeeperAutomatic){
       const result=await runRangeKeeperAutomatic(campaign.id,campaign.lifecycle==='paused');
       if(result.status==='preparation_locked'){preparationSkipped++;continue;}
       if(typeof result.nextObservationAt==='number'&&Number.isFinite(result.nextObservationAt))
        nextObservationAt=Math.min(nextObservationAt??Infinity,result.nextObservationAt);
       const decision=result.decision&&typeof result.decision==='object'?
        result.decision as {action?:unknown;reason?:unknown}:null;
       log('info','rangekeeper_paper_automatic_pass',{campaignId:campaign.id,status:result.status,
        reason:result.reason,markId:result.markId,sourceBlock:result.source?.block,
        operationId:result.operationId,nextObservationAt:result.nextObservationAt,
        decision:decision?{action:decision.action,reason:decision.reason}:null});
       continue;
      }
      const result=await maintainRangeKeeperPaperObservation(store,chain,indexer,campaign.id,
       (chainId,sources)=>verifyCanonicalPaperAnchors(chain,chainId,sources));
      if(result.status==='preparation_locked'){preparationSkipped++;continue;}
      log('info','rangekeeper_paper_observation',{
       campaignId:campaign.id,markId:result.markId,replayed:result.replayed,
       sourceBlock:result.source.block,decision:result.decision,
      });
      continue;
     }
     const result=await maintainCanonicalPaperScenario(store,chain,indexer,
      campaign.id,maxSteps,{sampleValuation:campaign.lifecycle==='active'||campaign.lifecycle==='paused',
       ...(diagnostics?{progress:(stage,state,durationMs,reason)=>log(
        state==='failed'?'error':'info','paper_worker_maintenance_stage',{campaignId:campaign.id,
         stage,state,...(durationMs===undefined?{}:{durationMs}),...(reason?{reason}:{})})}:{})});
     if(result.status==='invalidated')invalidated++;
     if(result.status==='preparation_locked')preparationSkipped++;
    }catch(error){
     failed++;
     log('error','paper_worker_campaign_failed',{
      campaignId:campaign.id,reason:failureCode(error),
     });
    }
   }
   return {status:'completed' as const,processed:campaigns.length,invalidated,failed,
    preparationSkipped,...(nextObservationAt===undefined?{}:{nextObservationAt})};
  }finally{
   await lock.query('SELECT pg_advisory_unlock($1::int,$2::int)',lockKey);
  }
 }finally{lock.release();}
}

const pause=(durationMs:number,signal:AbortSignal)=>new Promise<void>(resolve=>{
 if(signal.aborted){resolve();return;}
 const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
 const timer=setTimeout(done,durationMs);
 signal.addEventListener('abort',done,{once:true});
});

/** The process supervisor owns restart and release identity. This loop never
 * loads a signer or performs startup DDL. The optional operation path claims
 * persisted work; its shared readiness lease proves a live DB session only,
 * not timely progress or recovery. */
async function main(){
 const env=envSchema.parse(process.env),stop=new AbortController();
 const diagnostics=process.env.DEPLOYMENT_PAPER_WORKER_DIAGNOSTICS==='1';
 process.once('SIGINT',()=>stop.abort());
 process.once('SIGTERM',()=>stop.abort());
 const store=new DeploymentStore(env.DATABASE_URL);
 const indexer=new pg.Pool({connectionString:env.DATABASE_URL,max:PAPER_WORKER_INDEXER_POOL_MAX});
 let readinessLease:PaperOperationReadinessLease|undefined;
 try{
 await store.assertReady();
  const chain=createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL,
   env.DEPLOYMENT_RPC_TIMEOUT_MS),workerId=`paper-model:${randomUUID()}`;
  if(env.DEPLOYMENT_PAPER_OPERATION_WORKER==='1')
   readinessLease=await acquirePaperOperationReadinessLease(indexer);
  let nextMaintenanceAt=Date.now();
  while(!stop.signal.aborted){
   if(readinessLease)await readinessLease.assertHealthy();
   if(env.DEPLOYMENT_PAPER_OPERATION_WORKER==='1'){
    for(let n=0;n<env.DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS&&!stop.signal.aborted;n++){
     if(readinessLease)await readinessLease.assertHealthy();
     try{
      const result=await processOnePaperOperation(store,chain,indexer,workerId,
       {rpcUrl:env.PAPER_FORK_RPC_URL??env.ROBINHOOD_READ_HTTP_URL,diagnostics});
      if(result.status==='idle')break;
      log(result.status==='blocked'?'error':'info','paper_operation_worker_pass',result);
      if(result.status==='retry')break;
     }catch(error){
      log('error','paper_operation_worker_failed',{reason:failureCode(error)});
      break;
     }
    }
   }
   if(Date.now()>=nextMaintenanceAt){
    let nextObservationAt:number|undefined;
    try{
     const result=await runPaperMaintenancePass(store,chain,indexer,
      env.DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS,
      env.DEPLOYMENT_PAPER_WORKER_MAX_STEPS,diagnostics,
      env.DEPLOYMENT_PAPER_OPERATION_WORKER==='1'?async (campaignId,observationOnly)=>{
       const runtime=loadRuntimeIdentity();
       if(!runtime)throw new DeploymentConflict('rangekeeper_runtime_build_identity_unavailable');
       const snapshot=await store.rangeKeeperPaperEpochSnapshot(campaignId);
       if(snapshot.previousMark.classification==='rangekeeper_paper_open_v1')
        return maintainRangeKeeperPaperObservation(store,chain,indexer,campaignId,
         (chainId,sources)=>verifyCanonicalPaperAnchors(chain,chainId,sources));
       return prepareRangeKeeperPaperRecenterPreview({store,client:chain,indexer,campaignId,
        buildId:runtime.buildId,rpcUrl:env.PAPER_FORK_RPC_URL??env.ROBINHOOD_READ_HTTP_URL,observationOnly,
        onFailure:(stage,error)=>log('error','rangekeeper_paper_automatic_failed',
         {campaignId,stage,reason:failureCode(error),
          cause:error instanceof Error&&error.cause?failureCode(error.cause):undefined})});
      }:undefined);
     log('info','paper_worker_pass',result);
     nextObservationAt=result.status==='completed'?result.nextObservationAt:undefined;
    }catch(error){
     log('error','paper_worker_pass_failed',{reason:failureCode(error)});
    }
    nextMaintenanceAt=nextPaperMaintenanceAt(Date.now(),env.DEPLOYMENT_PAPER_WORKER_INTERVAL_MS,nextObservationAt);
   }
   const untilMaintenance=Math.max(0,nextMaintenanceAt-Date.now());
   if(readinessLease)await readinessLease.waitForOperation(
    Math.min(PAPER_OPERATION_SHORT_POLL_MS,untilMaintenance),stop.signal);
   else await pause(untilMaintenance,stop.signal);
 }
 }finally{
  try{await readinessLease?.release();}
  finally{await indexer.end();await store.close();}
 }
}

if(process.argv[1]&&/deployments-paper-worker\.(?:ts|js)$/.test(process.argv[1]))
 main().catch(error=>{
  log('error','paper_worker_failed',{
   reason:failureCode(error),
  });
  process.exitCode=1;
 });
