// Matched $250 ablation on retained canonical captures. All arms share entry,
// forecasts, gas reserve, source timing and fee/cost stresses. Research only.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../../src/experiment/market.ts';
import {AdaptiveLpReplay} from '../../src/research/adaptive-lp.ts';
import {AgileLpReplay} from '../../src/research/agile-lp.ts';
import {InventoryLpReplay} from '../../src/research/inventory-lp.ts';
import {TrailingForecast} from '../../src/research/adaptive-forecast.ts';
import {marketValue} from '../../src/paper/market.ts';
import {deriveAdaptivePassiveBenchmark} from '../../src/paper/adaptive-benchmark.ts';

const [root,symbol,output]=process.argv.slice(2);assert(root&&['AAPL','NVDA'].includes(symbol)&&output&&!existsSync(output),
 'Usage: node --import tsx scripts/research/inventory-range-replay.mjs CAPTURE_ROOT AAPL|NVDA NEW_OUTPUT');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),read=p=>JSON.parse(readFileSync(p,'utf8'));
const original=read(root+'/plan.json'),prepared=read(root+'/prepared.json'),source=read(root+'/sources-v2/'+symbol+'.json');
assert.equal(hash(root+'/plan.json'),prepared.planSha256);assert.equal(hash(root+'/sources-v2/'+symbol+'.json'),prepared.sources[symbol]);
const plan={from:'2026-09-08T00:00:00Z',to:original.to,lpQuote:'240000000',gasReserveQuote:'10000000',
 forecast:{lookbackMs:3600000,minimumSpanMs:2400000,minimumSamples:40},decisionMs:30000,
 inventory:{spanSpacings:[1,2,4,8,16,32],cooldownMs:600000,confirmations:2},
 scenarios:[{name:'base',gasMultiplier:1,feePpm:1000000},{name:'double_gas_half_fees',gasMultiplier:2,feePpm:500000}],
 limitation:'Previously inspected dates; atomic later-observation fills, not staged live execution. Historical independent references unavailable. No-swap gas is a scenario derived from the retained NVDA stage weights and asset-scaled recenter gas.'};
const reserve=BigInt(plan.gasReserveQuote),start=Date.parse(plan.from),end=Date.parse(plan.to);
const median=original.profiles.median.recenter,raw=original.costs.median[symbol];
const costs=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,BigInt(v)]));
costs.residual=costs.recenter*BigInt(median.stageGasQuote[0]+median.stageGasQuote[2])/BigInt(median.gasQuote);
const policy={name:'outside_range',halfWidthsTicks:[10,20,40,80,160],adaptive:true,economicGate:true,budget:BigInt(plan.lpQuote),decisionMs:30000,quoteTtlMs:90000,horizonMs:600000,slippageBps:50,costBufferPpm:500000,feeBufferPpm:250000,gasMultiplier:1,feePpm:1000000,failEveryRecenter:0};
const rows=plan.scenarios.flatMap(s=>['outside_range','early_swap','early_inventory'].map(name=>{
 const p={...policy,...s,name};
 const model=name==='early_inventory'?new InventoryLpReplay(source.market,costs,p,{...plan.inventory,gasBudgetQuote:reserve}):name==='early_swap'?new AgileLpReplay(source.market,costs,p,{boundaryPpm:700000,confirmations:2,cooldownMs:600000,narrowingPersistenceMs:600000}):new AdaptiveLpReplay(source.market,costs,p);
 return {scenario:s.name,name,model};
}));
const book=new ExperimentMarket(source.seed),trailing=new TrailingForecast(plan.forecast.lookbackMs,plan.forecast.minimumSpanMs);
let g0=0n,g1=0n,lastSample=null,lastDecision=null,last=null,blocks=0,eventCount=0;
async function block(events){
 for(const e of events)for(const {segment,protocol} of book.apply(e)){
  const growth=segment.liquidity?(segment.fee-(protocol?segment.fee/BigInt(protocol):0n))*(1n<<128n)/segment.liquidity:0n;
  if(segment.token===0)g0+=growth;else g1+=growth;
  for(const {model} of rows)model.accrue(segment,protocol);
 }
 const m={...book.source(),at:events[0].at,block:events[0].block};blocks++;eventCount+=events.length;
 if(m.liquidity>0n&&(lastSample===null||m.at-lastSample>=60000)){trailing.observe({at:m.at,price:m.price,growth0:g0,growth1:g1});lastSample=m.at;}
 if(m.at<start)return;last=m;
 if(m.liquidity===0n||lastDecision!==null&&m.at-lastDecision<30000)return;
 lastDecision=m.at;
 // Agile's minimum count is 40 rather than TrailingForecast's fixed 60.
 const {agileForecastStats}=await import('../../src/research/agile-forecast.ts');
 const stats=agileForecastStats(trailing.samples,m.at,plan.forecast);
 for(const {model} of rows){
  const kind=model.pending?.kind??(model.position?'recenter':'entry');
  if(model.gas+model.cost(kind)+model.cost('exit')>reserve){model.pending=null;model.mark(m);model.reject('study_exit_reserve');continue;}
  await model.step(m,stats);
 }
}
let pending=[];
for(const page of source.pages){assert.equal(hash(root+'/'+page.file),page.sha256);
 for(const e of JSON.parse(gunzipSync(readFileSync(root+'/'+page.file)))){
  assert(e.at<end);if(pending.length&&pending[0].block!==e.block){await block(pending);pending=[];}pending.push(e);
 }
 console.log(JSON.stringify({symbol,page:page.file,blocks,events:eventCount}));
}
if(pending.length)await block(pending);book.verify(source.after);assert(last);
const results=rows.map(({scenario,name,model})=>{
 const benchmark=deriveAdaptivePassiveBenchmark(model.actions);assert(benchmark,'No benchmark entry');
 const hold={amount0:BigInt(benchmark.amount0),amount1:BigInt(benchmark.amount1)},summary=model.summary(last,hold);
 const holdMarked=marketValue(source.market,last.price,hold.amount0,hold.amount1)-BigInt(benchmark.entryCostQuote);
 const actions=summary.actions;
 if(name==='early_inventory')for(const action of actions.filter(a=>a.kind==='recenter')){assert.equal(action.token,null);assert.deepEqual(action.before,action.afterSwap);}
 assert(BigInt(summary.totalGasWithExitQuote)<=reserve);
 return {scenario,name,...summary,passiveBenchmark:benchmark,matchedPoolMarkedAlphaQuote:String(BigInt(summary.markedNavQuote)-holdMarked),
  // Parent summary uses a separate buy cost; recompute the same-entry comparator.
  matchedExecutableAlphaQuote:summary.terminalCashQuote===null||summary.holdTerminalCashQuote===null?null:String(BigInt(summary.terminalCashQuote)-(BigInt(summary.holdTerminalCashQuote)+model.cost('hold')-BigInt(benchmark.entryCostQuote))),
  allInInitialQuote:'250000000',allInTerminalQuote:summary.terminalCashQuote===null?null:String(BigInt(summary.terminalCashQuote)+reserve),
  earlyMoves:actions.filter(a=>a.kind==='recenter'&&a.early).length,swapActions:actions.filter(a=>a.token===0||a.token===1).length,
  independentReferenceAlphaQuote:null};
});
const files=['scripts/research/inventory-range-replay.mjs','src/research/inventory-lp.ts','src/research/inventory-range.ts','src/research/adaptive-lp.ts','src/research/agile-lp.ts','src/research/adaptive-forecast.ts','src/research/agile-forecast.ts'];
const result={symbol,plan,costs,sourceSha256:prepared.sources[symbol],code:Object.fromEntries(files.map(p=>[p,hash(p)])),results,canonicalEndVerified:true,executionEligible:false,promotionEligible:false};
writeFileSync(output,JSON.stringify(result,(_k,v)=>typeof v==='bigint'?String(v):v,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({symbol,output,results:results.map(r=>({name:r.name,scenario:r.scenario,pnl:r.netPnlQuote,alpha:r.matchedExecutableAlphaQuote,fees:r.feesQuote,gas:r.totalGasWithExitQuote,early:r.earlyMoves,moves:r.recenters}))}));
