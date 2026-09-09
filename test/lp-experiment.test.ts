import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {ExperimentMarket,type ExperimentFrame,type MarketSeed} from '../src/experiment/market.js';
import {ExperimentPortfolio,type Candidate} from '../src/experiment/portfolio.js';
import {json,parse,candidates} from '../src/experiment/runner.js';
const tick=221870,L=10n**20n;
function seed():MarketSeed{return {price:String(sqrtRatioAtTick(tick)),tick,liquidity:String(L),global0:'0',global1:'0',protocol0:0,protocol1:0,ticks:[{tick:220000,gross:String(L),net:String(L)},{tick:224000,gross:String(L),net:String(-L)},...Array.from({length:31},(_,i)=>({tick:221720+i*10,gross:'100',net:'0'}))]};}
function frame(at=1000000,t=tick):ExperimentFrame{const price=sqrtRatioAtTick(t);return {id:String(at),block:String(at),hash:'0xabc',sourceAt:new Date(at-5000).toISOString(),observedAt:new Date(at).toISOString(),targetSetHash:'test',price:String(price),tick:t,liquidity:String(L),global0:'0',global1:'0',referencePrice:String((1n<<192n)*10n**30n/price**2n),referenceEligible:true,referenceBasis:'heartbeat_valid',chainHealthy:true,reasons:[],dataValid:true,events:[]};}
const costs={buy:'10000',sell:'11000',mint:'12000',remove:'13000',revoke:'14000'};
function portfolio(management:Candidate['management']='exit_reentry'){return new ExperimentPortfolio({id:'test',budget:'1000000000',halfWidthTicks:20,management,costMultiplier:1,feeIncomePpm:1000000},costs);}
function market(t=tick){const m=new ExperimentMarket(seed());m.price=sqrtRatioAtTick(t);m.tick=t;return m.source();}
const pendingKind=(p:ExperimentPortfolio)=>p.s.pending?.kind;
function enter(p:ExperimentPortfolio){p.decision(frame(),market());assert.equal(p.s.position,null);assert.equal(pendingKind(p),'entry');p.decision(frame(1060000),market());assert(p.s.position);}
describe('bounded LP experiment',()=>{
 it('has exactly 20 frozen base candidates',()=>{assert.equal(candidates().length,20);assert.equal(new Set(candidates().map(c=>c.id)).size,20);});
 it('starts from cash, delays the fill, charges acquisition and mint, and holds its acquired comparator fixed',()=>{
  const p=portfolio();assert.equal(p.s.cash,1000000000n);assert.equal(p.s.rwa,0n);enter(p);
  assert.equal(p.s.costs,22000n);assert(p.s.hold0!==null&&p.s.hold1!>0n);const hold=[p.s.hold0,p.s.hold1];
  p.decision({...frame(1120000),chainHealthy:false},market());assert.equal(pendingKind(p),'exit');assert(p.s.position);
  p.decision({...frame(1180000),chainHealthy:false},market());assert(p.s.position,'No exit fill on unhealthy source');
  p.decision(frame(1240000),market());assert.equal(p.s.position,null);assert.equal(p.s.rwa,0n);assert.equal(p.s.costs,60000n);assert(p.s.cash<1000000000n);
  const cash=p.s.cash;p.decision(frame(1300000),market());assert.equal(p.s.pending,null);assert.equal(p.s.cash,cash);
  p.decision(frame(1840000),market());assert.equal(pendingKind(p),'entry');p.decision(frame(1900000),market());assert(p.s.position);
  assert.deepEqual([p.s.hold0,p.s.hold1],hold);assert.equal(p.s.costs,82000n);
 });
 it('uses the same delayed passive benchmark across widths and management rules',()=>{
  const a=portfolio(),b=new ExperimentPortfolio({...a.candidate,halfWidthTicks:30,management:'recenter'},costs);
  enter(a);enter(b);assert.deepEqual(a.s.benchmark,b.s.benchmark);assert(a.s.benchmark.filled);
  const before=json(a.s.benchmark);a.decision({...frame(1120000),chainHealthy:false},market());a.decision(frame(1180000),market());assert.equal(json(a.s.benchmark),before);
 });
 it('preserves bit-exact state across serialization and subsequent decisions',()=>{
  const p=portfolio();enter(p);const restored=new ExperimentPortfolio(p.candidate,p.costModel,parse(json(p.s)));
  const f=frame(1120000,tick-8);p.decision(f,market(tick-8));restored.decision(f,market(tick-8));assert.equal(json(p.s),json(restored.s));
 });
 it('requires persistent movement and a cooldown before recentering',()=>{
  const p=portfolio('recenter');enter(p);p.decision(frame(1120000,tick-16),market(tick-16));p.decision(frame(1180000,tick-16),market(tick-16));assert.equal(p.s.pending,null);
  p.decision(frame(1660000,tick-16),market(tick-16));assert.equal(pendingKind(p),'recenter');
  p.decision(frame(1720000,tick-16),market(tick-16));assert.equal(p.s.recenters,1);assert.equal(p.s.position?.tickLower,221830);
 });
 it('rejects inadmissible liquidity before purchasing inventory',()=>{
  const p=portfolio();p.decision(frame(),{...market(),liquidity:10n**16n});assert.equal(p.s.pending,null);assert.equal(p.s.costs,0n);assert.equal(p.s.rwa,0n);assert.equal(p.s.blocked.liquidity_share_admission,1);
 });
 it('invalidates missed decisions and cannot manufacture fees while waiting',()=>{
  const p=portfolio(),segment={from:sqrtRatioAtTick(tick),to:sqrtRatioAtTick(tick),tickBefore:tick,liquidity:L,fee:1000000n,token:0 as const,crossed:null};
  p.accrue(segment,0);assert.equal(p.s.fees0,0n);enter(p);p.accrue(segment,0);assert(p.s.fees0>0n);
  p.decision(frame(2060000),market());assert.equal(p.s.invalid,'source_gap_or_stale');assert.equal(p.summary(frame(2060000),market()).alpha,null);
 });
 it('reconciles mint/burn depth and flash fees against checkpoint endpoints',()=>{
  const m=new ExperimentMarket(seed()),base={block:'1',hash:'0xabc',tx:0,log:0};
  m.apply({...base,name:'Mint',args:{tickLower:221850,tickUpper:221890,amount:'1000'}});assert.equal(m.liquidity,L+1000n);
  m.apply({...base,name:'Burn',args:{tickLower:221850,tickUpper:221890,amount:'1000'}});assert.equal(m.liquidity,L);
  m.apply({...base,name:'Flash',args:{paid0:'1000000',paid1:'2000000'}});const f=frame();f.global0=String(1000000n*(1n<<128n)/L);f.global1=String(2000000n*(1n<<128n)/L);m.verify(f);
  assert.throws(()=>m.verify({...f,global0:'0'}),/fee0 mismatch/);
 });
});

describe('forward experiment persistence',()=>{
 it('starts prospectively, processes each frame once, and stops on revoked evidence',async t=>{
  const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {startForward,tickForward}=await import('../src/experiment/runner.js');
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const dir=await mkdtemp(join(tmpdir(),'lp-experiment-')),path=join(dir,'state.json');
  const identity={buildId:'a'.repeat(64),configHash:'b'.repeat(64),nodeVersion:process.version};
  const inputs=[frame()];let valid=true;
  const fake={
   checkpoints:async()=>inputs.map(f=>({id:f.id,block:f.block,source_at:f.sourceAt,observed_at:new Date(Date.parse(f.observedAt)-30000).toISOString(),target_set_hash:f.targetSetHash})),
   seed:async()=>seed(),health:async()=>[],events:async()=>[],coverage:async()=>{},costs:async()=>({costs}),historyValid:async()=>valid,
   frame:(row:{id:string})=>inputs.find(f=>f.id===row.id)!,
   liveFrame:async(row:{id:string})=>({...inputs.find(f=>f.id===row.id)!,observedAt:new Date().toISOString()}),
  } as unknown as import('../src/experiment/source.js').ExperimentSource;
  const selected=[portfolio().candidate,{...portfolio().candidate,id:'other',halfWidthTicks:30}];
  try{
   await startForward(fake,selected,costs,identity,path);
   let state=await tickForward(fake,path,identity);assert.equal(state.states[0]!.entries,0);assert.equal(state.sourceIds.length,1);
   t.mock.timers.tick(60000);inputs.push(frame(1060000));state=await tickForward(fake,path,identity);assert.equal(state.states[0]!.pending?.kind,'entry');
   t.mock.timers.tick(60000);inputs.push(frame(1120000));state=await tickForward(fake,path,identity);assert.equal(state.states[0]!.entries,1);
   const before=await readFile(path,'utf8');await tickForward(fake,path,identity);assert.equal(await readFile(path,'utf8'),before);
   await assert.rejects(tickForward(fake,path,{...identity,buildId:'c'.repeat(64)}),/runtime differs/);
   valid=false;state=await tickForward(fake,path,identity);assert.equal(state.status,'invalid');assert.equal(state.reason,'prior_source_revoked');
   assert(state.actions.length>0);
  }finally{await rm(dir,{recursive:true,force:true});t.mock.timers.reset();}
 });
 it('preserves accounting without retroactively filling checkpoints missed by a stopped worker',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {startForward,tickForward}=await import('../src/experiment/runner.js');
  t.mock.timers.enable({apis:['Date'],now:1000000});const dir=await mkdtemp(join(tmpdir(),'lp-stale-')),path=join(dir,'state.json');
  const identity={buildId:'a'.repeat(64),configHash:'b'.repeat(64),nodeVersion:process.version};const inputs=[frame()];
  const fake={checkpoints:async()=>inputs.map(f=>({id:f.id,block:f.block,source_at:f.sourceAt,observed_at:new Date(Date.parse(f.observedAt)-30000).toISOString(),target_set_hash:f.targetSetHash})),seed:async()=>seed(),health:async()=>[],events:async()=>[],coverage:async()=>{},costs:async()=>({costs}),historyValid:async()=>true,frame:(r:{id:string})=>inputs.find(f=>f.id===r.id)!,liveFrame:async(r:{id:string})=>({...inputs.find(f=>f.id===r.id)!,observedAt:new Date().toISOString()})} as unknown as import('../src/experiment/source.js').ExperimentSource;
  try{await startForward(fake,[portfolio().candidate,{...portfolio().candidate,id:'other'}],costs,identity,path);inputs.push(frame(1060000));t.mock.timers.tick(300000);const state=await tickForward(fake,path,identity);assert.equal(state.status,'paused_data');assert.equal(state.reason,'missed_forward_decision');assert.equal(state.states[0]!.entries,0);assert.equal(state.missedDecisions,1);}finally{await rm(dir,{recursive:true,force:true});t.mock.timers.reset();}
 });
});

describe('recoverable forward data pauses',()=>{
 async function setup(t:import('node:test').TestContext){
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {startForward,tickForward}=await import('../src/experiment/runner.js');
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const dir=await mkdtemp(join(tmpdir(),'lp-pause-')),path=join(dir,'state.json');
  t.after(async()=>{await rm(dir,{recursive:true,force:true});t.mock.timers.reset();});
  const identity={buildId:'a'.repeat(64),configHash:'b'.repeat(64),nodeVersion:process.version};
  const make=(at:number)=>({...frame(at),sourceAt:new Date(at-35000).toISOString()});
  const inputs=[make(Date.now())],events:import('../src/experiment/market.js').ExperimentEvent[]=[];
  let valid=true,coverage=true;
  const fake={
   checkpoints:async()=>inputs.filter(f=>Date.parse(f.observedAt)-30000<=Date.now()).map(f=>({id:f.id,block:f.block,source_at:f.sourceAt,observed_at:new Date(Date.parse(f.observedAt)-30000).toISOString(),target_set_hash:f.targetSetHash})),
   seed:async()=>seed(),health:async()=>[],costs:async()=>({costs}),historyValid:async()=>valid,
   coverage:async()=>{assert(coverage,'Coverage unavailable');},
   events:async(from:string,to:string)=>events.filter(e=>BigInt(e.block)>BigInt(from)&&BigInt(e.block)<=BigInt(to)),
   frame:(r:{id:string},_h:unknown,_e:unknown,at?:string)=>({...inputs.find(f=>f.id===r.id)!,observedAt:at??inputs.find(f=>f.id===r.id)!.observedAt}),
   liveFrame:async(r:{id:string})=>({...inputs.find(f=>f.id===r.id)!,observedAt:new Date().toISOString(),decisionMode:'prospective'}),
  } as unknown as import('../src/experiment/source.js').ExperimentSource;
  const selected=[portfolio().candidate,{...portfolio().candidate,id:'other',halfWidthTicks:30}];
  const tick=()=>tickForward(fake,path,identity);
  function add(at=Date.now(),fee=0n){
   const f=make(at);f.global0=String(BigInt(inputs.at(-1)!.global0)+fee*(1n<<128n)/L);inputs.push(f);
   if(fee)events.push({block:f.block,hash:f.hash,tx:0,log:0,name:'Flash',args:{paid0:String(fee),paid1:'0'}});
   return f;
  }
  const step=async(delta=60000)=>{t.mock.timers.tick(delta);add();return tick();};
  await startForward(fake,selected,costs,identity,path);
  return {tick,step,add,inputs,path,setValid:(v:boolean)=>valid=v,setCoverage:(v:boolean)=>coverage=v};
 }
 it('survives the recorded 184-second gap and 4.689-second late capture with inventory and fees intact',async t=>{
  const h=await setup(t);await h.step();const open=await h.step();
  assert.equal(open.states[0]!.entries,1);const before=json(open.states[0]);
  const lastSource=Date.parse(open.lastFrame.sourceAt);
  t.mock.timers.tick(151280);let state=await h.tick();
  assert.equal(Date.now()-lastSource,186280);assert.equal(state.status,'paused_data');assert.equal(json(state.states[0]),before);
  t.mock.timers.tick(4689);
  // This checkpoint was captured 4.689s after the old runner stopped. The
  // normal 30-second decision delay is still honored before resuming.
  const f=h.add(Date.now()+30000,100000000n);f.sourceAt=new Date(lastSource+184000).toISOString();
  state=await h.tick();assert.equal(state.status,'paused_data');assert.equal(json(state.states[0]),before);
  t.mock.timers.tick(30000);state=await h.tick();assert.equal(state.status,'running');
  assert.equal(state.states[0]!.position!.liquidity,open.states[0]!.position!.liquidity);
  assert.equal(state.states[0]!.costs,open.states[0]!.costs);assert.equal(state.states[0]!.entries,1);
  assert(state.states[0]!.fees0>open.states[0]!.fees0);assert.deepEqual(state.states[0]!.benchmark,open.states[0]!.benchmark);
  assert.equal(state.pausedSeconds,34.689);assert.equal(state.pauseCount,1);
  const fees=state.states[0]!.fees0;state=await h.tick();assert.equal(state.states[0]!.fees0,fees,'No duplicate catch-up credit');
 });
 it('cancels a stale entry quote and reacquires a prospective quote after restart',async t=>{
  const h=await setup(t);await h.step();t.mock.timers.tick(60000);h.add();t.mock.timers.tick(200000);
  let state=await h.tick();assert.equal(state.status,'paused_data');assert.equal(state.states[0]!.pending,null);
  assert.equal(state.states[0]!.entries,0);assert.equal(state.states[0]!.costs,0n);assert.equal(state.missedDecisions,1);
  h.add();state=await h.tick();assert.equal(state.status,'running');assert.equal(state.states[0]!.pending!.kind,'entry');
  assert.equal(state.states[0]!.pending!.after,Date.now());assert.equal(state.states[0]!.entries,0);
  state=await h.step();assert.equal(state.states[0]!.entries,1);assert.equal(state.states[0]!.costs,22000n);
 });
 it('retains a safety exit across a pause and executes it once on a fresh healthy source',async t=>{
  const h=await setup(t);await h.step();await h.step();t.mock.timers.tick(60000);h.add().chainHealthy=false;
  const signaled=await h.tick();assert.equal(signaled.states[0]!.pending!.kind,'exit');
  t.mock.timers.tick(151000);const paused=await h.tick();assert.equal(paused.status,'paused_data');
  assert.deepEqual(paused.states[0]!.pending,signaled.states[0]!.pending);
  h.add();const closed=await h.tick();assert.equal(closed.states[0]!.position,null);assert.equal(closed.states[0]!.rwa,0n);
  assert.equal(closed.states[0]!.exits,1);assert.equal(closed.states[0]!.costs,60000n);
 });
 it('does not let accounting-only catch-up extend the 900-second decision blackout',async t=>{
  const h=await setup(t);await h.step();await h.step();let state;
  for(let i=0;i<5;i++){t.mock.timers.tick(200000);h.add(Date.now()-165000);state=await h.tick();}
  assert.equal(state!.status,'invalid');assert.equal(state!.reason,'forward_blackout_exceeds_900_seconds');
  assert.equal(state!.states[0]!.entries,1);assert.equal(state!.states[0]!.exits,0);
 });
 it('retains the last accepted ledger when market reconstruction fails',async t=>{
  const h=await setup(t);await h.step();const open=await h.step(),before=json(open.states);
  t.mock.timers.tick(60000);const f=h.add(Date.now(),100000000n);f.global0=String(BigInt(f.global0)+1n);
  const invalid=await h.tick();assert.equal(invalid.status,'invalid');assert.equal(invalid.reason,'forward_market_or_accounting_reconstruction_failed');
  assert.equal(json(invalid.states),before);assert.equal(invalid.lastFrame.id,open.lastFrame.id);
 });
 it('keeps revoked sources terminal while paused',async t=>{
  const h=await setup(t);await h.step();await h.step();t.mock.timers.tick(151000);assert.equal((await h.tick()).status,'paused_data');
  h.setValid(false);const state=await h.tick();assert.equal(state.status,'invalid');assert.equal(state.reason,'prior_source_revoked');
  h.setValid(true);h.add();assert.equal((await h.tick()).status,'invalid');
 });
});
