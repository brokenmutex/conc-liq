// Isolated PostgreSQL + real dashboard/command routes + Chromium scaling/soak.
// TEST_DATABASE_URL is required. SOAK_MINUTES=120 qualifies R2; shorter runs are
// smoke checks only. P6 measures an idle operation-worker poll, not execution.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer as createTcpServer} from 'node:net';
import {mkdir,writeFile} from 'node:fs/promises';
import {appendFileSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {DeploymentStore} from '../../src/deployments/store.ts';
import {marketProfileSchema} from '../../src/deployments/market-profile.ts';
import {processOnePaperOperation} from '../../src/deployments/paper-operation-worker.ts';
import {createDeploymentCommandServer} from '../../src/deployments/server.ts';
import {DashboardRepository} from '../../src/dashboard/repository.ts';
import {loadDashboardConfig} from '../../src/dashboard/config.ts';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../../src/constants.ts';
import {PAPER_QUOTER,PAPER_ROUTER} from '../../src/paper/execution-abi.ts';
import {sqrtRatioAtTick} from '../../src/backtest/principal.ts';
import {buildDashboardAccountingFixture} from './helpers/dashboard-accounting-fixture.mjs';
import {startDashboardBrowser,wait} from './helpers/dashboard-browser.mjs';

assert(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL required');
const minutes=Number(process.env.SOAK_MINUTES??120);
assert(Number.isFinite(minutes)&&minutes>=0&&minutes<=240,'SOAK_MINUTES must be 0..240');
const evidence=resolve(process.env.EVIDENCE_DIR??`data/dashboard-follow-up-2026-09-29/soak-${Date.now()}`);
await mkdir(evidence,{recursive:true,mode:0o700});
const schema=`dashboard_soak_${randomUUID().replaceAll('-','')}`;
const adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
const admin=await adminPool.connect();
const initialPublic=(await admin.query('SELECT count(*)::int AS n FROM public.deployment_campaigns')).rows[0].n;
const url=new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
let store,repository,server,browser,workerPool,workerJob,stopWorker=false;
let interrupted=false;
const interrupt=()=>{interrupted=true;};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
async function interruptibleWait(ms){
 const until=performance.now()+ms;
 while(performance.now()<until){if(interrupted)throw Error('Acceptance run interrupted');await wait(Math.min(1000,until-performance.now()));}
 if(interrupted)throw Error('Acceptance run interrupted');
}
const failures=[],http=[],worker=[],samples=[],scaling=[];
let phase='setup';
const startedAt=new Date().toISOString();
const releaseManifest=existsSync('release.json')?JSON.parse(readFileSync('release.json','utf8')):null;
const sourceCommit=releaseManifest?.sourceCommit??execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const buildId=releaseManifest?.buildId??null;
function instrument(pool){
 const stats={acquisitions:0,connectionMs:0,queries:0,statementMs:0,errors:0,maxActive:0},held=new Map();
 pool.on('acquire',client=>{held.set(client,performance.now());stats.acquisitions++;stats.maxActive=Math.max(stats.maxActive,held.size);});
 pool.on('release',(_err,client)=>{const at=held.get(client);if(at!==undefined){stats.connectionMs+=performance.now()-at;held.delete(client);}});
 pool.on('connect',client=>{
  const original=client.query.bind(client);
  client.query=(...args)=>{
   const at=performance.now();stats.queries++;
   const finish=error=>{stats.statementMs+=performance.now()-at;if(error)stats.errors++;};
   const callback=args.at(-1);
   if(typeof callback==='function'){args[args.length-1]=(error,...values)=>{finish(error);callback(error,...values);};return original(...args);}
   try{return original(...args).then(value=>{finish();return value;},error=>{finish(error);throw error;});}
   catch(error){finish(error);throw error;}
  };
 });
 return ()=>({...stats,active:held.size,connectionMs:stats.connectionMs+[...held.values()].reduce((sum,t)=>sum+performance.now()-t,0)});
}
const quantile=(values,q)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))]??null;};
const distribution=values=>({n:values.length,p50:quantile(values,.5),p95:quantile(values,.95),max:values.length?Math.max(...values):null});
const codes={poolCodeHash:'0x'+'c'.repeat(64),token0CodeHash:'0x'+'c'.repeat(64),token1CodeHash:'0x'+'c'.repeat(64),managerCodeHash:'0x'+'c'.repeat(64),quoterCodeHash:'0x'+'c'.repeat(64)};
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,
 pool:'0x8000000000000000000000000000000000000001',token0:USDG,token1:'0xf000000000000000000000000000000000000001',quoteToken:0,
 decimals0:6,decimals1:6,fee:3000,tickSpacing:60,positionManager:NONFUNGIBLE_POSITION_MANAGER,
 router:PAPER_ROUTER,quoter:PAPER_QUOTER,...codes,reference0:'USDG/USD',reference1:'TEST/USD',nativeReference:'ETH/USD',numeraire:'USD'},
 referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
 nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
const allocation={token0Raw:'125000000',token1Raw:'125000000',nativeWei:'2000000000000000'};
const config={limits:{maxDeploymentValue:'250000000000000000000',minDeploymentValue:'1000000000000000000',maxExposurePpm:950000,
 maxLossValue:'12500000000000000000',maxDrawdownPpm:100000,maxActionCost:'10000000000000000000',maxRollingCost:'25000000000000000000',
 maxCampaignCost:'37500000000000000000',exitReserveWei:'1000000000000000',maxSlippageBps:50},range:{tickLower:-240,tickUpper:240}};
const ids=Array.from({length:50},()=>randomUUID()),profileId=randomUUID(),now=Math.floor(Date.now()/1000);
let report;
try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);await migrateDatabase(admin);
 await admin.query(`INSERT INTO deployment_market_profiles(id,chain_id,pool_address,token0_address,token1_address,token0_decimals,token1_decimals,quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at)
 VALUES($1,4663,$2,$3,$4,6,6,0,3000,60,$5,'{}',$6,clock_timestamp())`,[profileId,profile.pool.pool,profile.pool.token0,profile.pool.token1,JSON.stringify(profile),contentHash(profile)]);
 for(const [campaignIndex,id] of ids.entries()){
  await admin.query('BEGIN');
  try{
   await admin.query(`INSERT INTO deployment_campaigns(id,mode,chain_id,wallet,market_profile_id,allocation,lifecycle,range_state,current_revision,created_at)
    VALUES($1,'paper',4663,$2,$3,$4,'draft','inside',1,$5)`,[id,`0x${(campaignIndex+1).toString(16).padStart(40,'0')}`,profileId,JSON.stringify(allocation),new Date((now-168*3600)*1000)]);
   await admin.query(`INSERT INTO deployment_revisions(campaign_id,revision,strategy_id,strategy_version,state_schema_version,config,config_hash)
    VALUES($1,1,'static_manual_v1','1.0.0',1,$2,$3)`,[id,JSON.stringify(config),contentHash(config)]);
   await admin.query(`INSERT INTO deployment_ledger(campaign_id,entry_key,kind,value_raw,source) VALUES($1,'capital_in:1','capital_in','254000000000000000000','{}')`,[id]);
   const markIds=(await admin.query("SELECT nextval(pg_get_serial_sequence('deployment_marks','id'))::text AS id FROM generate_series(0,168)")).rows.map(row=>row.id);
   const marks=[],accounting=[];
   for(let i=0;i<=168;i++){
    const source={block:String(100000+i),hash:'0x'+(i+1).toString(16).padStart(64,'0'),timestamp:now-(168-i)*3600};
    const modeled=buildDashboardAccountingFixture({campaignId:id,sourceMarkId:markIds[i],source,profile,allocation,markIndex:i,
     intervalFeeAccrualQuote:'3000000000000000000',markGasExpenseQuote:i===0?'1000000000000000000':'0'});
    marks.push({id:markIds[i],campaign_id:id,at:new Date(source.timestamp*1000).toISOString(),source_block:source.block,source_hash:source.hash,
     inventory:{token0Raw:'120000000',token1Raw:'130000000',position:{liquidity:'1000000000000',tickLower:-240,tickUpper:240}},economics:modeled.economics,
     provenance:{...modeled.provenance,poolState:{tick:0,sqrtPriceX96:String(sqrtRatioAtTick(0))}}});
    accounting.push({campaign_id:id,source_mark_id:markIds[i],policy_version:modeled.snapshot.policyVersion,snapshot:modeled.snapshot,snapshot_hash:modeled.snapshotHash});
   }
   await admin.query(`INSERT INTO deployment_marks(id,campaign_id,revision,at,source_block,source_hash,inventory,economics,provenance)
    SELECT id,campaign_id,1,at,source_block,source_hash,inventory,economics,provenance FROM jsonb_to_recordset($1) AS x(id bigint,campaign_id uuid,at timestamptz,source_block numeric,source_hash text,inventory jsonb,economics jsonb,provenance jsonb)`,[JSON.stringify(marks)]);
   await admin.query(`INSERT INTO deployment_paper_accounting(campaign_id,source_mark_id,policy_version,snapshot,snapshot_hash)
    SELECT campaign_id,source_mark_id,policy_version,snapshot,snapshot_hash FROM jsonb_to_recordset($1) AS x(campaign_id uuid,source_mark_id bigint,policy_version text,snapshot jsonb,snapshot_hash text)`,[JSON.stringify(accounting)]);
   await admin.query('COMMIT');
  }catch(error){await admin.query('ROLLBACK');throw error;}
 }
 store=new DeploymentStore(url.toString());const workerDb=instrument(store.pool);
 workerPool=new pg.Pool({connectionString:url.toString(),max:1});
 repository=new DashboardRepository(loadDashboardConfig({DATABASE_URL:url.toString(),INDEXER_STREAM_KEY:'soak-fixture',ADAPTIVE_PAPER_STATE_PATH:'/nonexistent/soak.json'}));
 const dashboardDb=instrument(repository.pool);
 const fakeChain=new Proxy({}, {get(){throw Error('Unexpected chain read during idle worker test');}});
 workerJob=(async()=>{while(!stopWorker){const at=performance.now();try{
  const result=await processOnePaperOperation(store,fakeChain,workerPool,'dashboard-soak-worker');assert.equal(result.status,'idle');
  worker.push({phase,ms:performance.now()-at,at:new Date().toISOString()});
 }catch(error){failures.push({kind:'worker',message:String(error)});break;}await wait(2000);}})();
 phase='worker-baseline';await interruptibleWait(minutes>=120?60000:4000);
 const probe=createTcpServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const origin=`http://127.0.0.1:${port}`;
 server=createDeploymentCommandServer(store,{origin,setupDefaults:()=>({walletAddress:'0x'+'2'.repeat(40)}),
  paperSetupDraftList:async()=>[],dashboardRead:async path=>{
   const request=new URL(path,origin),at=performance.now();
   try{
    if(request.pathname==='/api/positions'){
     const overview=await repository.positions();
     return {...overview,positions:overview.positions.filter(p=>p.id.startsWith('paper-dep-')&&ids.includes(p.id.slice(10)))};
    }
    if(request.pathname.startsWith('/api/positions/'))return await repository.positions(request.pathname.slice(15),Number(request.searchParams.get('hours')??24));
    if(request.pathname==='/api/research')return await repository.research();
    if(request.pathname==='/api/dashboard')return {pools:[]};
    throw Error('Unexpected read route');
   }finally{http.push({phase,path:request.pathname,ms:performance.now()-at,at:new Date().toISOString()});}
  }});
 server.listen(port,'127.0.0.1');await once(server,'listening');
 browser=await startDashboardBrowser();const {page}=browser;
 await page.send('Page.enable');await page.send('Runtime.enable');await page.send('Performance.enable');await page.send('HeapProfiler.enable');
 page.on('Runtime.exceptionThrown',event=>failures.push({kind:'browser',message:event.exceptionDetails.text}));
 await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 let snapshotFile=null;page.on('HeapProfiler.addHeapSnapshotChunk',event=>{if(snapshotFile)appendFileSync(snapshotFile,event.chunk);});
 async function heapSnapshot(name){snapshotFile=resolve(evidence,name);writeFileSync(snapshotFile,'',{mode:0o600});try{await page.send('HeapProfiler.takeHeapSnapshot',{reportProgress:false});}finally{snapshotFile=null;}}
 for(const count of [1,10,50]){
  phase=`scaling-${count}`;await admin.query("UPDATE deployment_campaigns SET lifecycle=CASE WHEN id=ANY($1::uuid[]) THEN 'active' ELSE 'draft' END",[ids.slice(0,count)]);
  const responses=[];for(let i=0;i<5;i++){const at=performance.now();const result=await fetch(`${origin}/api/positions`);assert.equal(result.status,200);const data=await result.json();assert.equal(data.positions.length,count);responses.push(performance.now()-at);}
  const at=performance.now();await page.send('Page.navigate',{url:`${origin}/operator`});
  await page.waitFor(`document.querySelectorAll('#paper tr[data-position]').length===${count}`);
  await page.waitFor("document.querySelector('#paper .periods button[data-value=\"168\"]')!==null");
  await page.evaluate("document.querySelector('#paper .periods button[data-value=\"168\"]').click()");
  await page.waitFor("document.querySelector('#paper .periods button[aria-pressed=true]')?.dataset.value==='168'");
  const renderMs=performance.now()-at;
  const detailTimes=[];let minMarks=Infinity;
  for(const id of ids.slice(0,count)){
   const at=performance.now(),response=await fetch(`${origin}/api/positions/paper-dep-${id}?hours=168`);assert.equal(response.status,200);
   const detail=await response.json();assert(detail.performance,'persisted accounting must produce performance');
   minMarks=Math.min(minMarks,detail.performance.markCount);detailTimes.push(performance.now()-at);
  }
  assert(minMarks>=167,'full168-hour persisted mark fixture must be represented');
  const dom=await page.evaluate("({rows:document.querySelectorAll('#paper tr[data-position]').length,overflow:document.documentElement.scrollWidth>innerWidth})");
  const result={count,overviewMs:distribution(responses),detailMs:distribution(detailTimes),renderMs,minMarks,dom};scaling.push(result);
  assert(responses.every(ms=>ms<10000)&&detailTimes.every(ms=>ms<10000)&&renderMs<10000,'10s polling budget exceeded');
 }
 phase='state-preservation';
 const inspect=()=>page.evaluate("({focus:document.activeElement?.id||document.activeElement?.className,scrollY:window.scrollY,selection:String(getSelection()),setupDetailsOpen:document.querySelector('#setup-limits-review')?.open})");
 await page.evaluate("(()=>{document.querySelector('#paper-chart')?.focus();window.scrollTo(0,600);const d=document.querySelector('#setup-limits-review');if(d)d.open=true;const text=document.querySelector('#paper .status-sub');if(text){const range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range);}return true;})()");
 await wait(1000); // Allow CSS smooth scrolling and the deliberate selection to settle.
 const stateBefore=await inspect();
 const metricsBefore=Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
 await wait(11000);const stateAfter=await inspect();
 const metricsAfter=Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
 const renderWork=Object.fromEntries(['LayoutCount','RecalcStyleCount','LayoutDuration','RecalcStyleDuration','TaskDuration'].map(key=>[key,(metricsAfter[key]??0)-(metricsBefore[key]??0)]));
 await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await wait(200);
 const mobile=await page.evaluate("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,rows:document.querySelectorAll('#paper tr[data-position]').length})");
 assert.equal(mobile.rows,50);assert(mobile.scrollWidth<=mobile.width,'50-position mobile page overflow');
 await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await page.evaluate("(()=>{const input=document.querySelector('#setup-capital');input.focus();input.value='375';return true;})()");
 await wait(11000);
 const preserved=await page.evaluate("({value:document.querySelector('#setup-capital')?.value,focus:document.activeElement?.id})");
 assert.deepEqual(preserved,{value:'375',focus:'setup-capital'});
 await heapSnapshot('heap-before.heapsnapshot');
 const second=await browser.browser.send('Target.createTarget',{url:'about:blank'});
 const pages=await(await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
 const background=await browser.connect(pages.find(p=>p.id===second.targetId).webSocketDebuggerUrl);
 await page.send('Page.bringToFront');
 const soakStart=performance.now(),deadline=soakStart+minutes*60000;
 const baselineDashboard=dashboardDb(),baselineWorker=workerDb();let sequence=0;
 do{
  const elapsedMs=performance.now()-soakStart,fraction=minutes?elapsedMs/(minutes*60000):0;
  phase=fraction>=.5&&fraction<.75?'hidden':'visible';
  if(phase==='hidden')await background.send('Page.bringToFront');else await page.send('Page.bringToFront');
  await wait(100);
  const visibility=await page.evaluate('document.visibilityState');
  assert.equal(visibility,phase,'browser must really enter requested visibility state');
  if(phase==='visible')await page.evaluate(`document.querySelector('#paper tr[data-position="paper-dep-${ids[sequence%ids.length]}"] .position-select')?.click()`);
  await page.send('HeapProfiler.collectGarbage');
  const metrics=await page.send('Performance.getMetrics'),dom=await page.send('Memory.getDOMCounters'),heap=await page.send('Runtime.getHeapUsage');
  const sample={at:new Date().toISOString(),elapsedMs,phase,visibility,dom,heap,performance:Object.fromEntries(metrics.metrics.map(m=>[m.name,m.value])),dashboardDb:dashboardDb(),workerDb:workerDb(),requests:http.length,workerPasses:worker.length};
  samples.push(sample);appendFileSync(resolve(evidence,'samples.jsonl'),JSON.stringify(sample)+'\n',{mode:0o600});
  console.log(JSON.stringify({phase,elapsedMinutes:Math.round(elapsedMs/6000)/10,heapBytes:heap.usedSize,nodes:dom.nodes,listeners:dom.jsEventListeners,workerPasses:worker.length}));
  sequence++;if(performance.now()>=deadline)break;await interruptibleWait(Math.min(60000,Math.max(1000,minutes*60000/8),deadline-performance.now()));
  if(interrupted)throw Error('Acceptance run interrupted');
 }while(true);
 const elapsedMs=performance.now()-soakStart;
 await heapSnapshot('heap-after.heapsnapshot');
 const steady=samples.filter(s=>s.elapsedMs>=Math.min(10*60000,elapsedMs*.1));
 const first=steady[0]??samples[0],last=samples.at(-1);
 const bounds={heapBytes:first.heap.usedSize+32*1024*1024,nodes:Math.ceil(first.dom.nodes*1.35+1500),listeners:Math.ceil(first.dom.jsEventListeners*1.25+100)};
 assert(steady.every(sample=>sample.heap.usedSize<=bounds.heapBytes),'retained heap growth exceeds allowance');
 assert(steady.every(sample=>sample.dom.nodes<=bounds.nodes),'retained DOM growth exceeds allowance');
 assert(steady.every(sample=>sample.dom.jsEventListeners<=bounds.listeners),'listener growth exceeds allowance');
 assert.equal(failures.length,0,JSON.stringify(failures));
 report={status:'passed',startedAt,finishedAt:new Date().toISOString(),sourceCommit,buildId,schema,minutes,elapsedMs,
  r2Qualified:elapsedMs>=120*60000,p6DurationQualified:elapsedMs>=60*60000,
  boundaries:['isolated PostgreSQL fixture schema; retained legacy live summaries may be read but are filtered out of the fixture response','synthetic persisted paper accounting','real HTTP, repository and Chromium','real idle processOnePaperOperation every2s; no economic/maintenance execution','statement and connection timings are client wall time, not server CPU','fixture source ages naturally; no clock acceleration'],
  scaling,renderWork,stateBefore,stateAfter,mobile,preserved,bounds,first,last,baselineDashboard,baselineWorker,worker:{baselineMs:distribution(worker.filter(w=>w.phase==='worker-baseline').map(w=>w.ms)),concurrentMs:distribution(worker.filter(w=>['visible','hidden'].includes(w.phase)).map(w=>w.ms))},
  httpByPhase:Object.fromEntries([...new Set(http.map(h=>h.phase))].map(key=>[key,{requests:http.filter(h=>h.phase===key).length,ms:distribution(http.filter(h=>h.phase===key).map(h=>h.ms))}])),failures};
 await writeFile(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 await writeFile(resolve(evidence,'requests.json'),JSON.stringify(http)+'\n',{mode:0o600});
 await writeFile(resolve(evidence,'worker.json'),JSON.stringify(worker)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:report.status,r2Qualified:report.r2Qualified,p6DurationQualified:report.p6DurationQualified,evidence}));
}catch(error){
 await writeFile(resolve(evidence,'failure.json'),JSON.stringify({phase,message:String(error.stack??error),failures},null,2)+'\n',{mode:0o600});throw error;
}finally{
 stopWorker=true;await workerJob;await browser?.close().catch(error=>failures.push({kind:'browser-cleanup',message:String(error)}));
 if(server)await new Promise(resolve=>server.close(resolve));
 await repository?.close();await store?.close();await workerPool?.end();
 await admin.query('SET search_path=public');await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
 const afterPublic=(await admin.query('SELECT count(*)::int AS n FROM public.deployment_campaigns')).rows[0].n;
 await writeFile(resolve(evidence,'cleanup.json'),JSON.stringify({schemaRemoved:true,publicCampaignsBefore:initialPublic,publicCampaignsAfter:afterPublic,
  publicCampaignCountChanged:afterPublic!==initialPublic,publicCountIsObservationOnly:true})+'\n',{mode:0o600});
 admin.release();await adminPool.end();
}
