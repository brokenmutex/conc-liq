import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {describe,it} from 'node:test';
import {keccak256,type Hex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {liveWorkerEnvSchema} from '../src/deployments-live-worker.js';
import {loadLiveWorkerSigner,redactLiveWorkerText} from '../src/deployments/live-worker-signer.js';
import {assertLiveWorkerBroadcastChain,createLiveWorkerPublisher} from '../src/deployments/live-worker-publisher.js';
import {liveWorkerBackoffMs,runLiveWorkerLoop,runLiveWorkerPass,type LiveWorkerLoopDeps} from '../src/deployments/live-worker-loop.js';
import {classifyLiveWorkerSnapshotRefresh,createLiveWorkerMaintenance,
 type LiveWorkerMaintenanceInput} from '../src/deployments/live-worker-maintenance.js';
import type {RangeKeeperWorkerResult} from '../src/deployments/rangekeeper-live-wallet-worker.js';
import {MIGRATION_CHECKSUMS} from '../src/storage/migration-checksums.js';
// @ts-expect-error Release tooling is a JavaScript module.
import {inventory,releaseId} from '../scripts/release-files.mjs';

const keyHex=generatePrivateKey(),account=privateKeyToAccount(keyHex);
const baseEnv={DATABASE_URL:'postgresql://user:secret@localhost/db',ROBINHOOD_READ_HTTP_URL:'https://read.example/rpc-key',
 DEPLOYMENT_OPERATOR_WALLET_ADDRESS:account.address};
const executionEnv={...baseEnv,DEPLOYMENT_LIVE_EXECUTION:'1',RH_BROADCAST_RPC_URL:'https://publish.example/rpc-key',
 DEPLOYMENT_LIVE_SIGNER_FILE:'/etc/conc-liq/key.env'};
const intentFor=(operator:`0x${string}`,nonce=7)=>({id:'37df20c4-12ab-4fd4-a5a5-020f0dcd06f5',chainId:4663 as const,operator,action:'test_fixture',
 nonce,to:'0x2222222222222222222222222222222222222222' as const,data:'0x1234',value:'0' as const,gas:'210000',maxFeePerGas:'1000000000',
 maxPriorityFeePerGas:'1000',sourceBlock:'100',sourceHash:`0x${'ab'.repeat(32)}`});

describe('live worker environment',()=>{
 it('defaults to observe-only with bounded cadence and no signer requirement',()=>{
  const env=liveWorkerEnvSchema.parse(baseEnv);
  assert.equal(env.DEPLOYMENT_LIVE_EXECUTION,'0');assert.equal(env.DEPLOYMENT_LIVE_MANAGEMENT,'0');
  assert.equal(env.DEPLOYMENT_LIVE_WORKER_INTERVAL_MS,15_000);assert.equal(env.DEPLOYMENT_LIVE_MAX_STEPS_PER_PASS,8);
  assert.equal(env.DEPLOYMENT_LIVE_SIGNER_VARIABLE,'WALLET_PRIVATE_KEY');assert.equal(env.DEPLOYMENT_RPC_TIMEOUT_MS,12_000);
  assert.equal(env.RH_BROADCAST_RPC_URL,undefined);assert.equal(env.DEPLOYMENT_LIVE_SIGNER_FILE,undefined);
 });
 it('requires the broadcast endpoint and an absolute signer file only when execution is enabled',()=>{
  assert.equal(liveWorkerEnvSchema.parse(executionEnv).DEPLOYMENT_LIVE_EXECUTION,'1');
  const {RH_BROADCAST_RPC_URL:_url,...noUrl}=executionEnv;
  assert.throws(()=>liveWorkerEnvSchema.parse(noUrl),/RH_BROADCAST_RPC_URL/);
  const {DEPLOYMENT_LIVE_SIGNER_FILE:_file,...noFile}=executionEnv;
  assert.throws(()=>liveWorkerEnvSchema.parse(noFile),/DEPLOYMENT_LIVE_SIGNER_FILE/);
  assert.throws(()=>liveWorkerEnvSchema.parse({...executionEnv,DEPLOYMENT_LIVE_SIGNER_FILE:'relative/key.env'}),/absolute/);
  // Observe-only ignores the execution settings entirely.
  assert.equal(liveWorkerEnvSchema.parse({...baseEnv,DEPLOYMENT_LIVE_EXECUTION:'0'}).DEPLOYMENT_LIVE_EXECUTION,'0');
 });
 it('refuses management without execution and rejects non-http publisher endpoints',()=>{
  assert.throws(()=>liveWorkerEnvSchema.parse({...baseEnv,DEPLOYMENT_LIVE_MANAGEMENT:'1'}),/DEPLOYMENT_LIVE_MANAGEMENT/);
  assert.equal(liveWorkerEnvSchema.parse({...executionEnv,DEPLOYMENT_LIVE_MANAGEMENT:'1'}).DEPLOYMENT_LIVE_MANAGEMENT,'1');
  assert.throws(()=>liveWorkerEnvSchema.parse({...executionEnv,RH_BROADCAST_RPC_URL:'ftp://publish.example/'}));
  assert.throws(()=>liveWorkerEnvSchema.parse({...executionEnv,DEPLOYMENT_LIVE_EXECUTION:'yes'}));
 });
 it('bounds the loop interval, step budget, history limits and wallet address',()=>{
  const bad=(patch:Record<string,string>)=>assert.throws(()=>liveWorkerEnvSchema.parse({...baseEnv,...patch}));
  bad({DEPLOYMENT_LIVE_WORKER_INTERVAL_MS:'1000'});bad({DEPLOYMENT_LIVE_WORKER_INTERVAL_MS:'600000'});
  bad({DEPLOYMENT_LIVE_MAX_STEPS_PER_PASS:'0'});bad({DEPLOYMENT_LIVE_MAX_STEPS_PER_PASS:'33'});
  bad({DEPLOYMENT_RPC_TIMEOUT_MS:'10'});bad({DEPLOYMENT_LIVE_HISTORY_INTERVAL_MS:'1'});
  bad({DEPLOYMENT_LIVE_HISTORY_CHUNK_BLOCKS:'0'});bad({DEPLOYMENT_LIVE_HISTORY_MAX_BLOCKS_PER_PASS:'100000001'});
  bad({DEPLOYMENT_LIVE_HISTORY_CHUNK_BLOCKS:'2000000',DEPLOYMENT_LIVE_HISTORY_MAX_BLOCKS_PER_PASS:'1000000'});
  bad({DEPLOYMENT_LIVE_SNAPSHOT_REFRESH_AFTER_SECONDS:'175'});bad({DEPLOYMENT_LIVE_SNAPSHOT_REFRESH_AFTER_SECONDS:'-1'});
  bad({DEPLOYMENT_OPERATOR_WALLET_ADDRESS:'0x1234'});
  assert.equal(liveWorkerEnvSchema.parse({...baseEnv,DEPLOYMENT_LIVE_SNAPSHOT_REFRESH_AFTER_SECONDS:'0'}).DEPLOYMENT_LIVE_SNAPSHOT_REFRESH_AFTER_SECONDS,0);
  const env=liveWorkerEnvSchema.parse({...baseEnv,DEPLOYMENT_LIVE_WORKER_INTERVAL_MS:'30000',DEPLOYMENT_LIVE_MAX_STEPS_PER_PASS:'2'});
  assert.equal(env.DEPLOYMENT_LIVE_WORKER_INTERVAL_MS,30_000);assert.equal(env.DEPLOYMENT_LIVE_MAX_STEPS_PER_PASS,2);
 });
});

describe('live worker signer',()=>{
 const fixture=(content:string,mode=0o600)=>{
  const directory=mkdtempSync(join(tmpdir(),'conc-liq-live-worker-signer-')),file=join(directory,'key.env');
  writeFileSync(file,content);chmodSync(file,mode);
  return {directory,file,close:()=>rmSync(directory,{recursive:true,force:true})};
 };
 it('loads a private key file, signs the exact intent envelope and returns only the raw transaction',async()=>{
  const f=fixture(`WALLET_PRIVATE_KEY=${keyHex}\n`);
  try{
   const signer=loadLiveWorkerSigner({file:f.file,variable:'WALLET_PRIVATE_KEY',wallet:account.address.toLowerCase()});
   assert.equal(signer.address,account.address);assert(!JSON.stringify(signer).includes(keyHex.slice(2)));
   const raw=await signer.signIntent(intentFor(account.address));
   assert.match(raw,/^0x02[0-9a-f]+$/);
   assert.equal(await createLiveWorkerPublisher({url:'https://p.example/',fetchImpl:async(_u,init)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.method,'eth_sendRawTransaction');assert.deepEqual(body.params,[raw]);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:keccak256(raw)}));}})(raw),keccak256(raw));
   // A different sender or operator cannot be signed for.
   await assert.rejects(()=>signer.signIntent(intentFor('0x2222222222222222222222222222222222222222')),/operator/i);
  }finally{f.close();}
 });
 it('accepts a bare 64-hex key and a custom variable name',()=>{
  const f=fixture(`OTHER_KEY=${keyHex.slice(2)}\n`);
  try{assert.equal(loadLiveWorkerSigner({file:f.file,variable:'OTHER_KEY',wallet:account.address}).address,account.address);}
  finally{f.close();}
 });
 it('rejects group/world-accessible key files, symlinks and relative paths with a secret-free message',()=>{
  const f=fixture(`WALLET_PRIVATE_KEY=${keyHex}\n`,0o644);
  try{
   const input={file:f.file,variable:'WALLET_PRIVATE_KEY',wallet:account.address};
   assert.throws(()=>loadLiveWorkerSigner(input),error=>{
    assert(error instanceof Error);assert.match(error.message,/private file permissions/);assert(!error.message.includes(keyHex.slice(2)));return true;});
   chmodSync(f.file,0o640);assert.throws(()=>loadLiveWorkerSigner(input),/private file permissions/);
   chmodSync(f.file,0o600);assert.equal(loadLiveWorkerSigner(input).address,account.address);
   const link=join(f.directory,'link.env');symlinkSync(f.file,link);
   assert.throws(()=>loadLiveWorkerSigner({...input,file:link}),/private file permissions/);
   assert.throws(()=>loadLiveWorkerSigner({...input,file:'key.env'}),/absolute/);
  }finally{f.close();}
 });
 it('rejects a key whose derived address differs from the configured wallet',()=>{
  const f=fixture(`WALLET_PRIVATE_KEY=${keyHex}\n`);
  try{assert.throws(()=>loadLiveWorkerSigner({file:f.file,variable:'WALLET_PRIVATE_KEY',
   wallet:privateKeyToAccount(generatePrivateKey()).address}),/differs from configured operator wallet/);}
  finally{f.close();}
 });
 it('rejects malformed, missing and non-hex keys without echoing them',()=>{
  const f=fixture('');
  try{
   for(const value of ['bad-sensitive-fixture-value','0x1234',`0x${'0'.repeat(64)}`,'']){
    writeFileSync(f.file,`WALLET_PRIVATE_KEY=${value}\n`);chmodSync(f.file,0o600);
    assert.throws(()=>loadLiveWorkerSigner({file:f.file,variable:'WALLET_PRIVATE_KEY',wallet:account.address}),error=>{
     assert(error instanceof Error);assert.equal(error.message,'Cannot load live signer key: check private file permissions and configured variable');
     return true;});
   }
   writeFileSync(f.file,`WALLET_PRIVATE_KEY=${keyHex}\n`);chmodSync(f.file,0o600);
   assert.throws(()=>loadLiveWorkerSigner({file:f.file,variable:'MISSING_VARIABLE',wallet:account.address}),/Cannot load live signer key/);
   assert.throws(()=>loadLiveWorkerSigner({file:join(f.directory,'absent.env'),variable:'WALLET_PRIVATE_KEY',wallet:account.address}),/Cannot load live signer key/);
  }finally{f.close();}
 });
 it('redacts credentialed URLs and supplied secrets from log text',()=>{
  const text=redactLiveWorkerText(new Error('HTTP request failed. URL: https://user:pass@rpc.example/v1/abc123 token=supersecretvalue'),
   ['supersecretvalue']);
  assert(!/rpc\.example|abc123|pass@|supersecretvalue/.test(text),text);assert.match(text,/\[redacted-url\]/);
  assert.equal(redactLiveWorkerText('x'.repeat(1000)).length,240);
 });
});

describe('live worker publisher',()=>{
 const raw=('0x02'+'ab'.repeat(40)) as Hex,rpc=(body:unknown,status=200)=>async()=>new Response(JSON.stringify(body),{status});
 it('returns the node acknowledgement only when it equals the raw transaction hash',async()=>{
  const publish=createLiveWorkerPublisher({url:'https://p.example/',fetchImpl:rpc({jsonrpc:'2.0',id:1,result:keccak256(raw)})});
  assert.equal(await publish(raw),keccak256(raw));
  assert.equal(await createLiveWorkerPublisher({url:'https://p.example/',
   fetchImpl:rpc({jsonrpc:'2.0',id:1,result:keccak256(raw).toUpperCase().replace('0X','0x')})})(raw),keccak256(raw).toUpperCase().replace('0X','0x'));
 });
 it('rejects a mismatched, malformed or missing acknowledgement hash',async()=>{
  for(const result of [`0x${'11'.repeat(32)}`,'0x1234',null,42,undefined]){
   await assert.rejects(()=>createLiveWorkerPublisher({url:'https://p.example/',
    fetchImpl:rpc({jsonrpc:'2.0',id:1,result})})(raw),/publisher_hash_differs_from_raw/);
  }
  await assert.rejects(()=>createLiveWorkerPublisher({url:'https://p.example/',fetchImpl:rpc({})})(raw),/publisher_hash_differs_from_raw/);
  await assert.rejects(()=>createLiveWorkerPublisher({url:'https://p.example/',fetchImpl:rpc({})})('0x02a' as Hex),/malformed/);
 });
 it('treats an exact already-known acknowledgement as idempotent but surfaces other node errors without the endpoint',async()=>{
  const known=createLiveWorkerPublisher({url:'https://p.example/key',fetchImpl:rpc({jsonrpc:'2.0',id:1,error:{code:-32000,message:'already known'}})});
  assert.equal(await known(raw),keccak256(raw));
  const rejected=createLiveWorkerPublisher({url:'https://p.example/key',
   fetchImpl:rpc({jsonrpc:'2.0',id:1,error:{code:-32000,message:'nonce too low at https://p.example/key'}})});
  await assert.rejects(()=>rejected(raw),error=>{assert(error instanceof Error);assert.match(error.message,/nonce too low/);
   assert(!/p\.example|\/key/.test(error.message),error.message);return true;});
  await assert.rejects(()=>createLiveWorkerPublisher({url:'https://p.example/key',fetchImpl:rpc({},502)})(raw),/broadcast_rpc_http_502/);
  await assert.rejects(()=>createLiveWorkerPublisher({url:'https://p.example/secret-path',fetchImpl:async()=>{
   throw new TypeError('fetch failed https://p.example/secret-path');}})(raw),error=>{
   assert(error instanceof Error);assert(!/secret-path|p\.example/.test(error.message),error.message);return true;});
 });
 it('verifies the broadcast endpoint is on chain 4663 before use',async()=>{
  await assertLiveWorkerBroadcastChain({url:'https://p.example/',fetchImpl:rpc({jsonrpc:'2.0',id:1,result:'0x1237'})});
  await assert.rejects(()=>assertLiveWorkerBroadcastChain({url:'https://p.example/',fetchImpl:rpc({jsonrpc:'2.0',id:1,result:'0x1'})}),/wrong chain/);
  await assert.rejects(()=>assertLiveWorkerBroadcastChain({url:'https://p.example/',fetchImpl:rpc({jsonrpc:'2.0',id:1})}),/wrong chain/);
 });
});

type Step=RangeKeeperWorkerResult|Error;
function loopHarness(steps:Step[],overrides:Partial<LiveWorkerLoopDeps>&{lease?:()=>Promise<void>;maintain?:LiveWorkerLoopDeps['maintain']}={}){
 const logs:Array<{level:string;event:string;fields?:Record<string,unknown>}>=[],stop=new AbortController();
 let executed=0,leaseChecks=0,maintained=0;
 const deps:LiveWorkerLoopDeps={intervalMs:5_000,maxSteps:4,signal:stop.signal,
  log:(level,event,fields)=>{logs.push({level,event,fields});},
  maintain:overrides.maintain??(async()=>{maintained++;return {ready:true,reasons:[]};}),
  execute:overrides.execute===undefined&&'execute' in overrides?undefined:{
   lease:{assertHealthy:async()=>{leaseChecks++;await overrides.lease?.();}},
   step:async()=>{executed++;const next=steps.shift()??{status:'idle' as const};if(next instanceof Error)throw next;return next;}},
  ...Object.fromEntries(Object.entries(overrides).filter(([key])=>!['lease','maintain','execute'].includes(key)))};
 return {deps,logs,stop,counts:()=>({executed,leaseChecks,maintained})};
}

describe('live worker loop',()=>{
 it('steps the queue while it reports progress and stops on idle',async()=>{
  const h=loopHarness([{status:'prepared',jobId:'j1',stage:'swap'},{status:'reconciled',jobId:'j1',stage:'swap',effectId:'e1'},
   {status:'completed',jobId:'j1',effectId:'e2'},{status:'idle'}],{maxSteps:8});
  const result=await runLiveWorkerPass(h.deps);
  assert.deepEqual(result,{outcome:'idle',steps:4});assert.equal(h.counts().executed,4);
  assert.deepEqual(h.logs.filter(l=>l.event==='live_worker_step').map(l=>l.fields?.status),['prepared','reconciled','completed']);
  assert.equal(h.logs.find(l=>l.fields?.status==='reconciled')?.fields?.jobId,'j1');
  assert.equal(h.logs.find(l=>l.fields?.status==='reconciled')?.fields?.effectId,'e1');
 });
 it('caps steps per pass and reports remaining progress',async()=>{
  const steps:Step[]=Array.from({length:10},()=>({status:'reconciled' as const,jobId:'j',stage:'s'}));
  const h=loopHarness(steps,{maxSteps:3});
  assert.deepEqual(await runLiveWorkerPass(h.deps),{outcome:'progress',steps:3});assert.equal(h.counts().executed,3);
 });
 it('stops a pass on blocked and disabled results and logs the redacted reason',async()=>{
  const blocked=loopHarness([{status:'reconciled',jobId:'j',stage:'s'},
   {status:'blocked',jobId:'j',reason:'HTTP request failed. URL: https://rpc.example/secret'},{status:'reconciled',jobId:'j',stage:'s'}]);
  assert.deepEqual(await runLiveWorkerPass(blocked.deps),{outcome:'blocked',steps:2});
  const entry=blocked.logs.find(l=>l.fields?.status==='blocked');
  assert.equal(entry?.level,'error');assert.equal(entry?.fields?.jobId,'j');assert(!JSON.stringify(entry).includes('rpc.example'));
  const disabled=loopHarness([{status:'disabled',jobId:'j',reason:'signer_disabled'},{status:'reconciled',jobId:'j'}]);
  assert.deepEqual(await runLiveWorkerPass(disabled.deps),{outcome:'disabled',steps:1});
  assert.equal(disabled.logs.find(l=>l.fields?.status==='disabled')?.fields?.reason,'signer_disabled');
 });
 it('treats a throwing step as a failed pass, not a crash',async()=>{
  const h=loopHarness([new Error('connect ECONNREFUSED https://rpc.example/key')]);
  assert.deepEqual(await runLiveWorkerPass(h.deps),{outcome:'failed',steps:0});
  assert(!JSON.stringify(h.logs).includes('rpc.example'));assert.equal(h.logs[0]?.event,'live_worker_step_failed');
 });
 it('defers execution without error when maintenance is not ready or throws, and runs observe-only without a queue',async()=>{
  const notReady=loopHarness([{status:'reconciled',jobId:'j'}],{maintain:async()=>({ready:false,reasons:['canonical_wallet_snapshot_unavailable']})});
  assert.deepEqual(await runLiveWorkerPass(notReady.deps),{outcome:'deferred',steps:0});assert.equal(notReady.counts().executed,0);
  const throwing=loopHarness([],{maintain:async()=>{throw new Error('rpc down');}});
  assert.deepEqual(await runLiveWorkerPass(throwing.deps),{outcome:'deferred',steps:0});
  assert.equal(throwing.logs[0]?.event,'live_worker_maintenance_failed');
  const observeOnly=loopHarness([{status:'reconciled',jobId:'j'}],{execute:undefined});
  assert.deepEqual(await runLiveWorkerPass(observeOnly.deps),{outcome:'observed',steps:0});
  assert.equal(observeOnly.counts().maintained,1);assert.equal(observeOnly.counts().executed,0);
 });
 it('lease loss stops execution and propagates for a non-zero exit',async()=>{
  let healthy=true;
  const before=loopHarness([{status:'reconciled',jobId:'j'}],{lease:async()=>{if(!healthy)throw new Error('live worker readiness lease lost');}});
  healthy=false;
  await assert.rejects(()=>runLiveWorkerPass(before.deps),/lease lost/);
  assert.equal(before.counts().executed,0);assert.equal(before.counts().maintained,0);
  // Lost between steps: no further step is taken after the failing assertion.
  let calls=0;
  const between=loopHarness(Array.from({length:6},()=>({status:'reconciled' as const,jobId:'j',stage:'s'})),
   {maxSteps:8,lease:async()=>{if(++calls===4)throw new Error('live worker readiness lease lost');}});
  await assert.rejects(()=>runLiveWorkerLoop(between.deps),/lease lost/);
  assert.equal(between.counts().executed,2);
 });
 it('backs off exponentially on repeated blocked results and resets after progress',async()=>{
  assert.equal(liveWorkerBackoffMs(15_000,0),15_000);assert.equal(liveWorkerBackoffMs(15_000,1),30_000);
  assert.equal(liveWorkerBackoffMs(15_000,3),120_000);assert.equal(liveWorkerBackoffMs(15_000,20),300_000);
  assert.equal(liveWorkerBackoffMs(400_000,5),400_000);
  const steps:Step[]=[{status:'blocked',jobId:'j',reason:'canonical_stage_reverted'},{status:'blocked',jobId:'j',reason:'canonical_stage_reverted'},
   {status:'blocked',jobId:'j',reason:'canonical_stage_reverted'},{status:'idle'},{status:'idle'}];
  const delays:number[]=[],h=loopHarness(steps,{intervalMs:10_000});
  h.deps.sleep=async ms=>{delays.push(ms);if(delays.length===5)h.stop.abort();};
  await runLiveWorkerLoop(h.deps);
  assert.deepEqual(delays,[20_000,40_000,80_000,10_000,10_000]);
  assert.equal(h.logs.filter(l=>l.event==='live_worker_backoff').length,3);
 });
 it('finishes the in-flight step and then stops on abort',async()=>{
  const h=loopHarness([{status:'reconciled',jobId:'j',stage:'s'},{status:'reconciled',jobId:'j',stage:'s'}],{maxSteps:8});
  const inner=h.deps.execute!.step;
  h.deps.execute!.step=async()=>{const result=await inner();h.stop.abort();return result;};
  const sleeps:number[]=[];h.deps.sleep=async ms=>{sleeps.push(ms);};
  await runLiveWorkerLoop(h.deps);
  assert.equal(h.counts().executed,1);assert.equal(sleeps.length,1);
 });
 it('uses a short pause after a budget-limited pass so queued work drains promptly',async()=>{
  const h=loopHarness(Array.from({length:3},()=>({status:'reconciled' as const,jobId:'j',stage:'s'})),{maxSteps:3,intervalMs:15_000});
  const delays:number[]=[];h.deps.sleep=async ms=>{delays.push(ms);h.stop.abort();};
  await runLiveWorkerLoop(h.deps);assert.deepEqual(delays,[1_000]);
 });
});

describe('live worker snapshot classification',()=>{
 it('maps refresh results to refreshed, busy and unavailable',()=>{
  assert.deepEqual(classifyLiveWorkerSnapshotRefresh({status:'persisted',missing:[]}),{status:'refreshed',missing:[]});
  for(const code of ['persisted_live_queue_has_priority','persisted_live_action_recovery_has_priority'])
   assert.equal(classifyLiveWorkerSnapshotRefresh({status:'unavailable',missing:[code]}).status,'busy');
  assert.equal(classifyLiveWorkerSnapshotRefresh({status:'unavailable',missing:['canonical_wallet_snapshot_unavailable']},
   new Error('Wallet has an unresolved pending transaction')).status,'busy');
  assert.equal(classifyLiveWorkerSnapshotRefresh({status:'unavailable',missing:['canonical_wallet_snapshot_unavailable']},
   new Error('Wallet snapshot refresh is blocked by an unresolved stage')).status,'busy');
  assert.deepEqual(classifyLiveWorkerSnapshotRefresh({status:'unavailable',missing:['canonical_wallet_snapshot_unavailable']},
   new Error('rpc timeout')),{status:'unavailable',missing:['canonical_wallet_snapshot_unavailable']});
  // A persisted-but-blocked wallet is not readiness.
  assert.equal(classifyLiveWorkerSnapshotRefresh({status:'persisted',missing:['wallet_snapshot_persisted_blocked']}).status,'unavailable');
  assert.deepEqual(classifyLiveWorkerSnapshotRefresh({status:'read_only',missing:[]}),{status:'unavailable',missing:['wallet_snapshot_unavailable']});
 });
});

function walletPool(state:null|{status:string;source_timestamp:number}){
 const query=async(sql:string)=>{
  if(sql.includes('SELECT EXISTS'))return {rows:[{present:true}]};
  if(sql.includes('max(version)'))return {rows:[{version:14}]};
  if(sql.includes('FROM schema_migrations ORDER BY version'))
   return {rows:Array.from({length:14},(_,index)=>({version:index+1,checksum:MIGRATION_CHECKSUMS[index]}))};
  if(sql.includes('FROM deployment_live_wallet_tokens'))return {rows:[]};
  if(sql.includes('FROM deployment_live_wallets'))return {rows:state?[{generation:3,status:state.status,source_block:'900',
   source_hash:`0x${'11'.repeat(32)}`,source_timestamp:state.source_timestamp,snapshot_hash:'a'.repeat(64),commitments_hash:'b'.repeat(64),
   nonce:'1',pending_nonce:'1',native_balance_wei:'1'}]:[]};
  throw Error(`unexpected sql: ${sql.slice(0,60)}`);
 };
 return {query} as unknown as LiveWorkerMaintenanceInput['pool'];
}
function maintenanceHarness(options:{cursor?:boolean;state?:null|{status:string;source_timestamp:number};
 scans?:Array<Record<string,unknown>|Error>;refreshes?:Array<{status:'refreshed'|'busy'|'unavailable';missing:string[]}>}={}){
 const logs:Array<{level:string;event:string;fields?:Record<string,unknown>}>=[],scans=[...(options.scans??[])],refreshes=[...(options.refreshes??[])];
 let time=Date.now(),scanCalls=0,refreshCalls=0,refreshSource:unknown;
 // rangeKeeperConfirmedSource reads the real clock; only the maintenance clock (`time`) is advanced.
 const sourceTimestamp=()=>Math.floor(Date.now()/1000)-20;
 const client={getBlock:async(args?:{blockNumber:bigint})=>args?{number:args.blockNumber,hash:`0x${'22'.repeat(32)}`,
  timestamp:BigInt(sourceTimestamp())}:{number:2_000n}} as unknown as LiveWorkerMaintenanceInput['client'];
 const input:LiveWorkerMaintenanceInput={pool:walletPool(options.state===undefined?null:options.state),client,
  wallet:{chainId:4663,address:account.address.toLowerCase()},buildId:'a'.repeat(64),
  transferStore:{getCursor:async()=>options.cursor===false?null:{coveredThroughBlock:1_000n}} as unknown as LiveWorkerMaintenanceInput['transferStore'],
  loadProfiles:async()=>[{profile:{pool:{positionManager:'0x1111111111111111111111111111111111111111'}}} as never],
  history:{intervalMs:30_000,chunkBlocks:1_000n,maxBlocksPerRun:10_000n},refreshAfterSeconds:120,
  log:(level,event,fields)=>{logs.push({level,event,fields});},now:()=>time,
  maintainHistory:(async()=>{scanCalls++;const next=scans.shift()??{status:'scanned',completeThroughSource:true,chunks:0,transfers:0,coveredThroughBlock:'1980'};
   if(next instanceof Error)throw next;return next;}) as unknown as LiveWorkerMaintenanceInput['maintainHistory'],
  refreshSnapshot:(async(args:{source:unknown})=>{refreshCalls++;refreshSource=args.source;
   return refreshes.shift()??{status:'refreshed',missing:[]};}) as unknown as LiveWorkerMaintenanceInput['refreshSnapshot']};
 return {input,logs,advance:(ms:number)=>{time+=ms;},stats:()=>({scanCalls,refreshCalls,refreshSource})};
}

describe('live worker maintenance',()=>{
 it('never initializes missing wallet history: it reports uninitialized and neither scans nor refreshes',async()=>{
  const h=maintenanceHarness({cursor:false}),maintain=createLiveWorkerMaintenance(h.input);
  assert.deepEqual(await maintain(),{ready:false,reasons:['wallet_history_uninitialized']});
  assert.deepEqual({...h.stats(),refreshSource:undefined},{scanCalls:0,refreshCalls:0,refreshSource:undefined});
 });
 it('scans complete history, refreshes a missing snapshot at the confirmed source and reports ready',async()=>{
  const h=maintenanceHarness({state:null}),maintain=createLiveWorkerMaintenance(h.input);
  assert.deepEqual(await maintain(),{ready:true,reasons:[]});
  const stats=h.stats();assert.equal(stats.scanCalls,1);assert.equal(stats.refreshCalls,1);
  assert.equal((stats.refreshSource as {block:bigint}).block,1_936n);
  assert(h.logs.some(l=>l.event==='live_worker_wallet_snapshot'));assert(h.logs.some(l=>l.event==='live_worker_ready'));
 });
 it('refreshes only when the snapshot is stale and rescans only on the history cadence',async()=>{
  const h=maintenanceHarness({state:{status:'available',source_timestamp:0}});
  h.input.pool=walletPool({status:'available',source_timestamp:Math.floor(h.input.now!()/1000)-60});
  const maintain=createLiveWorkerMaintenance(h.input);
  assert.equal((await maintain()).ready,true);
  assert.deepEqual({s:h.stats().scanCalls,r:h.stats().refreshCalls},{s:1,r:0});
  h.advance(10_000);await maintain();assert.deepEqual({s:h.stats().scanCalls,r:h.stats().refreshCalls},{s:1,r:0});
  h.advance(25_000);await maintain();
  // 95 s old: still fresh; the cadence elapsed so history is checked again.
  assert.deepEqual({s:h.stats().scanCalls,r:h.stats().refreshCalls},{s:2,r:0});
  h.input.pool=walletPool({status:'available',source_timestamp:Math.floor(h.input.now!()/1000)-121});
  await maintain();assert.equal(h.stats().refreshCalls,1);
  h.input.pool=walletPool({status:'blocked',source_timestamp:Math.floor(h.input.now!()/1000)-5});
  await maintain();assert.equal(h.stats().refreshCalls,2);
 });
 it('treats queued or unresolved work as busy (ready, no error) and a failed refresh as not ready',async()=>{
  const busy=maintenanceHarness({state:null,refreshes:[{status:'busy',missing:['persisted_live_queue_has_priority']}]});
  assert.deepEqual(await createLiveWorkerMaintenance(busy.input)(),{ready:true,reasons:[]});
  assert(!busy.logs.some(l=>l.level==='error'||l.event==='live_worker_not_ready'));
  const failed=maintenanceHarness({state:null,refreshes:[{status:'unavailable',missing:['canonical_wallet_snapshot_unavailable']}]});
  assert.deepEqual(await createLiveWorkerMaintenance(failed.input)(),{ready:false,reasons:['canonical_wallet_snapshot_unavailable']});
  assert(failed.logs.some(l=>l.event==='live_worker_not_ready'));
  const thrown=maintenanceHarness({state:null});
  thrown.input.refreshSnapshot=async()=>{throw new Error('boom https://rpc.example/key');};
  assert.deepEqual(await createLiveWorkerMaintenance(thrown.input)(),{ready:false,reasons:['wallet_snapshot_refresh_failed']});
  assert(!JSON.stringify(thrown.logs).includes('rpc.example'));
 });
 it('keeps scanning every pass while catching up and never refreshes before history is complete',async()=>{
  const h=maintenanceHarness({state:null,scans:[{status:'scanned',completeThroughSource:false,chunks:10,transfers:0,coveredThroughBlock:'500'},
   {status:'scanned',completeThroughSource:true,chunks:5,transfers:1,coveredThroughBlock:'1980'}]});
  const maintain=createLiveWorkerMaintenance(h.input);
  assert.deepEqual(await maintain(),{ready:false,reasons:['wallet_history_catching_up']});
  assert.deepEqual({s:h.stats().scanCalls,r:h.stats().refreshCalls},{s:1,r:0});
  assert.deepEqual(await maintain(),{ready:true,reasons:[]});
  assert.deepEqual({s:h.stats().scanCalls,r:h.stats().refreshCalls},{s:2,r:1});
 });
 it('reports an unavailable or failing history scan as not ready without repairing it',async()=>{
  const unavailable=maintenanceHarness({state:null,scans:[{status:'unavailable',reason:'transfer_scan_coverage_boundary_changed'}]});
  const maintainA=createLiveWorkerMaintenance(unavailable.input);
  assert.deepEqual(await maintainA(),{ready:false,reasons:['wallet_history_transfer_scan_coverage_boundary_changed']});
  assert.equal(unavailable.stats().refreshCalls,0);
  const failing=maintenanceHarness({state:null,scans:[new Error('getLogs failed https://rpc.example/key')]});
  assert.deepEqual(await createLiveWorkerMaintenance(failing.input)(),{ready:false,reasons:['wallet_history_maintenance_failed']});
  assert(!JSON.stringify(failing.logs).includes('rpc.example'));assert.equal(failing.stats().refreshCalls,0);
  // The failure is retried only after the cadence, not on every pass.
  const retry=maintenanceHarness({state:null,scans:[new Error('x')]}),maintain=createLiveWorkerMaintenance(retry.input);
  await maintain();await maintain();assert.equal(retry.stats().scanCalls,1);
  retry.advance(31_000);assert.equal((await maintain()).ready,true);assert.equal(retry.stats().scanCalls,2);
 });
 it('logs readiness transitions once instead of every pass',async()=>{
  const h=maintenanceHarness({cursor:false}),maintain=createLiveWorkerMaintenance(h.input);
  await maintain();await maintain();await maintain();
  assert.equal(h.logs.filter(l=>l.event==='live_worker_not_ready').length,1);
 });
});

describe('release unit',()=>{
 it('renders conc-liq-rangekeeper.service against the sealed release with the live worker command',()=>{
  const temp=mkdtempSync(join(tmpdir(),'conc-liq-live-worker-unit-')),release=join(temp,'release'),output=join(temp,'rendered'),
   envFile=join(temp,'private-runtime.env');
  mkdirSync(release);writeFileSync(join(release,'sentinel'),'fixture');
  const manifest={format:1,sourceCommit:'live-worker-unit-fixture',nodeVersion:process.version,files:inventory(release),buildId:''};
  manifest.buildId=releaseId(manifest);writeFileSync(join(release,'release.json'),JSON.stringify(manifest));
  try{
   const report=JSON.parse(execFileSync(process.execPath,[resolve('scripts/render-release-units.mjs'),release,envFile,output],
    {cwd:process.cwd(),encoding:'utf8'})) as {installed:boolean;rendered:string[]};
   assert.equal(report.installed,false);assert(report.rendered.includes('conc-liq-rangekeeper.service'));
   const unit=readFileSync(join(output,'conc-liq-rangekeeper.service'),'utf8');
   assert.match(unit,/^Description=conc-liq supervised RangeKeeper live wallet worker$/m);
   assert.match(unit,/ExecStart=.*\/release\/bin\/node .*\/release\/launch\.mjs .*private-runtime\.env deployments-live-worker$/m);
   assert.match(unit,/^Conflicts=conc-liq-live-pilot\.service$/m);assert.match(unit,/^Restart=on-failure$/m);
   assert.match(unit,/^StartLimitBurst=\d+$/m);assert.match(unit,/^TimeoutStopSec=\d+s$/m);
   assert.match(unit,/^NoNewPrivileges=true$/m);assert.match(unit,/^ProtectSystem=full$/m);assert.match(unit,/^UMask=0077$/m);
   assert.doesNotMatch(unit,/^Environment(?:File)?=/m);assert.doesNotMatch(unit,/PRIVATE_KEY|npm run/);
  }finally{rmSync(temp,{recursive:true,force:true});}
 });
});
