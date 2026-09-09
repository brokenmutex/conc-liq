import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {ExperimentPortfolio} from '../src/experiment/portfolio.ts';
import {positionAmounts} from '../src/research/portfolio-math.ts';
import {referenceExposure} from '../src/research/management-audit.ts';
import {sqrtRatioAtTick} from '../src/backtest/principal.ts';

const [paperPath,marketPath,output]=process.argv.slice(2);
assert(paperPath&&marketPath&&output,'Usage: node --import tsx scripts/management-counterfactual-audit.mjs PAPER_SOURCE MARKET_SOURCE OUTPUT');
const hash=x=>createHash('sha256').update(x).digest('hex');
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
function read(path){const raw=fs.readFileSync(path,'utf8');assert.equal(hash(raw),fs.readFileSync(path+'.sha256','utf8').trim());return JSON.parse(raw);}
const paper=read(paperPath),data=read(marketPath),Q128=1n<<128n;
assert.equal(data.manifest.paperSha256,fs.readFileSync(paperPath+'.sha256','utf8').trim());
const sessions=paper.sessions.filter(s=>paper.selectedIds.includes(s.id));
const obs=new Map(sessions.map(s=>[s.id,paper.observations.filter(o=>o.session_id===s.id)]));
const byCp=new Map();for(const o of paper.observations)byCp.set(o.checkpoint_id,o);
const market=new ExperimentMarket(data.seed),seeds=new Map(),segments=new Map(),frames=new Map();
for(const f of data.frames){const ss=[];for(const e of f.events)ss.push(...market.apply(e));market.verify(f);seeds.set(f.id,market.seed());segments.set(f.id,ss);frames.set(f.id,f);}
const run=(s,action)=>paper.executions.find(x=>x.session_id===s.id&&x.action===action&&x.status==='succeeded');
function group(s,signal){
 const reasons=signal.state.reasons;
 if(reasons.includes('paper_inventory_threshold_exit_to_cash'))return 'inventory';
 if(reasons.some(r=>r.startsWith('chain_')))return 'infrastructure';
 if(reasons.length)return 'reference_or_risk';
 // Corroborated by the repo's recorded reliability deployment, not inferred
 // from empty reasons for arbitrary sessions.
 if(s.id==='27'&&signal.state.pendingSince==='2026-09-09T08:13:10.896Z')return 'operator_upgrade';
 return 'unclassified';
}
function recordedFrame(f,o){
 const reasons=o.entry_reasons;
 return {...f,observedAt:new Date(o.observed_at).toISOString(),referencePrice:o.state.reference?.referencePriceX18??f.referencePrice,
  referenceEligible:o.state.reference?.eligible===true&&!reasons.some(r=>!r.startsWith('chain_')&&r!=='source_ahead_of_confirmed_quorum'),
  chainHealthy:!reasons.some(r=>r.startsWith('chain_')),reasons};
}
const buffer=[],cases=[],counts={};
for(const s of sessions){
 const os=obs.get(s.id),entry=os.find(o=>o.action==='enter');if(!entry)continue;
 const ep=entry.state.position,ref=BigInt(entry.state.reference.referencePriceX18);
 const exposureAt=tick=>{
  const amounts=positionAmounts(sqrtRatioAtTick(tick),ep,BigInt(ep.liquidity),false);
  return referenceExposure(amounts.amount0+BigInt(ep.idle0),amounts.amount1+BigInt(ep.idle1),ref,BigInt(entry.state.costsPaidQuote)+BigInt(entry.state.exitReserveQuote));
 };
 let firstGuard=null;
 for(let tick=entry.state.last.tick;tick<=ep.tickUpper;tick++)if(exposureAt(tick)>=600000n){firstGuard=tick;break;}
 const signal=os.find(o=>o.action==='signal_exit');
 const row={session:s.id,entryTick:entry.state.last.tick,lower:ep.tickLower,upper:ep.tickUpper,lowerExposurePpm:exposureAt(ep.tickLower),upperExposurePpm:exposureAt(ep.tickUpper),
  firstGuardTickAtEntryReference:firstGuard,ticksFromEntryToGuard:firstGuard===null?null:firstGuard-entry.state.last.tick,
  guardBeforeRiskyBoundary:firstGuard!==null&&firstGuard<ep.tickUpper,
  assumption:'Entry inventory, reference, gas and reserve held fixed; integer tick sensitivity, not a future price forecast'};
 if(signal){row.exitGroup=group(s,signal);row.signalTick=signal.state.last.tick;row.signalInside=signal.state.last.tick>=ep.tickLower&&signal.state.last.tick<ep.tickUpper;counts[row.exitGroup]=(counts[row.exitGroup]??0)+1;}
 buffer.push(row);
 if(!signal||row.exitGroup==='operator_upgrade')continue;
 const before=os.filter(o=>BigInt(o.id)<BigInt(signal.id));
 const anchor=before.findLast(o=>o.state.status==='open'&&o.state.reference?.eligible===true&&o.entry_reasons.length===0);
 if(!anchor){cases.push({session:s.id,exitGroup:row.exitGroup,unavailable:'no_prior_eligible_open_observation'});continue;}
 const f0=recordedFrame(frames.get(anchor.checkpoint_id),anchor),endAt=Date.parse(f0.sourceAt)+1800000;
 const subsequent=data.frames.filter(f=>BigInt(f.block)>BigInt(f0.block));
 const end=subsequent.findIndex(f=>Date.parse(f.sourceAt)>=endAt);
 if(end<0){cases.push({session:s.id,exitGroup:row.exitGroup,unavailable:'30_minute_horizon_not_complete'});continue;}
 const path=subsequent.slice(0,end+1),m0=new ExperimentMarket(seeds.get(f0.id)).source();
 const branches=[];
 for(const multiplier of [1,2])for(const action of ['wait','recenter','exit']){
  const candidate={id:`${s.id}-${action}-${multiplier}`,budget:s.policy.budgetQuote,halfWidthTicks:20,management:'exit_reentry',costMultiplier:multiplier,feeIncomePpm:1000000,
   entryQuality:{maxQuoteAgeSeconds:90,maxTickDrift:5,minAllocationPpm:720000,maxRoundTripGasQuote:'1250000',costBasis:'frozen_scenario'}};
  const p=new ExperimentPortfolio(candidate,data.costEvidence.costs),st=anchor.state,ap=st.position;
  p.s.cash=BigInt(ap.idle0)-BigInt(st.costsPaidQuote);p.s.rwa=BigInt(ap.idle1);assert(p.s.cash>=0n);
  p.s.position={tickLower:ap.tickLower,tickUpper:ap.tickUpper,liquidity:BigInt(ap.liquidity),fee0:BigInt(ap.fee0)*Q128+BigInt(ap.feeRemainder0??'0'),fee1:BigInt(ap.fee1)*Q128+BigInt(ap.feeRemainder1??'0'),
   enteredAt:Date.parse(ap.enteredAt),center:BigInt(run(s,'entry').snapshot.result.entrySwap.sqrtPriceAfter)};
  p.s.lastAt=Date.parse(f0.observedAt);p.s.lastBlock=f0.block;p.s.lastTarget=f0.targetSetHash;p.s.lastMove=Date.parse(entry.observed_at);
  const initial=p.balances(m0);p.s.benchmark={cash:initial.amount0,rwa:initial.amount1,filled:true,after:null,minimum:0n};p.s.hold0=initial.amount0;p.s.hold1=initial.amount1;
  const start=p.summary(f0,m0);p.s.peak=BigInt(start.nav);
  let initialBlock=null;
  if(action==='exit')p.s.pending={kind:'exit',after:Date.parse(f0.observedAt),range:null,token:null,amount:0n,minimum:0n,reason:'diagnostic_exit',target:0n};
  if(action==='recenter'){
   if(Date.parse(f0.observedAt)-p.s.lastMove<600000)initialBlock='recenter_cooldown';
   else if(referenceExposure(initial.amount0,initial.amount1,BigInt(f0.referencePrice),BigInt(start.exitReserve))>=600000n)initialBlock='inventory';
   else{
    // Research-only call to the pinned model's quote path; this script never
    // imports the runtime store, signs, broadcasts or writes paper state.
    p.quote(f0,m0,'recenter','diagnostic_recenter');
    if(!p.s.pending)initialBlock='quote_rejected';
   }
  }
  const marks=[];let decisionObservations=0,accountingOnly=0;
  for(const frame of path){
   for(const {segment,protocol} of segments.get(frame.id))p.accrue(segment,protocol);
   const m=new ExperimentMarket(seeds.get(frame.id)).source(),o=byCp.get(frame.id),f=o?recordedFrame(frame,o):frame;
   // Cash remains cash: isolate one intervention and subsequent mandatory exits.
   // Frames without a recorded paper decision accrue fees but cannot authorize orders.
   if(o){decisionObservations++;if(p.s.position||p.s.pending||p.s.rwa>0n)p.decision(f,m);}
   else accountingOnly++;
   const r=p.summary(f,m);
   marks.push({checkpoint:frame.id,sourceAt:frame.sourceAt,nav:r.nav,liquidationNav:r.liquidationNav,alpha:r.liquidationAlphaVsHolding,exposurePpm:r.maxExposurePpm});
  }
  const last=path.at(-1),o=byCp.get(last.id),f=o?recordedFrame(last,o):last,final=p.summary(f,new ExperimentMarket(seeds.get(last.id)).source());
  branches.push({action,costMultiplier:multiplier,initialBlock,startNav:start.nav,final,actions:p.actions,decisionObservations,accountingOnly,marks});
 }
 const paired=[1,2].map(multiplier=>{
  const b=branches.filter(b=>b.costMultiplier===multiplier),wait=b.find(b=>b.action==='wait'),recenter=b.find(b=>b.action==='recenter'),exit=b.find(b=>b.action==='exit');
  const complete=b.every(b=>b.final.liquidationNav!==null&&!b.final.invalid);
  return {costMultiplier:multiplier,complete,recenterExecuted:recenter.final.recenters>0,exitExecuted:exit.final.exits>0,
   recenterMinusWait:complete?String(BigInt(recenter.final.liquidationNav)-BigInt(wait.final.liquidationNav)):null,
   exitMinusWait:complete?String(BigInt(exit.final.liquidationNav)-BigInt(wait.final.liquidationNav)):null};
 });
 cases.push({session:s.id,runtimeBuild:s.runtime_identity.buildId,exitGroup:row.exitGroup,signalObservation:signal.id,anchorObservation:anchor.id,anchorSourceAt:f0.sourceAt,anchorObservedAt:f0.observedAt,
  anchorBeforeSignalSeconds:(Date.parse(signal.observed_at)-Date.parse(anchor.observed_at))/1000,horizonSourceAt:path.at(-1).sourceAt,paired,branches});
}
const summary=[1,2].map(costMultiplier=>{
 const selected=cases.filter(c=>c.paired?.find(p=>p.costMultiplier===costMultiplier&&p.complete));
 const pairs=selected.map(c=>c.paired.find(p=>p.costMultiplier===costMultiplier));
 const executed=pairs.filter(p=>p.recenterExecuted);
 const median=values=>{if(!values.length)return null;const a=values.map(BigInt).sort((x,y)=>x<y?-1:x>y?1:0);return a[Math.floor(a.length/2)];};
 return {costMultiplier,completeCases:pairs.length,recenterExecuted:executed.length,recenterPositive:executed.filter(p=>BigInt(p.recenterMinusWait)>0n).length,
  recenterMedianDeltaExecuted:median(executed.map(p=>p.recenterMinusWait)),exitMedianDelta:median(pairs.map(p=>p.exitMinusWait)),
  latestRuntimeCases:selected.filter(c=>c.runtimeBuild===sessions.at(-1).runtime_identity.buildId).map(c=>({session:c.session,pair:c.paired.find(p=>p.costMultiplier===costMultiplier)}))};
});
const result={asOf:paper.asOf,source:{paperSha256:data.manifest.paperSha256,marketSha256:fs.readFileSync(marketPath+'.sha256','utf8').trim()},
 design:{scope:'Retrospective diagnostic; no strategy selected or deployed',anchors:'Last recorded eligible open observation before each first exit signal; excludes the documented operator upgrade',horizonMinutes:30,
  actions:'Wait; one attempted recenter at existing width; exit to cash. All retain mandatory guards and delayed execution. No subsequent entry or routine recenter.',
  costs:data.costEvidence,feeModel:'Already earned paper fees retained; future fees use existing modeled added-liquidity dilution',
  gateBoundary:'Recorded paper decision gates, with inventory recomputed per branch. No orders on frames without observations. Historical current-risk evidence was not immutable before the reliability release.',
  recenterConstraints:'Existing model preview, 90-second quote age, five-tick drift, 72% minimum placement, ten-minute cooldown and 60% inventory priority',
  limitations:['Anchors are selected retrospectively before known exits; this is neither a deployable rule nor an untouched performance test','Overlapping 30-minute windows and common market exposure are correlated; do not sum their deltas into campaign profits',
   'Only future action costs are doubled in the stress scenario; accrued fees and sunk entry costs remain fixed','Frozen scenario costs are not fresh quotes; counterfactual cash and fees are modeled, not fork-reproduced',
   'Operational gates are held as recorded; this does not establish which past infrastructure exits were avoidable','A rejected recenter follows guarded waiting; report executed and unexecuted intentions separately']},
 exitCounts:counts,buffer,summary,cases};
fs.writeFileSync(output,json(result),{flag:'wx'});
console.log(json({exitCounts:counts,buffer:{sessions:buffer.length,guardBeforeRiskyBoundary:buffer.filter(b=>b.guardBeforeRiskyBoundary).length,inventorySignalsInside:buffer.filter(b=>b.exitGroup==='inventory'&&b.signalInside).length},summary}));
