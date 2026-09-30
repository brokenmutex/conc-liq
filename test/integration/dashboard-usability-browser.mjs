// Run with TEST_DATABASE_URL='postgresql://root@localhost/conc_liq?host=/var/run/postgresql' node --import tsx test/integration/dashboard-usability-browser.mjs
// In a git worktree, link the ignored directories first or the run and the
// repository checks cannot find their inputs:
//   ln -s <primary>/node_modules ./node_modules && ln -s <primary>/.tools ./.tools
//   ln -s <primary>/data ./data && ln -s <primary>/archive ./archive
// Track 1b usability harness: U1 first-run empty state, U2 instrumented task
// cost, U3 keyboard and accessible-name semantics, U4 destructive-action
// distinguishability. The only simulated boundary is canonical chain
// observation; PostgreSQL, command HTTP routes, session/CSRF, dashboard assets,
// browser and saved state are real. No worker runs and no signer is loaded.
// Position payloads come from the real readDeploymentRows/deploymentPosition
// projection over rows seeded into an isolated schema, so the rendered contract
// is the production one.
//
// Finding checks are inverted when repaired: empty states are distinct,
// missing totals remain unavailable, and independent freshness failures agree.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {access,mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer as createTcpServer} from 'node:net';
import pg from 'pg';
import {contentHash} from '../../src/deployments/contracts.ts';
import {createDeploymentCommandServer} from '../../src/deployments/server.ts';
import {createDashboardServer} from '../../src/dashboard/server.ts';
import {DeploymentStore} from '../../src/deployments/store.ts';
import {createStaticPaperDraftFromSetup} from '../../src/deployments/static-paper-draft-admission.ts';
import {StaticPaperSetupReviewCache} from '../../src/deployments/static-paper-setup-review-cache.ts';
import {buildStaticPaperSetupPreflight} from '../../src/deployments/paper-setup-preflight.ts';
import {buildIndicativePaperOpenPreview} from '../../src/deployments/paper-preview.ts';
import {costIndicativePaperOpenPreview,PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES} from '../../src/deployments/paper-cost.ts';
import {persistTrustedPaperOpenPreview} from '../../src/deployments/paper-open-preflight.ts';
import {marketProfileSchema,referenceProofHash} from '../../src/deployments/market-profile.ts';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../../src/constants.ts';
import {PAPER_QUOTER,PAPER_ROUTER} from '../../src/paper/execution-abi.ts';
import {sqrtRatioAtTick} from '../../src/backtest/principal.ts';
import {readDeploymentRows,deploymentPosition,readDeploymentDetail} from '../../src/dashboard/deployment-position.ts';
import {buildDashboardAccountingFixture} from './helpers/dashboard-accounting-fixture.mjs';

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL is required');
const adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6}),admin=await adminPool.connect();
const publicCampaignCountBefore=(await admin.query(
 'SELECT count(*)::int AS n FROM public.deployment_campaigns')).rows[0].n;
const schema=`track1b_${randomUUID().replaceAll('-','')}`,temp=await mkdtemp(`${tmpdir()}/conc-liq-usability-`);
let store,server,rootServer,chrome,ws;const errors=[],resourceFailures=[],checks=[],detailErrors=[];
const findings={U1:{},U2:{},U3:{},U4:{},D3:{},D5:{}};
const blockSource={block:'100',hash:`0x${'a'.repeat(64)}`,timestamp:Math.floor(Date.now()/1000)};
const sourceHash=`0x${'a'.repeat(64)}`,codeHash=`0x${'c'.repeat(64)}`;

// Two registered pools so repeated action controls can be told apart by asset.
const poolFor=(index,reference)=>marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,
 pool:`0x800000000000000000000000000000000000000${index}`,token0:USDG,
 token1:`0xf00000000000000000000000000000000000000${index}`,quoteToken:0,decimals0:6,decimals1:6,
 fee:3000,tickSpacing:60,positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
 poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,managerCodeHash:codeHash,
 quoterCodeHash:codeHash,reference0:'USDG/USD',reference1:reference,nativeReference:'ETH/USD',numeraire:'USD'},
 referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
 nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}});
const profiles=[{profile:poolFor(1,'AAPL/USD'),id:''},{profile:poolFor(2,'NVDA/USD'),id:''}];
const referenceProof={fixture:'loopback-usability-source-boundary',
 registry:{fetchedAt:new Date().toISOString(),sha256:`sha256:${'1'.repeat(64)}`,
  url:'https://example.invalid/usability-fixture/registry'},
 feedDirectory:{fetchedAt:new Date().toISOString(),sha256:`sha256:${'2'.repeat(64)}`,
  url:'https://example.invalid/usability-fixture/feed-directory'}};
const frame=()=>({source:blockSource,tick:0,sqrtPriceX96:sqrtRatioAtTick(0),poolLiquidity:10n**24n,
 price0:10n**18n,price1:10n**18n,nativePrice:2000n*10n**18n,referenceEligible:true,
 referenceReasons:[],referenceProofHash:referenceProofHash(referenceProof),referenceProof});
const setupReviewCache=new StaticPaperSetupReviewCache();
let latestSetupPreflight=null;
const readSetup=async(input,pinnedSource)=>{
 const result=await buildStaticPaperSetupPreflight(input,{
 loadProfile:id=>store.paperSetupProfile(id),readFrame:async(_profile,source)=>{
  if(source&&(source.block!==blockSource.block||source.hash!==blockSource.hash||source.timestamp!==blockSource.timestamp))
   throw Error('mock_source_not_canonical');
  return frame();},
 verifyCanonical:async(_chainId,source)=>{
  if(source.block!==blockSource.block||source.hash!==blockSource.hash||source.timestamp!==blockSource.timestamp)
   throw Error('mock_source_not_canonical');},
  readGasProfiles:address=>store.paperGasProfiles(address),readGasPrice:async()=>1_000_000_000n,
 },pinnedSource);
 latestSetupPreflight=result;
 if(pinnedSource||result.status!=='available')return result;
 const captured=setupReviewCache.capture(result);
 assert(captured,'Server must capture the exact setup costs before browser review');
 latestSetupPreflight={...result,...captured};
 return latestSetupPreflight;
};

async function chromiumPath(){
 if(process.env.CHROMIUM_PATH)return process.env.CHROMIUM_PATH;
 const entries=await readdir('/root/.cache/ms-playwright',{withFileTypes:true});
 for(const entry of entries.filter(item=>item.isDirectory()&&/^chromium-\d+$/.test(item.name))
  .sort((a,b)=>Number(b.name.slice(9))-Number(a.name.slice(9)))){
  const candidate=`/root/.cache/ms-playwright/${entry.name}/chrome-linux64/chrome`;
  try{await access(candidate);return candidate;}catch{}
 }
 throw Error('Chromium not found; set CHROMIUM_PATH');
}

try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);
 await migrateDatabase(admin);
 const dbUrl=new URL(process.env.TEST_DATABASE_URL);dbUrl.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
 store=new DeploymentStore(dbUrl.toString());await store.assertReady();
 const targetSetHash=`0x${'d'.repeat(64)}`;
 for(const entry of profiles){
  const p=entry.profile.pool;
  await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,fee,
   created_block,target_set_hash,enabled) VALUES('usability-fixture',$1,4663,$2,$3,3000,1,$4,true)`,
  [p.pool,entry.profile.pool.reference1.split('/')[0],p.token1,targetSetHash]);
  const verified={profile:entry.profile,profileHash:contentHash(entry.profile),streamKey:'usability-fixture',
   source:blockSource,
   contractHashes:{poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
    managerCodeHash:codeHash,quoterCodeHash:codeHash},
   references:{price0:'1000000000000000000',price1:'1000000000000000000',
    nativePrice:'2000000000000000000000',proofHash:referenceProofHash(referenceProof)},
   referenceProof,verifiedAt:new Date().toISOString()};
  const registered=await store.registerVerifiedMarketProfile(verified);
  assert.equal(registered.created,true);entry.id=registered.id;
 }
}catch(error){
 await store?.close().catch(()=>{});admin.release();await adminPool.end();await rm(temp,{recursive:true,force:true});throw error;
}

try{

const gasSource={block:'99',hash:`0x${'9'.repeat(64)}`,estimatedAt:new Date().toISOString(),
 callHash:`0x${'8'.repeat(64)}`,method:'owned_fork_nitro_exact_call_v1'};
for(const entry of profiles)for(const stage of PAPER_STATIC_GAS_STAGES){
 const model={schemaVersion:1,source:gasSource,gasUnitsExpected:'100000',gasUnitsBound:'150000',
  sizeMinValue:'1',sizeMaxValue:String(500n*10n**18n),shareMinPpm:'0',shareMaxPpm:'1000000',
  tickLower:-240,tickUpper:240};
 await admin.query(`INSERT INTO deployment_calibration_profiles
  (id,version,chain_id,pool_address,path_version,stage,allowance_state,size_band,component,status,
   evidence_class,model,validation,source_hash,observed_until)
  VALUES($1,1,4663,$2,$3,$4,'zero','browser_1_to_500','gas_units','provisional',
   'fork_estimated',$5,'{}',$6,$7)`,[randomUUID(),entry.profile.pool.pool,PAPER_STATIC_GAS_PATH,stage,
  JSON.stringify(model),contentHash(gasSource),gasSource.estimatedAt]);
}

// Seeds an active static/manual paper campaign whose projection comes from the
// real dashboard reader. No operation, worker or accounting record is created.
async function seedActiveCampaign({profileEntry,rangeState,wallet,markAgeSeconds=0,
 initialCapitalRaw='250000000000000000000'}){
 const id=randomUUID(),p=profileEntry.profile.pool;
 const markSource={...blockSource,timestamp:blockSource.timestamp-markAgeSeconds};
 const allocation={token0Raw:'125000000',token1Raw:'125000000',nativeWei:'2000000000000000'};
 await admin.query(`INSERT INTO deployment_campaigns(id,mode,chain_id,wallet,market_profile_id,allocation,
  lifecycle,range_state,current_revision) VALUES($1,'paper',4663,$2,$3,$4,'active',$5,1)`,
 [id,wallet,profileEntry.id,JSON.stringify(allocation),rangeState]);
 const config={limits:{maxDeploymentValue:'250000000000000000000',minDeploymentValue:'1000000000000000000',
  maxExposurePpm:950000,maxLossValue:'12500000000000000000',maxDrawdownPpm:100000,
  maxActionCost:'10000000000000000000',maxRollingCost:'25000000000000000000',
  maxCampaignCost:'37500000000000000000',exitReserveWei:'1000000000000000',maxSlippageBps:50},
  range:{tickLower:-240,tickUpper:240}};
 await admin.query(`INSERT INTO deployment_revisions(campaign_id,revision,strategy_id,strategy_version,
  state_schema_version,config,config_hash) VALUES($1,1,'static_manual_v1','1.0.0',1,$2,$3)`,
 [id,JSON.stringify(config),contentHash(config)]);
 await admin.query(`INSERT INTO deployment_ledger(campaign_id,entry_key,kind,value_raw,source)
  VALUES($1,'capital_in:1','capital_in',$2,$3)`,
 [id,initialCapitalRaw,JSON.stringify({source:blockSource})]);
 const inventory={token0Raw:'120000000',token1Raw:'130000000',
  position:{liquidity:'1000000000000',tickLower:-240,tickUpper:240}};
 const provenance={classification:'paper_model_provisional',source:markSource,
  poolState:{tick:rangeState==='inside'?0:600,
  sqrtPriceX96:String(sqrtRatioAtTick(rangeState==='inside'?0:600))},
  modeledCosts:{closeRetain:{boundValue:'1200000000000000000'}}};
 await admin.query(`INSERT INTO deployment_marks(campaign_id,revision,at,source_block,source_hash,
  inventory,economics,provenance) VALUES($1,1,$2,$3,$4,$5,$6,$7)`,
 [id,new Date(markSource.timestamp*1000).toISOString(),blockSource.block,blockSource.hash,
  JSON.stringify(inventory),JSON.stringify({netNav:null}),JSON.stringify(provenance)]);
 return id;
}

const portProbe=createTcpServer();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');
const address=portProbe.address();assert(address&&typeof address!=='string');const port=address.port;
await new Promise((resolve,reject)=>portProbe.close(error=>error?reject(error):resolve()));
const origin=`http://127.0.0.1:${port}`;
const verifySource=async(_chainId,sources)=>{
 for(const source of sources)if(source.block!==blockSource.block||source.hash!==sourceHash||
  source.timestamp!==blockSource.timestamp)throw Error('mock_source_not_canonical');
};
let lastOpenPreview=null;
const paperPreview=async(campaignId,kind)=>{
 if(kind!=='open')return {kind,status:'unavailable',reason:'not_in_harness',actionAvailable:false};
 const draft=await store.paperDraft(campaignId),freshFrame=frame();
 const indicative=buildIndicativePaperOpenPreview(draft,freshFrame);
 const costed=costIndicativePaperOpenPreview(indicative,await store.paperGasProfiles(draft.profile.pool.pool),
  draft.profile.pool.pool,freshFrame.nativePrice,1_000_000_000n);
 if(costed.status!=='indicative'||costed.costs.status!=='provisional')return costed;
 const saved=await persistTrustedPaperOpenPreview({store,draft,frame:freshFrame,preview:costed,
  verifyAnchors:verifySource});
 lastOpenPreview={id:saved.id,contentDigest:saved.contentDigest,expectedRevision:saved.expectedRevision};
 return {...costed,...saved,kind:'open',status:'indicative',trustedPreviewSaved:true,
  actionAvailable:false,operationAcceptanceAvailable:false,economics:null};
};
// U6 moves server stale evidence, timestamp age, and timestamp validity
// independently. The row also carries persisted paper accounting so the
// freshness state can be checked without replacing modeled NAV/P&L/fees.
const staleness={ageSeconds:0,reason:false,invalidTime:false,calls:0,lastSourceAt:null,overviewServed:0};
const riskState={aaplPaused:true};
const degrade=position=>{
 staleness.calls++;
 if(!staleness.ageSeconds&&!staleness.reason&&!staleness.invalidTime)return position;
 const next={...position};
 if(Number.isFinite(staleness.ageSeconds)){
  const at=new Date(Date.now()-staleness.ageSeconds*1000).toISOString();
  next.sourceAt=at;next.heartbeatAt=at;
 }
 if(staleness.invalidTime)next.sourceAt='invalid-source-time';
 if(staleness.reason)next.reasons=[...new Set([...(position.reasons??[]),'source_stale'])];
 staleness.lastSourceAt=next.sourceAt;
 return next;
};
const dashboardRead=async(path)=>{
 if(path==='/api/dashboard')return {pools:profiles.map(entry=>({registryEnabled:true,
  poolAddress:entry.profile.pool.pool,rwaSymbol:entry.profile.pool.reference1.split('/')[0],
  fee:3000,tickSpacing:60}))};
 if(path.startsWith('/api/research')){
  const requested=new URL(path,'http://127.0.0.1').searchParams.get('capitalQuoteRaw')??'250000000';
  const generatedAt=new Date().toISOString();
  return {snapshotId:'usability-research-fixture',generatedAt,asOf:generatedAt,
   sourceFreshness:{status:'fresh',asOf:generatedAt,ageSeconds:0,maxAgeSeconds:90},
   capitalQuoteRaw:requested,streamKey:'usability-fixture',budgetQuote:requested,quoteDecimals:6,
   bucketMinutes:60,bucketCount:0,retainedHours:168,costs:{roundTripQuote:'1000000'},pools:[]};
 }
 if(path.startsWith('/api/positions')){
  const rows=await readDeploymentRows(admin);
  if(path.startsWith('/api/positions/')){
   const id=decodeURIComponent(path.split('?')[0].slice('/api/positions/'.length));
   const row=rows.find(row=>`paper-dep-${row.id}`===id);
   if(!row)return null;
   const hours=Number(new URL(path,origin).searchParams.get('hours')??24);
   try{const detail=await readDeploymentDetail(admin,row,hours);
    // loadDetail() overwrites positions[i] with this position and then renders,
    // so the selected row is drawn from here, not from the overview.
    return {...detail,position:degrade(detail.position)};}
   catch(error){detailErrors.push(String(error?.stack??error));throw error;}
  }
  staleness.overviewServed++;
  const riskAssets=[
   {rwaSymbol:'AAPL',executionEligible:!riskState.aaplPaused,snapshotAt:new Date().toISOString(),reasons:riskState.aaplPaused?['oracle_paused']:[],marketHours:'latest_equity_session',corporateActionPending:false,tradingTradable:true,oraclePaused:riskState.aaplPaused,oracleAgeSeconds:'18'},
   {rwaSymbol:'NVDA',executionEligible:true,snapshotAt:new Date(Date.now()-600000).toISOString(),reasons:[],marketHours:'latest_equity_session',corporateActionPending:false,tradingTradable:true,oraclePaused:false,oracleAgeSeconds:'22'},
   {rwaSymbol:'GLD',executionEligible:false,snapshotAt:null,reasons:['risk_snapshot_missing_asset'],marketHours:null,corporateActionPending:null,tradingTradable:null,oraclePaused:null,oracleAgeSeconds:null},
   ...['SPY','QQQ','GOOGL','MSFT'].map(rwaSymbol=>({rwaSymbol,executionEligible:false,snapshotAt:new Date().toISOString(),reasons:['sequencer_feed_unavailable'],marketHours:'latest_equity_session',corporateActionPending:false,tradingTradable:true,oraclePaused:false,oracleAgeSeconds:'12'})),
  ];
  return {positions:rows.map(deploymentPosition).map(degrade),
   riskAssets,riskFreshnessSeconds:180,serverTime:new Date().toISOString(),refreshMs:10000};
 }
 throw Error('unexpected_dashboard_path');
};
server=createDeploymentCommandServer(store,{origin,dashboardRead,
 paperSetupPreflight:input=>readSetup(input),
 paperSetupDraftAdmission:input=>createStaticPaperDraftFromSetup(input,{
  runPreflight:(request,pinned)=>readSetup(request,pinned),loadProfile:id=>store.paperSetupProfile(id),
  lookupCapturedReview:input=>setupReviewCache.lookup(input),
  findDraftRequest:(id,draft)=>store.findDraftRequest(id,draft),
  createDraftWithRequestId:(id,draft)=>store.createDraftWithRequestId(id,draft)}),
 paperSetupDraftList:()=>store.listStaticPaperDrafts(),
 paperSetupDraftDelete:id=>store.deleteStaticPaperDraft(id),
 setupDefaults:()=>({walletAddress:'0x2222222222222222222222222222222222222222'}),paperPreview,
 paperOperationReplay:(id,input,kinds)=>store.acceptedOperationReplay(id,input,kinds),
 paperOpenAcceptance:async(id,input,actor)=>store.acceptStaticPaperOpenOperation(id,input,actor,verifySource),
 paperLifecycleAcceptance:(id,input,actor)=>store.acceptStaticPaperLifecycleOperation(id,input,actor),
 paperRetainWorkerReady:()=>store.paperOperationWorkerReady()});
server.listen(port,'127.0.0.1');await once(server,'listening');
rootServer=createDashboardServer({
 snapshot:()=>dashboardRead('/api/dashboard'),
 positions:(id,hours)=>dashboardRead(id?`/api/positions/${encodeURIComponent(id)}?hours=${hours}`:'/api/positions'),
 research:capital=>dashboardRead(`/api/research?capitalQuoteRaw=${capital}`),
 researchDetails:input=>dashboardRead(`/api/research/details?capitalQuoteRaw=${input.capitalQuoteRaw}`),
},{fullAccountingEnabled:false,historySource:'legacy',canaryMaxCheckpointAgeSeconds:180,
 activityBucketBlocks:500,activityWindowBlocks:20_000,
 adaptivePaperStatePath:'/tmp/conc-liq-usability-no-adaptive-state.json',databaseUrl:'fixture',
 host:'127.0.0.1',port:0,refreshMs:10_000,researchRefreshMs:60_000,
 riskGateMaxSnapshotAgeSeconds:180,riskGateMaxCanonicalityAgeSeconds:180,streamKey:'usability-fixture'});
await once(rootServer,'listening');

let debugPort=0,stderr='';
chrome=spawn(await chromiumPath(),['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
 '--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',
 '--user-data-dir='+temp,'about:blank'],{stdio:['ignore','ignore','pipe']});
chrome.stderr.setEncoding('utf8');chrome.stderr.on('data',part=>{stderr+=part;
 const match=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);if(match)debugPort=Number(match[1]);});
for(let i=0;i<120&&!debugPort;i++){if(chrome.exitCode!==null)throw Error('Chromium exited: '+stderr);
 await new Promise(resolve=>setTimeout(resolve,100));}
assert(debugPort,'Chromium did not start remote debugging');
const targets=await fetch(`http://127.0.0.1:${debugPort}/json`).then(response=>response.json());
const target=targets.find(item=>item.type==='page');assert(target);
ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{
 ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
let sequence=0;const pending=new Map();
ws.addEventListener('message',event=>{const message=JSON.parse(event.data);
 if(message.id){const item=pending.get(message.id);if(!item)return;pending.delete(message.id);
  message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);}
 else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);
 else if(message.method==='Network.responseReceived'&&message.params.response.status>=400)
  resourceFailures.push({status:message.params.response.status,url:message.params.response.url});});
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});
 ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const result=await send('Runtime.evaluate',{
 expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
const waitFor=async expression=>{for(let i=0;i<160;i++){if(await evaluate(expression))return;
 await new Promise(resolve=>setTimeout(resolve,100));}
 throw Error('Timed out waiting for '+expression+`; errors=${JSON.stringify(errors)} responses=${JSON.stringify(resourceFailures)} detailErrors=${JSON.stringify(detailErrors.slice(0,2))}`);};
const check=async(name,expression)=>{assert(await evaluate(expression),name);checks.push(name);};

// Interaction counters. Every driver action goes through these so the recorded
// task cost is the operator's cost, not an estimate.
let cost=null;
const beginCost=()=>{cost={clicks:0,keystrokes:0,fields:new Set(),offscreen:0,startedAt:Date.now()};};
const offscreen=async selector=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
 if(!e)return false;const r=e.getBoundingClientRect();return r.top<0||r.bottom>innerHeight;})()`);
const click=async selector=>{
 if(cost){cost.clicks++;if(await offscreen(selector))cost.offscreen++;}
 return evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
};
const fill=async(selector,value)=>{
 if(cost){cost.keystrokes+=String(value).length;cost.fields.add(selector);if(await offscreen(selector))cost.offscreen++;}
 return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};
  e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
};
const endCost=async()=>{const value={clicks:cost.clicks,keystrokes:cost.keystrokes,fieldsTouched:cost.fields.size,
 offscreenInteractions:cost.offscreen,elapsedMs:Date.now()-cost.startedAt,
 pageScrollHeight:await evaluate('document.documentElement.scrollHeight'),
 viewportHeight:await evaluate('innerHeight'),
 horizontalOverflow:await evaluate('document.documentElement.scrollWidth>innerWidth')};cost=null;return value;};
const navigate=async(path)=>{await send('Page.navigate',{url:origin+path});await waitFor('document.readyState==="complete"');
 await new Promise(resolve=>setTimeout(resolve,100));};
const key=async(code,windowsVirtualKeyCode,modifiers=0)=>{
 await send('Input.dispatchKeyEvent',{type:'rawKeyDown',code,key:code,windowsVirtualKeyCode,modifiers});
 await send('Input.dispatchKeyEvent',{type:'keyUp',code,key:code,windowsVirtualKeyCode,modifiers});
 await new Promise(resolve=>setTimeout(resolve,30));
};
const describeFocus=()=>evaluate(`(()=>{const a=document.activeElement;if(!a||a===document.body)return null;
 return {tag:a.tagName.toLowerCase(),id:a.id||null,cls:a.className||null,
  text:(a.textContent||'').trim().slice(0,60),label:a.getAttribute('aria-label')||null,disabled:!!a.disabled};})()`);

await send('Page.enable');await send('Runtime.enable');await send('Log.enable');await send('Network.enable');
await send('DOM.enable');await send('Accessibility.enable');

// ── U1 · first-run empty state ───────────────────────────────────────────────
// Production is in exactly this state after today's reset: zero campaigns and
// zero drafts, with no filter applied.
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
await navigate('/operator');
await waitFor('document.querySelectorAll("[role=tab]").length===2');
await waitFor('window.concliqOperatorAuthenticated?.()===true&&document.querySelector("#setup-width").options.length>1');
await waitFor('document.querySelector("#paper .empty")!==null');
assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_campaigns')).rows[0].n,0);

findings.U1.filtersUntouched=await evaluate(
 'document.querySelector("#asset-filter").value==="all"&&document.querySelector("#status-filter").value==="all"');
findings.U1.paperEmptyText=await evaluate('document.querySelector("#paper .empty").textContent.trim()');
findings.U1.liveEmptyText=await evaluate('document.querySelector("#live .empty").textContent.trim()');
findings.U1.offersClearFilters=await evaluate('!!document.querySelector("#paper .empty [data-action=reset]")');
findings.U1.mentionsFilters=await evaluate(
 '/filter/i.test(document.querySelector("#paper .empty").textContent)');
findings.U1.emptyPointsToSetup=await evaluate(
 '/set up a position/i.test(document.querySelector("#paper .empty").textContent)');
findings.U1.sectionTotals=await evaluate(`(()=>{const t=document.querySelector("#paper .section-totals");
 return t?[...t.querySelectorAll("div")].map(d=>d.textContent.trim()).filter(Boolean):null;})()`);
findings.U1.setupHeadingOffscreen=await offscreen('#setup-title');
findings.U1.setupDistanceBelowFold=await evaluate(
 '(()=>{const r=document.querySelector("#setup-title").getBoundingClientRect();return Math.round(r.top-innerHeight);})()');

await check('U1 · first-run empty state identifies no paper positions and offers setup navigation',
 '/No paper positions yet/.test(document.querySelector("#paper .empty").textContent)&&'+
 'document.querySelector("#paper .empty a[href=\\"#setup-title\\"]")?.textContent.trim()==="Set up a position"');
await check('U1 · untouched filters do not offer Clear filters and missing totals stay unavailable',
 'document.querySelector("#asset-filter").value==="all"&&document.querySelector("#status-filter").value==="all"'+
 '&&!document.querySelector("#paper .empty [data-action=reset]")&&'+
 '/Managed value · unavailable/.test(document.querySelector("#paper .section-totals").textContent)&&'+
 '!/0\\.00/.test(document.querySelector("#paper .section-totals").textContent)');

// A real filter miss has different copy and offers a reset action.
await evaluate(`(()=>{const s=document.querySelector("#status-filter");s.value="paused";
 s.dispatchEvent(new Event("change",{bubbles:true}));})()`);
await waitFor('document.querySelector("#paper .empty")!==null');
findings.U1.filteredEmptyText=await evaluate('document.querySelector("#paper .empty").textContent.trim()');
findings.U1.emptyCopyIdenticalWhenFiltered=findings.U1.filteredEmptyText===findings.U1.paperEmptyText;
await check('U1 · filtered-empty state says no positions match and offers Clear filters',
 '/No positions match these filters/.test(document.querySelector("#paper .empty").textContent)&&'+
 '!!document.querySelector("#paper .empty [data-action=reset]")&&'+
 JSON.stringify(findings.U1.emptyCopyIdenticalWhenFiltered)+'===false');
await evaluate(`(()=>{const s=document.querySelector("#status-filter");s.value="all";
 s.dispatchEvent(new Event("change",{bubbles:true}));})()`);
await waitFor('document.querySelector("#paper .empty")!==null');

findings.U1.zeroPositionsShowCurrencyTotal=await evaluate(
 '/0\\.00/.test(document.querySelector("#paper .section-totals").textContent)');
await check('U1 · returning to all positions restores the unavailable totals label',
 '/Managed value · unavailable/.test(document.querySelector("#paper .section-totals").textContent)&&'+
 `${JSON.stringify(!findings.U1.zeroPositionsShowCurrencyTotal)}`);

const rootOrigin=`http://127.0.0.1:${rootServer.address().port}`;
await send('Page.navigate',{url:rootOrigin+'/'});
await waitFor('document.readyState==="complete"');
await waitFor('document.querySelector("#paper .empty")!==null');
await click('#paper .empty-setup-link');
await check('U1 · root empty-state setup link reaches read-only setup without operator authentication',
 'location.pathname==="/"&&location.hash==="#setup-title"&&'+
 'document.querySelector("#setup-title")!==null&&'+
 '/Setup preflight is read-only/.test(document.querySelector("#positions-panel .setup-panel").textContent)');

// ── U2 · instrumented task cost, load → review setup → saved draft ───────────
const draftIds=[];
for(const [width,mobile] of [[1440,false],[390,true]]){
 await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile});
 await navigate('/operator');
 await waitFor('window.concliqOperatorAuthenticated?.()===true&&document.querySelector("#setup-width").options.length>1');
 beginCost();
 await fill('#setup-capital','250');
 await click('#setup-review-button');
 await waitFor('document.querySelector("#setup-preflight-title").textContent==="Sizing preflight available"');
 await fill('#setup-wallet-address','0x1111111111111111111111111111111111111111');
 await waitFor('document.querySelector("#save-paper-draft").disabled===false');
 await click('#save-paper-draft');
 await waitFor('document.querySelector("#setup-draft-submit-status").textContent.includes("Saved static/manual paper draft")');
 findings.U2[`w${width}`]=await endCost();
 const id=await evaluate(`document.querySelector("#setup-draft-submit-status").textContent.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]`);
 assert(id,`draft persisted at ${width}px`);draftIds.push(id);
 checks.push(`U2 · load to saved draft measured at ${width}px`);
}
await check('U2 · saving a draft costs no more than four interactions at either width',
 JSON.stringify(findings.U2.w1440.clicks+findings.U2.w1440.fieldsTouched<=4&&
  findings.U2.w390.clicks+findings.U2.w390.fieldsTouched<=4)+'===true');
await check('U2 · neither width introduces horizontal overflow',
 JSON.stringify(!findings.U2.w1440.horizontalOverflow&&!findings.U2.w390.horizontalOverflow)+'===true');

// ── Seed two active campaigns on different assets for U3 and U4 ──────────────
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
const appleId=await seedActiveCampaign({profileEntry:profiles[0],rangeState:'inside',
 wallet:'0x1111111111111111111111111111111111111111'});
const nvidiaId=await seedActiveCampaign({profileEntry:profiles[1],rangeState:'outside',
 wallet:'0x1111111111111111111111111111111111111111'});
const historyAgeSeconds=13*86400;
const historyId=await seedActiveCampaign({profileEntry:profiles[0],rangeState:'inside',
 wallet:'0x1111111111111111111111111111111111111111',markAgeSeconds:historyAgeSeconds});
// The first source observation precedes DB campaign creation by one second,
// matching normal block-time versus persistence-time ordering.
const historyStartedAt=new Date((blockSource.timestamp-historyAgeSeconds+1)*1000).toISOString();
await admin.query('UPDATE deployment_campaigns SET created_at=$2 WHERE id=$1',[historyId,historyStartedAt]);
await navigate('/operator');
await waitFor('window.concliqOperatorAuthenticated?.()===true');
const rowSelector=id=>`#paper tbody tr[data-position="paper-dep-${id}"]`;
await waitFor(`document.querySelector(${JSON.stringify(rowSelector(appleId))})!==null`);
await waitFor(`document.querySelector(${JSON.stringify(rowSelector(nvidiaId))})!==null`);
await waitFor('document.querySelectorAll("#paper .retain-preview-button").length>=1');
// Read the verdict from its own element rather than substring-matching the
// whole row: "last recorded eligible" legitimately contains "eligible", so
// only the badge can prove a stale snapshot is not presented as current.
findings.D3=await evaluate(`(()=>{
 const row=s=>document.querySelector('#asset-risk [data-risk-asset="'+s+'"]');
 const read=s=>{const el=row(s);return el?{verdict:el.querySelector('.badge')?.textContent??null,
  detail:el.querySelector('.risk-detail')?.textContent??null,
  text:el.textContent.replace(/\\s+/g,' ').trim()}:null;};
 return {count:document.querySelectorAll('#asset-risk .risk-asset').length,
  freshBlocked:read('AAPL'),staleFormerlyEligible:read('NVDA'),missing:read('GLD'),
  note:document.querySelector('#asset-risk .inline-note')?.textContent??null};})()`);
await check('D3 · latest asset risk is visible with a fresh ineligible result and its reason',
 JSON.stringify(findings.D3.freshBlocked?.verdict==='Ineligible'&&
  findings.D3.freshBlocked.detail==='In the latest snapshot'&&
  findings.D3.freshBlocked.text.includes('oracle_paused'))+'===true');
await check('D3 · stale former eligibility is shown as unavailable, not current eligibility',
 JSON.stringify(findings.D3.staleFormerlyEligible?.verdict==='Unavailable'&&
  findings.D3.staleFormerlyEligible.verdict!=='Eligible'&&
  findings.D3.staleFormerlyEligible.detail?.includes('Snapshot stale')&&
  findings.D3.staleFormerlyEligible.detail.includes('last recorded eligible'))+'===true');
await check('D3 · an asset without a snapshot is explicitly unavailable and the whole tracked set remains visible',
 JSON.stringify(findings.D3.missing?.verdict==='Unavailable'&&
  findings.D3.missing.detail==='No recorded asset snapshot'&&findings.D3.count===7)+'===true');
await check('D3 · asset snapshot eligibility is not presented as action authorization',
 JSON.stringify(findings.D3.note?.includes('each action is checked again'))+'===true');
findings.U3.renderedRows=await evaluate(
 '[...document.querySelectorAll("#paper tbody tr")].length');
findings.U3.seededAssets=await evaluate(
 `[${JSON.stringify(rowSelector(appleId))},${JSON.stringify(rowSelector(nvidiaId))}]`+
 '.map(s=>document.querySelector(s).querySelector(".pair").textContent.replace(/\\s+/g," ").trim())');
await check('U3 · the two seeded campaigns render on different assets',
 JSON.stringify(new Set(findings.U3.seededAssets).size===2)+'===true');

// ── U3 · keyboard reachability and accessible names ──────────────────────────
// Action controls are rendered only inside the selected position's detail panel
// (dashboard/app.js lifecycleControls is called from detail/deploymentDetail),
// so two campaigns never expose their close controls at the same time. The
// ambiguity to measure is therefore across selections, not within one screen.
const readActionControls=()=>evaluate(`(()=>{
 const wanted=[...document.querySelectorAll("#paper .lifecycle-controls button")];
 return wanted.map(b=>({text:(b.textContent||"").trim(),label:b.getAttribute("aria-label"),
  title:b.getAttribute("title")||null,cls:b.className||null,
  campaign:b.closest("[data-campaign-id]")?.dataset.campaignId||null}));})()`);
const selectRow=async id=>{
 await evaluate(`document.querySelector('#paper tbody tr[data-position="paper-dep-${id}"] .position-select').click()`);
 await waitFor(`document.querySelector("#paper .position-detail")!==null`);
 await waitFor('document.querySelectorAll("#paper .lifecycle-controls button").length>0');
};
const accessibleName=b=>b.label||b.text;
await selectRow(appleId);
const appleControls=await readActionControls();
findings.U3.selectedAssetHeading=await evaluate(
 'document.querySelector("#paper .detail-heading h3").textContent.replace(/\\s+/g," ").trim()');
await selectRow(nvidiaId);
const nvidiaControls=await readActionControls();
findings.U3.appleActionNames=appleControls.map(accessibleName);
findings.U3.nvidiaActionNames=nvidiaControls.map(accessibleName);
findings.U3.namesIdenticalAcrossCampaigns=
 JSON.stringify(findings.U3.appleActionNames)===JSON.stringify(findings.U3.nvidiaActionNames);
findings.U3.simultaneousControlSets=await evaluate(
 'document.querySelectorAll("#paper .lifecycle-controls").length');
findings.U3.anyActionNameCarriesAsset=[...appleControls,...nvidiaControls]
 .some(b=>/AAPL|NVDA/.test(accessibleName(b)||''));
findings.U3.anyActionNameCarriesCampaign=[...appleControls,...nvidiaControls]
 .some(b=>/[0-9a-f]{8}-[0-9a-f]{4}/i.test(accessibleName(b)||''));
await check('U3 · only the selected campaign exposes close controls',
 'document.querySelectorAll("#paper .lifecycle-controls").length===1');
await check('U3 · close-control names identify their selected campaign and differ across assets',
 JSON.stringify(!findings.U3.namesIdenticalAcrossCampaigns)+'===true');
await check('U3 · close-control accessible names identify the asset',
 JSON.stringify(findings.U3.anyActionNameCarriesAsset)+'===true');
await check('U3 · close-control accessible names identify the campaign',
 JSON.stringify(findings.U3.anyActionNameCarriesCampaign)+'===true');

// Full AX tree cross-check: what a flat button list exposes to assistive tech.
const axTree=await send('Accessibility.getFullAXTree');
findings.U3.axCloseControlNames=axTree.nodes
 .filter(n=>n.role?.value==='button'&&n.name?.value&&
  /review close|confirm close/i.test(n.name.value))
 .map(n=>n.name.value.trim());
findings.U3.axCloseNamesHaveContext=findings.U3.axCloseControlNames
 .every(name=>/AAPL|NVDA/i.test(name)&&/[0-9a-f]{8}-[0-9a-f]{4}/i.test(name));
await check('U3 · the accessibility tree exposes close controls with asset and campaign context',
 JSON.stringify(findings.U3.axCloseControlNames.length>0&&findings.U3.axCloseNamesHaveContext)+'===true');
const selectedBeforeRiskPoll=await evaluate('document.querySelector("#paper tbody tr.selected")?.dataset.position??null');
riskState.aaplPaused=false;
await waitFor('document.querySelector("#asset-risk [data-risk-asset=AAPL] .badge")?.textContent==="Eligible"');
findings.D3.refreshWithSelection={before:selectedBeforeRiskPoll,
 after:await evaluate('document.querySelector("#paper tbody tr.selected")?.dataset.position??null')};
await check('D3 · the risk snapshot refreshes while a position remains selected',
 JSON.stringify(findings.D3.refreshWithSelection.before===findings.D3.refreshWithSelection.after&&
  findings.D3.refreshWithSelection.after!==null)+'===true');

// Keyboard reachability of the rendered action controls.
await evaluate('document.querySelector("#positions-tab").focus()');
const reached=[];
for(let i=0;i<160;i++){
 await key('Tab',9);
 const focus=await describeFocus();
 if(focus)reached.push(focus);
 if(focus&&/retain-preview-button/.test(focus.cls||''))break;
}
findings.U3.tabStopsToFirstCloseControl=reached.length;
findings.U3.reachedRetainByKeyboard=reached.some(f=>/retain-preview-button/.test(f.cls||''));
await check('U3 · the first retain-close control is reachable by Tab alone',
 JSON.stringify(findings.U3.reachedRetainByKeyboard)+'===true');

// Tablist arrow-key behaviour.
await evaluate('document.querySelector("#positions-tab").focus()');
await key('ArrowLeft',37);
findings.U3.arrowLeftSelectsResearch=await evaluate(
 'document.querySelector("#research-tab").getAttribute("aria-selected")==="true"');
findings.U3.arrowMovesFocus=await evaluate('document.activeElement.id');
await check('U3 · ArrowLeft on the tablist moves selection to Research',
 JSON.stringify(findings.U3.arrowLeftSelectsResearch)+'===true');
await evaluate('document.querySelector("#positions-tab").click()');
await waitFor('document.querySelector("#positions-tab").getAttribute("aria-selected")==="true"');
findings.U3.roving=await evaluate(`({positions:document.querySelector("#positions-tab").tabIndex,
 research:document.querySelector("#research-tab").tabIndex})`);
await check('U3 · the tablist keeps a single roving tab stop',
 'document.querySelector("#positions-tab").tabIndex===0&&document.querySelector("#research-tab").tabIndex===-1');

// Dialog focus containment and Escape.
await waitFor('document.querySelector("#paper [data-action=strategy]")!==null');
await evaluate('document.querySelector("#paper [data-action=strategy]").focus()');
const opener=await evaluate('document.activeElement.dataset.id');
await evaluate('document.querySelector("#paper [data-action=strategy]").click()');
await waitFor('document.querySelector("#detail-dialog").open===true');
findings.U3.dialogTrapsFocus=await evaluate(
 'document.querySelector("#detail-dialog").contains(document.activeElement)');
await key('Escape',27);
await waitFor('document.querySelector("#detail-dialog").open===false');
findings.U3.dialogClosesOnEscape=true;
findings.U3.focusReturnedToOpener=await evaluate(
 `document.activeElement?.dataset?.id===${JSON.stringify(opener)}`);
await check('U3 · the details dialog contains focus while open',
 JSON.stringify(findings.U3.dialogTrapsFocus)+'===true');
await check('U3 · Escape closes the details dialog',
 'document.querySelector("#detail-dialog").open===false');

// ── U4 · destructive-action distinguishability ───────────────────────────────
const geometry=await evaluate(`(()=>[...document.querySelectorAll("#paper .retain-action-root,#paper .convert-action-root")]
 .map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e),b=e.querySelector('button');return {
  root:e.className,text:(b?.textContent||"").trim(),buttonClass:b?.className||null,
  label:b?.getAttribute("aria-label")||null,groupLabel:e.getAttribute('aria-label'),
  border:s.borderColor,background:s.backgroundColor,
  x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};}))()`);
findings.U4.controls=geometry;
const retain=geometry.find(b=>b.root==='retain-action-root');
const convert=geometry.find(b=>b.root==='convert-action-root');
findings.U4.retain=retain??null;findings.U4.convert=convert??null;
if(retain&&convert){
 findings.U4.adjacent=Math.abs(retain.y-convert.y)<retain.h;
 findings.U4.distinctVisualTreatment=retain.border!==convert.border&&retain.background!==convert.background;
 findings.U4.distinctButtonIdentity=retain.buttonClass==='retain-preview-button'&&convert.buttonClass==='convert-preview-button';
 await check('U4 · retain and convert panels have distinct visual treatments',
  JSON.stringify(findings.U4.distinctVisualTreatment)+'===true');
 await check('U4 · retain and convert preview controls have distinct DOM identities',
  JSON.stringify(findings.U4.distinctButtonIdentity)+'===true');
}
// Read the copy before opening either preview, then verify distinct status and
// review identities after both review panels render.
findings.U4.retainStatusText=await evaluate(
 'document.querySelector(".retain-action-root .retain-action-status").textContent.trim()');
findings.U4.convertStatusText=await evaluate(
 'document.querySelector(".convert-action-root .convert-action-status").textContent.trim()');
findings.U4.convertGroupLabel=await evaluate(
 'document.querySelector(".convert-action-root").getAttribute("aria-label")');
findings.U4.retainGroupLabel=await evaluate(
 'document.querySelector(".retain-action-root").getAttribute("aria-label")');
await click('.retain-action-root .retain-preview-button');
await waitFor('document.querySelector(".retain-action-root .retain-action-review")?.hidden===false');
await click('.convert-action-root .convert-preview-button');
await waitFor('document.querySelector(".convert-action-root .convert-action-review")?.hidden===false');
findings.U4.statusIdentities=await evaluate(`({retain:document.querySelector('.retain-action-root .retain-action-status')?.className,
 convert:document.querySelector('.convert-action-root .convert-action-status')?.className,
 retainReview:document.querySelector('.retain-action-root .retain-action-review')?.className,
 convertReview:document.querySelector('.convert-action-root .convert-action-review')?.className})`);
await check('U4 · close action statuses and reviews have action-specific classes',
 JSON.stringify(findings.U4.statusIdentities.retain==='retain-action-status'&&
 findings.U4.statusIdentities.convert==='convert-action-status'&&
 findings.U4.statusIdentities.retainReview==='retain-action-review'&&
 findings.U4.statusIdentities.convertReview==='convert-action-review')+'===true');
// The copy an operator reads before an irreversible close, read per root.
findings.U4.retainReviewText=await evaluate(
 '(document.querySelector(".retain-action-root .retain-action-review")?.textContent??"").replace(/\\s+/g," ").trim().slice(0,400)');
findings.U4.lifecycleStatusText=await evaluate(
 'document.querySelector(".paper-lifecycle-action-root .retain-action-status").textContent.trim()');
findings.U4.retainConfirmRendered=await evaluate(
 '!!document.querySelector(".retain-action-root .retain-confirm-button")');
const retainCopy=`${findings.U4.retainReviewText} ${findings.U4.retainStatusText} ${findings.U4.retainGroupLabel}`;
findings.U4.retainCopyNamesAsset=/AAPL|NVDA/.test(retainCopy);
findings.U4.retainCopyNamesCampaign=/[0-9a-f]{8}-[0-9a-f]{4}/i.test(retainCopy);
findings.U4.distinctOutcomes=/retain.*token balances/i.test(findings.U4.retainStatusText)&&
 /convert.*tokens to USDG/i.test(findings.U4.convertStatusText)&&
 /no USDG swap/i.test(findings.U4.retainStatusText)&&/will not be retained/i.test(findings.U4.convertStatusText);
// Scope note: an accepted retain preview needs persisted paper accounting state,
// which this harness does not seed, so the post-preview confirm copy is out of
// reach here. What is asserted is the copy the operator actually reaches.
await check('U4 · the retain copy names the asset and campaign',
 JSON.stringify(findings.U4.retainCopyNamesAsset&&findings.U4.retainCopyNamesCampaign)+'===true');
await check('U4 · visible pre-preview copy clearly distinguishes retained balances from USDG conversion',
 JSON.stringify(findings.U4.distinctOutcomes)+'===true');
await check('U4 · retain and lifecycle roots show different text through the same class',
 JSON.stringify(findings.U4.retainStatusText!==findings.U4.lifecycleStatusText)+'===true');

for(const [width,mobile] of [[1440,false],[390,true]]){
 await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile});
 await new Promise(resolve=>setTimeout(resolve,150));
 findings.U4[`overflow${width}`]=await evaluate('document.documentElement.scrollWidth>innerWidth');
 findings.U4[`layout${width}`]=await evaluate(`(()=>Object.fromEntries(
  ['.retain-action-root','.convert-action-root'].map(s=>{const e=document.querySelector('#paper '+s),r=e.getBoundingClientRect();
   return [s,{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}]})))()`);
 await check(`U4 · two campaigns with action controls do not overflow at ${width}px`,
  'document.documentElement.scrollWidth<=innerWidth');
}

// ── U1b · detail view for a selected position with no marks in the window ────
// Every closed production position currently returns zero events and marks at
// the default 24h window, so this empty case is reachable in practice.
const staleId=await seedActiveCampaign({profileEntry:profiles[0],rangeState:'inside',
 wallet:'0x1111111111111111111111111111111111111111',markAgeSeconds:8*86400});
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
await navigate('/operator');
await waitFor('window.concliqOperatorAuthenticated?.()===true');
await waitFor(`document.querySelector(${JSON.stringify(rowSelector(staleId))})!==null`);
await selectRow(staleId);
await waitFor('document.querySelector("#paper .position-detail")!==null');
const staleDetail=await dashboardRead(`/api/positions/paper-dep-${staleId}?hours=24`);
findings.U1.staleWindow={markCount:staleDetail.performance.markCount,
 timelinePoints:staleDetail.performance.timeline.length,
 coveredStart:staleDetail.performance.coveredStart,
 sourceThrough:staleDetail.performance.sourceThrough,
 gaps:staleDetail.performance.gaps.length,
 rowsWithHours:staleDetail.performance.rows.filter(row=>row.hours>0).length};
await waitFor('document.querySelector("#paper .chart-footnote")!==null');
findings.U1.staleChartFootnote=await evaluate(
 'document.querySelector("#paper .chart-footnote").textContent.replace(/\\s+/g," ").trim()');
findings.U1.staleSessionTable=await evaluate(
 '(document.querySelector("#paper .session-table")?.textContent??"").replace(/\\s+/g," ").trim().slice(0,240)');
findings.U1.staleChartElements=await evaluate(`(()=>{
 const svg=document.querySelector("#paper-chart");if(!svg)return null;
 const counts={};for(const node of svg.querySelectorAll("*")){
  const key=node.tagName+(node.getAttribute("class")?'.'+node.getAttribute("class"):'');
  counts[key]=(counts[key]??0)+1;}
 return {counts,dataPaths:[...svg.querySelectorAll("path")]
  .filter(p=>(p.getAttribute("d")??"").length>8).length};})()`);
findings.U1.staleStatusLine=await evaluate(
 '(document.querySelector("#paper .status-sub")?.textContent??"").trim()');
await check('U1b · a selected position with no marks in the window still renders a detail panel',
 'document.querySelector("#paper .position-detail")!==null');
await check('U1b · the empty window reports zero marks rather than a misleading series',
 JSON.stringify(findings.U1.staleWindow.markCount===0&&
  findings.U1.staleWindow.timelinePoints===0)+'===true');
await check('U1b · the chart footnote states the mark count for an empty window',
 '/0 marks/.test(document.querySelector("#paper .chart-footnote").textContent)');

// ── D5 · retained campaign history uses an explicit all-recorded window ─────
await waitFor(`document.querySelector(${JSON.stringify(rowSelector(historyId))})!==null`);
await selectRow(historyId);
await waitFor(`document.querySelector('#paper .periods button[data-value="0"]')!==null`);
await evaluate(`document.querySelector('#paper .periods button[data-value="0"]').click()`);
await waitFor('document.querySelector("#paper .chart-footnote")?.textContent.includes("1 marks")');
const allHistory=await dashboardRead(`/api/positions/paper-dep-${historyId}?hours=0`);
const thirtyDayHistory=await dashboardRead(`/api/positions/paper-dep-${historyId}?hours=720`);
findings.D5={allMarkCount:allHistory.performance.markCount,
 allWindowHours:Math.round(allHistory.performance.hours),
 allSourceThrough:allHistory.performance.sourceThrough,
 expectedSourceAt:new Date((blockSource.timestamp-historyAgeSeconds)*1000).toISOString(),
 thirtyDayMarkCount:thirtyDayHistory.performance.markCount,
 renderedWindow:await evaluate('document.querySelector("#paper .chart-toolbar .periods button[aria-pressed=true]")?.textContent.trim()??null'),
 renderedFootnote:await evaluate('document.querySelector("#paper .chart-footnote")?.textContent.replace(/\\s+/g," ").trim()??null')};
await check('D5 · a 13-day-old recorded mark is reachable through the 30-day window',
 JSON.stringify(findings.D5.thirtyDayMarkCount===1)+'===true');
await check('D5 · All shows campaign history through its retained source mark',
 JSON.stringify(findings.D5.allMarkCount===1&&findings.D5.renderedWindow==='All'&&
  findings.D5.allSourceThrough===findings.D5.expectedSourceAt)+'===true');

assert.equal(errors.length,0,JSON.stringify(errors));
assert.equal(resourceFailures.filter(item=>item.status===404&&/\.(js|css)(\?|$)/.test(item.url)).length,0,
 'dashboard script/style assets load without 404s: '+JSON.stringify(resourceFailures));
// ── U6 · staleness rendering, and whether the two mechanisms agree ───────────
// The row under test is the active campaign seeded above. Each case sets the
// age and the server reason independently and reads what the row actually says.
// U1b's campaign is deliberately eight days stale, so it can never serve as a
// fresh baseline. U6 seeds its own campaign with a recent mark.
const u6Id=await seedActiveCampaign({profileEntry:profiles[0],rangeState:'inside',
 wallet:'0x1111111111111111111111111111111111111111',markAgeSeconds:30,
 initialCapitalRaw:'254000000000000000000'});
const u6Mark=(await admin.query(`SELECT id::text,source_block::text,source_hash,
 floor(extract(epoch FROM at))::int AS timestamp FROM deployment_marks
 WHERE campaign_id=$1 ORDER BY id DESC LIMIT 1`,[u6Id])).rows[0];
const u6Accounting=buildDashboardAccountingFixture({campaignId:u6Id,sourceMarkId:u6Mark.id,
 source:{block:u6Mark.source_block,hash:u6Mark.source_hash,timestamp:u6Mark.timestamp},
 profile:profiles[0].profile});
await admin.query(`INSERT INTO deployment_paper_accounting
 (campaign_id,source_mark_id,policy_version,snapshot,snapshot_hash) VALUES($1,$2,$3,$4,$5)`,
 [u6Id,u6Mark.id,u6Accounting.snapshot.policyVersion,JSON.stringify(u6Accounting.snapshot),u6Accounting.snapshotHash]);
await navigate('/operator');
await waitFor('window.concliqOperatorAuthenticated?.()===true');
await waitFor(`document.querySelector(${JSON.stringify(rowSelector(u6Id))})!==null`);
const u6Row=rowSelector(u6Id);
await evaluate(`document.querySelector(${JSON.stringify(u6Row)}+' .position-select').click()`);
await waitFor('document.querySelector("#paper .position-detail .metrics")?.textContent.includes("256.00")');
const readRow=async()=>JSON.parse(await evaluate(`(()=>{const row=document.querySelector(${JSON.stringify(u6Row)});
 if(!row)return JSON.stringify(null);
 return JSON.stringify({status:row.querySelector('.status-sub')?.textContent?.replace(/\\s+/g,' ').trim()??null,
  ageLabel:row.querySelector('.row-sub.negative')?.textContent?.trim()??null,
  sourceLabel:row.querySelector('td:nth-child(3) .row-sub:last-child')?.textContent?.trim()??null,
  // The source-age sub-label sits inside a td.num, so comparing whole cells
  // would always differ once the age changes. Split the headline values from
  // the sub-labels: U6 asks whether the VALUES stay confident beside a stale
  // source, not whether the age text changed.
  values:[...row.querySelectorAll('td.num')].map(cell=>{const clone=cell.cloneNode(true);
   for(const sub of clone.querySelectorAll('.row-sub'))sub.remove();
   return clone.textContent.replace(/\\s+/g,' ').trim();}),
  subs:[...row.querySelectorAll('td.num .row-sub')].map(sub=>sub.textContent.replace(/\\s+/g,' ').trim()),
  detailWarning:document.querySelector('#paper .position-detail .alert small')?.textContent.replace(/\\s+/g,' ').trim()??null,
  totalLabels:[...document.querySelectorAll('#paper .section-totals .label')].map(label=>label.textContent.trim())});})()`));
// The browser only observes a change on its next ten-second poll, so these
// waits get a longer budget than the default sixteen seconds. The server
// payload is asserted first, so a failure says which layer is at fault.
const waitForPoll=async expression=>{for(let i=0;i<300;i++){if(await evaluate(expression))return;
 await new Promise(resolve=>setTimeout(resolve,100));}
 throw Error('Timed out waiting for poll condition '+expression);};
const applyStaleness=async(next,expectation)=>{
 Object.assign(staleness,next);
 const served=(await dashboardRead('/api/positions')).positions
  .find(position=>position.id===`paper-dep-${u6Id}`);
 assert(served,'the U6 campaign must still be served');
 assert.equal(Boolean(served.reasons?.includes('source_stale')),Boolean(staleness.reason),
  `server reasons must reflect the injected reason: ${JSON.stringify(served.reasons)}`);
 if(staleness.invalidTime)assert.equal(served.sourceAt,'invalid-source-time');
 else{const servedAge=Math.round((Date.now()-Date.parse(served.sourceAt))/1000);
  assert(staleness.ageSeconds?servedAge>=180:servedAge<180,
   `server source age must reflect the injected age: ${servedAge}s for ${staleness.ageSeconds}`);}
 try{await waitForPoll(expectation);}
 catch(cause){throw Error(`${cause.message}\n  served=${JSON.stringify({
  id:served.id,history:served.history,status:served.status,reasons:served.reasons,
  sourceAt:served.sourceAt,lifecycle:served.deployment?.lifecycle,
  operation:served.deployment?.operation?.status??null})}\n  rendered=${JSON.stringify(await readRow())}`+
  `\n  degradeCalls=${staleness.calls} overviewServed=${staleness.overviewServed}`+
  ` lastSourceAt=${staleness.lastSourceAt}`+
  `\n  browserFetched=${await evaluate(`fetch('/api/positions').then(r=>r.json()).then(d=>JSON.stringify(
   (d.positions.find(p=>p.id===${JSON.stringify(`paper-dep-${u6Id}`)})??{}),['id','reasons','sourceAt','history','status']))`)}`);}
 return readRow();
};
const suffix='source stale / unavailable';
findings.U6={};

// Fresh baseline: neither mechanism engaged.
const fresh=await applyStaleness({ageSeconds:0,reason:false},
 `!document.querySelector(${JSON.stringify(u6Row)}).textContent.includes(${JSON.stringify(suffix)})`);
findings.U6.fresh=fresh;
await check('U6 a fresh row carries neither the stale condition nor a degraded age label',
 `${JSON.stringify(fresh.ageLabel===null&&!(fresh.status??'').includes(suffix))}===true`);

// Both engaged: the ordinary stale case.
const both=await applyStaleness({ageSeconds:1_200,reason:true},
 `document.querySelector(${JSON.stringify(u6Row)}).textContent.includes(${JSON.stringify(suffix)})`);
findings.U6.ageAndReason=both;
await check('U6 age past 180s together with a server stale reason degrades the condition and the age label',
 `${JSON.stringify(both.ageLabel!==null&&(both.status??'').includes(suffix)&&
  both.detailWarning?.includes('Displayed recorded-source values are stale')&&
  both.totalLabels.some(label=>label.includes('stale source')))}===true`);

// Age only: the browser sees an old timestamp, the server claims nothing.
const ageOnly=await applyStaleness({ageSeconds:1_200,reason:false},
 `document.querySelector(${JSON.stringify(u6Row)}).textContent.includes(${JSON.stringify(suffix)})`);
findings.U6.ageOnly=ageOnly;
await check('U6 an age past 180s alone degrades both condition and source-age label',
 `${JSON.stringify(ageOnly.ageLabel!==null&&(ageOnly.status??'').includes(suffix))}===true`);

// Reason only: the server declares staleness while the timestamp is fresh.
const reasonOnly=await applyStaleness({ageSeconds:0,reason:true},
 `document.querySelector(${JSON.stringify(u6Row)}).textContent.includes(${JSON.stringify(suffix)})&&`+
 `/Source \\d+s ago/.test(document.querySelector(${JSON.stringify(u6Row)}+' td:nth-child(3) .row-sub:last-child')?.textContent??'')`);
findings.U6.reasonOnly=reasonOnly;
await check('U6 a server stale reason beside a fresh timestamp degrades both condition and source-age label',
 `${JSON.stringify(reasonOnly.ageLabel!==null&&(reasonOnly.status??'').includes(suffix))}===true`);

const invalidTime=await applyStaleness({ageSeconds:0,reason:false,invalidTime:true},
 `document.querySelector(${JSON.stringify(u6Row)}).textContent.includes(${JSON.stringify(suffix)})&&`+
 `document.querySelector(${JSON.stringify(u6Row)}+' td:nth-child(3) .row-sub:last-child')?.textContent.includes('unavailable')`);
findings.U6.invalidTime=invalidTime;
await check('U6 invalid source time degrades condition and labels age unavailable',
 `${JSON.stringify(invalidTime.ageLabel?.includes('unavailable')&&(invalidTime.status??'').includes(suffix))}===true`);

// The central U6 question: are derived figures degraded beside a stale source?
findings.U6.valuesUnchangedWhileStale=
 JSON.stringify(both.values)===JSON.stringify(fresh.values);
findings.U6.freshValues=fresh.values;findings.U6.staleValues=both.values;
findings.U6.freshSubs=fresh.subs;findings.U6.staleSubs=both.subs;
await check('U6 persisted modeled NAV, P&L and fees are present and unchanged beside stale evidence',
 `${JSON.stringify(findings.U6.valuesUnchangedWhileStale&&fresh.values.some(v=>v.includes('256.00'))&&fresh.values.some(v=>v.includes('+2.00'))&&fresh.values.some(v=>v.includes('3.00')))}===true`);

// Recovery without a reload.
const recovered=await applyStaleness({ageSeconds:0,reason:false,invalidTime:false},
 `!document.querySelector(${JSON.stringify(u6Row)}).textContent.includes(${JSON.stringify(suffix)})`);
findings.U6.recovered=recovered;
await check('U6 the stale condition and the degraded age label both clear without a reload',
 `${JSON.stringify(recovered.ageLabel===null&&!(recovered.status??'').includes(suffix))}===true`);
await check('U6 detail warning clears on recovery while persisted figures remain identical',
 `${JSON.stringify(JSON.stringify(recovered.values)===JSON.stringify(fresh.values)&&
  !recovered.detailWarning?.includes('Displayed recorded-source values are stale'))}===true`);

const productionCampaigns=(await adminPool.query(
 'SELECT count(*)::int AS n FROM public.deployment_campaigns')).rows[0].n;
assert.equal(productionCampaigns,publicCampaignCountBefore,
 'the usability fixture must leave pre-existing public deployment rows unchanged');
console.log(JSON.stringify({checks,findings,draftIds,campaigns:{appleId,nvidiaId},
 openPreviewId:lastOpenPreview?.id,workerStarted:false,signerLoaded:false,
 publicDeploymentCampaigns:{before:publicCampaignCountBefore,after:productionCampaigns},
 browserExceptions:errors,httpResponses:resourceFailures,
 sourceBoundary:'deterministic canonical frame and seeded marks only'},null,2));

}finally{
 try{ws?.close();}catch{}
if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');await new Promise(resolve=>{
 const timer=setTimeout(resolve,2000);chrome.once('exit',()=>{clearTimeout(timer);resolve();});});
 if(chrome.exitCode===null)chrome.kill('SIGKILL');}
if(server?.listening)await new Promise(resolve=>server.close(resolve));
if(rootServer?.listening)await new Promise(resolve=>rootServer.close(resolve));
await store?.close();await admin.query('SET search_path=public');
await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);admin.release();await adminPool.end();
await rm(temp,{recursive:true,force:true});
}
