import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {balancedRecenterPlan,filledRecenter,inventoryBalances,poolReference,trimPlan,filledTrim} from '../src/research/inventory-management.ts';
import {historicalSwapQuote,modeledFeeGrowth,nvdaValueQuote,positionAmounts} from '../src/research/portfolio-math.ts';
import {referenceExposure} from '../src/research/management-audit.ts';
import {paperGasQuote} from '../src/paper/transaction-engine.ts';
import {sqrtRatioAtTick} from '../src/backtest/principal.ts';

const [dir,output]=process.argv.slice(2);assert(dir&&output,'Usage: node --import tsx scripts/inventory-management-study.mjs CAPTURE_DIR OUTPUT');
const hash=x=>createHash('sha256').update(x).digest('hex');
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
const read=name=>{const path=dir+'/'+name,raw=fs.readFileSync(path,'utf8');if(fs.existsSync(path+'.sha256'))assert.equal(hash(raw),fs.readFileSync(path+'.sha256','utf8').trim());return JSON.parse(raw);};
const paper=read('paper-source.json'),data=read('market-source.json'),metrics=read('session-metrics.json'),fork=read('recenter-54.json'),exit=read('exit-54.json'),trim=read('trim-54.json');
assert.equal(data.manifest.paperSha256,hash(fs.readFileSync(dir+'/paper-source.json')));
const Q128=1n<<128n,ms=x=>Date.parse(x),raw=x=>BigInt(x??'0');
const market=new ExperimentMarket(data.seed),frames=[],index=new Map();
for(const f of data.frames){const segments=[];for(const e of f.events)segments.push(...market.apply(e));market.verify(f);index.set(f.id,frames.length);frames.push({f,segments,seed:market.seed()});}
const sources=new Map(),source=i=>{if(!sources.has(i))sources.set(i,new ExperimentMarket(frames[i].seed).source());return sources.get(i);};
function bookOf(o){const s=o.state,p=s.position;return {cash:raw(p.idle0),rwa:raw(p.idle1),gas:raw(s.costsPaidQuote),position:{tickLower:p.tickLower,tickUpper:p.tickUpper,liquidity:raw(p.liquidity),fee0:raw(s.execution.earnedFee0)*Q128,fee1:raw(s.execution.earnedFee1)*Q128}};}
const marked=(b,m)=>{const a=inventoryBalances(b,m);return a.amount0+nvdaValueQuote(a.amount1,poolReference(m.price))-b.gas;};
const exposure=(b,m,ref,reserve)=>{const a=inventoryBalances(b,m);return referenceExposure(a.amount0,a.amount1,ref,b.gas+reserve);};
const metricById=new Map(metrics.sessions.map(s=>[s.id,s]));
const sessionRows=[],anchors=[];
for(const s of paper.sessions.filter(s=>s.status==='closed'&&paper.selectedIds.includes(s.id))){
 const os=paper.observations.filter(o=>o.session_id===s.id),entry=os.find(o=>o.action==='enter'),signal=os.find(o=>o.action==='signal_exit');assert(entry);
 const metric=metricById.get(s.id),b=bookOf(entry),m=source(index.get(entry.checkpoint_id)),ref=raw(entry.state.reference.referencePriceX18),p=b.position;
 let threshold=null;
 for(let tick=m.tick;tick<=p.tickUpper;tick++){
  const price=sqrtRatioAtTick(tick); // Constant initial pool/reference ratio; token1 USD price falls as pool tick rises.
  const scaledRef=ref*m.price**2n/price**2n;
  if(exposure(b,{...m,price,tick},scaledRef,raw(entry.state.exitReserveQuote))>=600000n){threshold=tick;break;}
 }
 const group=metric.exitReasons.some(r=>r.includes('inventory'))?'inventory':metric.exitReasons.some(r=>r.startsWith('chain_')||r==='source_ahead_of_confirmed_quorum')?'chain':metric.exitReasons.length?'risk_reference':'operator';
 sessionRows.push({session:s.id,group,entryAt:metric.entryAt,holdingMinutes:metric.holdingMinutes,pnl:metric.pnl,alpha:metric.alpha,fees:metric.fees,gas:metric.costs,entryDrag:metric.decomposition?.entryExecutionDrag,exitDrag:metric.decomposition?.exitExecutionDrag,entryAllocationPpm:metric.entryLpAllocationPpm,entryExposurePpm:metric.entryExposurePpm,signalExposurePpm:metric.signalExposurePpm,maxExposurePpm:metric.maxObservedExposurePpm,signalTick:signal?.state.last?.tick,lower:p.tickLower,upper:p.tickUpper,inventorySignalInside:group==='inventory'&&signal?signal.state.last.tick>=p.tickLower&&signal.state.last.tick<p.tickUpper:null,exitDelaySeconds:metric.exitDelaySeconds,thresholdTick:threshold,ticksFromEntryTo60:threshold===null?null:threshold-m.tick,thresholdBeforeBoundary:threshold!==null&&threshold<p.tickUpper});
 for(const trigger of [500000,550000]){
  const o=os.find(o=>o.state.status==='open'&&o.state.reference?.eligible&&index.has(o.checkpoint_id)&&exposure(bookOf(o),source(index.get(o.checkpoint_id)),raw(o.state.reference.referencePriceX18),raw(o.state.exitReserveQuote))>=BigInt(trigger));
  if(o)anchors.push({session:s.id,trigger,o,start:index.get(o.checkpoint_id),entryAt:entry.source_at});
 }
}
const txCosts=x=>x.result.transactions.map(t=>({action:t.action,quote:paperGasQuote(t.estimate.totalFeeWei,x.valuation)}));
const freshR=txCosts(fork),freshX=txCosts(exit),sum=(a,p)=>a.filter(t=>p(t.action)).reduce((n,t)=>n+t.quote,0n);
const old=Object.fromEntries(Object.entries(data.costEvidence.costs).map(([k,v])=>[k,raw(v)]));
const fresh={remove:sum(freshR,a=>a==='decrease_and_collect'),mint:sum(freshR,a=>a.includes('mint')),sell:sum(freshR,a=>a==='approve_recenter_swap'||a==='recenter_sell_nvda'),buy:sum(freshR,a=>a==='approve_recenter_swap'||a==='recenter_sell_nvda'),exit:raw(exit.gasQuote),trim:raw(trim.gasQuote)};
const profiles=[{id:'frozen_session6',...old,exit:old.remove+old.sell+old.revoke,trim:old.remove+old.sell},{id:'source_block_54',...fresh}];
const eligibility=f=>f.dataValid&&f.referenceEligible&&f.referencePrice&&f.chainHealthy&&ms(f.observedAt)-ms(f.sourceAt)<=180000;
function cashExit(b,m,cost){const a=inventoryBalances(b,m),q=historicalSwapQuote(m,a.amount1,1);assert(q.fullyFilled&&q.passesSlippage,'Exit depth unavailable');return {cash:a.amount0+q.amountOut,rwa:0n,gas:b.gas+cost,position:null};}
function terminal(b,m,cost){return marked(b.position||b.rwa?cashExit(b,m,cost):b,m);}
function accrue(b,segments,feePpm){if(!b.position)return;const p=b.position;for(const {segment,protocol} of segments)p[segment.token===0?'fee0':'fee1']+=modeledFeeGrowth(segment,p,p.liquidity,protocol)*p.liquidity*BigInt(feePpm)/1000000n;}

const rows=[];
for(const a of anchors)for(const horizon of [30,120]){
 const end=frames.findIndex((x,i)=>i>a.start&&ms(x.f.sourceAt)>=ms(frames[a.start].f.sourceAt)+horizon*60000);if(end<0)continue;
 for(const cost of profiles)for(const feePpm of [1000000,500000])for(const cooldown of [0,600])for(const strategy of ['guard60','exit_early','recenter60','trim25','hold80']){
  if(strategy!=='recenter60'&&cooldown!==0)continue;
  let b=bookOf(a.o),pending=null,attempted=false,exited=null,recenters=0,rejected=[],actions=[],feeValue=0n,peak=marked(b,source(a.start)),maxDrawdown=0n,maxExposure=0n,outsideSeconds=0,activeSeconds=0;
  const initial=inventoryBalances(b,source(a.start)),oldGas=b.gas,cap=strategy==='hold80'?800000n:600000n;
  let unavailable=null;
  for(let i=a.start;i<=end;i++){
   const {f,segments}=frames[i],m=source(i),now=i===a.start?ms(a.o.observed_at):ms(f.observedAt),ref=raw(f.referencePrice??poolReference(m.price));
   if(i>a.start){const before=inventoryBalances(b,m);accrue(b,segments,feePpm);const after=inventoryBalances(b,m);feeValue+=after.amount0-before.amount0+nvdaValueQuote(after.amount1-before.amount1,poolReference(m.price));
    const seconds=(ms(f.sourceAt)-ms(frames[i-1].f.sourceAt))/1000;if(b.position){activeSeconds+=seconds;const pm=source(i-1);if(pm.tick<b.position.tickLower||pm.tick>=b.position.tickUpper)outsideSeconds+=seconds;}}
   const nav=marked(b,m);if(nav>peak)peak=nav;if(peak-nav>maxDrawdown)maxDrawdown=peak-nav;
   const exp=exposure(b,m,ref,cost.exit);if(exp>maxExposure)maxExposure=exp;
   if(exited)continue;
   // Conservative historical checkpoint guards, not a reconstruction of the new bounded holding runtime.
   const mandatory=!eligibility(f)?'historical_guard':exp>=cap?'inventory_cap':null;
   if(mandatory&&pending?.kind!=='exit')pending={kind:'exit',reason:mandatory,at:now};
   if(pending&&ms(f.sourceAt)>pending.at){
    if(pending.kind==='exit'){
     if(eligibility(f)){try{b=cashExit(b,m,cost.exit);exited=pending.reason;actions.push({kind:'exit',checkpoint:f.id,reason:exited});pending=null;}catch(e){rejected.push(e.message);}}
    }else{
     const p=pending;pending=null;attempted=true;
     if(!eligibility(f)||now-p.at>90000||Math.abs(f.tick-p.tick)>5)rejected.push('quote_age_tick_or_guard');
     else try{const fill=p.kind==='trim'?filledTrim(b,m,p.plan,cost.trim):filledRecenter(b,m,p.plan,cost);b=fill.book;if(p.kind==='recenter')recenters++;actions.push({kind:p.kind,checkpoint:f.id,token:fill.token??1,delaySeconds:(ms(f.sourceAt)-p.at)/1000});}catch(e){rejected.push(e.message);}
    }
   }
   if(exited||pending)continue;
   if(strategy==='exit_early'&&!attempted){attempted=true;pending={kind:'exit',reason:'early_inventory_exit',at:now};}
   if((strategy==='recenter60'||strategy==='trim25')&&!attempted&&exp>=BigInt(a.trigger)&&eligibility(f)&&now-ms(a.entryAt)>=cooldown*1000){
    attempted=true;try{const balances=inventoryBalances(b,m),plan=strategy==='trim25'?trimPlan(b,m):balancedRecenterPlan(m,balances.amount0,balances.amount1);pending={kind:strategy==='trim25'?'trim':'recenter',plan,at:now,tick:f.tick};}catch(e){rejected.push(e.message);}
   }
  }
  const m=source(end),hold=initial.amount0+nvdaValueQuote(initial.amount1,poolReference(m.price))-oldGas;
  let net=null;try{net=terminal(b,m,cost.exit);}catch(e){unavailable=e.message;}
  rows.push({session:a.session,trigger:a.trigger,anchorObservation:a.o.id,anchorCheckpoint:frames[a.start].f.id,anchorAt:a.o.observed_at,horizonMinutes:horizon,endAt:frames[end].f.sourceAt,profile:cost.id,feePpm,cooldown,strategy,net,alpha:net===null?null:net-hold,newGas:b.gas-oldGas+(!exited?cost.exit:0n),feesAfterAnchor:feeValue,maxDrawdown,maxExposurePpm:maxExposure,activeSeconds,outsideSeconds,recenters,trims:actions.filter(a=>a.kind==='trim').length,attempted,exited,rejected,actions,terminalExecution:'Common-horizon depth liquidation valuation; not proof of contemporaneous operational eligibility',unavailable});
 }
}
for(const r of rows){const baseline=rows.find(x=>x.session===r.session&&x.trigger===r.trigger&&x.horizonMinutes===r.horizonMinutes&&x.profile===r.profile&&x.feePpm===r.feePpm&&x.strategy==='guard60');r.delta=baseline.net===null||r.net===null?null:r.net-baseline.net;}
const groups={};for(const r of rows){const key=[r.trigger,r.horizonMinutes,r.profile,r.feePpm,r.cooldown,r.strategy].join('/');(groups[key]??=[]).push(r);}
const aggregates=Object.entries(groups).map(([key,rs])=>{const ds=rs.filter(r=>r.delta!==null).map(r=>Number(r.delta)/1e6).sort((a,b)=>a-b);return {key,n:rs.length,available:ds.length,meanDelta:ds.reduce((a,b)=>a+b,0)/ds.length,medianDelta:ds.length%2?ds[(ds.length-1)/2]:(ds[ds.length/2-1]+ds[ds.length/2])/2,worstDelta:ds[0],bestDelta:ds.at(-1),wins:ds.filter(x=>x>0).length,recenterFills:rs.reduce((n,r)=>n+r.recenters,0),trimFills:rs.reduce((n,r)=>n+r.trims,0),rejections:rs.filter(r=>r.rejected.length).length,meanGas:rs.reduce((n,r)=>n+Number(r.newGas)/1e6,0)/rs.length,meanFees:rs.reduce((n,r)=>n+Number(r.feesAfterAnchor)/1e6,0)/rs.length,maxExposurePpm:Math.max(...rs.map(r=>Number(r.maxExposurePpm)))};});
const result={asOf:paper.asOf,source:{paperSha256:hash(fs.readFileSync(dir+'/paper-source.json')),marketSha256:hash(fs.readFileSync(dir+'/market-source.json')),checkpoints:frames.length},sessionRows,anchorCount:anchors.length,profiles,rows,aggregates,method:{selection:'First eligible recorded open observation per session crossing 50 or 55 percent; no future exit selection',actions:'One early intervention at most; decisions precede source blocks; frozen swap and mint minima, 90 second age and 5 tick drift; 0 and 600 second cooldown scenarios',guards:'Historical checkpoint reference and chain guards retained. New 30 block bounded holding is not backfilled. All strategies use identical guards except explicit hold80 inventory diagnostic.',fees:'Canonical crossing-aware segments with added-liquidity dilution; 100 and 50 percent income scenarios',costs:'Frozen source-block action profiles reused as scenarios; source_block_54 buy uses sell proxy and is not independently measured',valuation:'All branches liquidated at identical source horizons, including passive holding mark; terminal liquidation is a valuation convention, not a feasible trading claim',limits:['Retrospective overlapping episodes are not independent and must not be summed as a campaign','No repeated intervention or automatic reentry; no optimal strategy claim','Trim preserves 75 percent of old liquidity and sells frozen released NVDA; marginal self-swap fees are excluded','Unchanged historical pool path after hypothetical own price impact','Sequential fork intervention validated at one source; counterfactual atomic success assumes no mid-action failures','Historical checkpoint observation times are synthetic capture plus delay outside recorded anchors; historical current-risk evidence is incomplete','No untouched holdout, weekend sample, price gap stress or live execution receipts']}};
fs.writeFileSync(output,json(result),{flag:'wx'});fs.writeFileSync(output+'.sha256',hash(fs.readFileSync(output))+'\n',{flag:'wx'});
console.log(json({sessions:sessionRows.length,anchors:anchors.length,rows:rows.length,profiles,primary:aggregates.filter(r=>r.key.startsWith('500000/')&&r.key.includes('/source_block_54/1000000/'))}));
