import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {livePilotConfig} from './live-pilot/config.js';
import {loadPilotEnvSigner} from './live-pilot/signer.js';
import {PilotStore} from './live-pilot/store.js';
import {PilotChain} from './live-pilot/chain.js';
import {PilotController} from './live-pilot/controller.js';
import {readPilotGuard} from './live-pilot/guard.js';
import {createRobinhoodClient} from './client.js';
import {loadIndexerConfig} from './indexer/config.js';
import {PostgresRpcHealthGate} from './rpc-health/store.js';
import {pilotGasValuer} from './live-pilot/valuation.js';
import {json} from './live-pilot/domain.js';
import {PostgresRiskStore} from './risk/store.js';
import {loadRiskConfig} from './risk/config.js';
import {refreshRiskEvidence} from './risk/refresh.js';

const [command='',envPath='',configPath='config/live-pilot-nvda-250.json']=process.argv.slice(2);
assert(['init','tick','run','status','exit','resume','stop','recover-exit','retry-approval'].includes(command)&&envPath,'Usage: live-pilot.mjs init|tick|run|status|exit|resume|stop|recover-exit|retry-approval ENV [CONFIG]');
const config=livePilotConfig(JSON.parse(readFileSync(configPath,'utf8')),{allowBroadcast:true});
assert(config.operator);const operator=config.operator;
const env=parseEnv(readFileSync(envPath,'utf8'));if(config.signer?.kind==='env_file'){delete env[config.signer.variable];delete process.env[config.signer.variable];}
Object.assign(process.env,env);const indexer=loadIndexerConfig();
assert(process.env.DATABASE_URL);
const store=new PilotStore(process.env.DATABASE_URL),health=new PostgresRpcHealthGate({connectionString:process.env.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const client=createRobinhoodClient(indexer.rpcUrl,indexer.rpcTimeoutMs,{beforeRequest:()=>health.assertBulkAllowed().then(()=>{}),retryCount:0});
const riskStore=new PostgresRiskStore(process.env.DATABASE_URL),riskConfig=loadRiskConfig();
let stopped=false;for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopped=true;});
const statusPath=resolve(process.env.PILOT_STATUS_PATH??'data/live-pilot-status.json');
async function status() {
 const campaign=(await store.pool.query(`SELECT state,heartbeat_at,monitor FROM ${store.schema}.campaigns WHERE operator=$1`,[operator.toLowerCase()])).rows[0]??null;
 const actions=campaign?(await store.pool.query(`SELECT id,intent->>'action' AS kind,status,hash,created_at,broadcast_at,error,
  receipt->'facts'->>'gasWei' AS gas_wei FROM ${store.schema}.actions WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 50`,[campaign.state.id])).rows:[];
 const marks=campaign?(await store.pool.query(`SELECT at,block::text,kind,snapshot FROM ${store.schema}.marks WHERE campaign_id=$1 AND kind='mark' ORDER BY id DESC LIMIT 100`,[campaign.state.id])).rows:[];
 const value={computedAt:new Date().toISOString(),broadcastEnabled:config.broadcastEnabled,campaign,actions,marks};
 writeFileSync(statusPath+'.tmp',json(value)+'\n',{mode:0o600});renameSync(statusPath+'.tmp',statusPath);return value;
}
try {
 await store.initialize();
 if(command==='status')console.log(json(await status()));
 else {
  assert(!config.broadcastEnabled||process.env.PILOT_BROADCAST_RPC_URL,'Active execution requires an explicit publishing RPC');
  const publisher=process.env.PILOT_BROADCAST_RPC_URL?createRobinhoodClient(process.env.PILOT_BROADCAST_RPC_URL,indexer.rpcTimeoutMs,{retryCount:0}):client;
  const signer=loadPilotEnvSigner(config,process.cwd()),chain=new PilotChain(client,config,pilotGasValuer(client,config),publisher);
  const controller=new PilotController(store,chain,config,signer,(db,state)=>readPilotGuard(db,client,config,indexer.streamKey,state,(riskRunId,validationOnly)=>
   refreshRiskEvidence({config:indexer,riskConfig,gate:health,store:riskStore,riskRunId,validationOnly})));
  if(command==='init')console.log(json(await controller.start()));
  else if(command==='recover-exit')console.log(json(await controller.recoverExit()));
  else if(command==='retry-approval'){
   try{console.log(json(await controller.retryApproval(process.env.PILOT_INITIAL_APPROVAL_HASH)));}
   catch(error){
    const message=error instanceof Error?error.message:'';
    const reason=message==='Signed approval fee is below current base fee'?'initial_approval_waiting_for_lower_gas':
     message==='Signed approval gas limit is no longer sufficient'?'initial_approval_gas_limit_unavailable':
     message==='Fresh approval admission failed'?'initial_approval_waiting_for_admission':'initial_approval_retry_requires_review';
    await store.locked(operator,async db=>{const row=await store.current(db,operator);if(row)await store.monitor(db,row.state.id,[reason]);});
    await status();throw error;
   }
  }
  else if(['exit','resume','stop','recover-exit'].includes(command))console.log(json(await controller.request(command==='resume'?'running':command==='stop'?'stopped':'exit')));
  else do {
   try{const result=await controller.tick();console.log(json({at:new Date().toISOString(),...result}));}
   catch(error){console.error(json({at:new Date().toISOString(),event:'pilot_tick_failed',reason:error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[redacted-url]').slice(0,220):'unknown'}));if(command==='tick')process.exitCode=1;}
   await status();if(command!=='run'||stopped)break;await new Promise(r=>setTimeout(r,5000));
  }while(!stopped);
  await status();
 }
}finally{await store.close();await health.close();await riskStore.close();}
