import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {createRobinhoodClient,type RobinhoodClient} from './client.js';
import {maintainCanonicalPaperScenario} from './deployments/paper-maintenance.js';
import {processOnePaperOperation} from './deployments/paper-operation-worker.js';
import {DeploymentConflict,DeploymentStore} from './deployments/store.js';
import {log} from './logger.js';

const envSchema=z.object({
 DATABASE_URL:z.string().min(1),
 ROBINHOOD_READ_HTTP_URL:z.url(),
 DEPLOYMENT_RPC_TIMEOUT_MS:z.coerce.number().int().min(1000).max(30000).default(12000),
 DEPLOYMENT_PAPER_WORKER_INTERVAL_MS:z.coerce.number().int().min(10000).max(300000).default(60000),
 DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS:z.coerce.number().int().min(1).max(100).default(20),
 DEPLOYMENT_PAPER_WORKER_MAX_STEPS:z.coerce.number().int().min(1).max(100).default(8),
 DEPLOYMENT_PAPER_OPERATION_WORKER:z.enum(['0','1']).default('0'),
 DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS:z.coerce.number().int().min(1).max(20).default(4),
});

const lockKey=[4663,18727];
export type PaperCampaignRow={id:string;lifecycle:'active'|'paused'|'closing'|'closed'|'blocked'};
const failureCode=(error:unknown)=>error instanceof DeploymentConflict?error.code:
 error instanceof Error?error.name:'unknown';

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
 chain:RobinhoodClient,indexer:pg.Pool,maxCampaigns:number,maxSteps:number){
 if(!Number.isSafeInteger(maxCampaigns)||maxCampaigns<1||maxCampaigns>100||
  !Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>100)
  throw Error('Paper worker budget invalid');
 const lock=await indexer.connect();
 try{
  const acquired=(await lock.query<{acquired:boolean}>(
   'SELECT pg_try_advisory_lock($1::int,$2::int) AS acquired',lockKey)).rows[0]?.acquired;
  if(!acquired)return {status:'busy' as const,processed:0,invalidated:0,failed:0};
  try{
   const after=(await lock.query<PaperCampaignRow>(`
    SELECT c.id::text,c.lifecycle FROM deployment_campaigns c
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    WHERE c.mode='paper' AND r.strategy_id='static_manual_v1'
      AND c.lifecycle IN ('active','paused','closing','closed','blocked')
      AND ($1::uuid IS NULL OR c.id>$1::uuid)
    ORDER BY c.id
    LIMIT $2`,[campaignCursor,maxCampaigns])).rows;
   // A keyset scan lets PostgreSQL stop after the page instead of sorting all
   // eligible history. Wrap once when the tail contains fewer than the budget.
   const wrapped=campaignCursor!==null&&after.length<maxCampaigns?
    (await lock.query<PaperCampaignRow>(`
     SELECT c.id::text,c.lifecycle FROM deployment_campaigns c
     JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
     WHERE c.mode='paper' AND r.strategy_id='static_manual_v1'
       AND c.lifecycle IN ('active','paused','closing','closed','blocked')
       AND c.id<=$1::uuid
     ORDER BY c.id
     LIMIT $2`,[campaignCursor,maxCampaigns-after.length])).rows:[];
   const campaigns=after.concat(wrapped);
   campaignCursor=advancePaperCampaignCursor(campaigns,campaignCursor);
   let invalidated=0,failed=0;
   for(const campaign of campaigns){
    try{
     const result=await maintainCanonicalPaperScenario(store,chain,indexer,
      campaign.id,maxSteps,{sampleValuation:campaign.lifecycle==='active'||
       campaign.lifecycle==='paused'});
     if(result.status==='invalidated')invalidated++;
    }catch(error){
     failed++;
     log('error','paper_worker_campaign_failed',{
      campaignId:campaign.id,reason:failureCode(error),
     });
    }
   }
   return {status:'completed' as const,processed:campaigns.length,invalidated,failed};
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

/** The process supervisor owns restart and release identity. This loop has no
 * signer, operation claims, command acceptance or automatic schema migration. */
async function main(){
 const env=envSchema.parse(process.env),stop=new AbortController();
 process.once('SIGINT',()=>stop.abort());
 process.once('SIGTERM',()=>stop.abort());
 const store=new DeploymentStore(env.DATABASE_URL);
 const indexer=new pg.Pool({connectionString:env.DATABASE_URL,max:3});
 try{
 await store.assertReady();
  const chain=createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL,
   env.DEPLOYMENT_RPC_TIMEOUT_MS),workerId=`paper-model:${randomUUID()}`;
  while(!stop.signal.aborted){
   try{
    const result=await runPaperMaintenancePass(store,chain,indexer,
     env.DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS,
     env.DEPLOYMENT_PAPER_WORKER_MAX_STEPS);
    log('info','paper_worker_pass',result);
   }catch(error){
    log('error','paper_worker_pass_failed',{
     reason:failureCode(error),
    });
   }
   if(env.DEPLOYMENT_PAPER_OPERATION_WORKER==='1'){
    for(let n=0;n<env.DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS&&!stop.signal.aborted;n++){
     try{
      const result=await processOnePaperOperation(store,chain,indexer,workerId);
      if(result.status==='idle')break;
      log(result.status==='blocked'?'error':'info','paper_operation_worker_pass',result);
     }catch(error){
      log('error','paper_operation_worker_failed',{reason:failureCode(error)});
      break;
     }
    }
   }
   await pause(env.DEPLOYMENT_PAPER_WORKER_INTERVAL_MS,stop.signal);
  }
 }finally{
  await indexer.end();
  await store.close();
 }
}

if(process.argv[1]&&/deployments-paper-worker\.(?:ts|js)$/.test(process.argv[1]))
 main().catch(error=>{
  log('error','paper_worker_failed',{
   reason:failureCode(error),
  });
  process.exitCode=1;
 });
