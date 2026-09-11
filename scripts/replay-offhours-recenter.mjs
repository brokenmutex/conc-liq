import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {CAP_HOURS} from '../src/research/offhours-cap.ts';
import {OffHoursRecenter,RECENTER_RULES} from '../src/research/offhours-recenter.ts';
import {paperTradingWindow,equityHours} from '../src/paper/trading-hours.ts';
const [capturePath,planPath,output]=process.argv.slice(2);assert(output&&!fs.existsSync(output));
const digest=x=>createHash('sha256').update(x).digest('hex');
const raw=fs.readFileSync(capturePath,'utf8');assert.equal(digest(raw),fs.readFileSync(capturePath+'.sha256','utf8').trim());
const data=JSON.parse(raw),plan=JSON.parse(fs.readFileSync(planPath,'utf8'));
for(const [file,hash] of Object.entries(plan.codeHashes))assert.equal(digest(fs.readFileSync(file)),hash,`Frozen code changed: ${file}`);
assert.deepEqual(plan.caps,[600000,700000,800000]);assert.deepEqual(plan.tradingHours,CAP_HOURS);assert.deepEqual(plan.recenterRules,RECENTER_RULES);
assert.deepEqual(plan.rangePolicies,['hold_range','preserve_tokens','net_swap']);assert.equal(plan.lpAllocationPpm,800000);assert.equal(plan.halfWidthRawTicks,20);
const health=new Map(data.health.map(h=>[h.id,h])),market=new ExperimentMarket(data.seed),windows=[];
let window=null,last=null;
const profiles=plan.profiles.map(p=>({...p,entry:BigInt(p.entry),exit:BigInt(p.exit),buy:BigInt(p.buy),recenter:Object.fromEntries(Object.entries(p.recenter).map(([k,v])=>[k,BigInt(v)]))}));
function finish(frame,partialEnd=false){
 const results=window.models.map(x=>({profile:x.profile,...x.model.summary(market.source())}));
 for(const profile of profiles){const rs=results.filter(r=>r.profile===profile.id),first=rs.map(r=>r.actions.find(a=>a.kind==='entry')?.checkpoint);assert(first.every(x=>x===first[0]),'Caps differ before initial entry');
  const baseline=rs.find(r=>r.cap===600000&&r.rangePolicy==='hold_range');
  const available=!window.partialStart&&!partialEnd&&rs.every(r=>!r.invalid&&!r.positionOpen);
  for(const r of rs){r.available=available;r.delta=available?r.nav-baseline.nav:null;r.deltaSameCap=available?r.nav-rs.find(b=>b.cap===r.cap&&b.rangePolicy==='hold_range').nav:null;}}
 windows.push({startAt:window.startAt,excludedAt:window.excludedAt,endAt:frame.sourceAt,partialStart:window.partialStart,partialEnd,results});window=null;
}
for(const f of data.frames){
 const segments=[];for(const e of f.events)segments.push(...market.apply(e));market.verify(f);
 if(window)for(const x of window.models)x.model.accrue(segments,market.source());
 const schedule=paperTradingWindow(f.observedAt,CAP_HOURS);
 if(!window&&schedule.allowed){
  window={startAt:f.sourceAt,excludedAt:schedule.excludedAt,partialStart:!last||equityHours(last.observedAt).allowed,
   models:profiles.flatMap(p=>plan.caps.flatMap(cap=>plan.rangePolicies.map(mode=>({profile:p.id,model:new OffHoursRecenter(BigInt(plan.budgetQuote),cap,p,mode,p.recenter)}))))};
 }
 if(window){
  const samples=f.allHealthIds.map(id=>health.get(id));assert(samples.every(Boolean));
  for(const x of window.models)x.model.decision(f,market.source(),samples);
  if(Date.parse(f.sourceAt)>=Date.parse(window.excludedAt)){
   const done=window.models.every(x=>!x.model.book.position||x.model.invalid),timedOut=Date.parse(f.sourceAt)>Date.parse(window.excludedAt)+1800000;
   if(done||timedOut){if(timedOut)for(const x of window.models)if(x.model.book.position)x.model.invalid??='scheduled_exit_unavailable';finish(f);}
  }
 }
 last=f;
}
if(window)finish(last,true);
const aggregates=[];
for(const profile of profiles)for(const cap of plan.caps)for(const rangePolicy of plan.rangePolicies){
 const rows=windows.map(w=>w.results.find(r=>r.profile===profile.id&&r.cap===cap&&r.rangePolicy===rangePolicy)),valid=rows.filter(r=>r.available);
 const sum=k=>valid.reduce((n,r)=>n+Number(r[k]),0);
 aggregates.push({profile:profile.id,cap,rangePolicy,windows:rows.length,available:valid.length,traded:valid.filter(r=>r.entries).length,
  meanPnl:valid.length?sum('pnl')/1e6/valid.length:null,meanAlpha:valid.length?sum('alpha')/1e6/valid.length:null,
  meanDeltaSameCap:valid.length?sum('deltaSameCap')/1e6/valid.length:null,
  worstDeltaSameCap:valid.length?Math.min(...valid.map(r=>Number(r.deltaSameCap)/1e6)):null,
  recenters:sum('recenters'),recenterSwaps:sum('recenterSwaps'),recenterGas:sum('recenterGas')/1e6,recenterTurnover:sum('recenterTurnover')/1e6,
  meanDeployedPercent:sum('holdingSeconds')?sum('deploymentPpmSeconds')/sum('holdingSeconds')/10000:null,
  meanDelta:valid.length?sum('delta')/1e6/valid.length:null,worstDelta:valid.length?Math.min(...valid.map(r=>Number(r.delta)/1e6)):null,
  worstPnl:valid.length?Math.min(...valid.map(r=>Number(r.pnl)/1e6)):null,maxDrawdown:valid.length?Math.max(...valid.map(r=>Number(r.maxDrawdown)/1e6)):null,
  entries:sum('entries'),exits:sum('exits'),gas:sum('gas')/1e6,fees:sum('fees')/1e6,
  inventoryExits:valid.flatMap(r=>r.actions).filter(a=>a.reason==='inventory_cap').length,
  scheduledExits:valid.flatMap(r=>r.actions).filter(a=>a.reason==='scheduled_cash_exit').length,
  holdingHours:sum('holdingSeconds')/3600,outsideHours:sum('outsideSeconds')/3600,lateExitSeconds:sum('lateExitSeconds')});
}
const out={computedAt:new Date().toISOString(),captureSha256:digest(raw),planSha256:digest(fs.readFileSync(planPath)),manifest:data.manifest,plan,windows,aggregates,
 method:{scope:'Independent allowed trading windows with common starting cash, compounding after each full cash exit and 600 second cooldown; 3 inventory caps crossed with 3 range policies; fixed 80 percent allocation setting and 20 raw tick half-width; hard exits take priority over range moves',
 recentering:'Center displacement of 10 ticks in a consistent direction across two distinct checkpoints and at least 60 seconds; 600 seconds since entry or last move. Recenter quote requires a later source, age at most 90 seconds, drift at most 5 ticks, frozen swap and mint minima, post-fill reference band and inventory cap. Hold policy never moves; preserve retains all tokens and can deploy less; net_swap executes a single net balancing trade for the new range. Recenter does not reset the session holding clock or benchmark.',
 timing:'Quote decisions use checkpoint capture plus 30 seconds and require a later source to fill; schedule uses New York calendar; no new entries within 30 minutes of exclusion and exits requested 10 minutes before',
 guards:'Canonical checkpoint and source reference gates, captured chain entry readiness, and 30-block bounded holding evaluated from stored raw health samples. Current-risk refresh timing is approximated by source reference eligibility; historical ETH gas-feed freshness is not proven.',
 costs:'Saved fork entry/exit estimates plus separately executed buy, sell, remove and mint evidence; the larger observed remove/mint components apply to both recenter modes. Costs reused across sizes and dates; 2x gas plus 50 percent modeled fees sensitivity. Hypothetical entry failures incur no transaction gas because checks precede mint; partial transaction failures are not modeled; a recenter fill is atomic in this model even though the fork proof uses sequential calls.',
 fees:'Canonical crossing-aware fee segments with added-liquidity dilution, retained Q128 remainder, and unchanged subsequent historical price path',
 benchmark:'One common initial acquired-token passive holding benchmark per window and profile, including buy gas. It remains invested after the LP exits; absolute cash Pnl is also reported.',
 exclusions:'Partial first/last windows and any paired window with missed holding decisions, unreconciled data or unresolved scheduled exit are unavailable for ranking. Full event coverage alone cannot prove missed decisions.',
 economicGate:'No forecast of future recenter fee benefit gates actions in this diagnostic. Report net cost drag and validate a candidate before designing or deploying such a forecast.',
 inference:'Retrospective correlated windows, no profitability or optimal-cap claim. Prospective validation remains a model on captured data, not actual simultaneous fork executions.'}};
const encoded=JSON.stringify(out,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';fs.writeFileSync(output,encoded,{flag:'wx'});fs.writeFileSync(output+'.sha256',digest(encoded)+'\n',{flag:'wx'});
console.log(JSON.stringify({windows:windows.length,aggregates,unavailable:windows.map(w=>({start:w.startAt,partialStart:w.partialStart,partialEnd:w.partialEnd,reasons:[...new Set(w.results.map(r=>r.invalid).filter(Boolean))]}))},null,2));
