import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,writeFile,mkdir,rename } from 'node:fs/promises';
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
export interface LiveState {version:1;createdAt:string;planHash:string;runtime:RuntimeIdentity;costs:ExperimentCosts;candidates:Candidate[];seed:MarketSeed;lastFrame:ExperimentFrame;sourceIds:string[];states:PortfolioState[];actions:Record<string,unknown>[];status:'running'|'invalid';reason?:string}
export async function startForward(source:ExperimentSource,selected:Candidate[],costs:ExperimentCosts,runtime:RuntimeIdentity|undefined,path:string){
 assertRuntimeMatches(runtime??null,runtime);
 assert.equal(JSON.stringify((await source.costs()).costs),JSON.stringify(costs),'Frozen cost evidence changed');
 assert(selected.length>=2&&selected.length<=4,'Forward comparison needs two to four eligible candidates');
 const now=new Date().toISOString(),rows=await source.checkpoints(new Date(Date.now()-180000).toISOString(),now),row=rows.at(-1);assert(row,'Fresh checkpoint unavailable');await source.coverage(row.block,row.target_set_hash);
 const seed=await source.seed(row),health=await source.health(row.observed_at,new Date(new Date(row.observed_at).getTime()+30000).toISOString()),frame=source.frame(row,health,[]);assert(frame.dataValid);
 const portfolios=selected.map(c=>new ExperimentPortfolio(c,costs));
 const state:LiveState={version:1,createdAt:new Date().toISOString(),planHash:digest(JSON.stringify({selected,costs})),runtime:runtime!,costs,candidates:selected,seed,lastFrame:frame,sourceIds:[frame.id],states:portfolios.map(p=>p.s),actions:[],status:'running'};
 await mkdir(dirname(path),{recursive:true});await writeFile(path,json(state),{flag:'wx'});return state;
}
export async function tickForward(source:ExperimentSource,path:string,runtime:RuntimeIdentity|undefined){
 const state:LiveState=parse(await readFile(path,'utf8'));assertRuntimeMatches(state.runtime,runtime);assert.equal(state.planHash,digest(JSON.stringify({selected:state.candidates,costs:state.costs})),'Experiment plan changed');if(state.status!=='running')return state;
 try{assert.equal(JSON.stringify((await source.costs()).costs),JSON.stringify(state.costs));}catch{state.status='invalid';state.reason='cost_evidence_invalid';await persistStopped(path,state);return state;}
 if(!(await source.historyValid(state.sourceIds))){state.status='invalid';state.reason='prior_source_revoked';await persistStopped(path,state);return state;}
 const rows=(await source.checkpoints(state.lastFrame.sourceAt,new Date().toISOString())).filter(r=>BigInt(r.block)>BigInt(state.lastFrame.block));
 if(!rows.length){if(Date.now()-Date.parse(state.lastFrame.sourceAt)>180000){state.status='invalid';state.reason='forward_source_unavailable';await persistStopped(path,state);}return state;}
 const market=new ExperimentMarket(state.seed),portfolios=state.candidates.map((c,i)=>new ExperimentPortfolio(c,state.costs,state.states[i]));
 for(const row of rows){
  if(Date.now()<new Date(row.observed_at).getTime()+30000)break;
  // Never backfill a missed live decision using today's knowledge.
  if(Date.now()-new Date(row.source_at).getTime()>180000){state.status='invalid';state.reason='missed_forward_decision';break;}
  try{await source.coverage(row.block,row.target_set_hash);}catch{break;}
  const health=await source.health(row.observed_at,new Date(new Date(row.observed_at).getTime()+30000).toISOString()),events=await source.events(state.lastFrame.block,row.block),frame=source.frame(row,health,events);
  for(const e of events)for(const {segment,protocol} of market.apply(e))for(const p of portfolios)p.accrue(segment,protocol);
  market.verify(frame);if(Date.parse(frame.sourceAt)>=Date.parse(state.createdAt))for(const p of portfolios)p.decision(frame,market.source());
  state.lastFrame={...frame,events:[]};state.sourceIds.push(frame.id);state.seed=market.seed();state.states=portfolios.map(p=>p.s);
 }
 if(!(await source.historyValid(state.sourceIds))){state.status='invalid';state.reason='source_revoked_during_tick';}
 state.actions.push(...portfolios.flatMap(p=>p.actions.map(a=>({candidate:p.candidate.id,...a}))));
 await atomic(path,state);
 const report={observedAt:new Date().toISOString(),createdAt:state.createdAt,status:state.status,reason:state.reason,sourceAt:state.lastFrame.sourceAt,sourceIds:state.sourceIds,candidates:state.status==='running'?portfolios.map(p=>p.summary(state.lastFrame,market.source())):[],actions:portfolios.flatMap(p=>p.actions.map(a=>({candidate:p.candidate.id,...a}))),executionEligible:false};
 await atomic(path+'.status.json',report);
 await writeFile(path+'.status.md',statusMarkdown(report));
 // Each commit contains the full restart state; journal is evidence, not the checkpoint authority.
 if(report.actions.length)await writeFile(path+'.actions.jsonl',JSON.stringify(report)+'\n',{flag:'a'});
 return state;
}

async function persistStopped(path:string,state:LiveState){
 await atomic(path,state);const report={observedAt:new Date().toISOString(),createdAt:state.createdAt,status:state.status,reason:state.reason,sourceAt:state.lastFrame.sourceAt,candidates:[],executionEligible:false};
 await atomic(path+'.status.json',report);await writeFile(path+'.status.md',statusMarkdown(report));
}
function statusMarkdown(report:{observedAt:string;status:string;reason?:string;sourceAt:string;candidates:any[]}){
 const dollars=(n:string|null)=>n===null?'unavailable':(Number(n)/1e6).toFixed(6);
 return `# Forward LP comparison\n\nUpdated ${report.observedAt}; source ${report.sourceAt}. Status: ${report.status}${report.reason?' — '+report.reason:''}. Modeled portfolios with frozen fork cost scenarios; no broadcasts.\n\n| Candidate | NAV USDG | P&L USDG | Alpha vs common holding USDG | Estimated costs USDG | Entries | Recenters | Infra exits |\n|---|---:|---:|---:|---:|---:|---:|---:|\n`+report.candidates.map(r=>`| ${r.candidate.id} | ${dollars(r.nav)} | ${dollars(r.pnl)} | ${dollars(r.commonAlpha)} | ${dollars(r.costs)} | ${r.entries} | ${r.recenters} | ${r.infrastructureExits} |`).join('\n')+'\n';
}
