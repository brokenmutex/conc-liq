import assert from 'node:assert/strict';
import {once} from 'node:events';
import {it} from 'node:test';
import {createLiveCommandWiring,resolveLiveReviewPersistence,type LiveCommandRuntime} from '../src/deployments/live-command-wiring.js';
import {createDeploymentCommandServer} from '../src/deployments/server.js';
import {DeploymentConflict} from '../src/deployments/store.js';

const wallet={chainId:4663 as const,address:'0x0000000000000000000000000000000000000900'};
const campaignId='10000000-0000-4000-8000-000000000001';
const retainBody={previewId:'30000000-0000-4000-8000-000000000001',contentDigest:'a'.repeat(64),expectedRevision:1,
 idempotencyKey:'40000000-0000-4000-8000-000000000001'};
const SCHEMA_REASON='live_runtime_or_wallet_history_schema_unavailable';

// deployments.ts reads the schema once at startup; walletTransferStore is non-null only
// for exactly v14 with a valid operator wallet, and that is what auto persistence follows.
const liveSchemaReady=(version:number,walletConfigured:boolean)=>version===14&&walletConfigured;

it('live review persistence follows the schema when unset and honours explicit 0 and 1',()=>{
 // v14 with a configured wallet: unset turns persistence on without any new env key.
 assert.equal(resolveLiveReviewPersistence(undefined,liveSchemaReady(14,true)),true);
 assert.equal(resolveLiveReviewPersistence('0',liveSchemaReady(14,true)),false);
 assert.equal(resolveLiveReviewPersistence('1',liveSchemaReady(14,true)),true);
 // v11: unset stays off (read-only review), 0 stays off, explicit 1 keeps its earlier
 // behaviour and the live runtime itself fails closed below v14.
 assert.equal(resolveLiveReviewPersistence(undefined,liveSchemaReady(11,true)),false);
 assert.equal(resolveLiveReviewPersistence('0',liveSchemaReady(11,true)),false);
 assert.equal(resolveLiveReviewPersistence('1',liveSchemaReady(11,true)),true);
 // v14 without a configured wallet is not ready: unset stays off.
 assert.equal(resolveLiveReviewPersistence(undefined,liveSchemaReady(14,false)),false);
 assert.equal(resolveLiveReviewPersistence('0',liveSchemaReady(14,false)),false);
 // Intermediate schemas never auto-enable.
 for(const version of [0,7,12,13,15])assert.equal(resolveLiveReviewPersistence(undefined,liveSchemaReady(version,true)),false);
});

function fakeRuntime(){
 const calls={previews:[] as string[],operations:[] as string[],convertPreviews:[] as string[],convertOperations:[] as string[]};let release:(()=>void)|null=null,hold=false;
 const runtime:LiveCommandRuntime={
  async retainPreview(id){calls.previews.push(id);if(hold)await new Promise<void>(resolve=>{release=resolve;});
   return {kind:'rangekeeper_live_retain_preview',status:'indicative',trustedPreviewSaved:true,actionAvailable:true,
    operationAcceptanceAvailable:true,executionEligible:false};},
  async retainOperation(id){calls.operations.push(id);return {status:'queued',campaignId:id,jobId:'20000000-0000-4000-8000-000000000001',
   replayed:false,executionEligible:false,reason:'rangekeeper_live_execution_unavailable'};},
  async convertPreview(id){calls.convertPreviews.push(id);if(hold)await new Promise<void>(resolve=>{release=resolve;});
   return {kind:'rangekeeper_live_convert_preview',status:'indicative',trustedPreviewSaved:true,actionAvailable:true,
    operationAcceptanceAvailable:true,executionEligible:false};},
  async convertOperation(id){calls.convertOperations.push(id);return {status:'queued',campaignId:id,jobId:'20000000-0000-4000-8000-000000000002',
   replayed:false,executionEligible:false,reason:'rangekeeper_live_execution_unavailable'};},
 };
 return {runtime,calls,holdPreviews:()=>{hold=true;},resume:()=>{hold=false;release?.();}};
}

it('v11 or non-v14 wiring never builds a runtime and reports specific closed reasons',async()=>{
 for(const [schemaVersion,walletIdentity] of [[11,null],[11,wallet],[12,wallet],[13,wallet]] as const){
  let built=0,probed=0;
  const wiring=createLiveCommandWiring({schemaVersion,walletIdentity,
   readiness:async()=>{probed++;return {ready:true,missing:[]};},
   createRuntime:()=>{built++;throw Error('must not be built below v14');}});
  assert.equal(wiring.runtimeAvailable,false);assert.equal(built,0);
  assert.deepEqual(await wiring.workerReadiness(),{ready:false,missing:[SCHEMA_REASON]});assert.equal(probed,0);
  const preview=await wiring.retainPreview(campaignId) as Record<string,unknown>;
  assert.equal(preview.status,'unavailable');assert.deepEqual(preview.missing,[SCHEMA_REASON]);
  assert.equal(preview.actionAvailable,false);assert.equal(preview.operationAcceptanceAvailable,false);
  assert.equal(preview.executionEligible,false);assert.equal(preview.trustedPreviewSaved,false);
  assert.deepEqual(await wiring.retainAdmission(campaignId,retainBody),
   {status:'unavailable',missing:[SCHEMA_REASON],actionAvailable:false,executionEligible:false});
  const convert=await wiring.convertPreview(campaignId) as Record<string,unknown>;
  assert.equal(convert.kind,'rangekeeper_live_convert_preview');assert.equal(convert.status,'unavailable');assert.deepEqual(convert.missing,[SCHEMA_REASON]);
  assert.equal(convert.actionAvailable,false);assert.equal(convert.operationAcceptanceAvailable,false);
  assert.equal(convert.executionEligible,false);assert.equal(convert.trustedPreviewSaved,false);
  assert.deepEqual(await wiring.convertAdmission(campaignId,retainBody),
   {status:'unavailable',missing:[SCHEMA_REASON],actionAvailable:false,executionEligible:false});
 }
 // v14 without a usable operator wallet is closed with its own reason.
 const noWallet=createLiveCommandWiring({schemaVersion:14,walletIdentity:null,
  readiness:async()=>({ready:true,missing:[]}),createRuntime:()=>{throw Error('must not be built without a wallet');}});
 assert.deepEqual(await noWallet.workerReadiness(),{ready:false,missing:['server_operator_wallet_address_invalid']});
 assert.deepEqual((await noWallet.retainPreview(campaignId) as {missing:string[]}).missing,['server_operator_wallet_address_invalid']);
});

it('v14 wiring delegates to the composed runtime, serialises exit previews and fails closed on probe errors',async()=>{
 const fake=fakeRuntime();let built=0,probes=0,state:'ready'|'throws'|'missing'='ready';
 const wiring=createLiveCommandWiring({schemaVersion:14,walletIdentity:wallet,
  readiness:async w=>{probes++;assert.deepEqual(w,wallet);
   if(state==='throws')throw Error('connection refused postgres://secret');
   return state==='missing'?{ready:false,missing:['live_wallet_worker_not_connected']}:{ready:true,missing:[]};},
  createRuntime:()=>{built++;return fake.runtime;}});
 assert.equal(built,1);assert.equal(wiring.runtimeAvailable,true);assert.equal(wiring.unavailableReason,null);
 assert.deepEqual(await wiring.workerReadiness(),{ready:true,missing:[]});
 state='missing';assert.deepEqual(await wiring.workerReadiness(),{ready:false,missing:['live_wallet_worker_not_connected']});
 state='throws';assert.deepEqual(await wiring.workerReadiness(),{ready:false,missing:['live_worker_readiness_probe_failed']});
 // A worker that is away never blocks the exit path.
 assert.equal(((await wiring.retainPreview(campaignId)) as {status:string}).status,'indicative');
 assert.equal((await wiring.retainAdmission(campaignId,retainBody)).status,'queued');
 assert.deepEqual(fake.calls,{previews:[campaignId],operations:[campaignId],convertPreviews:[],convertOperations:[]});
 assert.equal(((await wiring.convertPreview(campaignId)) as {status:string}).status,'indicative');
 assert.equal((await wiring.convertAdmission(campaignId,retainBody)).status,'queued');
 assert.deepEqual(fake.calls,{previews:[campaignId],operations:[campaignId],convertPreviews:[campaignId],convertOperations:[campaignId]},
  'the convert exit is delegated to its own runtime callbacks, never to the retain ones');
 fake.holdPreviews();const first=wiring.retainPreview(campaignId);
 await assert.rejects(wiring.retainPreview(campaignId),(error:unknown)=>error instanceof DeploymentConflict&&
  error.code==='rangekeeper_live_retain_preview_busy');
 // One owned fork at a time across both exit previews.
 await assert.rejects(wiring.convertPreview(campaignId),(error:unknown)=>error instanceof DeploymentConflict&&
  error.code==='rangekeeper_live_convert_preview_busy');
 fake.resume();await first;
 assert.equal(((await wiring.retainPreview(campaignId)) as {status:string}).status,'indicative');
 assert.equal(fake.calls.previews.length,3,'The rejected concurrent preview must not reach the runtime');
 assert.equal(fake.calls.convertPreviews.length,1,'The rejected concurrent convert preview must not reach the runtime');
});

it('a failing runtime constructor leaves startup healthy with a specific closed reason',async()=>{
 let reported:unknown=null;
 const wiring=createLiveCommandWiring({schemaVersion:14,walletIdentity:wallet,readiness:async()=>({ready:true,missing:[]}),
  createRuntime:()=>{throw Error('compose failed');},onRuntimeFailure:error=>{reported=error;throw Error('logger broke');}});
 assert.equal(wiring.runtimeAvailable,false);assert((reported as Error).message==='compose failed');
 assert.equal(wiring.unavailableReason,'live_retain_runtime_unavailable');
 assert.deepEqual((await wiring.retainPreview(campaignId) as {missing:string[]}).missing,['live_retain_runtime_unavailable']);
 assert.equal((await wiring.retainAdmission(campaignId,retainBody)).status,'unavailable');
 assert.deepEqual((await wiring.convertPreview(campaignId) as {missing:string[]}).missing,['live_retain_runtime_unavailable']);
 assert.equal((await wiring.convertAdmission(campaignId,retainBody)).status,'unavailable');
 // Worker readiness is still reported honestly; exits are what is closed.
 assert.deepEqual(await wiring.workerReadiness(),{ready:true,missing:[]});
});

async function serve(wiring:ReturnType<typeof createLiveCommandWiring>){
 const origin='http://127.0.0.1:4174';
 const server=createDeploymentCommandServer({async createDraft(){throw Error('wrong writer');},
  async acceptOperation(){throw Error('wrong writer');},async operation(){return null;},async listMarketProfiles(){return [];}},{origin,
  liveWalletReview:async()=>({}),rangeKeeperLiveSetupPreflight:async()=>({}),
  rangeKeeperLiveSetupAdmission:async()=>({status:'unavailable',missing:['live_review_admission_disabled'],
   actionAvailable:false,executionEligible:false}),
  rangeKeeperLiveAdmissionReady:async()=>(await wiring.workerReadiness()).ready,rangeKeeperLiveWorkerReadiness:wiring.workerReadiness,
  rangeKeeperLiveRetainPreview:wiring.retainPreview,rangeKeeperLiveRetainAdmission:wiring.retainAdmission});
 server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert(addr&&typeof addr!=='string');
 const url=`http://127.0.0.1:${addr.port}`;
 const post=(path:string,body:unknown,headers:Record<string,string>={})=>fetch(url+path,{method:'POST',
  headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 const session=await post('/api/session',{},{origin}),cookie=session.headers.get('set-cookie')!.split(';')[0]!;
 const headers={origin,cookie,'x-csrf-token':(await session.json() as {csrfToken:string}).csrfToken};
 return {url,post,headers,cookie,close:async()=>{server.closeAllConnections();server.close();await once(server,'close');}};
}

it('v11 command serves live review and exit routes as specific closed answers, never a server error',async()=>{
 const app=await serve(createLiveCommandWiring({schemaVersion:11,walletIdentity:null,
  readiness:async()=>{throw Error('no probe below v14');},createRuntime:()=>{throw Error('no runtime below v14');}}));
 try{
  const {strategies}=await (await fetch(app.url+'/api/strategies',{headers:{cookie:app.cookie}})).json() as
   {strategies:Array<{id:string;live:boolean;liveSetup:boolean;liveAdmission:boolean;liveWorker?:{ready:boolean;missing:string[]}}>};
  const rk=strategies.find(s=>s.id==='rangekeeper_v1')!;
  assert.deepEqual([rk.live,rk.liveAdmission],[false,false]);
  assert.deepEqual(rk.liveWorker,{ready:false,missing:[SCHEMA_REASON]});
  const admit=await app.post('/api/deployments/rangekeeper/live-setup-admit',{reviewId:'10000000-0000-4000-8000-000000000001',
   reviewHash:'a'.repeat(64),requestId:'20000000-0000-4000-8000-000000000001'},app.headers);
  assert.equal(admit.status,503);
  assert.deepEqual((await admit.json() as {liveWorker:unknown}).liveWorker,{ready:false,missing:[SCHEMA_REASON]});
  const preview=await app.post(`/api/deployments/${campaignId}/live/retain-preview`,{},app.headers);
  assert.equal(preview.status,200);
  const previewBody=await preview.json() as Record<string,unknown>;
  assert.equal(previewBody.status,'unavailable');assert.deepEqual(previewBody.missing,[SCHEMA_REASON]);
  assert.equal(previewBody.actionAvailable,false);assert.equal(previewBody.operationAcceptanceAvailable,false);
  assert.equal(previewBody.executionEligible,false);
  const retain=await app.post(`/api/deployments/${campaignId}/live/retain-operations`,retainBody,app.headers);
  assert.equal(retain.status,409);const retainResult=await retain.json() as Record<string,unknown>;
  assert.equal(retainResult.error,SCHEMA_REASON);assert.equal(retainResult.actionAvailable,false);
  assert.equal(retainResult.executionEligible,false);
 }finally{await app.close();}
});

it('v14 command queues an exit while the worker is away and reports readiness separately',async()=>{
 const fake=fakeRuntime();let workerUp=false;
 const app=await serve(createLiveCommandWiring({schemaVersion:14,walletIdentity:wallet,
  readiness:async()=>workerUp?{ready:true,missing:[]}:{ready:false,missing:['live_wallet_worker_not_connected']},
  createRuntime:()=>fake.runtime}));
 const strategy=async()=>(await (await fetch(app.url+'/api/strategies',{headers:{cookie:app.cookie}})).json() as
  {strategies:Array<{id:string;live:boolean;liveWorker?:{ready:boolean;missing:string[]}}>}).strategies.find(s=>s.id==='rangekeeper_v1')!;
 try{
  let rk=await strategy();assert.equal(rk.live,false);
  assert.deepEqual(rk.liveWorker,{ready:false,missing:['live_wallet_worker_not_connected']});
  const queued=await app.post(`/api/deployments/${campaignId}/live/retain-operations`,retainBody,app.headers);
  assert.equal(queued.status,202);const body=await queued.json() as {status:string;executionEligible:boolean;liveWorker:{ready:boolean}};
  assert.equal(body.status,'queued');assert.equal(body.executionEligible,false);assert.equal(body.liveWorker.ready,false);
  workerUp=true;rk=await strategy();assert.equal(rk.live,true);assert.deepEqual(rk.liveWorker,{ready:true,missing:[]});
 }finally{await app.close();}
});

it('the composed runtime the command builds has no signer or publisher and answers closed without a database',async()=>{
 const {createRangeKeeperLiveRuntime}=await import('../src/deployments/rangekeeper-live-runtime.js');
 const failing=()=>{throw Error('database unavailable');};
 const pool={query:failing,connect:failing} as never;
 for(const persistReviews of [false,true]){
  const runtime=createRangeKeeperLiveRuntime({pool,client:{} as never,walletAddress:wallet.address,transferStore:{} as never,
   loadProfiles:async()=>[],rpcUrl:'http://127.0.0.1:1',anvilBinary:'/unused',buildId:'b'.repeat(64),persistReviews,
   managementEnabled:false});
  assert.equal(runtime.adapters.signIntent,undefined);assert.equal(runtime.adapters.publishRaw,undefined);
  assert.equal((await runtime.workerReadiness()).executionConfigured,false);
  const preview=await runtime.retainPreview(campaignId);
  assert.equal(preview.status,'unavailable');assert.equal(preview.actionAvailable,false);assert.equal(preview.executionEligible,false);
  const admission=await runtime.retainOperation(campaignId,retainBody);
  assert.equal(admission.status,'unavailable');assert.equal(admission.executionEligible,false);
  const convert=await runtime.convertPreview(campaignId);
  assert.equal(convert.status,'unavailable');assert.equal(convert.kind,'rangekeeper_live_convert_preview');
  assert.equal(convert.actionAvailable,false);assert.equal(convert.executionEligible,false);
  const convertAdmission=await runtime.convertOperation(campaignId,retainBody);
  assert.equal(convertAdmission.status,'unavailable');assert.equal(convertAdmission.executionEligible,false);
 }
});
