import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {historicalSwapQuote,modeledFeeGrowth,nvdaValueQuote} from '../src/research/portfolio-math.ts';
import {inventoryBalances,poolReference} from '../src/research/inventory-management.ts';
import {replayPaperMint,referenceExposure} from '../src/research/management-audit.ts';
import {sizeLiquidityForQuoteBudget} from '../src/simulator/math.ts';
import {USDG} from '../src/constants.ts';
import {PAPER_NVDA} from '../src/paper/engine.ts';
import {paperGasQuote} from '../src/paper/transaction-engine.ts';

const [dir,freshPath,output]=process.argv.slice(2);assert(dir&&freshPath&&output);
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=path=>{const raw=fs.readFileSync(path,'utf8');assert.equal(hash(raw),fs.readFileSync(path+'.sha256','utf8').trim());return JSON.parse(raw);};
const paper=read(dir+'/paper-source.json'),data=read(dir+'/market-source.json'),fresh=read(freshPath);
const market=new ExperimentMarket(data.seed),frames=[],byId=new Map(),byBlock=new Map();
const ms=Date.parse,raw=x=>BigInt(x??0),Q128=1n<<128n;
const buyGas=(result,valuation)=>paperGasQuote(String(result.transactions.slice(0,result.transactions.findIndex(t=>t.action==='buy_nvda')+1).reduce((n,t)=>n+raw(t.estimate.totalFeeWei),0n)),valuation);
for(const f of data.frames){const segments=[];for(const e of f.events)segments.push(...market.apply(e));market.verify(f);byId.set(f.id,frames.length);byBlock.set(f.block,frames.length);frames.push({f,segments,seed:market.seed()});}
const sources=new Map(),source=i=>{if(!sources.has(i))sources.set(i,new ExperimentMarket(frames[i].seed).source());return sources.get(i);};
const mark=(b,m)=>{const a=inventoryBalances(b,m);return a.amount0+nvdaValueQuote(a.amount1,poolReference(m.price))-b.gas;};
const eligibility=f=>f.referenceEligible&&f.chainHealthy&&f.dataValid&&ms(f.observedAt)-ms(f.sourceAt)<=180000;
function entry(s,o,allocation){
 const intent=o.state.execution.intent,signal=source(byBlock.get(intent.sourceBlock)),fill=source(byId.get(o.checkpoint_id));
 const budget=raw(s.policy.budgetQuote),lpBudget=budget*BigInt(allocation)/1000000n;
 const range={tickLower:intent.tickLower,tickUpper:intent.tickUpper};
 const sized=sizeLiquidityForQuoteBudget({budgetQuote:lpBudget,quoteToken:USDG,token0:USDG,token1:PAPER_NVDA,sqrtPriceX96:signal.price,...range});
 const amount=lpBudget-sized.amount0-sized.idleQuote,quote=historicalSwapQuote(signal,amount,0),minimum=quote.amountOut*9950n/10000n;
 assert(quote.fullyFilled&&minimum>0n);
 const q=historicalSwapQuote(fill,amount,0);
 assert(q.fullyFilled&&q.amountOut>=minimum,'Frozen entry output minimum not met');
 assert(q.tickAfter>=range.tickLower&&q.tickAfter<range.tickUpper,'Entry left range');
 const mint=replayPaperMint(q.sqrtPriceAfter,range,budget-amount,q.amountOut,budget-lpBudget);
 assert(mint.liquidity>0n&&mint.liquidity*1000000n<=q.liquidityAfter*BigInt(s.policy.maxLiquiditySharePpm),'Entry liquidity cap');
 return {intent:{...range,amount,minimum},q,mint,book:{cash:mint.idle0,rwa:mint.idle1,gas:0n,position:{...range,liquidity:mint.liquidity,fee0:0n,fee1:0n}}};
}
const parity=[],entries=[],rows=[];
for(const s of paper.sessions.filter(s=>s.status==='closed'&&paper.selectedIds.includes(s.id))){
 const o=paper.observations.find(o=>o.session_id===s.id&&o.action==='enter');assert(o);
 const run=paper.executions.find(x=>x.id===o.state.execution.entryRunId),r=run.snapshot.result,baseline=entry(s,o,800000);
 assert.equal(String(baseline.intent.amount),o.state.execution.intent.swapAmountQuote);
 assert.equal(String(baseline.intent.minimum),o.state.execution.intent.minRwaOut);
 for(const [actual,expected] of [[baseline.q.amountOut,r.entrySwap.actualOut],[baseline.q.sqrtPriceAfter,r.entrySwap.sqrtPriceAfter],[baseline.mint.liquidity,r.liquidity],[baseline.mint.amount0,r.minted0],[baseline.mint.amount1,r.minted1],[baseline.mint.idle0,r.balances.afterMint.quote],[baseline.mint.idle1,r.balances.afterMint.rwa]])assert.equal(String(actual),expected,`Entry parity session ${s.id}`);
 parity.push(s.id);
 const xr=paper.executions.find(x=>x.id===s.state.execution.exitRunId);assert(xr);
 const profiles=[{id:'recorded_session',entry:paperGasQuote(r.entryGasWei,run.snapshot.valuation),exit:paperGasQuote(xr.snapshot.result.totalGasWei,xr.snapshot.valuation),hold:buyGas(r,run.snapshot.valuation)},
 {id:'fresh55_common',entry:raw(fresh.entryGasQuote),exit:raw(fresh.exitGasQuote),hold:buyGas(fresh.result,fresh.valuation)}];
 const start=byId.get(o.checkpoint_id),initial=source(start);
 for(const allocation of [800000,550000]){
  let e;try{e=allocation===800000?baseline:entry(s,o,allocation);}catch(error){entries.push({session:s.id,allocation,status:'rejected',error:error.message});continue;}
  entries.push({session:s.id,allocation,status:'filled',budget:s.policy.budgetQuote,sourceAt:o.source_at,range:e.intent,
   minted0:e.mint.amount0,minted1:e.mint.amount1,idle0:e.mint.idle0,idle1:e.mint.idle1,liquidity:e.mint.liquidity,
   deployedPpm:(e.mint.amount0+nvdaValueQuote(e.mint.amount1,poolReference(initial.price)))*1000000n/raw(s.policy.budgetQuote)});
  for(const horizon of [30,120,360]){
   const end=frames.findIndex((x,i)=>i>start&&ms(x.f.sourceAt)>=ms(frames[start].f.sourceAt)+horizon*60000);if(end<0)continue;
   for(const cost of profiles)for(const guards of ['inventory_only','legacy_checkpoints']){
    let b=structuredClone(e.book);b.gas=cost.entry;
    const a0={amount0:raw(s.policy.budgetQuote)-e.intent.amount,amount1:e.q.amountOut};
    let pending=null,exitReason=null,exitAt=null,fees=0n,outsideSeconds=0,holdingSeconds=0,maxExposure=0n,error=null,exitTick=null;
    for(let i=start;i<=end;i++){
     const {f,segments}=frames[i],m=source(i);
     if(i>start&&b.position){
      const p=b.position,previous=source(i-1),secs=(ms(f.sourceAt)-ms(frames[i-1].f.sourceAt))/1000;
      holdingSeconds+=secs;if(previous.tick<p.tickLower||previous.tick>=p.tickUpper)outsideSeconds+=secs;
      const old0=p.fee0/Q128,old1=p.fee1/Q128;
      for(const {segment,protocol} of segments)p[segment.token===0?'fee0':'fee1']+=modeledFeeGrowth(segment,p,p.liquidity,protocol)*p.liquidity;
      fees+=p.fee0/Q128-old0+nvdaValueQuote(p.fee1/Q128-old1,poolReference(m.price));
     }
     if(!b.position)continue;
     const amounts=inventoryBalances(b,m),ref=raw(f.referencePrice??poolReference(m.price));
     const exp=referenceExposure(amounts.amount0,amounts.amount1,ref,b.gas+cost.exit);if(exp>maxExposure)maxExposure=exp;
     // Source-clock ordering: an exit can only fill after its checkpoint decision time.
     if(!pending&&(exp>=600000n||(guards==='legacy_checkpoints'&&!eligibility(f))))pending={at:i===start?ms(o.observed_at):ms(f.observedAt),reason:exp>=600000n?'inventory_cap':'historical_guard'};
     if(pending&&ms(f.sourceAt)>pending.at&&(guards==='inventory_only'||eligibility(f))){
      const q=historicalSwapQuote(m,amounts.amount1,1);if(q.fullyFilled&&q.passesSlippage){b={cash:amounts.amount0+q.amountOut,rwa:0n,gas:b.gas+cost.exit,position:null};exitReason=pending.reason;exitAt=f.sourceAt;exitTick=f.tick;}
     }
    }
    const m=source(end),a=inventoryBalances(b,m),hold=a0.amount0+nvdaValueQuote(a0.amount1,poolReference(m.price))-cost.hold;
    let net=mark(b,m);if(b.position){const q=historicalSwapQuote(m,a.amount1,1);if(!q.fullyFilled||!q.passesSlippage){net=null;error='Terminal liquidation depth unavailable';}else net=a.amount0+q.amountOut-b.gas-cost.exit;}
    rows.push({session:s.id,allocation,budget:s.policy.budgetQuote,horizonMinutes:horizon,profile:cost.id,guards,
     startAt:frames[start].f.sourceAt,endAt:frames[end].f.sourceAt,net,pnl:net===null?null:net-raw(s.policy.budgetQuote),
     hold,alpha:net===null?null:net-hold,fees,gas:b.gas+(b.position?cost.exit:0n),maxExposurePpm:maxExposure,
     outsideSeconds,holdingSeconds,exitReason,exitAt,exitTick,error});
   }
  }
 }
}
const paired=[];
for(const r of rows.filter(r=>r.allocation===550000)){
 const b=rows.find(b=>b.allocation===800000&&['session','horizonMinutes','profile','guards'].every(k=>b[k]===r[k]));assert(b);assert.equal(r.endAt,b.endAt);
 paired.push({...r,baselineNet:b.net,delta:r.net===null||b.net===null?null:r.net-b.net,baselineExitReason:b.exitReason,baselineFees:b.fees,baselineHoldingSeconds:b.holdingSeconds,baselineOutsideSeconds:b.outsideSeconds});
}
const groups=new Map();for(const r of paired){const key=[r.horizonMinutes,r.profile,r.guards].join('/');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
const aggregates=[...groups].map(([key,rs])=>{const ds=rs.filter(r=>r.delta!==null).map(r=>Number(r.delta)/1e6).sort((a,b)=>a-b);const mean=k=>rs.reduce((n,r)=>n+Number(r[k]),0)/rs.length;return {key,n:rs.length,available:ds.length,meanDelta:ds.reduce((a,b)=>a+b,0)/ds.length,medianDelta:ds.length%2?ds[(ds.length-1)/2]:(ds[ds.length/2-1]+ds[ds.length/2])/2,worstDelta:ds[0],bestDelta:ds.at(-1),wins:ds.filter(d=>d>0).length,inventoryExits55:rs.filter(r=>r.exitReason==='inventory_cap').length,inventoryExits80:rs.filter(r=>r.baselineExitReason==='inventory_cap').length,meanFees55:mean('fees')/1e6,meanFees80:mean('baselineFees')/1e6,meanHoldingMinutes55:mean('holdingSeconds')/60,meanHoldingMinutes80:mean('baselineHoldingSeconds')/60,meanOutsideMinutes55:mean('outsideSeconds')/60,meanOutsideMinutes80:mean('baselineOutsideSeconds')/60};});
const out={source:{paperSha256:hash(fs.readFileSync(dir+'/paper-source.json')),marketSha256:hash(fs.readFileSync(dir+'/market-source.json')),freshForkSha256:hash(fs.readFileSync(freshPath))},parity,entries,rows,paired,aggregates,
 method:{entry:'Identical saved quote and fill checkpoints and range for both allocations; budget varies by actual session; exact depth swap and integer mint; baseline agrees with every successful recorded entry',
 costs:'Recorded session entry and exit gas reused equally for both allocations; separate common fresh55 cost scenario. Neither is a measured historical candidate cost curve.',
 benchmark:'Passive holding of each candidate entry swap inventory, minus approval and buy gas only, matching the paper benchmark convention; the two allocations have different initial NVDA exposure',
 fees:'Crossing-aware canonical segments with added LP dilution and Q128 remainder; unchanged historical pool path after own hypothetical trade',
 guards:'inventory_only isolates 60 percent inventory mechanics and does not assert operational eligibility; legacy_checkpoints adds old conservative chain and reference guards, not the new 30 block holding tolerance',
 ending:'Delayed exits on later sources, one placement per episode, no recenter or reentry. Common-horizon depth liquidation is valuation, not proof of an operationally feasible exit.',
 limitations:['Retrospective overlapping episodes cannot be summed as campaign PnL','Actual entries selected under the 80 percent policy; selection bias','Lower allocation changes initial NVDA exposure, so a falling market can favor cash','No untouched holdout; fixed range with no recenter; outside time is checkpoint sampled','Gas profile reuse does not measure candidate-specific historical gas; no live receipts']}};
const encoded=JSON.stringify(out,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';fs.writeFileSync(output,encoded,{flag:'wx'});fs.writeFileSync(output+'.sha256',hash(encoded)+'\n',{flag:'wx'});
console.log(JSON.stringify({parity:parity.length,entries:entries.length,rejected:entries.filter(e=>e.status!=='filled'),rows:rows.length,aggregates},null,2));
