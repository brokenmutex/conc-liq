import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../src/experiment/market.ts';
const [root]=process.argv.slice(2);assert(root);const read=p=>JSON.parse(readFileSync(p)),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);
const source='data/adaptive-lp-universe-study-2026-09-13',meta=read(source+'/capture.json'),inc=read(source+'/inclusion.json'),done=read(source+'/completed.json'),cal=read(root+'/calibration.json');
assert.equal(done.captureSha256,hash(source+'/capture.json'));assert(done.canonicalEndsVerified);
const plan={version:'small_budget_matched_v1',createdAt:new Date().toISOString(),symbols:['AAPL','QQQ','NVDA'],from:'2026-08-30T00:00:00Z',to:'2026-09-11T19:30:00Z',warmupFrom:'2026-08-29T18:00:00Z',widths:[20,80,160],adaptiveWidths:[20,40,80,160],forecast:{lookbackMs:21600000,minimumSpanMs:7200000,maximumGapMs:900000,sampleMs:60000,horizonMs:600000},decisionMs:5000,quoteTtlMs:90000,slippageBps:50,costBufferPpm:500000,feeBufferPpm:250000,budgets:[{name:'all_in_250',lpQuote:'240000000',gasAllowanceQuote:'10000000'},{name:'250_plus_gas',lpQuote:'250000000',gasAllowanceQuote:null}],scenarios:[{name:'receipt_median',profile:'median',gasMultiplier:1,feePpm:1000000},{name:'receipt_p90_delay',profile:'p90',gasMultiplier:1,feePpm:1000000},{name:'double_gas_half_fees',profile:'median',gasMultiplier:2,feePpm:500000}],selection:'Previously named shortlist plus NVDA control; fixed before inspecting new matched-window returns. Higher fee-tier pools retained in capacity screen, outside fee-500 replay mechanics.',accounting:'Staged withdrawal, net swap, mint. No LP fees without a position. Same forecast-availability requirement for all policies. All-in budget reserves 10 USDG of gas purchasing power, stops and attempts liquidation before next bundle would consume its exit reserve. Terminal exit priced at last fresh source; no historical eligibility is inferred.',limitations:['Timing is transferred from a small NVDA sample; p90 includes halted mint recovery.','Stage attempt gas is charged even on preflight rejection; it is an adverse assumption, not broadcast evidence.','Mint re-quotes current held inventory and uses a frozen range; no modeled delay between that fresh mint quote and inclusion.','Terminal and gas-budget exits quote at decision source; their wall-clock delay and infrastructure outage paths are not replayed.','Historical flow and competing liquidity stay fixed. Historical independent references unavailable.','Reserve is fixed USDG purchasing power, not a mark-to-market ETH portfolio.'],sourceHashes:Object.fromEntries([source+'/capture.json',source+'/completed.json',source+'/inclusion.json',root+'/screen.json',root+'/calibration.json',root+'/references.json'].map(p=>[p,hash(p)])),executionEligible:false,promotionEligible:false};
// Fork ratios require no USD conversion: every proof uses one pinned block and
// asset-specific measured gas. Receipt USDG distributions supply the cost level.
const bundles={};
for(const symbol of plan.symbols){const path=root+`/fork-${symbol}.json`,f=read(path);assert.equal(hash(path),readFileSync(path+'.sha256','utf8').trim());assert(f.passed);assert.equal(f.policy.budgetQuote,'240000000');const rt=f.stages.roundTrip.proof,rc=f.stages.recenter.proof,ex=f.stages.restoredExit.proof;const buy=rt.transactions.findIndex(t=>t.action==='buy_nvda');assert(buy>=0);
 bundles[symbol]={entry:BigInt(rt.entryGasWei),recenter:BigInt(rc.totalGasWei),exit:BigInt(ex.totalGasWei),hold:rt.transactions.slice(0,buy+1).reduce((n,t)=>n+BigInt(t.estimate.totalFeeWei),0n),holdExit:ex.transactions.filter(t=>['approve_exit_swap','sell_nvda'].includes(t.action)).reduce((n,t)=>n+BigInt(t.estimate.totalFeeWei),0n)};plan.sourceHashes[path]=hash(path);
}
plan.costs={};plan.profiles={};
for(const profile of ['median','p90']){
 plan.costs[profile]={};plan.profiles[profile]={};
 for(const kind of ['entry','recenter']){const p=cal.groups[kind].profiles[profile];plan.profiles[profile][kind]={withdrawMs:p.withdrawMs??0,swapMs:p.swapMs??0,mintMs:p.mintMs,stageGasQuote:p.stageGasQuote,gasQuote:p.gasQuote};assert(p.mintMs>0);}
 for(const symbol of plan.symbols){const costs={};for(const kind of ['entry','recenter','exit']){const observed=BigInt(Math.ceil(cal.groups[kind].gasQuote[profile]));costs[kind]=(observed*bundles[symbol][kind]+bundles.NVDA[kind]-1n)/bundles.NVDA[kind];}
  costs.hold=costs.entry*bundles[symbol].hold/bundles[symbol].entry;costs.holdExit=costs.exit*bundles[symbol].holdExit/bundles[symbol].exit;
  plan.costs[profile][symbol]=costs;
 }
}
if(existsSync(root+'/plan.json')){const old=read(root+'/plan.json'),expected=JSON.parse(json(plan));delete old.createdAt;delete expected.createdAt;assert.deepEqual(old,expected,'Frozen plan changed');}
else writeFileSync(root+'/plan.json',json(plan)+'\n',{flag:'wx'});
mkdirSync(root+'/sources-v2',{recursive:true});
for(const symbol of plan.symbols){
 const a=meta.assets.find(a=>a.symbol===symbol),i=inc.included.find(a=>a.symbol===symbol),book=new ExperimentMarket(a.seed);let seed=null,events=[],pending=[],previous=null,readEvents=0,windowEvents=0,pages=[];
 const flush=()=>{if(!events.length)return;const file=`sources-v2/${symbol}-${pages.length}.json.gz`;writeFileSync(root+'/'+file,gzipSync(json(events)));pages.push({file,sha256:hash(root+'/'+file),events:events.length});events=[];};
 const apply=()=>{if(!pending.length)return;const at=pending[0].at;if(at>=Date.parse(plan.warmupFrom)&&!seed){seed=book.seed();assert(previous);}
  for(const e of pending){book.apply(e);readEvents++;if(seed){const {block,hash,tx,log,name,args,at}=e;events.push({block,hash,tx,log,name,args,at});windowEvents++;if(events.length>=10000)flush();}}previous={block:pending[0].block,at};pending=[];
 };
 for(const page of i.pages){const path=source+'/'+page.file;assert.equal(hash(path),page.sha256);for(const e of JSON.parse(gunzipSync(readFileSync(path))).events){if(pending.length&&pending[0].block!==e.block)apply();pending.push(e);}}
 apply();assert(seed);book.verify(a.after);assert.equal(book.protocol0,a.after.protocol0);assert.equal(book.protocol1,a.after.protocol1);
 flush();const output={symbol,market:a.market,seed,after:a.after,pages,sourceCaptureSha256:done.captureSha256,fullSourceEventsChecked:readEvents};
 writeFileSync(root+'/sources-v2/'+symbol+'.json',json(output)+'\n');
 console.log(json({stage:'matched_source',symbol,fullSourceEventsChecked:readEvents,windowEvents}));
}
writeFileSync(root+'/prepared.json',json({planSha256:hash(root+'/plan.json'),sources:Object.fromEntries(plan.symbols.map(s=>[s,hash(root+'/sources-v2/'+s+'.json')])),code:Object.fromEntries(['src/research/small-budget-lp.ts','src/research/adaptive-lp.ts','src/research/adaptive-forecast.ts','scripts/lp-small-budget-prepare.mjs'].map(p=>[p,hash(p)]))})+'\n',{flag:'wx'});
