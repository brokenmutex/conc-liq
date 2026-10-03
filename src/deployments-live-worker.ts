import assert from 'node:assert/strict';
import {isAbsolute} from 'node:path';
import pg from 'pg';
import {z} from 'zod';
import {getAddress,isAddress} from 'viem';
import {createRobinhoodClient} from './client.js';
import {ROBINHOOD_CHAIN_ID} from './constants.js';
import {DeploymentStore} from './deployments/store.js';
import {acquireLiveWorkerReadinessLease,type LiveWorkerReadinessLease} from './deployments/live-worker-readiness.js';
import {createRangeKeeperLiveRuntime,type RangeKeeperLiveRuntimeExecution} from './deployments/rangekeeper-live-runtime.js';
import {loadLiveWorkerSigner,redactLiveWorkerText} from './deployments/live-worker-signer.js';
import {assertLiveWorkerBroadcastChain,createLiveWorkerPublisher} from './deployments/live-worker-publisher.js';
import {createLiveWorkerMaintenance,loadLiveWorkerProfiles} from './deployments/live-worker-maintenance.js';
import {runLiveWorkerLoop} from './deployments/live-worker-loop.js';
import {PostgresPositionManagerWalletTransferStore} from './nft/position-manager-wallet-transfer-store.js';
import {assertLiveRuntimeSchemaReady,assertPositionManagerWalletTransferSchemaReady} from './storage/compatibility.js';
import {loadRuntimeIdentity} from './runtime/identity.js';
import {log} from './logger.js';

const flag=z.enum(['0','1']).default('0');
const httpUrl=z.url().refine(value=>/^https?:\/\//i.test(value),'must be an http(s) URL');
/** Execution needs a broadcast endpoint and a private key file; management only
 * runs inside the execution step, so it cannot be enabled without execution. */
export const liveWorkerEnvSchema=z.object({
 DATABASE_URL:z.string().min(1),
 ROBINHOOD_READ_HTTP_URL:httpUrl,
 PAPER_FORK_RPC_URL:httpUrl.optional(),
 DEPLOYMENT_OPERATOR_WALLET_ADDRESS:z.string().refine(isAddress,'must be an EVM address'),
 DEPLOYMENT_LIVE_EXECUTION:flag,
 DEPLOYMENT_LIVE_MANAGEMENT:flag,
 RH_BROADCAST_RPC_URL:httpUrl.optional(),
 DEPLOYMENT_LIVE_SIGNER_FILE:z.string().refine(isAbsolute,'must be an absolute path').optional(),
 DEPLOYMENT_LIVE_SIGNER_VARIABLE:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('WALLET_PRIVATE_KEY'),
 DEPLOYMENT_LIVE_WORKER_INTERVAL_MS:z.coerce.number().int().min(5_000).max(60_000).default(15_000),
 DEPLOYMENT_LIVE_MAX_STEPS_PER_PASS:z.coerce.number().int().min(1).max(32).default(8),
 DEPLOYMENT_RPC_TIMEOUT_MS:z.coerce.number().int().min(1000).max(30000).default(12000),
 // Wallet-history maintenance: cadence once complete, and per-pass scan bounds while catching up.
 DEPLOYMENT_LIVE_HISTORY_INTERVAL_MS:z.coerce.number().int().min(5_000).max(300_000).default(30_000),
 DEPLOYMENT_LIVE_HISTORY_CHUNK_BLOCKS:z.coerce.number().int().min(1).max(10_000_000).default(100_000),
 DEPLOYMENT_LIVE_HISTORY_MAX_BLOCKS_PER_PASS:z.coerce.number().int().min(1).max(100_000_000).default(1_000_000),
 // Refresh the persisted snapshot once its source is this old (0 = every pass). Each refresh
 // starts a new wallet generation and source, and admission rejects a frozen setup review
 // whose generation/source moved, so refresh only as the 180 s readiness window requires.
 DEPLOYMENT_LIVE_SNAPSHOT_REFRESH_AFTER_SECONDS:z.coerce.number().int().min(0).max(150).default(120),
}).superRefine((env,ctx)=>{
 const need=(ok:boolean,path:string,message:string)=>{if(!ok)ctx.addIssue({code:'custom',path:[path],message});};
 if(env.DEPLOYMENT_LIVE_EXECUTION==='1'){
  need(env.RH_BROADCAST_RPC_URL!==undefined,'RH_BROADCAST_RPC_URL','required when DEPLOYMENT_LIVE_EXECUTION=1');
  need(env.DEPLOYMENT_LIVE_SIGNER_FILE!==undefined,'DEPLOYMENT_LIVE_SIGNER_FILE','required when DEPLOYMENT_LIVE_EXECUTION=1');
 }
 need(env.DEPLOYMENT_LIVE_MANAGEMENT==='0'||env.DEPLOYMENT_LIVE_EXECUTION==='1','DEPLOYMENT_LIVE_MANAGEMENT',
  'requires DEPLOYMENT_LIVE_EXECUTION=1');
 need(env.DEPLOYMENT_LIVE_HISTORY_CHUNK_BLOCKS<=env.DEPLOYMENT_LIVE_HISTORY_MAX_BLOCKS_PER_PASS,
  'DEPLOYMENT_LIVE_HISTORY_CHUNK_BLOCKS','must not exceed DEPLOYMENT_LIVE_HISTORY_MAX_BLOCKS_PER_PASS');
});
export type LiveWorkerEnv=z.infer<typeof liveWorkerEnvSchema>;

/** Supervised shared-wallet worker. With execution configured it is the only
 * process holding a signer and publisher, and its session advisory lease is the
 * command service's proof that it is connected. Without execution it only keeps
 * wallet history and the canonical wallet snapshot fresh (no lease, no signer,
 * no queue steps). Runtime services never run DDL: a missing v14 schema fails startup. */
async function main(){
 const env=liveWorkerEnvSchema.parse(process.env),stop=new AbortController();
 const identity=loadRuntimeIdentity();
 if(!identity)throw Error('CONC_LIQ_RUNTIME_IDENTITY buildId is required');
 const execute=env.DEPLOYMENT_LIVE_EXECUTION==='1',management=env.DEPLOYMENT_LIVE_MANAGEMENT==='1';
 const walletAddress=getAddress(env.DEPLOYMENT_OPERATOR_WALLET_ADDRESS),wallet={chainId:ROBINHOOD_CHAIN_ID,
  address:walletAddress.toLowerCase()} as const;
 const secrets=[env.ROBINHOOD_READ_HTTP_URL,env.PAPER_FORK_RPC_URL,env.RH_BROADCAST_RPC_URL,env.DATABASE_URL]
  .filter((value):value is string=>typeof value==='string');
 process.once('SIGINT',()=>stop.abort());
 process.once('SIGTERM',()=>stop.abort());
 const store=new DeploymentStore(env.DATABASE_URL);
 const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:8,statement_timeout:30_000});
 // An idle client dropped by PostgreSQL must not become an uncaught exception; the lease has its own handler.
 pool.on('error',error=>log('error','live_worker_pool_error',{reason:redactLiveWorkerText(error,secrets)}));
 const walletStore=new PostgresPositionManagerWalletTransferStore(env.DATABASE_URL,walletAddress);
 let lease:LiveWorkerReadinessLease|undefined;
 try{
  await store.assertReady();
  await assertLiveRuntimeSchemaReady(pool);
  await assertPositionManagerWalletTransferSchemaReady(pool);
  await walletStore.assertReady();
  const client=createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL,env.DEPLOYMENT_RPC_TIMEOUT_MS);
  assert.equal(await client.getChainId(),ROBINHOOD_CHAIN_ID,'Read endpoint is on the wrong chain');
  const loadProfiles=()=>loadLiveWorkerProfiles(store);
  assert((await loadProfiles()).length>0,'registered_market_profiles_unavailable');
  let runtime:ReturnType<typeof createRangeKeeperLiveRuntime>|undefined;
  if(execute){
   const signer=loadLiveWorkerSigner({file:env.DEPLOYMENT_LIVE_SIGNER_FILE!,variable:env.DEPLOYMENT_LIVE_SIGNER_VARIABLE,
    wallet:walletAddress});
   await assertLiveWorkerBroadcastChain({url:env.RH_BROADCAST_RPC_URL!,timeoutMs:env.DEPLOYMENT_RPC_TIMEOUT_MS});
   const execution:RangeKeeperLiveRuntimeExecution={enabled:true,signIntent:signer.signIntent,
    publishRaw:createLiveWorkerPublisher({url:env.RH_BROADCAST_RPC_URL!,timeoutMs:env.DEPLOYMENT_RPC_TIMEOUT_MS})};
   runtime=createRangeKeeperLiveRuntime({pool,client,walletAddress,transferStore:walletStore,
    loadProfiles:async()=>(await loadProfiles()).map(row=>({id:row.id,profile:row.profile,profileHash:row.profileHash})),
    rpcUrl:env.PAPER_FORK_RPC_URL??env.ROBINHOOD_READ_HTTP_URL,anvilBinary:process.env.ANVIL_BIN??'/root/.foundry/bin/anvil',
    buildId:identity.buildId,persistReviews:management,managementEnabled:management,execution});
   // Only now: every startup check passed and execution is explicitly configured.
   lease=await acquireLiveWorkerReadinessLease(pool);
  }
  log('info','live_worker_started',{wallet:walletAddress,buildId:identity.buildId,execution:execute,management,
   intervalMs:env.DEPLOYMENT_LIVE_WORKER_INTERVAL_MS,maxStepsPerPass:env.DEPLOYMENT_LIVE_MAX_STEPS_PER_PASS});
  const maintain=createLiveWorkerMaintenance({pool,client,wallet,buildId:identity.buildId,transferStore:walletStore,loadProfiles,
   history:{intervalMs:env.DEPLOYMENT_LIVE_HISTORY_INTERVAL_MS,chunkBlocks:BigInt(env.DEPLOYMENT_LIVE_HISTORY_CHUNK_BLOCKS),
    maxBlocksPerRun:BigInt(env.DEPLOYMENT_LIVE_HISTORY_MAX_BLOCKS_PER_PASS)},
   refreshAfterSeconds:env.DEPLOYMENT_LIVE_SNAPSHOT_REFRESH_AFTER_SECONDS,log});
  await runLiveWorkerLoop({intervalMs:env.DEPLOYMENT_LIVE_WORKER_INTERVAL_MS,maxSteps:env.DEPLOYMENT_LIVE_MAX_STEPS_PER_PASS,
   signal:stop.signal,log,maintain,secrets,
   execute:runtime&&lease?{lease,step:()=>runtime!.worker.execute()}:undefined});
 }finally{
  // The lease is released first so the command service stops reporting a connected worker.
  try{await lease?.release();}catch(error){log('error','live_worker_lease_release_failed',{reason:redactLiveWorkerText(error,secrets)});}
  await Promise.allSettled([pool.end(),walletStore.close(),store.close()]);
 }
}

if(process.argv[1]&&/deployments-live-worker\.(?:ts|js)$/.test(process.argv[1]))
 main().catch(error=>{
  // Zod issues name the variable and rule only; the text is still redacted like every other failure.
  const reason=error instanceof z.ZodError?`invalid_environment: ${error.issues.map(issue=>
   `${issue.path.join('.')} ${issue.message}`).join('; ')}`:error;
  log('error','live_worker_failed',{reason:redactLiveWorkerText(reason,[
   process.env.ROBINHOOD_READ_HTTP_URL,process.env.PAPER_FORK_RPC_URL,process.env.RH_BROADCAST_RPC_URL,process.env.DATABASE_URL]
    .filter((value):value is string=>typeof value==='string'))});
  process.exitCode=1;
 });
