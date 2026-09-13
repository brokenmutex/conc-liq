// Offline continuous-portfolio extension. Original decision/fee code is unchanged.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {AdaptiveLpReplay} from '../src/research/adaptive-lp.ts';
import {TrailingForecast,forecastPortfolio} from '../src/research/adaptive-forecast.ts';
import {marketTokens,marketValue,marketRange} from '../src/paper/market.ts';
import {historicalSwapQuote} from '../src/research/portfolio-math.ts';
import {marketSession} from '../src/paper/session-performance.ts';
import {sizeLiquidityForQuoteBudget} from '../src/simulator/math.ts';
import {virtualFeeCredit} from '../src/research/virtual-fees.ts';
const [symbol,budgetText,source='data/adaptive-lp-long-study-2026-09-13',root=source+'/runs']=process.argv.slice(2);
const hash=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v),read=p=>JSON.parse(readFileSync(p));
const meta=read(source+'/capture.json'),complete=read(source+'/completed.json'),plan=meta.plan;
assert.equal(hash(readFileSync('notes/adaptive-lp-long-study-2026-09-13/plan.json')),complete.planSha256);
assert.equal(hash(readFileSync(source+'/capture.json')),complete.captureSha256);assert(complete.canonicalEndsVerified&&complete.dbLogsExactMatch);
const amendmentPath='notes/adaptive-lp-long-study-2026-09-13/availability-amendment.json',amendment=read(amendmentPath);assert.equal(amendment.planSha256,complete.planSha256);
const prior=read('notes/adaptive-lp-study-2026-09-13/manifest.json');
for(const [p,h] of Object.entries(prior.code))assert.equal(hash(readFileSync(p)),h,'Frozen original replay code changed: '+p);
assert(plan.symbols.includes(symbol)&&plan.budgetsQuote.includes(budgetText));const budget=BigInt(budgetText),asset=meta.assets.find(a=>a.symbol===symbol);
const out=root+'/'+symbol+'-'+budgetText;mkdirSync(out,{recursive:true});assert(!existsSync(out+'/manifest.json'),'Output exists');
writeFileSync(out+'/manifest.json',json({planSha256:complete.planSha256,captureSha256:complete.captureSha256,captureCompleteSha256:hash(readFileSync(source+'/completed.json')),source,symbol,budgetQuote:budgetText,availabilityAmendmentSha256:hash(readFileSync(amendmentPath)),code:prior.code,runnerSha256:hash(readFileSync('scripts/adaptive-lp-long-study.mjs')),createdAt:new Date().toISOString()})+'\n');
assert.equal(asset.market.pool.toLowerCase(),asset.pool.toLowerCase());assert.equal(asset.market.fee,500);assert.deepEqual(asset.costs,prior.sources.find(a=>a.symbol===symbol).costs);
const book=new ExperimentMarket(asset.seed),costs=Object.fromEntries(Object.entries(asset.costs).map(([k,v])=>[k,BigInt(v)]));
const definitions=[...plan.halfWidthsTicks.map(w=>({name:`fixed_${w}`,widths:[w],adaptive:false,gate:false})),{name:'adaptive_width',widths:plan.halfWidthsTicks,adaptive:true,gate:false},{name:'adaptive_economic',widths:plan.halfWidthsTicks,adaptive:true,gate:true}];
const entries=plan.scenarios.flatMap(scenario=>definitions.map(def=>({scenario:scenario.name,model:new AdaptiveLpReplay(asset.market,costs,{halfWidthsTicks:def.widths,adaptive:def.adaptive,economicGate:def.gate,budget,decisionMs:plan.decisionSeconds*1000,quoteTtlMs:plan.quoteTtlSeconds*1000,horizonMs:plan.forecast.horizonSeconds*1000,slippageBps:plan.slippageBps,...plan.economicGate,...scenario,name:def.name}),nav:budget,holdValue:budget,weekly:new Map(),regimes:new Map(),lastRegime:null,lastWeek:null,gas:0n,actions:0,fee0:0n,fee1:0n})));
const trailing=new TrailingForecast(plan.forecast.lookbackSeconds*1000,plan.forecast.minimumSpanSeconds*1000,plan.forecast.maximumGapSeconds*1000);
let growth0=0n,growth1=0n,lastSample=null,hold=null,lastSource=null,firstAt=null,processed=0,blocks=0,lastLog=Date.now(),lastProbe=null,probes=[];const forecastMetrics=new Map(),calendarCache=new Map();
const Q=1n<<128n,start=Date.parse(plan.from),end=Date.parse(plan.to);
const cloneSource=m=>{const ticks=[...m.ticks],net=new Map(ticks.map(t=>[t,m.net(t)]));return {...m,ticks,net:t=>net.get(t)??0n};};
function week(at){const d=new Date(at);d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);}
function bucket(map,key,at){let b=map.get(key);if(!b){b={key,fromAt:at,toAt:at,navChangeQuote:0n,holdChangeQuote:0n,alphaQuote:0n,feesQuote:0n,gasQuote:0n,actions:0,marks:0,holdingMs:0,outsideMs:0};map.set(key,b);}return b;}
function add(b,at,nav,holdValue,fee,gas,count){b.toAt=at;b.navChangeQuote+=nav;b.holdChangeQuote+=holdValue;b.alphaQuote+=nav-holdValue;b.feesQuote+=fee;b.gasQuote+=gas;b.actions+=count;b.marks++;}
let previousMark=null;
async function applyBlock(events){
 const at=events[0].at;assert(events.every(e=>e.at===at));
 probes=probes.filter(p=>{if(at<p.until)return true;if(!lastSource||lastSource.at<p.until-90000)return false;const actual=marketValue(asset.market,lastSource.price,p.fee0/Q,p.fee1/Q),r=forecastMetrics.get(p.width)??{width:p.width,count:0,absoluteError:0n,trailingAbsoluteError:0n,predicted:0n,actual:0n};r.count++;r.absoluteError+=p.predicted>actual?p.predicted-actual:actual-p.predicted;r.trailingAbsoluteError+=p.trailing>actual?p.trailing-actual:actual-p.trailing;r.predicted+=p.predicted;r.actual+=actual;forecastMetrics.set(p.width,r);return false;});
 for(const e of events){for(const {segment,protocol} of book.apply(e)){
  const g=segment.liquidity?(segment.fee-(protocol?segment.fee/BigInt(protocol):0n))*Q/segment.liquidity:0n;if(segment.token===0)growth0+=g;else growth1+=g;
  if(hold)for(const s of entries)s.model.accrue(segment,protocol);
  for(const p of probes){const f=virtualFeeCredit(segment,p,p.liquidity,protocol).lower;if(segment.token===0)p.fee0+=f;else p.fee1+=f;}
 }processed++;}
 const m={...book.source(),at,block:events[0].block};blocks++;
 if(at>=end)throw new Error('Capture extends into excluded evaluation period');
 if(lastSample===null||at-lastSample>=plan.forecastSampleSeconds*1000){trailing.observe({at,price:m.price,growth0,growth1});lastSample=at;}
 const stats=trailing.stats(at);
 if(at>=start&&!hold){
  const q0=marketTokens(asset.market).quoteIsToken0;let available=false;
  try{const q=historicalSwapQuote(m,BigInt(plan.budgetsQuote[0])/2n,q0?0:1,plan.slippageBps);available=m.liquidity>0n&&q.fullyFilled&&q.passesSlippage;}catch{}
  if(!available){lastSource=cloneSource(m);return;}
 }
 if(at>=start){
  if(!hold){const q0=marketTokens(asset.market).quoteIsToken0,q=historicalSwapQuote(m,budget/2n,q0?0:1,plan.slippageBps);assert(q.fullyFilled&&q.passesSlippage,'Common passive acquisition unavailable at frozen start');hold={amount0:q0?budget-budget/2n:q.amountOut,amount1:q0?q.amountOut:budget-budget/2n};firstAt=at;for(const s of entries){for(let t=start;t<=at;t+=86400000)bucket(s.weekly,week(t),t);}}
  const minute=Math.floor(at/60000);if(!calendarCache.has(minute))calendarCache.set(minute,{...marketSession(at),week:week(at)});const cal=calendarCache.get(minute);
  for(const s of entries){const old=s.model.last;await s.model.step(m,stats);const model=s.model,balances=model.balances(m),nav=marketValue(asset.market,m.price,balances.amount0,balances.amount1)-model.gas;
   const hv=marketValue(asset.market,m.price,hold.amount0,hold.amount1)-model.cost('hold');
   const fee=marketValue(asset.market,m.price,model.fees0-s.fee0,model.fees1-s.fee1),gas=model.gas-s.gas,actions=model.actions.length-s.actions;
   const w=bucket(s.weekly,cal.week,at),r=bucket(s.regimes,s.lastRegime===null||s.lastRegime===cal.key?cal.regime:'mixed_boundary',at);
   for(const b of [w,r]){add(b,at,nav-s.nav,hv-s.holdValue,fee,gas,actions);if(previousMark!==null&&old?.holding){b.holdingMs+=at-previousMark;if(old.outside)b.outsideMs+=at-previousMark;}}
   // Week-crossing price changes belong to the ending observation's week;
   // preserve them whole and disclose this convention instead of prorating.
   s.nav=nav;s.holdValue=hv;s.lastRegime=cal.key;s.lastWeek=cal.week;s.gas=model.gas;s.actions=model.actions.length;s.fee0=model.fees0;s.fee1=model.fees1;
  }
  previousMark=at;
  if(stats&&(lastProbe===null||at-lastProbe>=plan.forecast.horizonSeconds*1000)){
   lastProbe=at;
   for(const width of plan.halfWidthsTicks){try{const range=marketRange(m.price,m.tick,width,asset.market.tickSpacing),tokens=marketTokens(asset.market),sized=sizeLiquidityForQuoteBudget({budgetQuote:budget,quoteToken:tokens.quoteIsToken0?tokens.token0:tokens.token1,...tokens,sqrtPriceX96:m.price,...range});const p={...range,liquidity:sized.liquidity},f=forecastPortfolio(asset.market,m,{amount0:0n,amount1:0n,position:p},stats,plan.forecast.horizonSeconds*1000,0n);if(f)probes.push({...p,width,until:at+plan.forecast.horizonSeconds*1000,fee0:0n,fee1:0n,predicted:f.feesQuote,trailing:f.trailingAlwaysActiveFeesQuote});}catch{/* Report only feasible probes; no synthetic predictions. */}}
  }
 }
 lastSource=cloneSource(m);
 if(Date.now()-lastLog>30000){console.log(json({stage:'replaying',symbol,budgetQuote:budgetText,at:new Date(at).toISOString(),events:processed,blocks}));lastLog=Date.now();}
}
let pending=[];
for(const page of complete.pages){const raw=readFileSync(source+'/'+page.file);assert.equal(hash(raw),page.sha256);for(const e of JSON.parse(gunzipSync(raw)).events){if(e.symbol!==symbol)continue;if(pending.length&&pending[0].block!==e.block){await applyBlock(pending);pending=[];}pending.push(e);}}
if(pending.length)await applyBlock(pending);book.verify(asset.after);assert(hold&&lastSource&&firstAt!==null);assert.equal(book.protocol0,asset.after.protocol0);assert.equal(book.protocol1,asset.after.protocol1);
const results=[];
for(const s of entries){const result={symbol,budgetQuote:budgetText,requestedFromAt:start,preBenchmarkCashWaitMs:firstAt-start,fullWindowMs:lastSource.at-start,scenario:s.scenario,...s.model.summary(lastSource,hold)};
 assert.equal(result.markedNavQuote,String(s.nav));
 if(result.terminalCashQuote!==null&&result.holdTerminalCashQuote!==null){const cash=BigInt(result.terminalCashQuote)-s.nav,h=BigInt(result.holdTerminalCashQuote)-s.holdValue,gas=BigInt(result.terminalExitCostQuote);add(bucket(s.weekly,s.lastWeek,lastSource.at),lastSource.at,cash,h,0n,gas,0);add(bucket(s.regimes,'terminal_liquidation',lastSource.at),lastSource.at,cash,h,0n,gas,0);}
 result.weekly=[...s.weekly.values()];result.regimes=[...s.regimes.values()];
 for(const rows of [result.weekly,result.regimes]){assert.equal(rows.reduce((n,r)=>n+r.navChangeQuote,0n),BigInt(result.terminalCashQuote??result.markedNavQuote)-budget);if(result.alphaQuote!==null)assert.equal(rows.reduce((n,r)=>n+r.alphaQuote,0n),BigInt(result.alphaQuote));}
 results.push(result);
}
writeFileSync(out+'/results.json',json({symbol,budgetQuote:budgetText,fromAt:firstAt,toAt:lastSource.at,events:processed,blocks,results,forecastMetrics:[...forecastMetrics.values()],canonicalEndVerified:true,executionEligible:false,promotionEligible:false})+'\n');
writeFileSync(out+'/completed.json',json({completedAt:new Date().toISOString(),rows:results.length,resultsSha256:hash(readFileSync(out+'/results.json'))})+'\n');
console.log(json({stage:'completed',symbol,budgetQuote:budgetText,rows:results.length,output:out}));
