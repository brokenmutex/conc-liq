import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {loadDataset} from '../src/experiment/runner.ts';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {ExperimentPortfolio} from '../src/experiment/portfolio.ts';

const [input,output,selectionPath]=process.argv.slice(2);
assert(input&&output&&selectionPath,'Usage: lp-recenter-calibrate.mjs DATASET REPORT SELECTION');
const data=await loadDataset(input);
const quality={maxQuoteAgeSeconds:90,maxTickDrift:5,minAllocationPpm:720000,maxRoundTripGasQuote:'1250000',costBasis:'frozen_scenario'};
const rules=[{distancePercent:40,persistence:1},{distancePercent:40,persistence:2},{distancePercent:50,persistence:1},{distancePercent:50,persistence:2}];
const make=(width,rule)=>({id:`1000-${width}-${rule?`recenter-${rule.distancePercent}-${rule.persistence}`:'exit_reentry'}`,budget:'1000000000',halfWidthTicks:width,
 management:rule?'recenter':'exit_reentry',costMultiplier:1,feeIncomePpm:1000000,entryQuality:quality,...(rule?{recenterRule:rule}:{})});
const base=[20,30].flatMap(w=>[make(w),...rules.map(r=>make(w,r))]);
const market=new ExperimentMarket(data.seed),windows=[];let activeKey='',portfolios=[],last;
const complete=()=>{if(last&&portfolios.length)windows.push({key:activeKey,through:last.sourceAt,results:portfolios.map(p=>{
 const s=p.summary(last,market.source());return {candidate:s.candidate.id,costMultiplier:s.candidate.costMultiplier,invalid:s.invalid,pnl:s.pnl,alpha:s.commonAlpha,
 entries:s.entries,recenters:s.recenters,exits:s.exits,costs:s.costs,fees:s.feesQuote,observations:s.observations,activeSeconds:s.activeSeconds,
 maxExposurePpm:s.maxExposurePpm,drawdownPpm:s.drawdownPpm,blocked:s.blocked};})});};
for(const f of data.frames){
 const key=new Date(Math.floor(Date.parse(f.sourceAt)/21600000)*21600000).toISOString();
 if(key!==activeKey){complete();activeKey=key;portfolios=base.flatMap(c=>[c,{...c,costMultiplier:2,feeIncomePpm:500000}]).map(c=>new ExperimentPortfolio(c,data.costEvidence.costs));}
 for(const e of f.events)for(const {segment,protocol} of market.apply(e))for(const p of portfolios)p.accrue(segment,protocol);
 market.verify(f);for(const p of portfolios)p.decision(f,market.source());last=f;
}
complete();
const split=Math.max(1,Math.floor(windows.length*0.65));
const valid=r=>r&&!r.invalid&&r.alpha!==null&&r.entries>0&&r.observations>=30&&r.activeSeconds>=1800;
const median=xs=>{const v=[...xs].sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:null;};
function metrics(rule,ws,multiplier=1){
 const pairs=[];let recenters=0,invalid=0,noEntry=0;
 for(const w of ws)for(const width of [20,30]){
  const fixed=w.results.find(r=>r.candidate===make(width).id&&r.costMultiplier===multiplier);
  const active=w.results.find(r=>r.candidate===make(width,rule).id&&r.costMultiplier===multiplier);
  recenters+=active.recenters;if(active.invalid)invalid++;if(!active.entries)noEntry++;
  if(valid(fixed)&&valid(active))pairs.push({window:w.key,width,deltaAlphaRaw:String(BigInt(active.alpha)-BigInt(fixed.alpha)),activeAlphaRaw:active.alpha,recenters:active.recenters});
 }
 return {pairedWindows:pairs.length,medianDeltaAlphaRaw:median(pairs.map(p=>Number(p.deltaAlphaRaw))),medianActiveAlphaRaw:median(pairs.map(p=>Number(p.activeAlphaRaw))),recenters,invalidCells:invalid,noEntryCells:noEntry,pairs};
}
const scores=rules.map(rule=>({rule,development:metrics(rule,windows.slice(0,split)),validation:metrics(rule,windows.slice(split)),stressValidation:metrics(rule,windows.slice(split),2)}));
const eligible=scores.filter(s=>s.development.pairedWindows>=2&&s.development.recenters>0)
 .sort((a,b)=>b.development.medianDeltaAlphaRaw-a.development.medianDeltaAlphaRaw||a.rule.persistence-b.rule.persistence||a.rule.distancePercent-b.rule.distancePercent);
assert(eligible.length,'No exercised development candidate; do not select an untested recenter rule');
const chosen=eligible[0],selected=[make(20),make(30),make(20,chosen.rule),make(30,chosen.rule)];
const codeSha256=Object.fromEntries(['scripts/lp-recenter-calibrate.mjs','src/experiment/portfolio.ts','src/experiment/market.ts','src/paper/engine.ts','src/research/portfolio-math.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
const report={computedAt:new Date().toISOString(),evidenceClass:'development_calibration_for_prospective_learning',executionEligible:false,
 source:input,sourceSha256:readFileSync(input+'.sha256','utf8').trim(),codeSha256,
 split:{development:windows.slice(0,split).map(w=>w.key),validation:windows.slice(split).map(w=>w.key)},scores,selected,windows,
 limitations:['Historical checkpoint-only reference gating and capture-plus-30-second clock; current-risk refresh admissibility is not reconstructed',
 'Frozen fork gas scenarios, not fresh action-specific quotes; the 1.25 USDG cap is a scenario cap, not the proposed fresh rolling gas gate',
 'Six-hour windows reset candidate capital and are correlated; statistics are not campaign PnL or proof of an optimum',
 'Selection uses development paired alpha deltas only; validation and future observations must be reported even if negative']};
const selection={createdAt:report.computedAt,selected,costEvidence:data.costEvidence,sourceSha256:report.sourceSha256,codeSha256,
 selectionRule:'Best median development alpha delta versus the same-width fixed control among exercised 40/50 percent, one/two observation rules; common rule at both widths; prospective learning only',
 review:{reliabilityHours:24,economicsHours:72,minOvernightWindows:2,minRecentersPerActiveCandidate:10,weekendStillRequired:true},
 missingFreshCostGate:true,executionEligible:false};
for(const [path,value] of [[output,report],[selectionPath,selection]]){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify({windows:windows.length,chosen:chosen.rule,scores,selected},null,2));
