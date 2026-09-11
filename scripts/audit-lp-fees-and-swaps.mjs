import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {OffHoursRecenter} from '../src/research/offhours-recenter.ts';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {paperTradingWindow,equityHours} from '../src/paper/trading-hours.ts';
import {CAP_HOURS} from '../src/research/offhours-cap.ts';
import {paperSegmentCredit} from '../src/research/management-audit.ts';
import {historicalSwapQuote,nvdaValueQuote} from '../src/research/portfolio-math.ts';
import {inventoryBalances,poolReference} from '../src/research/inventory-management.ts';
const [capturePath,resultPath,output]=process.argv.slice(2);assert(output&&!fs.existsSync(output));
const digest=x=>createHash('sha256').update(x).digest('hex'),raw=fs.readFileSync(capturePath),saved=JSON.parse(fs.readFileSync(resultPath));
assert.equal(digest(raw),saved.captureSha256);const data=JSON.parse(raw),plan=saved.plan;
for(const [file,hash] of Object.entries(plan.codeHashes))assert.equal(digest(fs.readFileSync(file)),hash,`Frozen model changed: ${file}`);
const Q128=1n<<128n;
class Audit extends OffHoursRecenter {
 shadow=new WeakMap();feeDiluted=0n;feeUndiluted=0n;maxOursOverHistoricalPpm=0n;partialSegments=0;swaps=[];
 accrue(segments,m){
  const p=this.book.position;if(!p||this.invalid)return;
  const before0=p.fee0/Q128,before1=p.fee1/Q128;
  const shadow=this.shadow.get(p)??[0n,0n],s0=shadow[0]/Q128,s1=shadow[1]/Q128;
  for(const {segment,protocol} of segments){
   let credit;try{credit=paperSegmentCredit(segment,p,p.liquidity,protocol);}catch(error){if(String(error).includes('Partial fee segment')){this.partialSegments++;continue;}throw error;}
   shadow[segment.token]+=credit*BigInt(this.costs.feePpm)/1000000n;
   if(credit){const ratio=p.liquidity*1000000n/segment.liquidity;if(ratio>this.maxOursOverHistoricalPpm)this.maxOursOverHistoricalPpm=ratio;}
  }
  this.shadow.set(p,shadow);super.accrue(segments,m);
  this.feeDiluted+=p.fee0/Q128-before0+nvdaValueQuote(p.fee1/Q128-before1,poolReference(m.price));
  this.feeUndiluted+=shadow[0]/Q128-s0+nvdaValueQuote(shadow[1]/Q128-s1,poolReference(m.price));
 }
 decision(f,m,health){
  const balances=inventoryBalances(this.book,m),pending=this.pending,move=this.rangeIntent,start=this.actions.length;
  super.decision(f,m,health);
  for(const a of this.actions.slice(start)){
   let token,amount;
   if(a.kind==='entry'){assert.equal(pending?.kind,'entry');token=0;amount=pending.amount;}
   else if(a.kind==='exit'){token=1;amount=balances.amount1;}
   else if(a.kind==='recenter'&&move?.plan.swap){token=move.plan.token;amount=move.plan.amount;}
   else continue;
   const q=historicalSwapQuote(m,amount,token);assert(q.fullyFilled);
   const ref=poolReference(m.price),fee=token===0?q.feeInput:nvdaValueQuote(q.feeInput,ref),shortfall=token===1?q.outputShortfall:nvdaValueQuote(q.outputShortfall,ref);
   // Both components are already embedded in the actual token output. These
   // diagnostic fields never mutate the portfolio or deduct costs again.
   this.swaps.push({kind:a.kind,checkpoint:f.id,at:f.sourceAt,tokenIn:token===0?'USDG':'NVDA',amountIn:String(amount),amountOut:String(q.amountOut),feeInput:String(q.feeInput),feeQuote:String(fee),spotShortfallQuote:String(shortfall),impactBeyondFeeQuote:String(shortfall>fee?shortfall-fee:0n)});
  }
 }
 audited(m){const r=this.summary(m);assert.equal(this.feeDiluted,r.fees,'Fee diagnostic differs from actual accrual');return {...r,audit:{feeDiluted:this.feeDiluted,feeUndiluted:this.partialSegments?null:this.feeUndiluted,partialSegments:this.partialSegments,maxOursOverHistoricalPpm:this.maxOursOverHistoricalPpm,swapFees:this.swaps.reduce((n,s)=>n+BigInt(s.feeQuote),0n),swapImpact:this.swaps.reduce((n,s)=>n+BigInt(s.impactBeyondFeeQuote),0n),swaps:this.swaps}};}
}
const market=new ExperimentMarket(data.seed),health=new Map(data.health.map(x=>[x.id,x]));let window=null,last=null;const windows=[];
const p=plan.profiles.find(p=>p.id==='saved_fork_costs'),cost={...p,entry:BigInt(p.entry),exit:BigInt(p.exit),buy:BigInt(p.buy)},recenter=Object.fromEntries(Object.entries(p.recenter).map(([k,v])=>[k,BigInt(v)]));
function finish(f){
 const original=saved.windows.find(w=>w.startAt===window.startAt);assert(original);const results=window.models.map(m=>m.audited(market.source()));
 for(const r of results){const old=original.results.find(x=>x.profile===p.id&&x.cap===r.cap&&x.rangePolicy===r.rangePolicy);for(const [k,v] of Object.entries(r)){if(k==='audit')continue;assert.deepEqual(JSON.parse(JSON.stringify(v,(_,v)=>typeof v==='bigint'?String(v):v)),old[k],`Original changed: ${k}`);}r.available=old.available;}
 windows.push({startAt:window.startAt,endAt:f.sourceAt,results});window=null;
}
for(const f of data.frames){
 const segments=[];for(const e of f.events)segments.push(...market.apply(e));market.verify(f);if(window)for(const m of window.models)m.accrue(segments,market.source());
 const schedule=paperTradingWindow(f.observedAt,CAP_HOURS);
 if(!window&&schedule.allowed)window={startAt:f.sourceAt,excludedAt:schedule.excludedAt,models:plan.caps.flatMap(cap=>plan.rangePolicies.map(mode=>new Audit(BigInt(plan.budgetQuote),cap,cost,mode,recenter)))};
 if(window){for(const m of window.models)m.decision(f,market.source(),f.allHealthIds.map(id=>health.get(id)));
  if(Date.parse(f.sourceAt)>=Date.parse(window.excludedAt)){
   const done=window.models.every(m=>!m.book.position||m.invalid),late=Date.parse(f.sourceAt)>Date.parse(window.excludedAt)+1800000;
   if(done||late){if(late)for(const m of window.models)if(m.book.position)m.invalid??='scheduled_exit_unavailable';finish(f);}
  }
 }
 last=f;
}
if(window)finish(last);
const aggregates=[];
for(const cap of plan.caps)for(const mode of plan.rangePolicies){const rows=windows.flatMap(w=>w.results.filter(r=>r.available&&r.cap===cap&&r.rangePolicy===mode));const sum=k=>rows.reduce((n,r)=>n+Number(r.audit[k]),0)/1e6;
 aggregates.push({cap,rangePolicy:mode,windows:rows.length,fees:sum('feeDiluted'),undilutedFees:rows.every(r=>r.audit.feeUndiluted!==null)?sum('feeUndiluted'):null,swapFees:sum('swapFees'),swapImpact:sum('swapImpact'),maxOursOverHistoricalPpm:Math.max(...rows.map(r=>Number(r.audit.maxOursOverHistoricalPpm))),partialSegments:rows.reduce((n,r)=>n+r.audit.partialSegments,0)});}
const result={computedAt:new Date().toISOString(),captureSha256:saved.captureSha256,originalResultsSha256:digest(fs.readFileSync(resultPath)),auditCodeSha256:digest(fs.readFileSync('scripts/audit-lp-fees-and-swaps.mjs')),originalAccountingUnchanged:true,aggregates,windows,limits:['Swap fees and impact diagnostics are embedded in output balances; never subtract them twice','Undiluted fee comparison is the paper convention on the same hypothetical actions, not a realized LP position','Counterfactual market path and trade flow remain unchanged; NFT restoration injects estimated fees and is not independent earnings proof']};
const encoded=JSON.stringify(result,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';fs.writeFileSync(output,encoded,{flag:'wx'});fs.writeFileSync(output+'.sha256',digest(encoded)+'\n',{flag:'wx'});console.log(JSON.stringify(aggregates,null,2));
