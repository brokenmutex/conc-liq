// Offline forecast/trigger ablation. Original source and replay stay frozen.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {AdaptiveLpReplay} from '../src/research/adaptive-lp.ts';
import {AgileLpReplay} from '../src/research/agile-lp.ts';
import {TrailingForecast} from '../src/research/adaptive-forecast.ts';
import {agileForecastStats} from '../src/research/agile-forecast.ts';
import {marketTokens,marketValue} from '../src/paper/market.ts';
import {historicalSwapQuote} from '../src/research/portfolio-math.ts';
import {auditAgileActions} from './audit-agile-lp.mjs';

const [symbol,root='data/adaptive-lp-agility-2026-09-14',planPath='notes/adaptive-lp-agility-2026-09-14/plan.json']=process.argv.slice(2);
const read=p=>JSON.parse(readFileSync(p)),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);
const plan=read(planPath),source=plan.sourceDirectory;
assert(plan.symbols.includes(symbol));
for(const [p,h] of Object.entries(plan.sourceHashes))assert.equal(hash(p),h);
const prior=read('notes/adaptive-lp-study-2026-09-13/manifest.json');
for(const [p,h] of Object.entries(prior.code))assert.equal(hash(p),h,'Frozen original code changed: '+p);
const complete=read(source+'/completed.json'),meta=read(source+'/capture.json'),inclusion=read(source+'/inclusion.json');
assert.equal(hash(source+'/capture.json'),complete.captureSha256);
assert.equal(inclusion.captureSha256,complete.captureSha256);
assert(complete.canonicalEndsVerified&&complete.indexedDbLogsExactMatch);
const asset={...meta.assets.find(a=>a.symbol===symbol),...inclusion.included.find(a=>a.symbol===symbol)};
assert(asset.pages&&asset.costs&&asset.market.pool.toLowerCase()===asset.pool.toLowerCase());
for(const [p,h] of Object.entries(asset.evidenceHashes))assert.equal(hash(p),h);
const memo=read(source+'/memo-validation/certificate.json');
assert(memo.exhaustivePassed&&memo.quoteConformancePassed&&memo.controlByteIdentical);
for(const [p,h] of Object.entries({'scripts/lp-tick-memo-hook.mjs':memo.hookSha256,'scripts/lp-empty-quote-hook.mjs':memo.quoteHookSha256,'src/backtest/principal.ts':memo.sourceSha256,'src/research/portfolio-math.ts':memo.quoteSourceSha256,[source+'/memo-validation/exhaustive.json']:memo.exhaustiveSha256,[source+'/memo-validation/quote-conformance.json']:memo.quoteConformanceSha256,[memo.controlResult]:memo.controlSha256,[memo.originalResult]:memo.controlSha256}))assert.equal(hash(p),h);
const out=root+'/'+symbol;mkdirSync(out,{recursive:true});assert(!existsSync(out+'/manifest.json'),'Output already started; use a new root');
const paths=[...Object.keys(prior.code),'src/research/agile-forecast.ts','src/research/agile-lp.ts','scripts/agile-lp-study.mjs','scripts/audit-agile-lp.mjs','scripts/lp-tick-memo-hook.mjs','scripts/lp-empty-quote-hook.mjs'];
const code=Object.fromEntries(paths.map(p=>[p,hash(p)]));
const manifest={createdAt:new Date().toISOString(),symbol,planPath,planSha256:hash(planPath),sourceHashes:plan.sourceHashes,code,execArgv:process.execArgv,executionEligible:false,promotionEligible:false};
writeFileSync(out+'/manifest.json',json(manifest)+'\n',{flag:'wx'});

const start=Date.parse(plan.from),warmup=Date.parse(plan.warmupFrom),end=Date.parse(plan.to),budget=BigInt(plan.budgetQuote),Q=1n<<128n;
const book=new ExperimentMarket(asset.seed),costs=Object.fromEntries(Object.entries(asset.costs).map(([k,v])=>[k,BigInt(v)]));
const models=plan.scenarios.flatMap(scenario=>plan.arms.map(arm=>{
  const policy={halfWidthsTicks:plan.halfWidthsTicks,adaptive:true,economicGate:true,budget,decisionMs:plan.decisionMs,quoteTtlMs:plan.quoteTtlMs,horizonMs:plan.horizonMs,slippageBps:plan.slippageBps,...plan.economicGate,...scenario,name:arm.name};
  return {arm,scenario,model:arm.early?new AgileLpReplay(asset.market,costs,policy,plan.early):new AdaptiveLpReplay(asset.market,costs,policy),daily:new Map(),nav:budget,holdNav:budget,invalidAt:null};
}));
const trailing=new TrailingForecast(),availability=Object.fromEntries(plan.arms.map(a=>[a.name,{available:0,unavailable:0}]));
let lastSample=null,growth0=0n,growth1=0n,statsByArm=null,last=null,hold=null,firstAt=null,processed=0,blocks=0,lastLog=Date.now(),auditSeed=null;
let savedEvents=[],eventPages=[],savedIndex=0,commonUnavailable=0;
function saveEvents(){if(!savedEvents.length)return;const file=`events-${savedIndex++}.json.gz`;writeFileSync(out+'/'+file,gzipSync(json(savedEvents)),{flag:'wx'});eventPages.push({file,sha256:hash(out+'/'+file),events:savedEvents.length});savedEvents=[];}
const add=(map,key,nav,hold)=>{const b=map.get(key)??{day:key,navChangeQuote:0n,holdChangeQuote:0n};b.navChangeQuote+=nav;b.holdChangeQuote+=hold;map.set(key,b);};
async function block(events){
  const at=events[0].at;assert(events.every(e=>e.at===at));assert(at<end);
  if(at>=warmup&&auditSeed===null)auditSeed=book.seed();
  if(at>=warmup){savedEvents.push(...events);if(savedEvents.length>=25000)saveEvents();}
  for(const e of events){
    for(const {segment,protocol} of book.apply(e)){
      const growth=segment.liquidity?(segment.fee-(protocol?segment.fee/BigInt(protocol):0n))*Q/segment.liquidity:0n;
      if(segment.token===0)growth0+=growth;else growth1+=growth;
      if(hold)for(const r of models)r.model.accrue(segment,protocol);
    }
    processed++;
  }
  blocks++;
  if(at<warmup)return;
  const m={...book.source(),at,block:events[0].block};
  if(lastSample===null||at-lastSample>=plan.sampleMs){
    trailing.observe({at,price:m.price,growth0,growth1});lastSample=at;
    const baseline=trailing.stats(at);
    statsByArm=Object.fromEntries(plan.arms.map(a=>[a.name,a.forecast?agileForecastStats(trailing.samples,at,a.forecast):baseline]));
  }
  // Cache only immutable estimates; explicitly reapply timestamp freshness.
  const fresh=at-lastSample<=90000,common=fresh&&Object.values(statsByArm).every(Boolean);
  if(at>=start){
    for(const a of plan.arms)availability[a.name][fresh&&statsByArm[a.name]?'available':'unavailable']++;
    if(!common)commonUnavailable++;
    if(!hold&&common&&m.liquidity>0n){
      const q0=marketTokens(asset.market).quoteIsToken0;
      try{const q=historicalSwapQuote(m,budget/2n,q0?0:1,plan.slippageBps);if(q.fullyFilled&&q.passesSlippage){hold={amount0:q0?budget-budget/2n:q.amountOut,amount1:q0?q.amountOut:budget-budget/2n};firstAt=at;}}catch{/* Shared benchmark remains cash until its acquisition is feasible. */}
    }
    if(hold)for(const r of models){
      await r.model.step(m,common?statsByArm[r.arm.name]:null);
      if(r.model.invalid)r.invalidAt??=at;
      const b=r.model.balances(m),nav=marketValue(asset.market,m.price,b.amount0,b.amount1)-r.model.gas;
      const holdNav=marketValue(asset.market,m.price,hold.amount0,hold.amount1)-r.model.cost('hold');
      add(r.daily,new Date(at).toISOString().slice(0,10),nav-r.nav,holdNav-r.holdNav);r.nav=nav;r.holdNav=holdNav;
    }
  }
  last=m;
  if(Date.now()-lastLog>30000){console.log(json({stage:'replay',symbol,at:new Date(at).toISOString(),events:processed,blocks}));lastLog=Date.now();}
}
let pending=[],previous=null;
for(const page of asset.pages){
  assert.equal(hash(source+'/'+page.file),page.sha256);
  for(const e of JSON.parse(gunzipSync(readFileSync(source+'/'+page.file))).events){
    assert.equal(e.symbol,symbol);if(Number(e.block)<=asset.seedBlock)continue;
    if(previous)assert(BigInt(e.block)>BigInt(previous.block)||e.block===previous.block&&(e.tx>previous.tx||e.tx===previous.tx&&e.log>previous.log));
    previous=e;
    if(pending.length&&pending[0].block!==e.block){await block(pending);pending=[];}pending.push(e);
  }
}
if(pending.length)await block(pending);saveEvents();book.verify(asset.after);assert.equal(book.protocol0,asset.after.protocol0);assert.equal(book.protocol1,asset.after.protocol1);assert(last&&hold&&auditSeed);
const rows=models.map(r=>{
  const result=r.model.summary(last,hold);assert.equal(result.markedNavQuote,String(r.nav));
  if(end-last.at>90000||last.liquidity===0n){result.terminalCashQuote=null;result.holdTerminalCashQuote=null;result.alphaQuote=null;result.netPnlQuote=null;result.terminalExecutable=false;}
  if(result.terminalCashQuote!==null&&result.holdTerminalCashQuote!==null)add(r.daily,'terminal_liquidation',BigInt(result.terminalCashQuote)-r.nav,BigInt(result.holdTerminalCashQuote)-r.holdNav);
  const daily=[...r.daily.values()].map(d=>({...d,alphaQuote:d.navChangeQuote-d.holdChangeQuote}));
  assert.equal(daily.reduce((n,d)=>n+d.navChangeQuote,0n),BigInt(result.terminalCashQuote??result.markedNavQuote)-budget);
  if(result.alphaQuote!==null)assert.equal(daily.reduce((n,d)=>n+d.alphaQuote,0n),BigInt(result.alphaQuote));
  assert.equal(r.model.actions.reduce((n,a)=>n+BigInt(a.gasQuote),0n),r.model.gas);
  return {symbol,scenario:r.scenario.name,budgetQuote:plan.budgetQuote,...result,invalidAt:r.invalidAt,earlyRecenters:result.actions.filter(a=>a.early&&a.kind==='recenter').length,daily};
});
const replaySource={seed:auditSeed,after:book.seed(),market:asset.market,costs:asset.costs,pages:eventPages,firstAt,lastAt:last.at,hold};
writeFileSync(out+'/source.json',json(replaySource)+'\n',{flag:'wx'});
const verification=await auditAgileActions(out,replaySource,rows,plan);
for(const [p,h] of Object.entries(code))assert.equal(hash(p),h,'Code changed during run: '+p);
const result={symbol,from:plan.from,to:plan.to,firstAt,lastAt:last.at,events:processed,blocks,availability,commonUnavailable,rows,verification,planSha256:manifest.planSha256,sourceSha256:hash(out+'/source.json'),executionEligible:false,promotionEligible:false};
writeFileSync(out+'/results.json',json(result)+'\n',{flag:'wx'});
writeFileSync(out+'/completed.json',json({completedAt:new Date().toISOString(),rows:rows.length,resultsSha256:hash(out+'/results.json'),manifestSha256:hash(out+'/manifest.json')})+'\n',{flag:'wx'});
console.log(json({stage:'complete',symbol,rows:rows.length,verification,output:out}));
