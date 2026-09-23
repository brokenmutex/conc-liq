import pg from 'pg';
import {z} from 'zod';
import {createRobinhoodClient} from './client.js';
import {DeploymentStore} from './deployments/store.js';
import {maintainCanonicalPaperScenario} from './deployments/paper-maintenance.js';
import {log} from './logger.js';

const envSchema=z.object({
 DATABASE_URL:z.string().min(1),
 ROBINHOOD_READ_HTTP_URL:z.url(),
 DEPLOYMENT_RPC_TIMEOUT_MS:z.coerce.number().int().min(1000).max(30000).default(12000),
});
const argumentsSchema=z.tuple([
 z.uuid(),z.coerce.number().int().min(1).max(100).default(16),
]);

/** One explicitly selected, bounded paper reconciliation pass. The command
 * reads canonical chain/indexer evidence and appends only provisional paper
 * evidence or invalidations. It has no signer, broadcast or scheduler. */
async function main(){
 const env=envSchema.parse(process.env);
 const [campaignId,maxSteps]=argumentsSchema.parse([
  process.argv[2],process.argv[3]??16,
 ]);
 const store=new DeploymentStore(env.DATABASE_URL);
 const indexer=new pg.Pool({connectionString:env.DATABASE_URL,max:2});
 try{
  await store.assertReady();
  const chain=createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL,
   env.DEPLOYMENT_RPC_TIMEOUT_MS);
  const result=await maintainCanonicalPaperScenario(store,chain,indexer,
   campaignId,maxSteps);
  log('info','paper_maintenance_complete',{
   campaignId,status:result.status,steps:result.steps,caughtUp:result.caughtUp,
   invalidatedCount:result.standardAudit.invalidated.length+
    (result.conversionAudit?.invalidated.length??0),
  });
  if(result.status==='invalidated')process.exitCode=2;
 }finally{
  await indexer.end();
  await store.close();
 }
}

main().catch(error=>{
 log('error','paper_maintenance_failed',{
  reason:error instanceof Error?error.message:'unknown',
 });
 process.exitCode=1;
});
