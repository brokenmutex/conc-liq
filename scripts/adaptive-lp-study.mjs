// Offline only: consumes frozen public market/fork evidence; no env, RPC or DB.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {AdaptiveLpReplay} from '../src/research/adaptive-lp.ts';
import {TrailingForecast,forecastPortfolio} from '../src/research/adaptive-forecast.ts';
import {marketTokens,marketRange,marketValue} from '../src/paper/market.ts';
import {historicalSwapQuote} from '../src/research/portfolio-math.ts';
import {sizeLiquidityForQuoteBudget} from '../src/simulator/math.ts';
import {virtualFeeCredit} from '../src/research/virtual-fees.ts';
import {paperGasQuote} from '../src/paper/transaction-engine.ts';

const [planPath='notes/adaptive-lp-study-2026-09-13/plan.json',output='data/adaptive-lp-study-2026-09-13']=process.argv.slice(2);
const planRaw=readFileSync(planPath),plan=JSON.parse(planRaw),source=resolve(plan.sourceDirectory),root=resolve(output);
assert.notEqual(root,source);mkdirSync(root,{recursive:true});
const hash=x=>createHash('sha256').update(x).digest('hex');
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);
const save=(name,x)=>{const path=root+'/'+name;assert(!existsSync(path),`Output exists: ${path}`);writeFileSync(path,json(x)+'\n');};
const codePaths=['src/research/virtual-fees.ts','src/research/adaptive-forecast.ts','src/research/adaptive-lp.ts','src/research/swap.ts','src/research/portfolio-math.ts','src/research/management-audit.ts','src/experiment/market.ts','src/paper/market.ts','src/paper/execution-recenter.ts','src/backtest/principal.ts','scripts/adaptive-lp-study.mjs'];
const manifest={planSha256:hash(planRaw),plan,code:Object.fromEntries(codePaths.map(p=>[p,hash(readFileSync(p))])),createdAt:new Date().toISOString(),sources:[]};
const times=new Map(),hashes=new Map(),history=JSON.parse(readFileSync(source+'/history-screen.json'));
for(const page of history.pages){
 const raw=readFileSync(source+`/history-private/${page.from}-${page.toExclusive}.json.gz`);assert.equal(hash(raw),page.sha256);
 const d=JSON.parse(gunzipSync(raw));
 for(const b of d.blocks){const n=Number(b.number),t=Number(BigInt(b.timestamp))*1000;
  if(times.has(n)){assert.equal(times.get(n),t);assert.equal(hashes.get(n).toLowerCase(),b.hash.toLowerCase());}
  times.set(n,t);hashes.set(n,b.hash);
 }
}
const inputs=[];
const timeRaw=readFileSync(plan.supplementalTimestamps);assert.equal(hash(timeRaw),readFileSync(plan.supplementalTimestamps+'.sha256','utf8').trim());
const supplement=JSON.parse(timeRaw);manifest.supplementalTimestampsSha256=hash(timeRaw);
for(const b of supplement.blocks){assert(!times.has(b.number));times.set(b.number,Number(BigInt(b.timestamp))*1000);hashes.set(b.number,b.hash);}
for(const symbol of plan.symbols){
 const path=source+`/replay-source-${symbol}.json.gz`,raw=readFileSync(path);assert.equal(hash(raw),readFileSync(path+'.sha256','utf8').trim());
 const d=JSON.parse(gunzipSync(raw));assert.equal(d.symbol,symbol);assert.equal(d.market.fee,500);assert.equal(d.market.tickSpacing,10);
 let previous=null,missing=0;const firstEventBlock=Number(d.events[0].block);
 for(const e of d.events){const b=Number(e.block);assert(b>d.fromBlock&&b<=d.toBlock);
  if(previous)assert(b>previous.b||(b===previous.b&&(e.tx>previous.tx||e.tx===previous.tx&&e.log>previous.log)));
  previous={b,tx:e.tx,log:e.log};
  if(times.has(b))assert.equal(hashes.get(b).toLowerCase(),e.hash.toLowerCase());
  else {missing++;throw new Error('Event timestamp missing');}
 }
 const forkRaw=readFileSync(source+`/fork-${symbol}.json`);assert.equal(hash(forkRaw),readFileSync(source+`/fork-${symbol}.json.sha256`,'utf8').trim());
 const fork=JSON.parse(forkRaw);assert(fork.passed);
 const holdExitWei=fork.stages.restoredExit.proof.transactions.filter(t=>['approve_exit_swap','sell_nvda'].includes(t.action)).reduce((n,t)=>n+BigInt(t.estimate.totalFeeWei),0n);
 const costs={...Object.fromEntries(Object.entries(d.costs).map(([k,v])=>[k,BigInt(v)])),holdExit:paperGasQuote(String(holdExitWei),d.valuation)};
 assert.equal(supplement.sources[symbol],hash(raw));
 inputs.push({d,costs});manifest.sources.push({symbol,sha256:hash(raw),forkSha256:hash(forkRaw),events:d.events.length,eventsWithoutTimestamp:missing,firstEventBlock,costs});
}
manifest.historySha256=hash(readFileSync(source+'/history-screen.json'));
save('manifest.json',manifest);console.log(json({stage:'frozen',planSha256:manifest.planSha256,sources:manifest.sources}));

const definitions=[...plan.halfWidthsTicks.map(w=>({name:`fixed_${w}`,widths:[w],adaptive:false,gate:false})),{name:'adaptive_width',widths:plan.halfWidthsTicks,adaptive:true,gate:false},{name:'adaptive_economic',widths:plan.halfWidthsTicks,adaptive:true,gate:true}];
const cloneSource=m=>{const ticks=[...m.ticks],net=new Map(ticks.map(t=>[t,m.net(t)]));return {...m,ticks,net:t=>net.get(t)??0n};};
async function run({d,costs},phases){
 const book=new ExperimentMarket(d.seed),trailing=new TrailingForecast(plan.forecast.lookbackSeconds*1000,plan.forecast.minimumSpanSeconds*1000,plan.forecast.maximumGapSeconds*1000);
 const results=[],groups=new Map(),forecastMetrics=new Map();let lastSample=null,lastSource=null,lastProbe=null,probes=[];
 let cumulative0=0n,cumulative1=0n,activeGroup=null,processed=0;
 const finish=(phase,group)=>{
  if(!group.last)return;
  const models=group.models.map(({scenario,model})=>({scenario,...model.summary(group.last,group.hold)}));
  results.push({symbol:d.symbol,phase:phase.name,requestedFrom:phase.from,requestedTo:phase.to,sourceFrom:group.first,sourceTo:group.last.at,costs,models});
  console.log(json({stage:'phase_completed',symbol:d.symbol,phase:phase.name,models:models.length}));
 };
 for(let i=0;i<d.events.length;i++){
  const e=d.events[i],next=d.events[i+1];
  const blockAt=times.get(Number(e.block));
  // Establish phase boundaries BEFORE crediting any event in the new block.
  if(i===0||d.events[i-1].block!==e.block){
   if(blockAt!==undefined){
    if(activeGroup&&blockAt>=Date.parse(activeGroup.phase.to)){finish(activeGroup.phase,activeGroup);activeGroup=null;}
    probes=probes.filter(p=>{
      if(blockAt<p.until)return true;
      if(!lastSource||lastSource.at<p.until-90000||blockAt>=p.phaseEnd)return false;
      const actual=marketValue(d.market,lastSource.price,p.fee0/(1n<<128n),p.fee1/(1n<<128n));
      const key=p.phase+':'+p.width,r=forecastMetrics.get(key)??{phase:p.phase,width:p.width,count:0,absoluteError:0n,trailingAbsoluteError:0n,predicted:0n,actual:0n};
      r.count++;r.absoluteError+=p.predicted>actual?p.predicted-actual:actual-p.predicted;r.trailingAbsoluteError+=p.trailing>actual?p.trailing-actual:actual-p.trailing;r.predicted+=p.predicted;r.actual+=actual;forecastMetrics.set(key,r);return false;
    });
   }
  }
  for(const {segment,protocol} of book.apply(e)){
   const growth=segment.liquidity?(segment.fee-(protocol?segment.fee/BigInt(protocol):0n))*(1n<<128n)/segment.liquidity:0n;
   if(segment.token===0)cumulative0+=growth;else cumulative1+=growth;
   if(activeGroup)for(const {model} of activeGroup.models)model.accrue(segment,protocol);
   for(const p of probes){const credit=virtualFeeCredit(segment,p,p.liquidity,protocol).lower;if(segment.token===0)p.fee0+=credit;else p.fee1+=credit;}
  }
  processed++;
  if(next&&next.block===e.block)continue;
  if(blockAt===undefined)continue;
  const m={...book.source(),at:blockAt,block:e.block};
  if(blockAt>=Date.parse(plan.phases.at(-1).to)){lastSource=cloneSource(m);continue;}
  if(lastSample===null||m.at-lastSample>=plan.forecastSampleSeconds*1000){trailing.observe({at:m.at,price:m.price,growth0:cumulative0,growth1:cumulative1});lastSample=m.at;}
  const stats=trailing.stats(m.at),phase=phases.find(p=>m.at>=Date.parse(p.from)&&m.at<Date.parse(p.to));
  if(phase&&!activeGroup){
   assert(!groups.has(phase.name));
   const q0=marketTokens(d.market).quoteIsToken0,budget=BigInt(plan.budgetQuote),buy=historicalSwapQuote(m,budget/2n,q0?0:1,plan.slippageBps);
   assert(buy.fullyFilled&&buy.passesSlippage,'Common passive acquisition unavailable');
   const hold={amount0:q0?budget-budget/2n:buy.amountOut,amount1:q0?buy.amountOut:budget-budget/2n};
   const models=plan.scenarios.flatMap(scenario=>definitions.map(def=>({scenario:scenario.name,model:new AdaptiveLpReplay(d.market,costs,
    {halfWidthsTicks:def.widths,adaptive:def.adaptive,economicGate:def.gate,budget,decisionMs:plan.decisionSeconds*1000,quoteTtlMs:plan.quoteTtlSeconds*1000,horizonMs:plan.forecast.horizonSeconds*1000,slippageBps:plan.slippageBps,...plan.economicGate,...scenario,name:def.name})})));
   activeGroup={phase,models,hold,first:m.at,last:null};groups.set(phase.name,activeGroup);
  }
  if(activeGroup){
   for(const {model} of activeGroup.models)await model.step(m,stats);
   activeGroup.last=cloneSource(m);
   if(stats&&(lastProbe===null||m.at-lastProbe>=plan.forecast.horizonSeconds*1000)){
    lastProbe=m.at;
    for(const width of plan.halfWidthsTicks){
     const range=marketRange(m.price,m.tick,width,d.market.tickSpacing),tokens=marketTokens(d.market);
     const size=sizeLiquidityForQuoteBudget({budgetQuote:BigInt(plan.budgetQuote),quoteToken:tokens.quoteIsToken0?tokens.token0:tokens.token1,...tokens,sqrtPriceX96:m.price,...range});
     const p={...range,liquidity:size.liquidity};
     const f=forecastPortfolio(d.market,m,{amount0:0n,amount1:0n,position:p},stats,plan.forecast.horizonSeconds*1000,0n);
     if(f)probes.push({...p,phase:phase.name,phaseEnd:Date.parse(phase.to),width,until:m.at+plan.forecast.horizonSeconds*1000,fee0:0n,fee1:0n,predicted:f.feesQuote,trailing:f.trailingAlwaysActiveFeesQuote});
    }
   }
  }
  lastSource=cloneSource(m);
  if(processed%20000<5)console.log(json({stage:'replaying',symbol:d.symbol,at:new Date(m.at).toISOString(),events:processed}));
 }
 if(activeGroup)finish(activeGroup.phase,activeGroup);
 book.verify(d.after);
 assert.equal(results.length,phases.length,'Incomplete phase coverage');
 return {symbol:d.symbol,results,forecastMetrics:[...forecastMetrics.values()],canonicalEndVerified:true,events:processed};
}

const training=[];
for(const input of inputs){console.log(json({stage:'development_validation',symbol:input.d.symbol}));training.push(await run(input,plan.phases.slice(0,2)));}
save('development-validation.json',training);
const fixed=plan.halfWidthsTicks.filter(w=>w!==20).map(width=>({width,alpha:training.reduce((sum,d)=>{
 const m=d.results.find(r=>r.phase==='validation').models.find(m=>m.name===`fixed_${width}`&&m.scenario==='pinned_fork_costs');assert(m.alphaQuote!==null&&!m.invalid);return sum+BigInt(m.alphaQuote);
},0n)})).sort((a,b)=>a.alpha===b.alpha?b.width-a.width:a.alpha>b.alpha?-1:1);
const selection={selectedFixedHalfWidthTicks:fixed[0].width,validationScores:fixed,planSha256:manifest.planSha256,basis:'validation_only',selectedAt:new Date().toISOString()};
save('selection.json',selection);console.log(json({stage:'selection_frozen',...selection}));
const testing=[];for(const input of inputs){console.log(json({stage:'retrospective_test',symbol:input.d.symbol}));testing.push(await run(input,plan.phases.slice(2)));}
save('retrospective-test.json',testing);
const all=[...training,...testing],rows=all.flatMap(d=>d.results.flatMap(r=>r.models.map(({actions,economicScores,...m})=>({symbol:r.symbol,phase:r.phase,...m,actionCount:actions.length,economicDecisions:economicScores.length}))));
save('summary.json',{planSha256:manifest.planSha256,selection,rows,forecastMetrics:all.flatMap(d=>d.forecastMetrics.map(r=>({symbol:d.symbol,...r}))),
 limitations:[
  'Conditional recorded market path. Historical issuer, oracle, infrastructure and quote availability are not reconstructed; executionEligible=false.',
  'Virtual fees apportion recorded post-protocol step fees by rational input distance and dilute by added liquidity. Integer bounds do not bound economic counterfactual error.',
  'Successful paths charge full pinned asset-specific fork bundles. Costs are scenarios, not historical receipt costs. Passive exit uses saved approve/sell components.',
  'Every fifth otherwise executable recenter fails after removal and swap in the failure scenario; full bundle gas is charged and actual residual inventory funds recovery after ten minutes. This is a stress assumption, not a fitted failure probability.',
  'Forecasts use trailing fee growth, current liquidity and zero-drift diffusion scenarios. They do not model correlated future depth/flow, jumps or independent true-price discovery.',
  'Terminal strategy and passive balances are both liquidated with exact swap quotes on the terminal canonical depth. Invalid or slippage-rejected terminal quotes are unavailable.',
  'Every event timestamp is verified against its frozen block hash, using the original independent swap capture plus supplemental canonical block headers.',
  'Decision and exposure statistics follow timestamped event blocks; source gaps are disclosed. No historical safety action can be inferred from absent evidence.',
  'Retrospective dates have been inspected before. A prospective untouched evaluation remains necessary; the separately reserved weekend is excluded.'
 ],executionEligible:false,promotionEligible:false});
save('completed.json',{completedAt:new Date().toISOString(),planSha256:manifest.planSha256,rows:rows.length,canonicalEndsVerified:all.every(d=>d.canonicalEndVerified)});
console.log(json({stage:'completed',output:root,rows:rows.length}));
