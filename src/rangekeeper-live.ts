import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {createRobinhoodClient} from './client.js';
import {parseRangeKeeperConfig,rangeKeeperConfigHash} from './strategy/rangekeeper/config.js';
import {inspectRangeKeeperLaunch} from './strategy/rangekeeper/live-preflight.js';
import {loadRangeKeeperSigner} from './strategy/rangekeeper/live-signer.js';
import {RangeKeeperLiveStore} from './strategy/rangekeeper/live-store.js';
import {RangeKeeperLiveController} from './strategy/rangekeeper/live-controller.js';
import {rangeKeeperJson} from './strategy/rangekeeper/live-domain.js';

const [command,configPath,...args]=process.argv.slice(2);
assert(command&&configPath,'Usage: rangekeeper-live COMMAND CONFIG [ARG]');
const mutation=new Set(['init','rearm-preflight','rearm-untraded','resume-preflight','resume-costed',
 'count-preflight','migrate-counts','stale-recenter-preflight','migrate-stale-recenter',
 'tick','run','stop','recover-exit','recover-mint']);
assert(command==='preflight'||command==='status'||mutation.has(command),'Unknown RangeKeeper command');
const config=parseRangeKeeperConfig(JSON.parse(readFileSync(resolve(configPath),'utf8')),{allowBroadcast:true});
const archive=process.env.RH_ARCHIVE_RPC_URL;
assert(archive,'RH_ARCHIVE_RPC_URL required');
const client=createRobinhoodClient(archive,20_000,{retryCount:0});
const buildId=JSON.parse(process.env.CONC_LIQ_RUNTIME_IDENTITY??'{}').buildId as string|undefined;
const anvil=process.env.ANVIL_BIN??'/root/.foundry/bin/anvil';
const output=(v:unknown)=>console.log(rangeKeeperJson(v));
const gate=()=>{
 for(const type of ['is-active','is-enabled']){
  const result=spawnSync('systemctl',[type,'conc-liq-live-pilot.service'],{encoding:'utf8',timeout:5000});
  assert(result.status!==null&&!result.error,'Cannot verify former pilot service status');
  assert(type==='is-active'?result.stdout.trim()==='inactive':result.stdout.trim()==='disabled',
   `Former pilot service must be ${type==='is-active'?'inactive':'disabled'}`);
 }
};
if(command==='preflight'){
 assert(buildId,'Sealed release identity required');
 const proof=await inspectRangeKeeperLaunch({client,config,buildId,rpcUrl:archive,anvilBinary:anvil,
  simulateFork:args.includes('--fork')});
 output({configHash:rangeKeeperConfigHash(config),source:proof.source,pool:proof.pool,operator:proof.operator,
  allocation:proof.funding.allocation,bookedStrategyValue:proof.funding.bookedStrategyValue,
  candidate:proof.candidate,liquiditySharePpm:proof.liquiditySharePpm,
  nativeRequiredWei:proof.nativeRequiredWei,nativeShortfallWei:proof.nativeShortfallWei,
  forkSimulated:proof.forkSimulated,preflightReason:proof.preflightReason});
}else{
 const database=process.env.DATABASE_URL;assert(database,'DATABASE_URL required');
 const store=new RangeKeeperLiveStore(database);
 try{
  if(command==='status'){
   assert(config.operator,'Status needs configured operator');
   output(await store.locked(config.operator,async db=>{
    const row=await store.current(db,config.operator!);if(!row)return null;
    const pending=await store.pending(db,row.state.id);
    return {state:row.state,monitor:row.monitor,heartbeatAt:row.heartbeatAt,
     pending:pending?{id:pending.id,status:pending.status,kind:pending.plan.kind,
      nonce:pending.intent.nonce,hash:pending.hash,broadcastAt:pending.broadcastAt,error:pending.error}:null};
   }));
  }else{
   assert(buildId,'Sealed release identity required');
   const publisherUrl=process.env.RH_BROADCAST_RPC_URL;
   assert(publisherUrl,'RH_BROADCAST_RPC_URL required for live commands');
   const publisher=createRobinhoodClient(publisherUrl,20_000,{retryCount:0});
   const signer=loadRangeKeeperSigner(config,process.cwd());
   const controller=new RangeKeeperLiveController(store,config,client,publisher,signer,buildId,archive,anvil,gate);
   await store.initialize();
   if(command==='init')output(await controller.start());
   else if(command==='rearm-preflight'||command==='rearm-untraded'){
    assert(args.length===2&&/^[0-9a-f-]{36}$/i.test(args[0]!)&&/^[0-9a-f]{64}$/i.test(args[1]!),
     'Rearm requires exact closed campaign ID and previous build ID');
    output(await controller.rearmUntraded(args[0]!,args[1]!,command==='rearm-untraded'));
   }
   else if(command==='resume-preflight'||command==='resume-costed'){
    assert(args.length===2&&/^[0-9a-f-]{36}$/i.test(args[0]!)&&/^[0-9a-f]{64}$/i.test(args[1]!),
     'Resume requires exact closed campaign ID and previous build ID');
    output(await controller.resumeCosted(args[0]!,args[1]!,command==='resume-costed'));
   }
   else if(command==='count-preflight'||command==='migrate-counts'){
    assert(args.length===2&&/^[0-9a-f-]{36}$/i.test(args[0]!)&&/^[0-9a-f]{64}$/i.test(args[1]!),
     'Count migration requires exact active campaign ID and previous build ID');
    if(command==='migrate-counts'){
     const worker=spawnSync('systemctl',['is-active','conc-liq-rangekeeper.service'],{encoding:'utf8',timeout:5000});
     assert(worker.status!==null&&!worker.error&&worker.stdout.trim()==='inactive',
      'Stop the existing RangeKeeper worker before applying a count migration');
    }
    output(await controller.migrateCounts(args[0]!,args[1]!,command==='migrate-counts'));
   }
   else if(command==='stale-recenter-preflight'||command==='migrate-stale-recenter'){
    assert(args.length===2&&/^[0-9a-f-]{36}$/i.test(args[0]!)&&/^[0-9a-f]{64}$/i.test(args[1]!),
     'Stale recenter migration requires exact campaign ID and previous build ID');
    if(command==='migrate-stale-recenter'){
     const worker=spawnSync('systemctl',['is-active','conc-liq-rangekeeper.service'],{encoding:'utf8',timeout:5000});
     assert(worker.status!==null&&!worker.error&&worker.stdout.trim()==='inactive',
      'Stop the existing RangeKeeper worker before migrating a stale recenter');
    }
    output(await controller.migrateStaleRecenter(args[0]!,args[1]!,command==='migrate-stale-recenter'));
   }
   else if(command==='stop')output(await controller.requestStop());
   else if(command==='recover-exit')output(await controller.recoverExit());
   else if(command==='recover-mint')output(await controller.recoverMint());
   else if(command==='tick'){
    const result=await controller.tick();output({status:result.status,result:'result' in result?result.result:null});
   }else{
    assert(command==='run');
    while(true){
     const result=await controller.tick();output({status:result.status,result:'result' in result?result.result:null});
     if(result.state.phase==='closed'||result.state.phase==='halted')break;
     // The first quote pass can consume most of the confirmation window.
     // Still require a distinct canonical block and fresh simulated quote.
     const delay=result.status==='first_confirmation'||result.status==='duplicate_or_backward_observation'?1_000:30_000;
     await new Promise(resolve=>setTimeout(resolve,delay));
    }
   }
  }
 }finally{await store.close();}
}
