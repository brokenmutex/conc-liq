import assert from 'node:assert/strict';
import {once} from 'node:events';
import {it} from 'node:test';
import {createDeploymentCommandServer} from '../src/deployments/server.js';
import {DeploymentConflict} from '../src/deployments/store.js';

it('live review routes enforce session and CSRF, reject wallet overrides and cannot create live drafts',async()=>{
 const origin='http://127.0.0.1:4174';let reads=0,reviews=0,writes=0;
 const store={async createDraft(){writes++;return {};},async acceptOperation(){writes++;return {};},
  async operation(){return null;},async listMarketProfiles(){return [];}};
 const server=createDeploymentCommandServer(store,{origin,
  liveWalletReview:async()=>{reads++;return {kind:'live_wallet_review',actionAvailable:false};},
  rangeKeeperLiveSetupPreflight:async()=>{reviews++;return {kind:'rangekeeper_live_setup_preflight',
   mode:'live',strategyId:'rangekeeper_v1',status:'indicative',actionAvailable:false,
   draftCreationAvailable:false,operationAcceptanceAvailable:false,executionEligible:false};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}`;
 const post=(path:string,body:unknown,headers:Record<string,string>={})=>fetch(url+path,{
  method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  assert.equal((await fetch(url+'/api/deployments/live-wallet')).status,401);
  const login=await post('/api/session',{},{origin});
  const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const {csrfToken}=await login.json() as {csrfToken:string};
  const headers={origin,cookie,'x-csrf-token':csrfToken};
  const {strategies}=await (await fetch(url+'/api/strategies',{headers:{cookie}})).json() as {strategies:Array<{id:string;live:boolean;liveSetup:boolean}>};
  assert.equal(strategies.find(s=>s.id==='rangekeeper_v1')?.liveSetup,true);
  assert.equal((strategies.find(s=>s.id==='rangekeeper_v1') as {liveAdmission?:boolean})?.liveAdmission,false);
  assert(strategies.every(s=>s.live===false));
  assert.equal((await fetch(url+'/api/deployments/live-wallet',{headers:{cookie}})).status,200);
  const limits={maxDeploymentValue:'1000000000000000000000',minDeploymentValue:'0',
   maxExposurePpm:1000000,maxLossValue:'10000000000000000000',maxDrawdownPpm:100000,
   maxActionCost:'1000000000000000000',maxRollingCost:'10000000000000000000',
   maxCampaignCost:'10000000000000000000',exitReserveWei:'1000000000000000',maxSlippageBps:20,
   minDeploymentPpm:100000,maxSwapInputValue:'1000000000000000000000',maxSwapInputPpm:1000000,
   maxSwapShortfallValue:'1000000000000000000',maxRecenters:10,maxLiquiditySharePpm:10000,
   maxObservationGapSeconds:300};
  const input={profileId:'10000000-0000-4000-8000-000000000001',capitalQuoteRaw:'250000000',fullWidthSpacings:2,limits};
  const path='/api/deployments/rangekeeper/live-setup-preflight';
  assert.equal((await post(path,input,{origin})).status,401);
  assert.equal((await post(path,input,{origin,cookie})).status,403);
  assert.equal((await post(path,input,{...headers,origin:'https://other.example'})).status,403);
  for(const override of [{wallet:'0x'+'1'.repeat(40)},{signer:'secret'},{calldata:'0x'},{fullWidthSpacings:3}])
   assert.equal((await post(path,{...input,...override},headers)).status,400);
  const reviewed=await post(path,input,headers);assert.equal(reviewed.status,200);
  assert.equal((await reviewed.json() as {executionEligible:boolean}).executionEligible,false);
  const unavailableAdmission=await post('/api/deployments/rangekeeper/live-setup-admit',{
   reviewId:'10000000-0000-4000-8000-000000000001',reviewHash:'a'.repeat(64),
   requestId:'20000000-0000-4000-8000-000000000001'},headers);
  assert.equal(unavailableAdmission.status,503);
  const draft={mode:'live',chainId:4663,wallet:'0x'+'1'.repeat(40),marketProfileId:input.profileId,
   strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
   allocation:{token0Raw:'0',token1Raw:'250000000',nativeWei:'1'},config:{fullWidthSpacings:2}};
  const rejected=await post('/api/deployments/drafts',draft,headers);
  assert.equal(rejected.status,409);assert.deepEqual(await rejected.json(),{error:'rangekeeper_live_execution_unavailable'});
  assert.equal(reads,1);assert.equal(reviews,1);assert.equal(writes,0);
 }finally{server.closeAllConnections();server.close();await once(server,'close');}
});

it('live admission readiness fails closed and never accepts signing input from HTTP',async()=>{
 const origin='http://127.0.0.1:4174';let readiness:'ready'|'stopped'|'failed'='ready',admissions=0;
 const server=createDeploymentCommandServer({async createDraft(){throw Error('wrong writer');},
  async acceptOperation(){throw Error('wrong writer');},async operation(){return null;},
  async listMarketProfiles(){return [];}},{origin,
  rangeKeeperLiveAdmissionReady:async()=>{if(readiness==='failed')throw Error('probe failed');return readiness==='ready';},
  rangeKeeperLiveSetupAdmission:async()=>{admissions++;return {status:'queued',campaignId:'campaign',jobId:'job',
   replayed:false,executionEligible:false,reason:'rangekeeper_live_execution_unavailable'};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}`;
 const post=(path:string,body:unknown,headers:Record<string,string>)=>fetch(url+path,{
  method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  const session=await post('/api/session',{},{origin});
  const cookie=session.headers.get('set-cookie')!.split(';')[0]!,{csrfToken}=await session.json() as {csrfToken:string};
  const headers={origin,cookie,'x-csrf-token':csrfToken};
  const path='/api/deployments/rangekeeper/live-setup-admit',input={reviewId:'10000000-0000-4000-8000-000000000001',
   reviewHash:'a'.repeat(64),requestId:'20000000-0000-4000-8000-000000000001'};
  assert.equal((await post(path,input,{origin})).status,401);
  assert.equal((await post(path,input,{origin,cookie})).status,403);
  assert.equal((await post(path,{...input,calldata:'0x'},headers)).status,400);
  assert.equal((await post(path,{...input,wallet:'0x'+'1'.repeat(40)},headers)).status,400);
  assert.equal((await post(path,input,headers)).status,202);assert.equal(admissions,1);
  for(const mode of ['stopped','failed'] as const){readiness=mode;
   assert.equal((await post(path,input,headers)).status,503);assert.equal(admissions,1);}
 }finally{server.closeAllConnections();server.close();await once(server,'close');}
});

it('live retain routes require a frozen strict review and are never held behind worker readiness',async()=>{
 const origin='http://127.0.0.1:4174',campaignId='10000000-0000-4000-8000-000000000001';
 let ready=true,previewCalls=0,admissions=0,replayed=false;
 const queued=()=>({status:'queued' as const,campaignId,jobId:'20000000-0000-4000-8000-000000000001',
  replayed,executionEligible:false as const,reason:'rangekeeper_live_execution_unavailable' as const});
 const server=createDeploymentCommandServer({async createDraft(){throw Error('wrong writer');},
  async acceptOperation(){throw Error('wrong writer');},async operation(){return null;},async listMarketProfiles(){return [];}},{origin,
  rangeKeeperLiveSetupAdmission:async()=>queued(),rangeKeeperLiveAdmissionReady:async()=>ready,
  rangeKeeperLiveRetainPreview:async id=>{assert.equal(id,campaignId);previewCalls++;
   return {status:'indicative',kind:'rangekeeper_live_retain_preview',trustedPreviewSaved:true,
    actionAvailable:true,operationAcceptanceAvailable:true,executionEligible:false};},
  rangeKeeperLiveRetainAdmission:async(id,input)=>{assert.equal(id,campaignId);assert.equal(input.expectedRevision,1);admissions++;return queued();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert(addr&&typeof addr!=='string');
 const url=`http://127.0.0.1:${addr.port}`;
 const post=(path:string,body:unknown,headers:Record<string,string>)=>fetch(url+path,{method:'POST',
  headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  const session=await post('/api/session',{},{origin}),cookie=session.headers.get('set-cookie')!.split(';')[0]!;
  const {csrfToken}=await session.json() as {csrfToken:string},headers={origin,cookie,'x-csrf-token':csrfToken};
  const preview=`/api/deployments/${campaignId}/live/retain-preview`,accept=`/api/deployments/${campaignId}/live/retain-operations`;
  const input={previewId:'30000000-0000-4000-8000-000000000001',contentDigest:'a'.repeat(64),expectedRevision:1,
   idempotencyKey:'40000000-0000-4000-8000-000000000001'};
  assert.equal((await post(preview,{},{origin})).status,401);
  assert.equal((await post(preview,{},{origin,cookie})).status,403);
  assert.equal((await post(preview,{wallet:'0x'+'1'.repeat(40)},headers)).status,400);
  assert.equal(previewCalls,0);
  const approvedPreview=await post(preview,{},headers);assert.equal(approvedPreview.status,200);
  assert.equal((await approvedPreview.json() as {actionAvailable:boolean}).actionAvailable,true);
  for(const extra of [{kind:'close_convert'},{calldata:'0x'},{wallet:'0x'+'1'.repeat(40)}])
   assert.equal((await post(accept,{...input,...extra},headers)).status,400);
  assert.equal(admissions,0);assert.equal((await post(accept,input,headers)).status,202);
  replayed=true;assert.equal((await post(accept,input,headers)).status,200);assert.equal(admissions,2);
  // The exit is never held behind worker readiness: a disconnected worker only
  // changes the reported liveWorker state, and the exit is queued, not executed.
  ready=false;const away=await post(preview,{},headers),awayBody=await away.json() as {actionAvailable:boolean;
   operationAcceptanceAvailable:boolean;executionEligible:boolean;liveWorker:{ready:boolean;missing:string[]}};
  assert.equal(awayBody.actionAvailable,true);assert.equal(awayBody.operationAcceptanceAvailable,true);
  assert.equal(awayBody.executionEligible,false);
  assert.deepEqual(awayBody.liveWorker,{ready:false,missing:['live_wallet_worker_not_ready']});
  const queuedAway=await post(accept,input,headers);assert.equal(queuedAway.status,200);assert.equal(admissions,3);
  const queuedBody=await queuedAway.json() as {status:string;executionEligible:boolean;liveWorker:{ready:boolean}};
  assert.equal(queuedBody.status,'queued');assert.equal(queuedBody.executionEligible,false);
  assert.equal(queuedBody.liveWorker.ready,false);
 }finally{server.closeAllConnections();server.close();await once(server,'close');}
});

const wrongWriter={async createDraft(){throw Error('wrong writer');},async acceptOperation(){throw Error('wrong writer');},
 async operation(){return null;},async listMarketProfiles(){return [];}};
async function serve(options:Partial<Parameters<typeof createDeploymentCommandServer>[1]>){
 const origin='http://127.0.0.1:4174',server=createDeploymentCommandServer(wrongWriter,{origin,...options});
 server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert(addr&&typeof addr!=='string');
 const url=`http://127.0.0.1:${addr.port}`;
 const post=(path:string,body:unknown,headers:Record<string,string>={})=>fetch(url+path,{method:'POST',
  headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 const session=await post('/api/session',{},{origin}),cookie=session.headers.get('set-cookie')!.split(';')[0]!;
 const headers={origin,cookie,'x-csrf-token':(await session.json() as {csrfToken:string}).csrfToken};
 type Strategy={id:string;live:boolean;liveSetup:boolean;liveAdmission:boolean;
  liveWorker?:{ready:boolean;missing:string[]}};
 const strategies=async()=>(await (await fetch(url+'/api/strategies',{headers:{cookie}})).json() as
  {strategies:Strategy[]}).strategies;
 const close=async()=>{server.closeAllConnections();server.close();await once(server,'close');};
 return {url,origin,cookie,headers,post,strategies,close,rangeKeeper:async()=>(await strategies()).find(s=>s.id==='rangekeeper_v1')!};
}
const liveWiring={liveWalletReview:async()=>({}),rangeKeeperLiveSetupPreflight:async()=>({}),
 rangeKeeperLiveSetupAdmission:async()=>({status:'unavailable' as const,missing:['x'],actionAvailable:false as const,
  executionEligible:false as const})};
const retainInput={previewId:'30000000-0000-4000-8000-000000000001',contentDigest:'a'.repeat(64),expectedRevision:1,
 idempotencyKey:'40000000-0000-4000-8000-000000000001'};

it('strategies report live only with live wiring and a ready worker, and expose closed reasons',async()=>{
 let state:'ready'|'missing'|'failed'|'unsafe'|'unready_without_reason'='ready';
 const probe=async()=>{
  if(state==='failed')throw Error('postgres://secret@host/db refused');
  if(state==='missing')return {ready:false,missing:['live_wallet_worker_not_connected','canonical_wallet_snapshot_stale']};
  if(state==='unsafe')return {ready:false,missing:['Bearer secret','with spaces','x'.repeat(200),'canonical_wallet_snapshot_stale']};
  if(state==='unready_without_reason')return {ready:false,missing:[]};
  return {ready:true,missing:[]};
 };
 const app=await serve({...liveWiring,rangeKeeperLiveWorkerReadiness:probe});
 try{
  const all=await app.strategies(),rk=all.find(s=>s.id==='rangekeeper_v1')!;
  assert.deepEqual([rk.live,rk.liveSetup,rk.liveAdmission],[true,true,true]);
  assert.deepEqual(rk.liveWorker,{ready:true,missing:[]});
  // Only RangeKeeper has a live path; other strategies carry no worker field.
  for(const other of all.filter(s=>s.id!=='rangekeeper_v1')){
   assert.equal(other.live,false);assert.equal(other.liveAdmission,false);assert.equal('liveWorker' in other,false);}
  state='missing';let closed=await app.rangeKeeper();
  assert.deepEqual([closed.live,closed.liveSetup,closed.liveAdmission],[false,true,false]);
  assert.deepEqual(closed.liveWorker,{ready:false,missing:['live_wallet_worker_not_connected','canonical_wallet_snapshot_stale']});
  state='failed';closed=await app.rangeKeeper();
  assert.deepEqual(closed.liveWorker,{ready:false,missing:['live_worker_readiness_probe_failed']});
  assert.equal(closed.live,false);
  assert(!JSON.stringify(closed).includes('secret'));
  // Only fixed machine codes survive, so a probe can never leak free text.
  state='unsafe';closed=await app.rangeKeeper();
  assert.deepEqual(closed.liveWorker,{ready:false,missing:['canonical_wallet_snapshot_stale']});
  state='unready_without_reason';closed=await app.rangeKeeper();
  assert.deepEqual(closed.liveWorker,{ready:false,missing:['live_wallet_worker_not_ready']});
  state='ready';assert.equal((await app.rangeKeeper()).live,true);
 }finally{await app.close();}
 // The boolean probe alone still closes admission and names a generic reason.
 let flag=true;const boolean=await serve({...liveWiring,rangeKeeperLiveAdmissionReady:async()=>flag});
 try{
  assert.deepEqual((await boolean.rangeKeeper()).liveWorker,{ready:true,missing:[]});
  flag=false;const closed=await boolean.rangeKeeper();
  assert.deepEqual(closed.liveWorker,{ready:false,missing:['live_wallet_worker_not_ready']});assert.equal(closed.live,false);
 }finally{await boolean.close();}
 // No readiness callback at all is closed, never ready.
 const bare=await serve(liveWiring);
 try{
  const closed=await bare.rangeKeeper();
  assert.deepEqual(closed.liveWorker,{ready:false,missing:['live_worker_readiness_unavailable']});
  assert.deepEqual([closed.live,closed.liveSetup,closed.liveAdmission],[false,true,false]);
 }finally{await bare.close();}
 // A ready worker is not enough without the review and admission wiring.
 const ready=async()=>({ready:true,missing:[]});
 const noAdmission=await serve({liveWalletReview:liveWiring.liveWalletReview,
  rangeKeeperLiveSetupPreflight:liveWiring.rangeKeeperLiveSetupPreflight,rangeKeeperLiveWorkerReadiness:ready});
 const noSetup=await serve({rangeKeeperLiveSetupAdmission:liveWiring.rangeKeeperLiveSetupAdmission,rangeKeeperLiveWorkerReadiness:ready});
 try{
  const a=await noAdmission.rangeKeeper(),b=await noSetup.rangeKeeper();
  assert.deepEqual([a.live,a.liveSetup,a.liveAdmission,a.liveWorker?.ready],[false,true,false,true]);
  assert.deepEqual([b.live,b.liveSetup,b.liveAdmission,b.liveWorker?.ready],[false,false,true,true]);
 }finally{await noAdmission.close();await noSetup.close();}
});

it('live admission refusal names the closed worker reasons without calling admission',async()=>{
 let admissions=0;
 const app=await serve({...liveWiring,rangeKeeperLiveSetupAdmission:async()=>{admissions++;throw Error('must not run');},
  rangeKeeperLiveWorkerReadiness:async()=>({ready:false,missing:['live_wallet_worker_not_connected']})});
 try{
  const refused=await app.post('/api/deployments/rangekeeper/live-setup-admit',{reviewId:'10000000-0000-4000-8000-000000000001',
   reviewHash:'a'.repeat(64),requestId:'20000000-0000-4000-8000-000000000001'},app.headers);
  assert.equal(refused.status,503);const body=await refused.json() as Record<string,unknown>;
  assert.equal(body.error,'rangekeeper_live_worker_not_ready');assert.equal(body.executionEligible,false);
  assert.deepEqual(body.liveWorker,{ready:false,missing:['live_wallet_worker_not_connected']});assert.equal(admissions,0);
 }finally{await app.close();}
});

it('live retain routes queue reviewed exits and map every admission outcome without claiming execution',async()=>{
 const campaignId='10000000-0000-4000-8000-000000000001',jobId='20000000-0000-4000-8000-000000000001';
 type Outcome='queued'|'replayed'|'conflict'|'unavailable'|'busy';let outcome:Outcome='queued',previews=0,admissions=0;
 const app=await serve({rangeKeeperLiveWorkerReadiness:async()=>({ready:false,missing:['live_wallet_worker_not_connected']}),
  rangeKeeperLiveRetainPreview:async id=>{assert.equal(id,campaignId);previews++;
   if(outcome==='busy')throw new DeploymentConflict('rangekeeper_live_retain_preview_busy');
   if(outcome==='unavailable')return {kind:'rangekeeper_live_retain_preview',status:'unavailable',trustedPreviewSaved:false,
    missing:['live_campaign_unavailable'],actionAvailable:false,operationAcceptanceAvailable:false,executionEligible:true};
   return {kind:'rangekeeper_live_retain_preview',status:'indicative',trustedPreviewSaved:true,
    actionAvailable:true,operationAcceptanceAvailable:true,executionEligible:false};},
  rangeKeeperLiveRetainAdmission:async id=>{assert.equal(id,campaignId);admissions++;
   if(outcome==='conflict')return {status:'request_conflict' as const,requestId:'k',missing:['live_request_id_conflict'] as ['live_request_id_conflict'],
    executionEligible:false as const};
   if(outcome==='unavailable')return {status:'unavailable' as const,missing:['live_management_review_persistence_disabled'],
    actionAvailable:false as const,executionEligible:false as const};
   return {status:'queued' as const,campaignId,jobId,replayed:outcome==='replayed',executionEligible:false as const,
    reason:'rangekeeper_live_execution_unavailable' as const};}});
 const preview=`/api/deployments/${campaignId}/live/retain-preview`,accept=`/api/deployments/${campaignId}/live/retain-operations`;
 try{
  // Worker away: the exit is still previewed and queued, and says so.
  let response=await app.post(preview,{},app.headers);assert.equal(response.status,200);
  let body=await response.json() as Record<string,any>;
  assert.equal(body.actionAvailable,true);assert.equal(body.executionEligible,false);
  assert.deepEqual(body.liveWorker,{ready:false,missing:['live_wallet_worker_not_connected']});
  response=await app.post(accept,retainInput,app.headers);assert.equal(response.status,202);
  body=await response.json();assert.equal(body.status,'queued');assert.equal(body.jobId,jobId);
  assert.equal(body.executionEligible,false);assert.equal(body.reason,'rangekeeper_live_execution_unavailable');
  assert.deepEqual(body.liveWorker,{ready:false,missing:['live_wallet_worker_not_connected']});
  outcome='replayed';response=await app.post(accept,retainInput,app.headers);assert.equal(response.status,200);
  assert.equal((await response.json() as {replayed:boolean}).replayed,true);
  outcome='conflict';response=await app.post(accept,retainInput,app.headers);assert.equal(response.status,409);
  body=await response.json();assert.equal(body.error,'live_request_id_conflict');assert.equal(body.executionEligible,false);
  outcome='unavailable';response=await app.post(accept,retainInput,app.headers);assert.equal(response.status,409);
  body=await response.json();assert.equal(body.error,'live_management_review_persistence_disabled');
  assert.equal(body.actionAvailable,false);assert.equal(body.executionEligible,false);
  // A preview the runtime could not save is never offered, and eligibility is never claimed.
  response=await app.post(preview,{},app.headers);body=await response.json();
  assert.equal(body.status,'unavailable');assert.equal(body.actionAvailable,false);assert.equal(body.executionEligible,false);
  outcome='busy';response=await app.post(preview,{},app.headers);assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'rangekeeper_live_retain_preview_busy'});
  assert.equal(previews,3);assert.equal(admissions,4);
  // Malformed ids and bodies never reach the runtime.
  assert.equal((await app.post('/api/deployments/not-a-uuid/live/retain-operations',retainInput,app.headers)).status,404);
  assert.equal((await app.post(accept,{...retainInput,expectedRevision:0},app.headers)).status,400);
  assert.equal((await app.post(accept,{...retainInput,idempotencyKey:'not-a-uuid'},app.headers)).status,400);
  assert.equal(admissions,4);
 }finally{await app.close();}
});

it('live retain routes enforce origin, session and CSRF before any runtime call',async()=>{
 const campaignId='10000000-0000-4000-8000-000000000001';let calls=0;
 const app=await serve({rangeKeeperLiveRetainPreview:async()=>{calls++;return {status:'unavailable'};},
  rangeKeeperLiveRetainAdmission:async()=>{calls++;throw Error('must not run');}});
 try{
  for(const [path,body] of [[`/api/deployments/${campaignId}/live/retain-preview`,{}],
   [`/api/deployments/${campaignId}/live/retain-operations`,retainInput]] as const){
   assert.equal((await app.post(path,body,{origin:app.origin})).status,401);
   assert.equal((await app.post(path,body,{origin:app.origin,cookie:app.cookie})).status,403);
   assert.equal((await app.post(path,body,{...app.headers,'x-csrf-token':'0'.repeat(64)})).status,403);
   assert.equal((await app.post(path,body,{...app.headers,origin:'https://other.example'})).status,403);
   assert.equal((await app.post(path,body,{cookie:app.cookie,'x-csrf-token':app.headers['x-csrf-token']})).status,403);
   assert.equal((await fetch(app.url+path,{method:'POST',headers:{origin:app.origin,cookie:app.cookie,
    'x-csrf-token':app.headers['x-csrf-token']},body:JSON.stringify(body)})).status,415);
  }
  assert.equal((await fetch(app.url+`/api/deployments/${campaignId}/live/retain-preview`,{headers:{cookie:app.cookie}})).status,404);
  assert.equal(calls,0);
 }finally{await app.close();}
});

it('live retain routes report closed unavailability when no runtime is wired',async()=>{
 const campaignId='10000000-0000-4000-8000-000000000001',app=await serve({});
 try{
  let response=await app.post(`/api/deployments/${campaignId}/live/retain-preview`,{},app.headers);
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'rangekeeper_live_retain_preview_unavailable'});
  response=await app.post(`/api/deployments/${campaignId}/live/retain-operations`,retainInput,app.headers);
  assert.equal(response.status,503);const body=await response.json() as Record<string,unknown>;
  assert.equal(body.error,'rangekeeper_live_retain_unavailable');assert.equal(body.actionAvailable,false);
  assert.equal(body.executionEligible,false);
 }finally{await app.close();}
});
