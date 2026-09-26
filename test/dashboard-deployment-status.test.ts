import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const context=vm.createContext({
 document:{querySelector:()=>({addEventListener(){}}),addEventListener(){}},
 window:{addEventListener(){}},
 location:{pathname:'/operator'},
 fetch:()=>new Promise(()=>{}),
 AbortSignal,
});
const appScript=readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8')
 .replace(/import \{[^\n]+\} from '\.\/deployment-actions\.js';/,
  'const mountPaperLifecycleAction=()=>{},mountStaticRetainAction=()=>{},mountStaticConvertAction=()=>{},mountPendingPaperAcceptanceRecovery=()=>{};');
vm.runInContext(appScript,context);
const run=(expression:string)=>vm.runInContext(expression,context);

function position(status:string,lifecycle:string,extra:Record<string,unknown>={}){
 return {id:`paper-dep-${status}`,label:'Manual-1',mode:'paper',asset:'BASE',quote:'USDG',
  fee:3000,status,history:lifecycle==='closed',hasLiquidity:true,initial:null,capital:null,
  fees:null,sourceAt:new Date().toISOString(),reasons:[],deployment:{lifecycle,revision:1,
   campaignId:'67b2b303-e821-4450-bb7b-27171b12079f',strategyId:'static_manual_v1',rangeState:'inside',operation:{stage:null,reason:null}},...extra};
}

test('deployment badges preserve manual hold, pause and blocked recovery',()=>{
 const outside=position('outside','active',{deployment:{lifecycle:'active',strategyId:'static_manual_v1',
  rangeState:'outside',operation:{stage:null,reason:null}}});
 const paused=position('paused','paused',{deployment:{lifecycle:'paused',strategyId:'static_manual_v1',
  rangeState:'outside',operation:{stage:null,reason:null}}});
 const blocked=position('blocked','blocked',{reasons:['source_stale'],deployment:{lifecycle:'blocked',
  strategyId:'static_manual_v1',rangeState:'outside',operation:{stage:'recovery',reason:'receipt <mismatch>'}}});
 Object.assign(context,{outside,paused,blocked});
 assert.match(run('row(outside,null)'),/badge outside[^>]*>Outside range/);
 assert.match(run('condition(outside)'),/Outside range · manual hold/);
 assert.doesNotMatch(run('row(outside,null)'),/Management paused/);
 assert.match(run('row(paused,null)'),/badge paused[^>]*>Management paused/);
 assert.match(run('condition(paused)'),/Management paused · outside range/);
 const blockedRow=run('row(blocked,null)');
 assert.match(blockedRow,/badge blocked[^>]*>Recovery blocked/);
 assert.match(blockedRow,/receipt &lt;mismatch&gt; · recovery · source stale/);
 assert.doesNotMatch(blockedRow,/receipt <mismatch>/);
});

test('attention filter excludes normal manual hold and includes recovery and stale sources',()=>{
 const current=[position('open','active'),position('outside','active'),position('paused','paused'),
  position('blocked','blocked'),position('waiting','opening'),position('exiting','closing'),
  position('outside','active',{id:'stale-outside',reasons:['source_stale'],
   sourceAt:new Date(Date.now()-181000).toISOString()})];
 Object.assign(context,{current});
 run('positions=current;statusFilter="attention"');
 assert.deepEqual(Array.from(run('visible("paper")'),(p:any)=>p.id),
  ['paper-dep-paused','paper-dep-blocked','paper-dep-exiting','stale-outside']);
 run('statusFilter="outside"');
 assert.deepEqual(Array.from(run('visible("paper")'),(p:any)=>p.id),
  ['paper-dep-outside','stale-outside']);
 assert.match(run('condition(current[4])'),/Opening in progress/);
 assert.match(run('condition(current[5])'),/Close in progress/);
 const closed=position('closed','closed');Object.assign(context,{closed});
 assert.match(run('condition(closed)'),/Campaign closed/);
});

test('queued lifecycle operations remain visible before a valuation mark exists',()=>{
 const opening=position('waiting','opening',{deployment:{lifecycle:'opening',
  strategyId:'static_manual_v1',rangeState:'unknown',operation:{kind:'open',
   status:'queued',stage:'accepted',reason:null}}});
 const pausing=position('open','active',{deployment:{lifecycle:'active',
  strategyId:'static_manual_v1',rangeState:'inside',operation:{kind:'pause',
   status:'preflighting',stage:'source_recheck',reason:null}}});
 Object.assign(context,{opening,pausing});
 assert.match(run('condition(opening)'),/Open in progress · accepted · queued/);
 assert.match(run('condition(pausing)'),/Pause in progress · source_recheck · preflighting/);
 assert.match(run('row(opening,null)'),/Open in progress · accepted · queued/);
 assert.match(run('deploymentDetail(opening,modes.paper)'),/Open in progress · accepted · queued/);
 assert.equal(run('needsAttention(pausing)'),true);
});

test('retain-close browser affordance requires loopback, static paper and no pending operation',()=>{
 const eligible=position('open','active');
 Object.assign(context,{eligible});
 assert.match(run('lifecycleControls(eligible)'),/retain-action-root/);
 assert.match(run('lifecycleControls(eligible)'),/convert-action-root/);
 assert.match(run('lifecycleControls(eligible)'),/paper-lifecycle-action-root[^>]+data-kind="pause"/);
 const paused=position('paused','paused');Object.assign(context,{paused});
 assert.match(run('lifecycleControls(paused)'),/paper-lifecycle-action-root[^>]+data-kind="resume"/);
 const pending=position('open','active',{deployment:{...eligible.deployment,
  operation:{kind:'close_retain',status:'queued',stage:'accepted',reason:null}}});
 Object.assign(context,{pending});
 assert.doesNotMatch(run('lifecycleControls(pending)'),/retain-action-root/);
 assert.doesNotMatch(run('lifecycleControls(pending)'),/convert-action-root/);
 const rk=position('open','active',{deployment:{...eligible.deployment,strategyId:'rangekeeper_v1'}});
 Object.assign(context,{rk});
 assert.doesNotMatch(run('lifecycleControls(rk)'),/retain-action-root/);
 assert.doesNotMatch(run('lifecycleControls(rk)'),/convert-action-root/);
 assert.doesNotMatch(run('lifecycleControls(rk)'),/paper-lifecycle-action-root/);
 context.location.pathname='/';
 assert.doesNotMatch(run('lifecycleControls(eligible)'),/retain-action-root/);
 assert.doesNotMatch(run('lifecycleControls(eligible)'),/convert-action-root/);
 assert.doesNotMatch(run('lifecycleControls(eligible)'),/paper-lifecycle-action-root/);
});

test('positions without a deployment journal render disabled controls on both surfaces',()=>{
 const predecessor=position('open','active',{mode:'live',deployment:undefined});
 Object.assign(context,{predecessor});
 for(const path of ['/operator','/']){
  context.location.pathname=path;
  assert.match(run('lifecycleControls(predecessor)'),/Position actions unavailable/);
  assert.doesNotMatch(run('lifecycleControls(predecessor)'),/action-root/);
 }
});

test('same eligible action root survives a detail rerender while its preview is pending',()=>{
 const root=(className:string,extra:Record<string,string>={})=>({
  classList:{contains:(name:string)=>name===className},
  dataset:{campaignId:'67b2b303-e821-4450-bb7b-27171b12079f',revision:'1',
   lifecycle:'active',authenticated:'true',...extra},
  previewStatus:'Preview request pending',replacement:null as unknown,
  replaceWith(value:unknown){this.replacement=value;},
 });
 const mounted=root('retain-action-root'),placeholder=root('retain-action-root');
 Object.assign(context,{mounted,placeholder});
 run('preserveActionRoots([mounted],[placeholder])');
 assert.equal((placeholder as any).replacement,mounted);
 assert.equal((placeholder as any).replacement.previewStatus,'Preview request pending');
 Object.assign(context,{mountCount:0});
 run('mountActionRootOnce(mounted,()=>mountCount++)');
 run('mountActionRootOnce(mounted,()=>mountCount++)');
 assert.equal(run('mountCount'),1);
});

test('action roots are not reused across lifecycle, revision, auth, or pending-operation changes',()=>{
 const root=(className:string,extra:Record<string,string>={})=>({
  classList:{contains:(name:string)=>name===className},
  dataset:{campaignId:'67b2b303-e821-4450-bb7b-27171b12079f',revision:'1',
   lifecycle:'active',authenticated:'true',...extra},
  replacement:null as unknown,replaceWith(value:unknown){this.replacement=value;},
 });
 const old=root('paper-lifecycle-action-root',{kind:'pause'});
 const changed=root('paper-lifecycle-action-root',{kind:'resume',lifecycle:'paused'});
 Object.assign(context,{old,changed});
 run('preserveActionRoots([old],[changed])');
 assert.equal((changed as any).replacement,null);
 const oldRetain=root('retain-action-root');
 const revision=root('retain-action-root',{revision:'2'});
 const auth=root('retain-action-root',{authenticated:'false'});
 Object.assign(context,{oldRetain,revision,auth});
 run('preserveActionRoots([oldRetain],[revision,auth])');
 assert.equal((revision as any).replacement,null);
 assert.equal((auth as any).replacement,null);
 const pending=position('open','active',{deployment:{...position('open','active').deployment,
  operation:{kind:'pause',status:'queued',stage:'accepted',reason:null}}});
 Object.assign(context,{pending});
 assert.doesNotMatch(run('lifecycleControls(pending)'),/retain-action-root|paper-lifecycle-action-root/);
 run('preserveActionRoots([oldRetain],[])');
 assert.equal((oldRetain as any).replacement,null);
});

test('provisional paper economics are labeled as modeled throughout the row and detail metrics',()=>{
 const modeled=position('closed','closed',{accounting:'provisional',initial:250,capital:251,
  benchmark:252,fees:2,gas:1,deployment:{lifecycle:'closed',strategyId:'static_manual_v1',
   rangeState:'no_liquidity',operation:{stage:null,reason:null}}});
 Object.assign(context,{modeled});
 assert.match(run('condition(modeled)'),/provisional modeled outcome/);
 assert.match(run('row(modeled,null)'),/Provisional modeled value/);
 const metrics=run('deploymentMetrics(modeled)');
 assert.match(metrics,/Starting capital/);
 assert.match(metrics,/Modeled net value/);
 assert.match(metrics,/Vs passive inventory/);
 assert.match(metrics,/Lower integer fixed-flow allocation/);
 assert.match(metrics,/Scoped fork estimate · not paid gas/);
 assert.doesNotMatch(metrics,/Paid execution costs/);
});

test('static deployment metrics show persisted starting capital or an unavailable value',()=>{
 const recorded=position('open','active',{initial:2000,accounting:'unavailable',
  deployment:{lifecycle:'active',strategyId:'static_manual_v1',rangeState:'inside',
   lowerBoundValue:null,passiveTokenValue:null,operation:{stage:null,reason:null}}});
 const missing=position('open','active',{initial:null,accounting:'unavailable',
  deployment:{lifecycle:'active',strategyId:'static_manual_v1',rangeState:'inside',
   lowerBoundValue:null,passiveTokenValue:null,operation:{stage:null,reason:null}}});
 Object.assign(context,{recorded,missing});
 assert.match(run('deploymentMetrics(recorded)'),/Starting capital[\s\S]*2,000\.00[\s\S]*Persisted capital-in baseline/);
 assert.match(run('deploymentMetrics(missing)'),/Starting capital[\s\S]*>—<[\s\S]*Capital-in evidence unavailable/);
});
