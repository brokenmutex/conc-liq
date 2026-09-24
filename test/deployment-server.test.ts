import assert from 'node:assert/strict';
import {randomBytes,scryptSync} from 'node:crypto';
import {once} from 'node:events';
import {it} from 'node:test';
import {createDeploymentCommandServer} from '../src/deployments/server.js';

it('command API requires operator session, exact origin and CSRF before a draft is stored',async()=>{
 const salt=randomBytes(16),password='test-only-operator-secret';
 const hash=`scrypt:${salt.toString('hex')}:${scryptSync(password,salt,32).toString('hex')}`;
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
 const server=createDeploymentCommandServer(store, {origin,passwordHash:hash,
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
  assert.equal((await post('/api/session',{password})).status,403);
  assert.equal((await post('/api/session',{password:'wrong'},{origin})).status,401);
  const login=await post('/api/session',{password},{origin});assert.equal(login.status,200);
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
  const setupDraftInput={requestId:'aef5f51e-18ef-4e9c-952d-8d772970f709',profileId:setupInput.profileId,
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
  assert.equal(setupDraftCalls.length,3);
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
  assert(body.strategies.every(s=>s.paper===false&&s.live===false));
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

it('exposes only ready, persisted retain-close acceptance on the guarded command origin',async()=>{
 const salt=randomBytes(16),password='test-only-operator-secret';
 const hash=`scrypt:${salt.toString('hex')}:${scryptSync(password,salt,32).toString('hex')}`;
 const origin='http://127.0.0.1:4174',calls:unknown[]=[],lifecycleCalls:unknown[]=[],openCalls:unknown[]=[];
 let workerReady=true,probeFails=false;
 const store={async createDraft(){return {};},async acceptOperation(){throw Error('generic acceptance must stay unused');},
  async operation(){return null;},async listMarketProfiles(){return [];}};
 const server=createDeploymentCommandServer(store,{origin,passwordHash:hash,paperRetainWorkerReady:async()=>{
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
  const login=await post('/api/session',{password},{origin});
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
