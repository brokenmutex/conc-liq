// Freeze evidence inclusion and prove retained control identity before added-asset strategy runs.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {verifyUniverseSources} from './verify-adaptive-lp-universe-source.mjs';
import {paperGasQuote} from '../src/paper/transaction-engine.ts';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {marketTokens} from '../src/paper/market.ts';
import {historicalSwapQuote} from '../src/research/portfolio-math.ts';
const root=process.argv[2]??'data/adaptive-lp-universe-study-2026-09-13',read=p=>JSON.parse(readFileSync(p)),hash=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v,2);
assert(!existsSync(root+'/inclusion.json'));verifyUniverseSources(root);
const meta=read(root+'/capture.json'),done=read(root+'/completed.json'),plan=meta.plan,oldRoot='data/adaptive-lp-long-study-2026-09-13',old=read(oldRoot+'/capture.json'),oldDone=read(oldRoot+'/completed.json');
assert.equal(done.captureSha256,hash(readFileSync(root+'/capture.json')));assert(done.canonicalEndsVerified&&done.indexedDbLogsExactMatch);
assert.equal(hash(readFileSync(meta.planPath)),done.planSha256);assert.deepEqual(plan,read(meta.planPath));for(const [p,h] of Object.entries(plan.sourceHashes)){assert.equal(hash(readFileSync(p)),h);assert.equal(hash(readFileSync(root+'/'+p.split('/').at(-1))),h);}
for(const k of ['from','to','warmupFrom','budgetsQuote','halfWidthsTicks','forecast','decisionSeconds','forecastSampleSeconds','quoteTtlSeconds','slippageBps','economicGate','scenarios'])assert.deepEqual(plan[k],old.plan[k]);
const referencePath='data/asset-expansion-2026-09-13/candidate-references.json',references=read(referencePath);
const valuation=old.assets[0].costValuation,controls=['AAPL','GOOGL'],included=[],excluded=[],books=new Map(meta.assets.map(a=>[a.symbol,new ExperimentMarket(a.seed)])),availability=new Map();
const digestEvent=(h,e)=>h.update(JSON.stringify([e.symbol,e.block,e.hash,e.tx,e.log,e.at,e.transactionHash,e.rawData,e.rawTopics])+'\n');
const oldHashes=new Map(controls.map(s=>[s,createHash('sha256')])),newHashes=new Map(controls.map(s=>[s,createHash('sha256')]));
for(const page of oldDone.pages){const raw=readFileSync(oldRoot+'/'+page.file);assert.equal(hash(raw),page.sha256);for(const e of JSON.parse(gunzipSync(raw)).events)digestEvent(oldHashes.get(e.symbol),e);}
const assetPages=new Map(meta.assets.map(a=>[a.symbol,[]]));mkdirSync(root+'/asset-pages',{recursive:true});
let pending=new Map(meta.assets.map(a=>[a.symbol,[]]));
function applyBlock(events){const a=meta.assets.find(a=>a.symbol===events[0].symbol),book=books.get(a.symbol),at=events[0].at;if(availability.has(a.symbol))return;for(const e of events)book.apply(e);if(at<Date.parse(plan.from))return;
 try{const source=book.source(),q=historicalSwapQuote(source,BigInt(plan.budgetsQuote[0])/2n,marketTokens(a.market).quoteIsToken0?0:1,plan.slippageBps);if(source.liquidity>0n&&q.fullyFilled&&q.passesSlippage)availability.set(a.symbol,{at,block:events[0].block,liquidity:String(source.liquidity)});}catch{/* Not executable at this observation; retain cash. */}
}
for(const page of done.pages){const raw=readFileSync(root+'/'+page.file);assert.equal(hash(raw),page.sha256);const events=JSON.parse(gunzipSync(raw)).events;for(const a of meta.assets){const subset=events.filter(e=>e.symbol===a.symbol&&Number(e.block)>a.seedBlock);if(subset.length){const file=`asset-pages/${a.symbol}-${page.from}.json.gz`,compressed=gzipSync(JSON.stringify({events:subset}));writeFileSync(root+'/'+file,compressed);assetPages.get(a.symbol).push({file,events:subset.length,sha256:hash(compressed),canonicalPageSha256:page.sha256});}}for(const e of events){if(newHashes.has(e.symbol))digestEvent(newHashes.get(e.symbol),e);const a=meta.assets.find(a=>a.symbol===e.symbol);if(Number(e.block)<=a.seedBlock)continue;let batch=pending.get(e.symbol);if(batch.length&&batch[0].block!==e.block){applyBlock(batch);batch=[];pending.set(e.symbol,batch);}batch.push(e);}}
for(const batch of pending.values())if(batch.length)applyBlock(batch);
const controlIdentities={};
for(const symbol of controls){const a=meta.assets.find(a=>a.symbol===symbol),b=old.assets.find(a=>a.symbol===symbol),normalize=s=>({...s,ticks:[...s.ticks].sort((a,b)=>a.tick-b.tick)});assert.deepEqual(normalize(a.seed),normalize(b.seed));assert.deepEqual(a.after,b.after);assert.deepEqual(a.market,b.market);const h=oldHashes.get(symbol).digest('hex');assert.equal(newHashes.get(symbol).digest('hex'),h);controlIdentities[symbol]={normalizedRawEventsSha256:h,seedAndEndIdentical:true};}
for(const a of meta.assets){const forkPath=root+(a.symbol==='TSLA'?'/wide-cost-probe':'')+`/fork-${a.symbol}.json`,raw=readFileSync(forkPath),fork=JSON.parse(raw);assert.equal(hash(raw),readFileSync(forkPath+'.sha256','utf8').trim());assert.equal(fork.source.block,valuation.sourceBlock);assert.equal(fork.source.hash,valuation.sourceHash);assert.deepEqual(fork.policy.market,a.market);
 const reasons=[];for(const k of ['roundTrip','restoredExit','recenter'])if(!fork.stages[k]?.passed)reasons.push('missing_'+k+'_cost_proof');if(!availability.has(a.symbol))reasons.push('no_common_largest_budget_entry');
 if(reasons.length){excluded.push({symbol:a.symbol,reasons});continue;}
 const rt=fork.stages.roundTrip.proof,rc=fork.stages.recenter.proof,ex=fork.stages.restoredExit.proof,buyIndex=rt.transactions.findIndex(t=>t.action==='buy_nvda');assert(buyIndex>=0);
 const buy=rt.transactions.slice(0,buyIndex+1).reduce((n,t)=>n+BigInt(t.estimate.totalFeeWei),0n),sell=ex.transactions.filter(t=>['approve_exit_swap','sell_nvda'].includes(t.action)).reduce((n,t)=>n+BigInt(t.estimate.totalFeeWei),0n);
 const costs=Object.fromEntries(Object.entries({entry:rt.entryGasWei,recenter:rc.totalGasWei,exit:ex.totalGasWei,hold:buy,holdExit:sell}).map(([k,v])=>{assert(BigInt(v)>0n);return[k,String(paperGasQuote(String(v),valuation))];}));
 const retained=controls.includes(a.symbol);if(retained)assert.deepEqual(costs,old.assets.find(x=>x.symbol===a.symbol).costs);
 included.push({symbol:a.symbol,referenceAtDiscovery:references.rows.find(r=>r.pool===a.pool)?.reference??null,pages:assetPages.get(a.symbol),costs,costValuation:valuation,forkPath,completeTransactionStages:true,canonicalBoundariesInitialized:fork.passed,forkHalfWidthTicks:fork.policy.halfWidthSpacings*10,availability:availability.get(a.symbol),evidenceHashes:{[forkPath]:hash(raw)},...(retained?{retainedRunRoot:oldRoot+'/runs',priorControlIdentityVerified:true}: {})});
}
const out={referenceSnapshot:{path:referencePath,sha256:hash(readFileSync(referencePath)),anchor:references.anchor},sourceVerificationSha256:hash(readFileSync(root+'/source-verification.json')),planSha256:done.planSha256,captureSha256:done.captureSha256,retainedCaptureSha256:oldDone.captureSha256,controlIdentities,included,excluded,screeningUniverse:read(root+'/universe.json').rows.map(a=>({symbol:a.symbol,pool:a.pool,fee:a.fee,createdBlock:a.createdBlock,inStudy:included.some(x=>x.symbol===a.symbol&&a.fee===500),reasons:included.some(x=>x.symbol===a.symbol&&a.fee===500)?[]:(a.reasons.length?a.reasons:read(root+'/history-screen.json').rows.find(x=>x.pool===a.pool)?.screenReasons??['outside_frozen_screen'])})),createdAt:new Date().toISOString(),executionEligible:false,promotionEligible:false};
writeFileSync(root+'/inclusion.json',json(out)+'\n');console.log(json({included:included.map(a=>({symbol:a.symbol,costs:a.costs,availability:a.availability})),excluded}));
