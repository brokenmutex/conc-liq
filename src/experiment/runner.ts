import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,writeFile,mkdir,rename,access,link,unlink } from 'node:fs/promises';
import { assertRuntimeMatches } from '../runtime/identity.js';
import type { RuntimeIdentity } from '../runtime/identity.js';
import { dirname } from 'node:path';
import { ExperimentSource } from './source.js';
import { ExperimentMarket,type ExperimentFrame,type MarketSeed } from './market.js';
import { ExperimentPortfolio,type Candidate,type ExperimentCosts,type PortfolioState } from './portfolio.js';
export const json=(x:unknown)=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?{bigint:String(v)}:v,2)+'\n';
export const parse=(x:string)=>JSON.parse(x,(_,v)=>v&&typeof v==='object'&&Object.keys(v).length===1&&typeof v.bigint==='string'?BigInt(v.bigint):v);
export const digest=(x:string)=>createHash('sha256').update(x).digest('hex');
export async function atomic(path:string,value:unknown){await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',json(value));await rename(path+'.tmp',path);}
export function candidates():Candidate[]{const out:Candidate[]=[];for(const budget of ['250000000','1000000000'])for(const width of [10,20,30,40,50])for(const management of ['exit_reentry','recenter'] as const)out.push({id:`${Number(budget)/1e6}-${width}-${management}`,budget,halfWidthTicks:width,management,costMultiplier:1,feeIncomePpm:1000000});return out;}
export interface Dataset {manifest:Record<string,unknown>;seed:MarketSeed;frames:ExperimentFrame[];costEvidence:Awaited<ReturnType<ExperimentSource['costs']>>}
export async function capture(source:ExperimentSource,from:string,to:string,path:string){
 const rows=await source.checkpoints(from,to);assert(rows.length>=2,'Insufficient checkpoint window');
 await source.coverage(rows.at(-1).block,rows.at(-1).target_set_hash);
 const seed=await source.seed(rows[0]),health=await source.health(rows[0].observed_at,new Date(new Date(rows.at(-1).observed_at).getTime()+30000).toISOString()),events=await source.events(rows[0].block,rows.at(-1).block),costEvidence=await source.costs();
 let index=0;const frames:ExperimentFrame[]=[];
 for(const row of rows){const assigned=[];while(index<events.length&&BigInt(events[index]!.block)<=BigInt(row.block))assigned.push(events[index++]!);frames.push(source.frame(row,health,assigned));}
 assert(index===events.length);assert(await source.historyValid(rows.map(r=>r.id)),'Capture canonicality changed');
 const data:Dataset={manifest:{version:1,capturedAt:new Date().toISOString(),requestedFrom:from,requestedTo:to,source:'read_only_postgresql',executionEligible:false,candidates:candidates(),costScenarios:['fork_estimate_1x_full_fees','fork_estimate_2x_half_fees'],referencePolicy:'same_continuous_bounded_v1_as_paper',accounting:'Cash funded; acquired-inventory passive baseline; pool-spot NAV and independent-reference NAV; all modeled operation costs debited',limitation:'Observed market path, hypothetical fee dilution, frozen fork costs; timing uses checkpoint capture plus a frozen 30-second decision delay rather than actual worker invocation; not transaction-faithful paper execution'},seed,frames,costEvidence};
 await mkdir(dirname(path),{recursive:true});const text=json(data);await writeFile(path,text,{flag:'wx'});await writeFile(path+'.sha256',digest(text)+'\n',{flag:'wx'});
 return {path,checkpoints:frames.length,events:events.length,from:frames[0]!.sourceAt,to:frames.at(-1)!.sourceAt,validFrames:frames.filter(f=>f.dataValid).length,referenceEligible:frames.filter(f=>f.referenceEligible).length,healthy:frames.filter(f=>f.chainHealthy).length};
}
export async function loadDataset(path:string):Promise<Dataset>{const text=await readFile(path,'utf8');assert.equal(digest(text),(await readFile(path+'.sha256','utf8')).trim());return parse(text);}
export async function screen(data:Dataset,path:string){
 const codeSha256:Record<string,string>={};for(const file of ['src/experiment/runner.ts','src/experiment/market.ts','src/experiment/portfolio.ts','src/experiment/source.ts','src/research/swap.ts','src/research/portfolio-math.ts','src/paper/engine.ts','src/paper/reference.ts','src/canary-plan/entry-readiness.ts','src/backtest/principal.ts','src/simulator/math.ts'])codeSha256[file]=digest(await readFile(file,'utf8'));
 const market=new ExperimentMarket(data.seed),base=candidates();let portfolios:ExperimentPortfolio[]=[];let activeKey='';let windowStart='';let last:ExperimentFrame|undefined;const windows:any[]=[];
 const complete=()=>{if(last&&portfolios.length)windows.push({key:activeKey,from:windowStart,through:last.sourceAt,results:portfolios.map(p=>p.summary(last!,market.source()))});};
 for(const frame of data.frames){
  const key=new Date(Math.floor(Date.parse(frame.sourceAt)/21600000)*21600000).toISOString();
  // Score independent six-hour blocks; market reconstruction remains continuous.
  if(key!==activeKey){complete();activeKey=key;windowStart=frame.sourceAt;portfolios=base.flatMap(c=>[c,{...c,costMultiplier:2,feeIncomePpm:500000}]).map(c=>new ExperimentPortfolio(c,data.costEvidence.costs));}
  for(const e of frame.events)for(const {segment,protocol} of market.apply(e))if(last&&key===new Date(Math.floor(Date.parse(last.sourceAt)/21600000)*21600000).toISOString())for(const p of portfolios)p.accrue(segment,protocol);
  market.verify(frame);
  for(const p of portfolios)p.decision(frame,market.source());last=frame;
 }
 complete();
 const split=Math.max(1,Math.floor(windows.length*0.65));
 const scores=base.map(candidate=>{
  const metrics=(ws:any[],stress:boolean)=>{
   const cells=ws.map(w=>w.results.find((r:any)=>r.candidate.id===candidate.id&&r.candidate.costMultiplier===(stress?2:1)));
   const valid=cells.filter((r:any)=>!r.invalid&&r.entries>0&&r.observations>=30&&r.activeSeconds+r.outsideSeconds>=1800&&r.commonAlphaPpm!==null);
   const values=valid.map((r:any)=>Number(r.commonAlphaPpm)).sort((a:number,b:number)=>a-b);
   return {windows:cells.length,valid:valid.length,medianAlphaPpm:values.length?values[Math.floor(values.length/2)]:null,worstAlphaPpm:values[0]??null,positive:values.filter((v:number)=>v>0).length,
    maxDrawdownPpm:valid.length?Math.max(...valid.map((r:any)=>Number(r.drawdownPpm))):null,entries:cells.reduce((n:number,r:any)=>n+r.entries,0),infrastructureExits:cells.reduce((n:number,r:any)=>n+r.infrastructureExits,0)};
  };
  return {candidate,development:metrics(windows.slice(0,split),false),validation:metrics(windows.slice(split),false),stressValidation:metrics(windows.slice(split),true)};
 });
 // Shortlist is a learning allocation, never a claim of an optimal or profitable policy.
 const eligible=scores.filter(r=>r.development.valid>=2&&r.validation.valid>=1&&r.stressValidation.valid>=1).sort((a,b)=>(b.stressValidation.medianAlphaPpm??-Infinity)-(a.stressValidation.medianAlphaPpm??-Infinity));
 const selected:Candidate[]=[];
 const strongest=eligible.find(r=>r.candidate.budget==='1000000000'&&r.candidate.management==='exit_reentry'&&r.candidate.halfWidthTicks!==20);
 const ids=strongest?['1000-20-exit_reentry',strongest.candidate.id,`250-${strongest.candidate.halfWidthTicks}-exit_reentry`,'1000-20-recenter']:[];
 for(const id of ids){const row=eligible.find(r=>r.candidate.id===id);if(row)selected.push(row.candidate);}
 const result={computedAt:new Date().toISOString(),evidenceClass:'exploratory_historical_screen',executionEligible:false,codeSha256,sourceManifest:data.manifest,sourceSha256:digest(json(data)),costEvidence:data.costEvidence,
  split:{development:windows.slice(0,split).map(w=>w.key),validation:windows.slice(split).map(w=>w.key),note:'Chronological six-hour blocks are correlated; this is not multiple independent weekends. Finalists use validation data, so future forward comparison is the untouched evaluation.'},
  selectionRule:'Qualify on at least two development blocks and one validation block under both scenarios, with 30 observations and 30 minutes invested. Select current 1000/20 fixed control, strongest conservative 1000 fixed alternative width, its 250 counterpart, and 1000/20 recenter. This paired design isolates width, size and management. Scores use a shared cash-funded 40-percent NVDA passive benchmark acquired after a delayed quote, independent of candidate range.',
  scores,selected,windows};
 await writeFile(path,json(result),{flag:'wx'});return result;
}
export interface LiveState {
 version:2;createdAt:string;planHash:string;runtime:RuntimeIdentity;costs:ExperimentCosts;candidates:Candidate[];
 seed:MarketSeed;lastFrame:ExperimentFrame;sourceIds:string[];states:PortfolioState[];actions:Record<string,unknown>[];
 status:'running'|'paused_data'|'invalid';reason?:string;lastPollAt:string;lastDecisionSourceAt:string;pausedSince:string|null;pausedSeconds:number;
 pauseCount:number;missedDecisions:number;decisionCount:number;
 observations:{checkpointId:string;sourceAt:string;observedAt:string;decisionMade:boolean;
  referenceEvidence?:ExperimentFrame['referenceEvidence'];healthSampleIds?:readonly string[]}[];
}
export async function startForward(source:ExperimentSource,selected:Candidate[],costs:ExperimentCosts,runtime:RuntimeIdentity|undefined,path:string){
 assertRuntimeMatches(runtime??null,runtime);
 assert.equal(JSON.stringify((await source.costs()).costs),JSON.stringify(costs),'Frozen cost evidence changed');
 assert(selected.length>=2&&selected.length<=4,'Forward comparison needs two to four eligible candidates');
 const now=new Date().toISOString(),rows=await source.checkpoints(new Date(Date.now()-180000).toISOString(),now),row=rows.at(-1);assert(row,'Fresh checkpoint unavailable');await source.coverage(row.block,row.target_set_hash);
 const seed=await source.seed(row),frame=await source.liveFrame(row,[]);assert(frame.dataValid);
 const portfolios=selected.map(c=>new ExperimentPortfolio(c,costs));
 const createdAt=new Date().toISOString();
 const state:LiveState={version:2,createdAt,planHash:digest(JSON.stringify({selected,costs})),runtime:runtime!,costs,candidates:selected,
  seed,lastFrame:{...frame,events:[]},sourceIds:[frame.id],states:portfolios.map(p=>p.s),actions:[],status:'running',
  lastPollAt:createdAt,lastDecisionSourceAt:frame.sourceAt,pausedSince:null,pausedSeconds:0,pauseCount:0,missedDecisions:0,decisionCount:0,observations:[]};
 await mkdir(dirname(path),{recursive:true});await writeFile(path,json(state),{flag:'wx'});await persistForward(path,state);return state;
}
function pauseForward(state:LiveState,reason:string){
 if(state.pausedSince===null){state.pausedSince=new Date().toISOString();state.pauseCount++;}
 state.status='paused_data';state.reason=reason;
}
function resumeForward(state:LiveState){
 if(state.pausedSince!==null){state.pausedSeconds+=(Date.now()-Date.parse(state.pausedSince))/1000;state.pausedSince=null;}
 state.status='running';delete state.reason;
}
function referenceSources(state:LiveState){
 const sources=new Map<string,{id:string;block:string;hash:string}>();
 for(const o of state.observations){const e=o.referenceEvidence?.current,s=e?.selected;
  if(e?.failedChecks.length===0&&s?.riskRunId&&s.blockNumber&&s.blockHash)sources.set(s.riskRunId,{id:s.riskRunId,block:s.blockNumber,hash:s.blockHash});
 }
 return [...sources.values()];
}
export async function tickForward(source:ExperimentSource,path:string,runtime:RuntimeIdentity|undefined){
 const state:LiveState=parse(await readFile(path,'utf8'));assertRuntimeMatches(state.runtime,runtime);assert.equal(state.planHash,digest(JSON.stringify({selected:state.candidates,costs:state.costs})),'Experiment plan changed');if(state.status==='invalid')return state;
 assert.equal(state.version,2,'Start a new comparison version; old cohorts cannot be relabelled');
 const invalid=async(reason:string)=>{state.status='invalid';state.reason=reason;await persistForward(path,state);return state;};
 try{assert.equal(JSON.stringify((await source.costs()).costs),JSON.stringify(state.costs));}catch{return invalid('cost_evidence_invalid');}
 if(!(await source.historyValid(state.sourceIds,referenceSources(state))))return invalid('prior_source_revoked');
 const age=Date.now()-Date.parse(state.lastFrame.sourceAt);
 if(age>900000||Date.now()-Date.parse(state.lastDecisionSourceAt)>900000)return invalid('forward_blackout_exceeds_900_seconds');
 if(age>180000)pauseForward(state,'forward_source_unavailable');
 const rows=(await source.checkpoints(state.lastFrame.sourceAt,new Date().toISOString())).filter(r=>BigInt(r.block)>BigInt(state.lastFrame.block));
 if(!rows.length){await persistForward(path,state);return state;}
 const market=new ExperimentMarket(state.seed),portfolios=state.candidates.map((c,i)=>new ExperimentPortfolio(c,state.costs,parse(json(state.states[i]))));
 for(const row of rows){
  if(Date.now()<new Date(row.observed_at).getTime()+30000)break;
  if(row.target_set_hash!==state.lastFrame.targetSetHash)return invalid('forward_target_changed');
  if(new Date(row.source_at).getTime()-Date.parse(state.lastFrame.sourceAt)>900000)return invalid('forward_accounting_gap_exceeds_900_seconds');
  try{await source.coverage(row.block,row.target_set_hash);}catch{break;}
  const stale=Date.now()-new Date(row.source_at).getTime()>180000;
  const events=await source.events(state.lastFrame.block,row.block);
  // Old frames prove accounting only. Fresh decisions use the actual worker clock and current risk gate.
  const frame=stale?{...source.frame(row,[],events,new Date().toISOString()),decisionMode:'accounting_only' as const}:await source.liveFrame(row,events);
  if(!frame.dataValid)return invalid('forward_source_identity_unproven');
  if(!stale&&frame.reasons.includes('source_ahead_of_confirmed_quorum'))break;
  const actionable=!stale&&Date.now()-Date.parse(frame.sourceAt)<=180000&&Date.parse(frame.sourceAt)>=Date.parse(state.createdAt);
  try{
   for(const e of events)for(const {segment,protocol} of market.apply(e))for(const p of portfolios)p.accrue(segment,protocol);
   market.verify(frame);
   if(!actionable){pauseForward(state,'missed_forward_decision');for(const p of portfolios)p.observeWithoutDecision(frame,market.source());state.missedDecisions++;}
   else{
    if(state.status==='paused_data')for(const p of portfolios)p.expireEntryIntents(frame);
    for(const p of portfolios)p.decision(frame,market.source());state.decisionCount++;state.lastDecisionSourceAt=frame.sourceAt;resumeForward(state);
   }
  }catch{return invalid('forward_market_or_accounting_reconstruction_failed');}
  // Copy the accepted ledger so a later failed reconstruction cannot alter it.
  state.lastFrame={...frame,events:[]};state.sourceIds.push(frame.id);state.seed=market.seed();state.states=parse(json(portfolios.map(p=>p.s)));
  state.observations.push({checkpointId:frame.id,sourceAt:frame.sourceAt,observedAt:frame.observedAt,decisionMade:actionable,
   referenceEvidence:frame.referenceEvidence,healthSampleIds:frame.healthSampleIds});
  state.actions.push(...portfolios.flatMap(p=>p.actions.splice(0).map(a=>({candidate:p.candidate.id,...a}))));
  if(portfolios.some(p=>p.s.invalid))return invalid('forward_candidate_accounting_invalid');
 }
 if(!(await source.historyValid(state.sourceIds,referenceSources(state))))return invalid('source_revoked_during_tick');
 await persistForward(path,state);
 return state;
}

async function persistForward(path:string,state:LiveState){
 state.lastPollAt=new Date().toISOString();await atomic(path,state);
 const market=new ExperimentMarket(state.seed),elapsed=(Date.now()-Date.parse(state.createdAt))/1000;
 const pausedSeconds=state.pausedSeconds+(state.pausedSince?(Date.now()-Date.parse(state.pausedSince))/1000:0);
 const candidates=state.status==='invalid'?[]:state.candidates.map((c,i)=>new ExperimentPortfolio(c,state.costs,state.states[i]).summary(state.lastFrame,market.source()));
 const report={observedAt:state.lastPollAt,createdAt:state.createdAt,status:state.status,reason:state.reason,sourceAt:state.lastFrame.sourceAt,
  markFresh:state.status==='running'&&Date.now()-Date.parse(state.lastFrame.sourceAt)<=180000,
  candidates,executionEligible:false,decisionClock:'actual_worker_with_current_reference_gate',
  nextReviewAt:elapsed<86400?new Date(Date.parse(state.createdAt)+86400000).toISOString():elapsed<259200?new Date(Date.parse(state.createdAt)+259200000).toISOString():null,
  quality:{pausedSeconds,pauseCount:state.pauseCount,missedDecisions:state.missedDecisions,decisions:state.decisionCount,
   availableTimePpm:elapsed>0?Math.max(0,Math.floor((elapsed-pausedSeconds)*1000000/elapsed)):1000000,
   note:'Poll-observed data pauses and skipped checkpoint decisions; heartbeat gaps must also be reviewed'}};
 await atomic(path+'.status.json',report);await writeFile(path+'.status.md',statusMarkdown(report));
 // Freeze review evidence locally. This sends no messages and never retunes a candidate.
 for(const hours of [24,72])if(elapsed>=hours*3600){
  const reviewPath=`${path}.review-${hours}h.json`;
  try{await access(reviewPath);continue;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const review={hours,scheduledAt:new Date(Date.parse(state.createdAt)+hours*3600000).toISOString(),...report,
   minimumRecentersMet:state.candidates.every((c,i)=>c.management!=='recenter'||state.states[i]!.recenters>=10),
   selectionEligible:false,note:'Review artifact only; assess coverage, overnight/weekend scope, complete costs and paired outcomes before selection',
   stateSha256:digest(json(state)),state};
  const temporary=reviewPath+'.tmp';await writeFile(temporary,json(review));
  try{await link(temporary,reviewPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  finally{await unlink(temporary);}
 }
}
function statusMarkdown(report:{observedAt:string;status:string;reason?:string;sourceAt:string;candidates:any[];markFresh?:boolean;quality?:{pausedSeconds:number;missedDecisions:number}}){
 const dollars=(n:string|null)=>n===null?'unavailable':(Number(n)/1e6).toFixed(6);
 return `# Forward LP comparison\n\nUpdated ${report.observedAt}; source ${report.sourceAt}. Status: ${report.status}${report.reason?' — '+report.reason:''}. Modeled portfolios with frozen fork cost scenarios; no broadcasts.\n\nMarks fresh: ${report.markFresh===true?'yes':'no; values are last-source marks'}. Data pause seconds: ${report.quality?.pausedSeconds??'unavailable'}. Skipped checkpoint decisions: ${report.quality?.missedDecisions??'unavailable'}.\n\n| Candidate | NAV USDG | P&L USDG | Alpha vs common holding USDG | Estimated costs USDG | Entries | Recenters | Infra exits |\n|---|---:|---:|---:|---:|---:|---:|---:|\n`+report.candidates.map(r=>`| ${r.candidate.id} | ${dollars(r.nav)} | ${dollars(r.pnl)} | ${dollars(r.commonAlpha)} | ${dollars(r.costs)} | ${r.entries} | ${r.recenters} | ${r.infrastructureExits} |`).join('\n')+'\n';
}
