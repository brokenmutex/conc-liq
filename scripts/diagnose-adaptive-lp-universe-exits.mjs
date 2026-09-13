// Explain passive terminal-quote failures using the frozen canonical book.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {historicalSwapQuote} from '../src/research/portfolio-math.ts';
import {marketTokens} from '../src/paper/market.ts';
const [root='data/adaptive-lp-universe-study-2026-09-13',symbol='SLV']=process.argv.slice(2);
const read=p=>JSON.parse(readFileSync(p)),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const meta=read(root+'/capture.json'),inc=read(root+'/inclusion.json'),output=root+'/passive-exit-'+symbol+'.json';
assert.equal(hash(root+'/capture.json'),inc.captureSha256);assert(!existsSync(output));
assert(inc.included.some(a=>a.symbol===symbol));
const asset={...meta.assets.find(a=>a.symbol===symbol),...inc.included.find(a=>a.symbol===symbol)};
const book=new ExperimentMarket(asset.seed),q0=marketTokens(asset.market).quoteIsToken0,holds=[];
function apply(events){
 for(const e of events)book.apply(e);
 if(events[0].block===asset.availability.block)for(const budget of meta.plan.budgetsQuote){
  const q=historicalSwapQuote(book.source(),BigInt(budget)/2n,q0?0:1,meta.plan.slippageBps);
  assert(q.fullyFilled&&q.passesSlippage);holds.push({budgetQuote:budget,stockAmount:q.amountOut});
 }
}
let pending=[];
for(const page of asset.pages){
 const path=root+'/'+page.file;assert.equal(hash(path),page.sha256);
 for(const e of JSON.parse(gunzipSync(readFileSync(path))).events){
  assert.equal(e.symbol,symbol);
  if(pending.length&&e.block!==pending[0].block){apply(pending);pending=[];}pending.push(e);
 }
}
if(pending.length)apply(pending);book.verify(asset.after);assert.equal(holds.length,meta.plan.budgetsQuote.length);
const resultHashes={},rows=holds.map(h=>{
 const exit=historicalSwapQuote(book.source(),h.stockAmount,q0?1:0,meta.plan.slippageBps);
 const path=root+'/runs/'+symbol+'-'+h.budgetQuote+'/results.json';resultHashes[path]=hash(path);
 for(const r of read(path).results){
  const mult=BigInt(meta.plan.scenarios.find(s=>s.name===r.scenario).gasMultiplier);
  const cash=exit.fullyFilled&&exit.passesSlippage?String(BigInt(h.budgetQuote)-BigInt(h.budgetQuote)/2n+exit.amountOut-(BigInt(asset.costs.hold)+BigInt(asset.costs.holdExit))*mult):null;
  assert.equal(r.holdTerminalCashQuote,cash);
 }
 return {...h,exit,outputShortfallBps:Number(exit.outputShortfall)*10000/Number(exit.idealOutput)};
});
writeFileSync(output,JSON.stringify({symbol,availability:asset.availability,slippageLimitBps:meta.plan.slippageBps,canonicalEndVerified:true,allReportedPassiveTerminalCashVerified:true,captureSha256:inc.captureSha256,inclusionSha256:hash(root+'/inclusion.json'),diagnosticCodeSha256:hash('scripts/diagnose-adaptive-lp-universe-exits.mjs'),resultHashes,rows,scope:'Separate canonical reconstruction of the passive acquisition and terminal sale at each size. No strategy decisions or parameters changed.'},(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n');
console.log(JSON.stringify({symbol,rows:rows.map(r=>({budgetQuote:r.budgetQuote,fullyFilled:r.exit.fullyFilled,passesSlippage:r.exit.passesSlippage,outputShortfallBps:r.outputShortfallBps}))}));
