import assert from 'node:assert/strict';
import {once} from 'node:events';
import {it} from 'node:test';
import {createDeploymentCommandServer} from '../src/deployments/server.js';

it('command API requires operator session, exact origin and CSRF before a draft is stored without a password',async()=>{
 const origin='http://127.0.0.1:4174';
 const calls:unknown[]=[];
 const previewCalls:Array<{id:string;kind:string}>=[];
 const setupCalls:unknown[]=[];
 const setupDraftCalls:unknown[]=[];
 let setupDraftListCalls=0;
 const dashboardReads:string[]=[];
 let acceptCalls=0;
 const store={
  async createDraft(input:unknown){calls.push(input);return {id:'67b2b303-e821-4450-bb7b-27171b12079f',revision:1};},
  async acceptOperation(){acceptCalls++;throw Error('not expected');},
  async operation(){return null;},
  async listMarketProfiles(){return [{id:'aef5f51e-18ef-4e9c-952d-8d772970f708',draftAvailable:true,deploymentAvailable:false}];},
 };
 const server=createDeploymentCommandServer(store, {origin,
 paperPreview:async(id,kind)=>{previewCalls.push({id,kind});
   // Preview producers cannot expose an actionable result until the separate
   // acceptance and worker admission path is ready.
   return {status:'indicative',actionAvailable:true,economics:null,...(kind==='open'?{
    previewId:'aef5f51e-18ef-4e9c-952d-8d772970f708',contentDigest:'a'.repeat(64),
    expectedRevision:1,expiresAt:'2026-09-23T10:00:00.000Z',trustedPreviewSaved:true}: {})};},
  paperSetupPreflight:async(input)=>{setupCalls.push(input);return {kind:'paper_setup_preflight',
   status:'unavailable',actionAvailable:false,draftCreated:false,operationCreated:false};},
  paperSetupDraftAdmission:async(input)=>{setupDraftCalls.push(input);const attempt=setupDraftCalls.length;
   if(attempt===1)return {status:'draft_created',draftId:'67b2b303-e821-4450-bb7b-27171b12079f',
    revision:1,configHash:'c'.repeat(64),profileId:'aef5f51e-18ef-4e9c-952d-8d772970f708',
    replayed:false,source:{block:'100',hash:'0x'+'a'.repeat(64),timestamp:1},
    range:{tickLower:-60,tickUpper:60},allocationHash:'d'.repeat(64)};
   if(attempt===2)return {status:'draft_created',draftId:'67b2b303-e821-4450-bb7b-27171b12079f',
    revision:1,configHash:'c'.repeat(64),profileId:'aef5f51e-18ef-4e9c-952d-8d772970f708',
    replayed:true,source:{block:'100',hash:'0x'+'a'.repeat(64),timestamp:1},
    range:{tickLower:-60,tickUpper:60},allocationHash:'d'.repeat(64)};
   if(attempt===4)return {status:'unavailable',draftId:null,revision:null,configHash:null,
    profileId:'aef5f51e-18ef-4e9c-952d-8d772970f708',missing:['setup_gas_price_exceeds_reviewed_bound'],limitations:[]};
   return {status:'request_conflict',requestId:'aef5f51e-18ef-4e9c-952d-8d772970f709',
   profileId:'aef5f51e-18ef-4e9c-952d-8d772970f708',missing:['draft_request_id_conflict']};},
  paperSetupDraftList:async()=>{setupDraftListCalls++;return [{id:'67b2b303-e821-4450-bb7b-27171b12079f',revision:1}];},
  dashboardRead:async(path)=>{dashboardReads.push(path);
   return path.startsWith('/api/positions/paper-dep-')&&!path.includes('?')?null:{path};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}`;
 const post=(path:string,body:unknown,headers:Record<string,string>={})=>fetch(url+path,{
  method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  const operatorPage=await fetch(url+'/operator');
  assert.equal(operatorPage.status,200);
  assert.match(operatorPage.headers.get('content-security-policy')??'',/script-src 'self'/);
  assert.match(await operatorPage.text(),/id="setup-form"/);
  assert.equal((await fetch(url+'/tabs.js')).status,200);
  assert.equal((await fetch(url+'/operator-session.js')).status,200);
  assert.equal((await fetch(url+'/research.css')).status,200);
  assert.deepEqual(await (await fetch(url+'/api/research')).json(),{path:'/api/research'});
  assert.deepEqual(await (await fetch(url+'/api/dashboard')).json(),{path:'/api/dashboard'});
  assert.deepEqual(await (await fetch(url+'/api/positions?hours=6')).json(),
   {path:'/api/positions?hours=6'});
  const detailId='paper-dep-67b2b303-e821-4450-bb7b-27171b12079f';
  assert.deepEqual(await (await fetch(url+`/api/positions/${detailId}?hours=24`)).json(),
   {path:`/api/positions/${detailId}?hours=24`});
  const missing=await fetch(url+`/api/positions/${detailId}`);
  assert.equal(missing.status,404);
  assert.deepEqual(await missing.json(),{error:'position_not_found'});
  assert.equal((await fetch(url+'/api/positions?hours=2')).status,400);
  assert.deepEqual(dashboardReads,['/api/research','/api/dashboard','/api/positions?hours=6',
   `/api/positions/${detailId}?hours=24`,`/api/positions/${detailId}`]);
  assert.equal((await fetch(url+'/api/strategies')).status,401);
  assert.equal((await fetch(url+'/api/deployments/setup-drafts')).status,401,
   'saved draft recovery must require the loopback operator session');
  assert.equal((await post('/api/session',{})).status,403);
  assert.equal((await post('/api/session',{password:'obsolete'},{origin})).status,400);
  const login=await post('/api/session',{},{origin});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')?.split(';')[0];assert(cookie);
  const {csrfToken}=await login.json() as {csrfToken:string};
  const draftList=await fetch(url+'/api/deployments/setup-drafts',{headers:{cookie}});
  assert.equal(draftList.status,200);
  assert.deepEqual(await draftList.json(),{drafts:[{id:'67b2b303-e821-4450-bb7b-27171b12079f',revision:1}]});
  assert.equal(setupDraftListCalls,1);
  const setupPath='/api/deployments/setup-preflight',setupInput={
   profileId:'aef5f51e-18ef-4e9c-952d-8d772970f708',capitalQuoteRaw:'100000000',halfWidthTicks:60};
  assert.equal((await post(setupPath,setupInput,{origin})).status,401);
  assert.equal((await post(setupPath,setupInput,{origin,cookie})).status,403);
  assert.equal((await post(setupPath,{...setupInput,capitalQuoteRaw:'1.5'},
   {origin,cookie,'x-csrf-token':csrfToken})).status,400);
  const setup=await post(setupPath,setupInput,{origin,cookie,'x-csrf-token':csrfToken});
  assert.equal(setup.status,200);
  assert.deepEqual(await setup.json(),{kind:'paper_setup_preflight',status:'unavailable',
   actionAvailable:false,draftCreated:false,operationCreated:false});
  assert.deepEqual(setupCalls,[setupInput]);
  assert.equal(calls.length,0);
  assert.equal(acceptCalls,0);
  const setupDraftPath='/api/deployments/setup-drafts';
  const setupDraftInput={requestId:'aef5f51e-18ef-4e9c-952d-8d772970f709',reviewId:'aef5f51e-18ef-4e9c-952d-8d772970f710',profileId:setupInput.profileId,
   capitalQuoteRaw:setupInput.capitalQuoteRaw,halfWidthTicks:setupInput.halfWidthTicks,
   wallet:'0x1111111111111111111111111111111111111111',
   allocation:{token0Raw:'50000000',token1Raw:'0',nativeWei:'10000000000000000'},
   limits:{maxDeploymentValue:'100000000000000000000',minDeploymentValue:'1000000000000000000',
    maxExposurePpm:1000000,maxLossValue:'1000000000000000000',maxDrawdownPpm:1000000,
    maxActionCost:'5000000000000000000',maxRollingCost:'8000000000000000000',
    maxCampaignCost:'8000000000000000000',exitReserveWei:'1000000000000000',maxSlippageBps:50},
   reviewed:{profileId:setupInput.profileId,profileHash:'b'.repeat(64),
    input:{capitalQuoteRaw:setupInput.capitalQuoteRaw,halfWidthTicks:60},
    source:{block:'100',hash:'0x'+'a'.repeat(64),timestamp:1},
    profile:{pool:'0x1111111111111111111111111111111111111111',fee:3000,tickSpacing:60,
     token0:'0x2222222222222222222222222222222222222222',token1:'0x3333333333333333333333333333333333333333',quoteToken:1},
    range:{centerTick:0,centerAnchorTick:0,halfWidthTicks:60,tickLower:-60,tickUpper:60,
     fullWidthTicks:120,lowerPriceQuotePerBaseX18:'990000000000000000',upperPriceQuotePerBaseX18:'1010000000000000000'},
    requirements:{liquidity:'100',token0Raw:'50000000',token1Raw:'0',referenceValueQuoteRaw:'50000000',
     budgetResidualQuoteRaw:'50000000',sizingConvention:'maximize_v3_liquidity_under_independent_reference_quote_budget'},
    references:{price0:'1000000000000000000',price1:'1000000000000000000',
     nativePrice:'2000000000000000000000',proofHash:'c'.repeat(64)},
    costs:{status:'provisional',scope:'open_and_close_retain_gas_only',pathVersion:'paper_static_manual_no_swap_v1',
     sizeBand:'test',gasPriceWei:'1000000000',boundGasPriceWei:'1250000000',
     gasPriceObservedAt:new Date().toISOString(),nativeReferencePrice:'2000000000000000000000',
     stages:Array.from({length:6},(_,index)=>({stage:'stage-'+index,
      profileId:'00000000-0000-4000-8000-00000000000'+(index+1),version:1,
      evidenceClass:'fork_estimated',expectedGasUnits:'100',boundGasUnits:'120',source:{block:'99'}})),
     open:{expectedGasUnits:'100',boundGasUnits:'120',expectedWei:'1000',boundWei:'1500',
      expectedValue:'1000000000000000000',boundValue:'1500000000000000000'},
     closeRetain:{expectedGasUnits:'100',boundGasUnits:'120',expectedWei:'1000',boundWei:'1500',
      expectedValue:'1000000000000000000',boundValue:'1500000000000000000'},missing:[]}}};
  assert.equal((await post(setupDraftPath,setupDraftInput,{origin,cookie})).status,403);
  const admitted=await post(setupDraftPath,setupDraftInput,{origin,cookie,'x-csrf-token':csrfToken});
  assert.equal(admitted.status,201);assert.equal((await admitted.json()).replayed,false);
  const replayed=await post(setupDraftPath,setupDraftInput,{origin,cookie,'x-csrf-token':csrfToken});
  assert.equal(replayed.status,200);assert.equal((await replayed.json()).replayed,true);
  const conflict=await post(setupDraftPath,setupDraftInput,{origin,cookie,'x-csrf-token':csrfToken});
  assert.equal(conflict.status,409);assert.equal((await conflict.json()).error,'draft_request_id_conflict');
  const changedQuote=await post(setupDraftPath,setupDraftInput,{origin,cookie,'x-csrf-token':csrfToken});
  assert.equal(changedQuote.status,409);assert.equal((await changedQuote.json()).error,'setup_gas_price_exceeds_reviewed_bound');
  assert.equal(setupDraftCalls.length,4);
  const draft={mode:'paper',chainId:4663,wallet:'0x1111111111111111111111111111111111111111',
   marketProfileId:'aef5f51e-18ef-4e9c-952d-8d772970f708',strategyId:'static_manual_v1',
   strategyVersion:'1.0.0',stateSchemaVersion:1,
   allocation:{token0Raw:'0',token1Raw:'250000000',nativeWei:'0'},
   config:{tickLower:-20,tickUpper:20}};
  assert.equal((await post('/api/deployments/drafts',draft,{origin,cookie})).status,403);
  assert.equal((await post('/api/deployments/drafts',{...draft,strategyId:'adaptive_v1'},
   {origin,cookie,'x-csrf-token':csrfToken})).status,400);
  assert.equal((await post('/api/deployments/drafts',{...draft,config:{...draft.config,signer:'secret'}},
   {origin,cookie,'x-csrf-token':csrfToken})).status,400);
  const created=await post('/api/deployments/drafts',draft,{origin,cookie,'x-csrf-token':csrfToken});
  assert.equal(created.status,409);assert.deepEqual(await created.json(),{error:'static_paper_setup_admission_required'});
  assert.equal(calls.length,0);
  const previewPath='/api/deployments/67b2b303-e821-4450-bb7b-27171b12079f/previews';
  assert.equal((await post(previewPath,{kind:'close'},{origin,cookie,'x-csrf-token':csrfToken})).status,400);
  const preview=await post(previewPath,{kind:'open'},{origin,cookie,'x-csrf-token':csrfToken});
  assert.equal(preview.status,200);
  assert.deepEqual(await preview.json(),{status:'indicative',actionAvailable:false,
   operationAcceptanceAvailable:false,economics:null,
   previewId:'aef5f51e-18ef-4e9c-952d-8d772970f708',contentDigest:'a'.repeat(64),
   expectedRevision:1,expiresAt:'2026-09-23T10:00:00.000Z',trustedPreviewSaved:true});
  const closePreview=await post(previewPath,{kind:'close_retain'},
   {origin,cookie,'x-csrf-token':csrfToken});
  assert.equal(closePreview.status,200);
  assert.deepEqual(await closePreview.json(),{status:'indicative',actionAvailable:false,
   operationAcceptanceAvailable:false,economics:null});
  const convertPreview=await post(previewPath,{kind:'close_convert'},
   {origin,cookie,'x-csrf-token':csrfToken});
  assert.equal(convertPreview.status,200);
  assert.deepEqual(await convertPreview.json(),{status:'indicative',actionAvailable:false,
   operationAcceptanceAvailable:false,economics:null});
  const pausePreview=await post(previewPath,{kind:'pause'},
   {origin,cookie,'x-csrf-token':csrfToken});
  assert.equal(pausePreview.status,200);
  assert.deepEqual(await pausePreview.json(),{status:'indicative',actionAvailable:false,
   operationAcceptanceAvailable:false,economics:null});
  const resumePreview=await post(previewPath,{kind:'resume'},
   {origin,cookie,'x-csrf-token':csrfToken});
  assert.equal(resumePreview.status,200);
  assert.deepEqual(await resumePreview.json(),{status:'indicative',actionAvailable:false,
   operationAcceptanceAvailable:false,economics:null});
  assert.deepEqual(previewCalls,[
   {id:'67b2b303-e821-4450-bb7b-27171b12079f',kind:'open'},
   {id:'67b2b303-e821-4450-bb7b-27171b12079f',kind:'close_retain'},
   {id:'67b2b303-e821-4450-bb7b-27171b12079f',kind:'close_convert'},
   {id:'67b2b303-e821-4450-bb7b-27171b12079f',kind:'pause'},
   {id:'67b2b303-e821-4450-bb7b-27171b12079f',kind:'resume'},
  ]);
  const accept=await post('/api/deployments/67b2b303-e821-4450-bb7b-27171b12079f/operations',{},
   {origin,cookie,'x-csrf-token':csrfToken});
  assert.equal(accept.status,400);
  assert.deepEqual(await accept.json(),{error:'invalid_request'});
  assert.equal(acceptCalls,0);
  const catalog=await fetch(url+'/api/strategies',{headers:{cookie}});
  assert.equal(catalog.status,200);
  const body=await catalog.json() as {strategies:{id:string;paper:boolean;live:boolean}[]};
  assert.deepEqual(body.strategies.map(s=>s.id),['static_manual_v1','rangekeeper_v1']);
  assert.deepEqual(body.strategies.map(s=>[s.paper,s.live]),[[false,false],[false,false]],
   'paper support is false when the complete static/manual callback set is not installed');
  const profiles=await fetch(url+'/api/market-profiles',{headers:{cookie}});
  assert.equal(profiles.status,200);
  const profileRows=(await profiles.json() as {profiles:{id:string;deploymentAvailable:boolean}[]}).profiles;
  assert.equal(profileRows[0]?.id,'aef5f51e-18ef-4e9c-952d-8d772970f708');
  assert.equal(profileRows[0]?.deploymentAvailable,false);
  const logout=await fetch(url+'/api/session',{method:'DELETE',headers:{origin,cookie,'x-csrf-token':csrfToken}});
  assert.equal(logout.status,200);
  assert.equal((await fetch(url+'/api/strategies',{headers:{cookie}})).status,401);
 }finally{server.close();await once(server,'close');}
});

it('reports static/manual paper support only when its required command callbacks are installed',async()=>{
 const origin='http://127.0.0.1:4175';
 const store={async createDraft(){return {};},async acceptOperation(){return {};},
  async operation(){return null;},async listMarketProfiles(){return [];}};
 const server=createDeploymentCommandServer(store,{origin,
  paperPreview:async()=>({}),paperSetupPreflight:async()=>({}),paperSetupDraftAdmission:async()=>({}),
  paperSetupDraftList:async()=>[],paperOpenAcceptance:async()=>({}),paperRetainAcceptance:async()=>({}),
  paperLifecycleAcceptance:async()=>({}),paperOperationReplay:async()=>null,paperRetainWorkerReady:async()=>false});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}`;
 try{
  const login=await fetch(url+'/api/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')?.split(';')[0];assert(cookie);
  const catalog=await fetch(url+'/api/strategies',{headers:{cookie}});
  assert.equal(catalog.status,200);
  const body=await catalog.json() as {strategies:{id:string;paper:boolean;live:boolean}[]};
  assert.deepEqual(body.strategies.map(s=>s.id),['static_manual_v1','rangekeeper_v1']);
  assert.deepEqual(body.strategies.map(s=>[s.paper,s.live]),[[true,false],[false,false]],
   'catalog reports installed paper support while readiness remains transient');
 }finally{server.close();await once(server,'close');}
});

it('exposes only ready, persisted retain-close acceptance on the guarded command origin',async()=>{
 const origin='http://127.0.0.1:4174',calls:unknown[]=[],lifecycleCalls:unknown[]=[],openCalls:unknown[]=[];
 let workerReady=true,probeFails=false;
 const store={async createDraft(){return {};},async acceptOperation(){throw Error('generic acceptance must stay unused');},
  async operation(){return null;},async listMarketProfiles(){return [];}};
 const server=createDeploymentCommandServer(store,{origin,paperRetainWorkerReady:async()=>{
   if(probeFails)throw Error('probe unavailable');return workerReady;},
  paperOperationReplay:async(_campaignId,input,allowedKinds)=>{
   if(input.idempotencyKey==='retain-close-request-1'&&allowedKinds.includes('close_retain')&&!workerReady)
    return {id:'67b2b303-e821-4450-bb7b-27171b12079f',status:'queued',replayed:true};
   if(input.idempotencyKey==='paper-pause-http-1'&&allowedKinds.includes('pause')&&!workerReady)
    return {id:'67b2b303-e821-4450-bb7b-27171b12079f',status:'queued',replayed:true};
   if(input.idempotencyKey==='paper-open-http-1'&&allowedKinds.includes('open')&&!workerReady)
    return {id:'67b2b303-e821-4450-bb7b-27171b12079f',status:'queued',replayed:true};
   if(input.idempotencyKey==='paper-convert-http-1'&&allowedKinds.includes('close_convert')&&!workerReady)
    return {id:'67b2b303-e821-4450-bb7b-27171b12079f',status:'queued',replayed:true};
   return null;
  },
  paperOpenAcceptance:async(campaignId,input,actor)=>{openCalls.push({campaignId,input,actor});
   return {id:'67b2b303-e821-4450-bb7b-27171b12079f',status:'queued',replayed:false};},
  paperRetainAcceptance:async(campaignId,input,actor)=>{calls.push({campaignId,input,actor});
   return {id:'67b2b303-e821-4450-bb7b-27171b12079f',status:'queued',replayed:false};},
  paperLifecycleAcceptance:async(campaignId,input,actor)=>{lifecycleCalls.push({campaignId,input,actor});
   return {id:'67b2b303-e821-4450-bb7b-27171b12079f',status:'queued',replayed:false};},
  paperPreview:async(_campaignId,kind)=>kind==='pause'||kind==='resume'?
   {kind,status:'indicative',id:'aef5f51e-18ef-4e9c-952d-8d772970f708',contentDigest:'b'.repeat(64),
    expectedRevision:1,proposal:{from:kind==='pause'?'active':'paused',to:kind==='pause'?'paused':'active'},
    expiresAt:new Date(Date.now()+60_000).toISOString()}:
   {kind:'close_retain',status:'indicative',trustedPreviewSaved:true}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}`;
 const post=(path:string,body:unknown,headers:Record<string,string>={})=>fetch(url+path,{
  method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  const login=await post('/api/session',{},{origin});
  const cookie=login.headers.get('set-cookie')?.split(';')[0];assert(cookie);
  const {csrfToken}=await login.json() as {csrfToken:string};
  const headers={origin,cookie,'x-csrf-token':csrfToken};
  const campaign='67b2b303-e821-4450-bb7b-27171b12079f';
  const preview=await post(`/api/deployments/${campaign}/previews`,{kind:'close_retain'},headers);
  assert.equal(preview.status,200);
  assert.deepEqual(await preview.json(),{kind:'close_retain',status:'indicative',
   trustedPreviewSaved:true,actionAvailable:true,operationAcceptanceAvailable:true});
  const command={previewId:'aef5f51e-18ef-4e9c-952d-8d772970f708',contentDigest:'a'.repeat(64),
   expectedRevision:1,idempotencyKey:'retain-close-request-1'};
  const accepted=await post(`/api/deployments/${campaign}/operations`,command,headers);
  assert.equal(accepted.status,202);
  assert.deepEqual(await accepted.json(),{id:campaign,status:'queued',replayed:false});
  assert.deepEqual(calls,[{campaignId:campaign,input:command,actor:'operator'}]);
  const lifecyclePreview=await post(`/api/deployments/${campaign}/previews`,{kind:'pause'},headers);
  assert.equal(lifecyclePreview.status,200);
  assert.equal((await lifecyclePreview.json() as {actionAvailable:boolean}).actionAvailable,true);
  const lifecycleCommand={previewId:'aef5f51e-18ef-4e9c-952d-8d772970f708',contentDigest:'b'.repeat(64),
   expectedRevision:1,idempotencyKey:'paper-pause-http-1'};
  const lifecycleAccepted=await post(`/api/deployments/${campaign}/lifecycle-operations`,lifecycleCommand,headers);
  assert.equal(lifecycleAccepted.status,202);
  assert.deepEqual(lifecycleCalls,[{campaignId:campaign,input:lifecycleCommand,actor:'operator'}]);
  const openCommand={...command,idempotencyKey:'paper-open-http-1'};
  assert.equal((await post(`/api/deployments/${campaign}/open-operations`,openCommand,headers)).status,202);
  assert.equal(openCalls.length,1);
  const convertCommand={...command,idempotencyKey:'paper-convert-http-1'};
  const unconfiguredConvert=await post(`/api/deployments/${campaign}/close-convert-operations`,
   convertCommand,headers);
  assert.equal(unconfiguredConvert.status,503);
  assert.deepEqual(await unconfiguredConvert.json(),{error:'paper_close_convert_acceptance_unavailable'});
  const wrongKind=await post(`/api/deployments/${campaign}/previews`,{kind:'open'},headers);
  assert.equal((await wrongKind.json() as {actionAvailable:boolean}).actionAvailable,false);
  workerReady=false;
  const unavailablePreview=await post(`/api/deployments/${campaign}/previews`,{kind:'close_retain'},headers);
  assert.equal((await unavailablePreview.json() as {actionAvailable:boolean}).actionAvailable,false);
  const unavailableAccept=await post(`/api/deployments/${campaign}/operations`,command,headers);
  assert.equal(unavailableAccept.status,202);
  assert.equal((await unavailableAccept.json() as {replayed:boolean}).replayed,true);
  const unavailableLifecycle=await post(`/api/deployments/${campaign}/lifecycle-operations`,
   lifecycleCommand,headers);
  assert.equal(unavailableLifecycle.status,202);
  assert.equal((await unavailableLifecycle.json() as {replayed:boolean}).replayed,true);
  const unavailableOpen=await post(`/api/deployments/${campaign}/open-operations`,openCommand,headers);
  assert.equal(unavailableOpen.status,202);
  assert.equal((await unavailableOpen.json() as {replayed:boolean}).replayed,true);
  const unavailableConvert=await post(`/api/deployments/${campaign}/close-convert-operations`,
   convertCommand,headers);
  assert.equal(unavailableConvert.status,202);
  assert.equal((await unavailableConvert.json() as {replayed:boolean}).replayed,true);
  const newCommand={...command,idempotencyKey:'new-request-while-worker-down'};
  assert.equal((await post(`/api/deployments/${campaign}/operations`,newCommand,headers)).status,503);
  assert.equal(calls.length,1);
  assert.equal(lifecycleCalls.length,1);
  assert.equal(openCalls.length,1);
  probeFails=true;
  const failedProbeAccept=await post(`/api/deployments/${campaign}/operations`,command,headers);
  assert.equal(failedProbeAccept.status,202);
  assert.equal(calls.length,1);
 }finally{server.close();await once(server,'close');}
});

it('requires a live preparation lease for V3 convert review and fresh acceptance, preserving same-key replay',async()=>{
 const origin='http://127.0.0.1:4174',campaign='67b2b303-e821-4450-bb7b-27171b12079f';
 const previewId='aef5f51e-18ef-4e9c-952d-8d772970f708',sourceHash='0x'+'a'.repeat(64);
 let workerReady=true,preparationReady=false,acceptedKey:string|null=null,acceptCalls=0;
 const acceptance={previewId,contentDigest:'b'.repeat(64),expectedRevision:1,
  idempotencyKey:'convert-request-1'};
 const server=createDeploymentCommandServer({async createDraft(){return {};},
  async acceptOperation(){throw Error('generic acceptance must not be used');},
  async operation(){return null;},async listMarketProfiles(){return [];},
 },{origin,
  paperRetainWorkerReady:async()=>workerReady,
  paperConvertPreparationReady:async()=>preparationReady,
  paperConvertAcceptance:async(_id,input)=>{acceptCalls++;acceptedKey=input.idempotencyKey;
   return {id:'9a7d3072-c8bf-4eae-bbb5-00dd367f93ba',status:'queued',replayed:false};},
  paperOperationReplay:async(_id,input,kinds)=>acceptedKey===input.idempotencyKey&&
   kinds.includes('close_convert')?{id:'9a7d3072-c8bf-4eae-bbb5-00dd367f93ba',
    status:'queued',replayed:true}:null,
  paperPreview:async()=>({kind:'close_convert',status:'indicative',trustedPreviewSaved:true,
   id:previewId,contentDigest:acceptance.contentDigest,expectedRevision:1,
   expiresAt:new Date(Date.now()+120_000).toISOString(),terminalModelVersion:3,
   modelHash:'c'.repeat(64),source:{block:'100',hash:sourceHash,
    timestamp:Math.floor(Date.now()/1000)},costs:{pathVersion:
     'paper_static_manual_close_convert_prestate_v1',paidGasAvailable:false}}),
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}`;
 const post=(path:string,body:unknown,headers:Record<string,string>={})=>fetch(url+path,{
  method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  const login=await post('/api/session',{},{origin});
  const cookie=login.headers.get('set-cookie')?.split(';')[0];assert(cookie);
  const {csrfToken}=await login.json() as {csrfToken:string};
  const headers={origin,cookie,'x-csrf-token':csrfToken};
  const preview=await post(`/api/deployments/${campaign}/previews`,{kind:'close_convert'},headers);
  assert.equal(preview.status,200);
  assert.equal((await preview.json() as {actionAvailable:boolean}).actionAvailable,false);
  const locked=await post(`/api/deployments/${campaign}/close-convert-operations`,acceptance,headers);
  assert.equal(locked.status,503);
  assert.deepEqual(await locked.json(),{error:'paper_close_convert_preparation_unavailable'});
  assert.equal(acceptCalls,0);

  preparationReady=true;
  const readyPreview=await post(`/api/deployments/${campaign}/previews`,{kind:'close_convert'},headers);
  assert.equal((await readyPreview.json() as {actionAvailable:boolean}).actionAvailable,true);
  // Treat the first successful response as lost. The same idempotency key
  // must recover the queued operation even after process readiness is gone.
  const accepted=await post(`/api/deployments/${campaign}/close-convert-operations`,acceptance,headers);
  assert.equal(accepted.status,202);assert.equal((await accepted.json() as {replayed:boolean}).replayed,false);
  workerReady=false;preparationReady=false;
  const retry=await post(`/api/deployments/${campaign}/close-convert-operations`,acceptance,headers);
  assert.equal(retry.status,202);assert.equal((await retry.json() as {replayed:boolean}).replayed,true);
  const fresh={...acceptance,idempotencyKey:'fresh-convert-request'};
  const unavailable=await post(`/api/deployments/${campaign}/close-convert-operations`,fresh,headers);
  assert.equal(unavailable.status,503);
  assert.deepEqual(await unavailable.json(),{error:'paper_close_convert_preparation_unavailable'});
  assert.equal(acceptCalls,1);
 }finally{server.close();await once(server,'close');}
});

it('explicit HTTPS operator origin preserves automatic sessions, CSRF and secure cookies',async()=>{
 const origin='http://127.0.0.1:4174',publicOrigin='https://operator.example.test';
 const store={async createDraft(){throw Error('no draft expected');},
  async acceptOperation(){throw Error('no operation expected');},async operation(){return null;},
  async listMarketProfiles(){return [];}};
 for(const invalid of ['', 'http://operator.example.test', publicOrigin+'/',publicOrigin+'/path',
  'https://user:pass@operator.example.test',publicOrigin+'?query',publicOrigin+'#fragment']){
  assert.throws(()=>createDeploymentCommandServer(store,{origin,publicOrigin:invalid}));
 }
 for(const enabled of [false,true]){
  let clock=0;
  const server=createDeploymentCommandServer(store,{origin,now:()=>clock,...(enabled?{publicOrigin}:{})});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}`;
  const login=(headers:Record<string,string>)=>fetch(url+'/api/session',{method:'POST',
   headers:{'content-type':'application/json',...headers},body:JSON.stringify({})});
  try{
   assert.equal((await fetch(url+'/api/market-profiles')).status,401);
   assert.equal((await login({'x-forwarded-host':'operator.example.test','x-forwarded-proto':'https'})).status,403);
   for(const bad of ['null','https://evil.example.test',publicOrigin+'.evil.test','http://operator.example.test']){
    assert.equal((await login({origin:bad})).status,403);
   }
   const external=await login({origin:publicOrigin});
   assert.equal(external.status,enabled?200:403);
   if(enabled){
    const setCookie=external.headers.get('set-cookie')??'';
    assert.match(setCookie,/; Secure/);assert.match(setCookie,/HttpOnly; SameSite=Strict/);
    const cookie=setCookie.split(';')[0]!;
    const {csrfToken}=await external.json() as {csrfToken:string};
    const reused=await login({origin:publicOrigin,cookie});
    assert.equal(reused.status,200);
    assert.equal((await reused.json() as {csrfToken:string}).csrfToken,csrfToken,
     'another tab must preserve the current session and CSRF token');
    assert.equal(reused.headers.get('set-cookie'),null);
    assert.equal((await fetch(url+'/api/market-profiles',{headers:{cookie}})).status,200);
    const logout=(headers:Record<string,string>)=>fetch(url+'/api/session',{method:'DELETE',headers:{cookie,...headers}});
    assert.equal((await logout({origin:publicOrigin})).status,403);
    assert.equal((await logout({origin:'https://evil.example.test','x-csrf-token':csrfToken})).status,403);
    const out=await logout({origin:publicOrigin,'x-csrf-token':csrfToken});
    assert.equal(out.status,200);assert.match(out.headers.get('set-cookie')??'',/; Secure/);
    assert.equal((await fetch(url+'/api/market-profiles',{headers:{cookie}})).status,401);
   }
   const local=await login({origin});assert.equal(local.status,200);
   assert.doesNotMatch(local.headers.get('set-cookie')??'',/; Secure/);
   const priorCookie=local.headers.get('set-cookie')!.split(';')[0]!;
   const priorCsrf=(await local.json() as {csrfToken:string}).csrfToken;
   clock=4*60*60*1000+1;
   assert.equal((await fetch(url+'/api/market-profiles',{headers:{cookie:priorCookie}})).status,401);
   const renewed=await login({origin,cookie:priorCookie});assert.equal(renewed.status,200);
   assert.notEqual((await renewed.json() as {csrfToken:string}).csrfToken,priorCsrf);
   assert.notEqual(renewed.headers.get('set-cookie')!.split(';')[0],priorCookie);
  }finally{server.close();await once(server,'close');}
 }
});
