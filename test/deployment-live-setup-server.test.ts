import assert from 'node:assert/strict';
import {once} from 'node:events';
import {it} from 'node:test';
import {createDeploymentCommandServer} from '../src/deployments/server.js';

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

it('live retain routes require a frozen strict review and preserve closed readiness',async()=>{
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
  ready=false;const closed=await post(preview,{},headers);
  assert.equal((await closed.json() as {actionAvailable:boolean}).actionAvailable,false);
  assert.equal((await post(accept,input,headers)).status,503);assert.equal(admissions,2);
 }finally{server.closeAllConnections();server.close();await once(server,'close');}
});
