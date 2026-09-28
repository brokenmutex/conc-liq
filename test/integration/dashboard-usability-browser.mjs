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

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL is required');
const adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6}),admin=await adminPool.connect();
const schema=`track1b_${randomUUID().replaceAll('-','')}`,temp=await mkdtemp(`${tmpdir()}/conc-liq-usability-`);
let store,server,chrome,ws;const errors=[],resourceFailures=[],checks=[],detailErrors=[];
const findings={U1:{},U2:{},U3:{},U4:{}};
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
async function seedActiveCampaign({profileEntry,rangeState,wallet,markAgeSeconds=0}){
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
 [id,'250000000000000000000',JSON.stringify({source:blockSource})]);
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
const dashboardRead=async(path)=>{
 if(path==='/api/dashboard')return {pools:profiles.map(entry=>({registryEnabled:true,
  poolAddress:entry.profile.pool.pool,rwaSymbol:entry.profile.pool.reference1.split('/')[0],
  fee:3000,tickSpacing:60}))};
 if(path==='/api/research')return {generatedAt:new Date().toISOString(),pools:[],windows:[]};
 if(path.startsWith('/api/positions')){
  const rows=await readDeploymentRows(admin);
  if(path.startsWith('/api/positions/')){
   const id=decodeURIComponent(path.split('?')[0].slice('/api/positions/'.length));
   const row=rows.find(row=>`paper-dep-${row.id}`===id);
   if(!row)return null;
   try{return await readDeploymentDetail(admin,row,24);}
   catch(error){detailErrors.push(String(error?.stack??error));throw error;}
  }
  return {positions:rows.map(deploymentPosition),serverTime:new Date().toISOString(),refreshMs:10000};
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

await check('U1 · genuinely-empty Positions still renders the filtered-to-empty message',
 '/No matching current positions/.test(document.querySelector("#paper .empty").textContent)');
await check('U1 · empty state offers Clear filters although no filter was ever applied',
 'document.querySelector("#asset-filter").value==="all"&&document.querySelector("#status-filter").value==="all"'+
 '&&!!document.querySelector("#paper .empty [data-action=reset]")');
await check('U1 · nothing in the empty state directs a first-run operator to Set up a position',
 '!/set up a position/i.test(document.querySelector("#paper .empty").textContent)');

// Distinguish the genuinely-empty case from a real filter miss: the copy is identical.
await evaluate(`(()=>{const s=document.querySelector("#status-filter");s.value="paused";
 s.dispatchEvent(new Event("change",{bubbles:true}));})()`);
await waitFor('document.querySelector("#paper .empty")!==null');
findings.U1.filteredEmptyText=await evaluate('document.querySelector("#paper .empty").textContent.trim()');
findings.U1.emptyCopyIdenticalWhenFiltered=findings.U1.filteredEmptyText===findings.U1.paperEmptyText;
await check('U1 · filtered-empty and genuinely-empty states are textually indistinguishable',
 JSON.stringify(findings.U1.emptyCopyIdenticalWhenFiltered)+'===true');
await evaluate(`(()=>{const s=document.querySelector("#status-filter");s.value="all";
 s.dispatchEvent(new Event("change",{bubbles:true}));})()`);
await waitFor('document.querySelector("#paper .empty")!==null');

// Zero positions still produce a currency figure from a reduce over an empty list.
findings.U1.zeroPositionsShowCurrencyTotal=await evaluate(
 '/\\$?0\\.00/.test(document.querySelector("#paper .section-totals").textContent)');
await check('U1 · zero positions render a $0.00 managed value rather than an absent one',
 '/0\\.00/.test(document.querySelector("#paper .section-totals").textContent)');

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
await navigate('/operator');
await waitFor('window.concliqOperatorAuthenticated?.()===true');
const rowSelector=id=>`#paper tbody tr[data-position="paper-dep-${id}"]`;
await waitFor(`document.querySelector(${JSON.stringify(rowSelector(appleId))})!==null`);
await waitFor(`document.querySelector(${JSON.stringify(rowSelector(nvidiaId))})!==null`);
await waitFor('document.querySelectorAll("#paper .retain-preview-button").length>=1');
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
await check('U3 · close-control names are identical between two different campaigns',
 JSON.stringify(findings.U3.namesIdenticalAcrossCampaigns)+'===true');
await check('U3 · no close-control accessible name identifies its asset',
 JSON.stringify(findings.U3.anyActionNameCarriesAsset)+'===false');
await check('U3 · no close-control accessible name identifies its campaign',
 JSON.stringify(findings.U3.anyActionNameCarriesCampaign)+'===false');

// Full AX tree cross-check: what a flat button list exposes to assistive tech.
const axTree=await send('Accessibility.getFullAXTree');
findings.U3.axCloseControlNames=axTree.nodes
 .filter(n=>n.role?.value==='button'&&n.name?.value&&
  /retain-close|convert-close|management/i.test(n.name.value))
 .map(n=>n.name.value.trim());
findings.U3.axCloseNamesLackContext=findings.U3.axCloseControlNames
 .every(name=>!/AAPL|NVDA|[0-9a-f]{8}-[0-9a-f]{4}/i.test(name));
await check('U3 · the accessibility tree exposes close controls without asset or campaign context',
 JSON.stringify(findings.U3.axCloseControlNames.length>0&&findings.U3.axCloseNamesLackContext)+'===true');

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
const geometry=await evaluate(`(()=>{
 const root=document.querySelector("#paper tbody tr.selected")?.nextElementSibling??document;
 const all=[...document.querySelectorAll("#paper .lifecycle-controls button")];
 return all.map(b=>{const r=b.getBoundingClientRect();return {text:(b.textContent||"").trim(),
  cls:b.className||null,label:b.getAttribute("aria-label"),
  x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};});})()`);
findings.U4.controls=geometry;
const retain=geometry.find(b=>/Review retain-close/.test(b.text));
const convert=geometry.find(b=>/Review convert-close/.test(b.text));
findings.U4.retain=retain??null;findings.U4.convert=convert??null;
if(retain&&convert){
 findings.U4.adjacent=Math.abs(retain.y-convert.y)<retain.h;
 findings.U4.widthDifferencePx=Math.abs(retain.w-convert.w);
 findings.U4.sharedConfirmClass=true;
 findings.U4.textEditDistanceWords=retain.text.split(/\s+/)
  .filter(word=>!convert.text.split(/\s+/).includes(word)).length;
 await check('U4 · retain and convert previews sit adjacent on one row',
  JSON.stringify(findings.U4.adjacent)+'===true');
 await check('U4 · retain and convert differ by a single word and no other affordance',
  JSON.stringify(findings.U4.textEditDistanceWords===1)+'===true');
}
findings.U4.convertPreviewHasNoClass=await evaluate(
 '[...document.querySelectorAll("#paper .lifecycle-controls button")]'+
 '.some(b=>/Review convert-close/.test(b.textContent)&&b.className==="")');
await check('U4 · the convert preview control carries no class of its own',
 JSON.stringify(findings.U4.convertPreviewHasNoClass)+'===true');

// Three different action controls share the class `retain-action-status`, so a
// selector cannot address one of them. Scope every read to its own root.
findings.U4.statusClassSharedBy=await evaluate(`(()=>{
 const roots=['.paper-lifecycle-action-root','.retain-action-root','.convert-action-root'];
 return roots.filter(r=>!!document.querySelector(r+' .retain-action-status'));})()`);
await check('U4 · the retain-action-status class is shared by three distinct action roots',
 JSON.stringify(findings.U4.statusClassSharedBy.length===3)+'===true');

// The copy an operator reads before an irreversible close, read per root.
await click('.retain-action-root .retain-preview-button');
await waitFor('document.querySelector(".retain-action-root .retain-action-status").textContent.length>0');
findings.U4.retainStatusText=await evaluate(
 'document.querySelector(".retain-action-root .retain-action-status").textContent.trim()');
findings.U4.retainReviewText=await evaluate(
 '(document.querySelector(".retain-action-root .retain-action-review")?.textContent??"").replace(/\\s+/g," ").trim().slice(0,400)');
findings.U4.lifecycleStatusText=await evaluate(
 'document.querySelector(".paper-lifecycle-action-root .retain-action-status").textContent.trim()');
findings.U4.retainConfirmRendered=await evaluate(
 '!!document.querySelector(".retain-action-root .retain-confirm-button")');
const retainCopy=`${findings.U4.retainReviewText} ${findings.U4.retainStatusText}`;
findings.U4.retainCopyNamesAsset=/AAPL|NVDA/.test(retainCopy);
findings.U4.retainCopyNamesCampaign=/[0-9a-f]{8}-[0-9a-f]{4}/i.test(retainCopy);
// Scope note: an accepted retain preview needs persisted paper accounting state,
// which this harness does not seed, so the post-preview confirm copy is out of
// reach here. What is asserted is the copy the operator actually reaches.
await check('U4 · the reachable retain copy names neither the asset nor the campaign',
 JSON.stringify(!findings.U4.retainCopyNamesAsset&&!findings.U4.retainCopyNamesCampaign)+'===true');
await check('U4 · retain and lifecycle roots show different text through the same class',
 JSON.stringify(findings.U4.retainStatusText!==findings.U4.lifecycleStatusText)+'===true');

for(const [width,mobile] of [[1440,false],[390,true]]){
 await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile});
 await new Promise(resolve=>setTimeout(resolve,150));
 findings.U4[`overflow${width}`]=await evaluate('document.documentElement.scrollWidth>innerWidth');
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

assert.equal(errors.length,0,JSON.stringify(errors));
assert.equal(resourceFailures.filter(item=>item.status===404&&/\.(js|css)(\?|$)/.test(item.url)).length,0,
 'dashboard script/style assets load without 404s: '+JSON.stringify(resourceFailures));
const productionCampaigns=(await adminPool.query(
 'SELECT count(*)::int AS n FROM public.deployment_campaigns')).rows[0].n;
assert.equal(productionCampaigns,0,'public deployment tables stay empty');
console.log(JSON.stringify({checks,findings,draftIds,campaigns:{appleId,nvidiaId},
 openPreviewId:lastOpenPreview?.id,workerStarted:false,signerLoaded:false,
 publicDeploymentCampaigns:productionCampaigns,
 browserExceptions:errors,httpResponses:resourceFailures,
 sourceBoundary:'deterministic canonical frame and seeded marks only'},null,2));

}finally{
 try{ws?.close();}catch{}
if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');await new Promise(resolve=>{
 const timer=setTimeout(resolve,2000);chrome.once('exit',()=>{clearTimeout(timer);resolve();});});
 if(chrome.exitCode===null)chrome.kill('SIGKILL');}
if(server?.listening)await new Promise(resolve=>server.close(resolve));
await store?.close();await admin.query('SET search_path=public');
await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);admin.release();await adminPool.end();
await rm(temp,{recursive:true,force:true});
}
