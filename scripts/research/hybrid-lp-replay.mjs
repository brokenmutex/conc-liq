// Preregistered staged $250 mechanics replay. Development evidence only: the
// retained dates were inspected previously and have no independent marks.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {ExperimentMarket} from '../../src/experiment/market.ts';
import {AdaptiveLpReplay} from '../../src/research/adaptive-lp.ts';
import {InventoryLpReplay} from '../../src/research/inventory-lp.ts';
import {HybridLpReplay} from '../../src/research/hybrid-lp.ts';
import {TrailingForecast} from '../../src/research/adaptive-forecast.ts';
import {agileForecastStats} from '../../src/research/agile-forecast.ts';
import {deriveAdaptivePassiveBenchmark} from '../../src/paper/adaptive-benchmark.ts';
import {canonicalBalances,marketValue} from '../../src/paper/market.ts';
import {marketSession} from '../../src/paper/session-performance.ts';

const [root,symbol,output]=process.argv.slice(2);
assert(root&&['AAPL','NVDA'].includes(symbol)&&output&&!existsSync(output),
  'Usage: node --import tsx scripts/research/hybrid-lp-replay.mjs CAPTURE_ROOT AAPL|NVDA NEW_OUTPUT');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),read=p=>JSON.parse(readFileSync(p,'utf8'));
const experimentPath='research/experiments/hybrid-lp-250-2026-09-20.json',experiment=read(experimentPath);
assert.equal(experiment.executionEligible,false);assert.equal(experiment.broadcastsEnabled,false);
for(const input of experiment.inputs.filter(i=>i.path.startsWith(root+'/')||i.path===root+'/plan.json'||i.path===root+'/prepared.json'))
  assert.equal(hash(input.path),input.sha256,`${input.path} changed after preregistration`);
const original=read(root+'/plan.json'),prepared=read(root+'/prepared.json'),source=read(root+'/sources-v2/'+symbol+'.json');
assert.equal(hash(root+'/plan.json'),prepared.planSha256);assert.equal(hash(root+'/sources-v2/'+symbol+'.json'),prepared.sources[symbol]);
const split=experiment.splits.development,start=Date.parse(split.from),end=Date.parse(split.to),reserve=BigInt(experiment.capital.gasReserveQuote);
assert.equal(BigInt(experiment.capital.totalQuote),BigInt(experiment.capital.strategyInventoryQuote)+reserve);
const raw=original.costs.median[symbol],costs=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,BigInt(v)]));
const weights=original.profiles.median.recenter.stageGasQuote,totalWeight=BigInt(original.profiles.median.recenter.gasQuote);
const withdraw=costs.recenter*BigInt(weights[0])/totalWeight,swap=costs.recenter*BigInt(weights[1])/totalWeight,mint=costs.recenter-withdraw-swap;
costs.residual=withdraw+mint;
const basePolicy={name:'',halfWidthsTicks:[10,20,40,80,160],adaptive:true,economicGate:true,budget:BigInt(experiment.capital.strategyInventoryQuote),
  decisionMs:experiment.policy.decisionMs,quoteTtlMs:90000,horizonMs:experiment.policy.forecastHorizonMs,slippageBps:experiment.policy.slippageBps,
  costBufferPpm:experiment.policy.costBufferPpm,feeBufferPpm:experiment.policy.feeBufferPpm,gasMultiplier:1,feePpm:1000000,failEveryRecenter:0};
const baseGrid={spanSpacings:experiment.policy.spanSpacings,lowerOffsetPpm:experiment.policy.lowerOffsetPpm,
  deploymentPpm:experiment.policy.deploymentPpm,swapInputPpm:experiment.policy.swapInputPpm,maxSwapInputPpm:experiment.policy.maxSwapInputPpm,minLiquidity:1n};
const rows=[];
for(const scenario of experiment.scenarios)for(const session of ['full_session','off_hours_only']){
  const p={...basePolicy,gasMultiplier:scenario.gasMultiplier,feePpm:scenario.feePpm};
  rows.push({scenario:scenario.name,session,name:'outside_range',model:new AdaptiveLpReplay(source.market,costs,{...p,name:'outside_range'})});
  rows.push({scenario:scenario.name,session,name:'inventory_only',model:new InventoryLpReplay(source.market,costs,{...p,name:'inventory_only'},
    {spanSpacings:experiment.policy.spanSpacings,cooldownMs:experiment.policy.cooldownMs,confirmations:experiment.policy.confirmations,gasBudgetQuote:reserve})});
  const stageCosts={approval:0n,withdrawCollect:withdraw,swap,mint,exit:costs.exit,
    adverseSelectionPpm:scenario.adverseSelectionPpm,approvalRequired:false};
  const common={costs:stageCosts,gasBudgetQuote:reserve,cooldownMs:experiment.policy.cooldownMs,confirmations:experiment.policy.confirmations,
    stageTtlMs:experiment.policy.stageTtlMs,stageDelayMs:{approval:30000*scenario.delayMultiplier,
      withdraw_collect:3072*scenario.delayMultiplier,swap:64000*scenario.delayMultiplier,mint:59000*scenario.delayMultiplier}};
  for(const span of experiment.policy.spanSpacings)rows.push({scenario:scenario.name,session,name:`hybrid_fixed_${span}`,
    model:new HybridLpReplay(source.market,costs,{...p,name:`hybrid_fixed_${span}`},{...common,grid:{...baseGrid,spanSpacings:[span]}})});
  rows.push({scenario:scenario.name,session,name:'hybrid_adaptive',model:new HybridLpReplay(source.market,costs,{...p,name:'hybrid_adaptive'},
    {...common,grid:baseGrid})});
}
const book=new ExperimentMarket(source.seed),trailing=new TrailingForecast(experiment.policy.forecastLookbackMs,experiment.policy.forecastMinimumSpanMs);
let g0=0n,g1=0n,lastSample=null,lastDecision=null,last=null,blocks=0,eventCount=0;
async function block(events){
  for(const event of events)for(const {segment,protocol} of book.apply(event)){
    const growth=segment.liquidity?(segment.fee-(protocol?segment.fee/BigInt(protocol):0n))*(1n<<128n)/segment.liquidity:0n;
    if(segment.token===0)g0+=growth;else g1+=growth;for(const row of rows)row.model.accrue(segment,protocol);
  }
  const m={...book.source(),at:events[0].at,block:events[0].block};blocks++;eventCount+=events.length;
  if(m.liquidity>0n&&(lastSample===null||m.at-lastSample>=60000)){trailing.observe({at:m.at,price:m.price,growth0:g0,growth1:g1});lastSample=m.at;}
  if(m.at<start)return;last=m;if(m.liquidity===0n||lastDecision!==null&&m.at-lastDecision<experiment.policy.decisionMs)return;lastDecision=m.at;
  const forecast=agileForecastStats(trailing.samples,m.at,{lookbackMs:experiment.policy.forecastLookbackMs,
    minimumSpanMs:experiment.policy.forecastMinimumSpanMs,minimumSamples:experiment.policy.forecastMinimumSamples});
  const offHours=marketSession(m.at).regime!=='regular';
  for(const row of rows){
    const staged=row.model instanceof HybridLpReplay?row.model.hybridPending!==null:row.model.pending!==null;
    if(row.session==='off_hours_only'&&!offHours&&!staged){row.model.mark(m);continue;}
    if(!(row.model instanceof HybridLpReplay)){
      const kind=row.model.pending?.kind??(row.model.position?'recenter':'entry');
      if(row.model.gas+row.model.cost(kind)+row.model.cost('exit')>reserve){row.model.pending=null;row.model.mark(m);row.model.reject('study_exit_reserve');continue;}
    }
    await row.model.step(m,forecast);
  }
}
let pending=[];
for(const page of source.pages){assert.equal(hash(root+'/'+page.file),page.sha256);
  for(const event of JSON.parse(gunzipSync(readFileSync(root+'/'+page.file)))){
    assert(event.at<end);if(pending.length&&pending[0].block!==event.block){await block(pending);pending=[];}pending.push(event);
  }
  console.log(JSON.stringify({symbol,page:page.file,blocks,events:eventCount}));
}
if(pending.length)await block(pending);book.verify(source.after);assert(last);
const results=rows.map(row=>{
  const benchmark=deriveAdaptivePassiveBenchmark(row.model.actions);
  const hold=benchmark?{amount0:BigInt(benchmark.amount0),amount1:BigInt(benchmark.amount1)}:canonicalBalances(source.market,BigInt(experiment.capital.strategyInventoryQuote),0n);
  const summary=row.model.summary(last,hold),terminalBalances=row.model.balances(last),holdMarked=marketValue(source.market,last.price,hold.amount0,hold.amount1)-BigInt(benchmark?.entryCostQuote??0);
  return {scenario:row.scenario,session:row.session,name:row.name,...summary,passiveBenchmark:benchmark,
    terminalHoldings:{amount0:String(terminalBalances.amount0),amount1:String(terminalBalances.amount1)},
    terminalPosition:row.model.position?{tickLower:row.model.position.tickLower,tickUpper:row.model.position.tickUpper,liquidity:String(row.model.position.liquidity)}:null,
    matchedPoolMarkedAlphaQuote:String(BigInt(summary.markedNavQuote)-holdMarked),allInInitialQuote:experiment.capital.totalQuote,
    allInTerminalQuote:summary.terminalCashQuote===null?null:String(BigInt(summary.terminalCashQuote)+reserve),
    swaps:summary.actions.filter(a=>a.token===0||a.token===1).length,stageReceipts:row.model instanceof HybridLpReplay?row.model.hybridStages.length:null,
    decisionRejections:row.model.rejected,independentReferenceAlphaQuote:null,referenceCoveragePpm:0,selectionEligible:false};
});
const files=['scripts/research/hybrid-lp-replay.mjs','src/research/hybrid-lp.ts','src/research/inventory-lp.ts','src/research/inventory-range.ts',
  'src/research/adaptive-lp.ts','src/research/adaptive-forecast.ts','src/research/agile-forecast.ts',experimentPath];
const result={schemaVersion:1,id:`hybrid-lp-250-2026-09-20-${symbol.toLowerCase()}`,symbol,experimentSha256:hash(experimentPath),
  sourceSha256:prepared.sources[symbol],costs:Object.fromEntries(Object.entries(costs).map(([k,v])=>[k,String(v)])),
  stagedCosts:{withdrawCollect:String(withdraw),swap:String(swap),mint:String(mint),approval:'unavailable_assumed_existing_zero_charge'},
  code:Object.fromEntries(files.map(path=>[path,hash(path)])),results,canonicalEndVerified:true,validationDataComplete:false,
  independentReferenceAvailable:false,executionEligible:false,broadcastsEnabled:false,promotionEligible:false,
  rejectionReasons:['development_dates_previously_inspected','independent_reference_unavailable','staged_costs_not_measured','validation_period_unavailable']};
writeFileSync(output,JSON.stringify(result,(_key,value)=>typeof value==='bigint'?String(value):value,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({symbol,output,results:results.map(r=>({scenario:r.scenario,session:r.session,name:r.name,pnl:r.netPnlQuote,
  alpha:r.alphaQuote,fees:r.feesQuote,gas:r.totalGasWithExitQuote,moves:r.recenters,swaps:r.swaps}))}));
