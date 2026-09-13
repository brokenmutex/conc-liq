import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getAddress} from 'viem';
import {canonicalBalances,namedBalances,marketTokens,marketValue,marketPriceX18,marketRange,NVDA_PAPER_MARKET,type PaperMarket} from '../src/paper/market.js';
import {paperPolicy} from '../src/paper/config.js';
import {closedPaperCash,continuationPolicy} from '../src/paper/reentry.js';
import {initialPaperState} from '../src/paper/engine.js';
import {sessionPerformance,type SessionMark} from '../src/paper/session-performance.js';
import {buildPaperExit} from '../src/paper/position-exit.js';
import {buildCanaryExit} from '../src/canary-plan/exit.js';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import type {PaperSessionRow} from '../src/paper/store.js';
import {evaluatePaperReference} from '../src/paper/reference.js';
import {readFileSync} from 'node:fs';
const reverse:PaperMarket={...NVDA_PAPER_MARKET,symbol:'GOOGL',rwa:getAddress('0x1111111111111111111111111111111111111111'),pool:getAddress('0x2222222222222222222222222222222222222222')};
const markets=[NVDA_PAPER_MARKET,reverse];
test('USDG valuation and raw balances are invariant to canonical token ordering',()=>{
 for(const m of markets){const p=marketTokens(m).quoteIsToken0?(1n<<96n)*100000n:(1n<<96n)/100000n;
  const b=canonicalBalances(m,500000000n,2n*10n**18n);assert.deepEqual(namedBalances(m,b.amount0,b.amount1),{quote:500000000n,rwa:2n*10n**18n});
  assert(marketValue(m,p,b.amount0,b.amount1)>=699999999n&&marketValue(m,p,b.amount0,b.amount1)<=700000000n);
  assert(marketPriceX18(m,p)>=99999999000000000000n&&marketPriceX18(m,p)<=100000000000000000000n);
 }
 assert.equal(marketTokens(reverse).token0,reverse.rwa);assert.equal(marketTokens(NVDA_PAPER_MARKET).quoteIsToken0,true);
});
test('range selection keeps the nearest grid center on either side of zero',()=>{
 for(const tick of [-223001,-223000,-7,7,223001]){const r=marketRange(sqrtRatioAtTick(tick),tick,20,10);assert.equal(r.tickUpper-r.tickLower,40);assert.equal(Math.abs(r.tickLower%10),0);assert(tick>=r.tickLower&&tick<r.tickUpper);}
 assert.throws(()=>marketRange(sqrtRatioAtTick(10),10,20,60),/tick spacing/);
});
test('reversed cash exits fund continuation from token1 and reject asset changes',()=>{
 const policy=paperPolicy({market:reverse,reentry:{cooldownSeconds:600}}),state=initialPaperState();
 Object.assign(state,{status:'closed',action:'exit',costsPaidQuote:'1000',exitReserveQuote:'0',navQuote:'999999000',pnlQuote:'-1000',
  position:{liquidity:'0',idle0:'0',idle1:'1000000000',fee0:'0',fee1:'0'},execution:{exitRunId:'10'}});
 const row={id:'1',policy,state} as PaperSessionRow;
 assert.equal(closedPaperCash(row),'999999000');assert.equal(continuationPolicy(row,policy).budgetQuote,'999999000');
 assert.throws(()=>continuationPolicy(row,paperPolicy({reentry:{cooldownSeconds:600}})),/market changed/);
 state.position!.idle0='1';assert.throws(()=>closedPaperCash(row),/residual inventory/);
});
test('session fees and swap shortfall agree across reversed orderings',()=>{
 const reports=markets.map(m=>{
  const b=canonicalBalances(m,900000000n,100000000n),f=canonicalBalances(m,2000000n,0n);
  const p={liquidity:'0',tickLower:-20,tickUpper:20,idle0:String(b.amount0),idle1:String(b.amount1),fee0:'0',fee1:'0',hold0:String(b.amount0),hold1:String(b.amount1),enteredAt:'2026-09-11T14:00:00Z'};
  const mark:SessionMark={id:'1',sessionId:'1',sourceAt:'2026-09-11T14:00:00Z',observedAt:'2026-09-11T14:00:01Z',block:'1',action:'enter',status:'open',tick:0,sqrtPriceX96:String(1n<<96n),navQuote:'999000000',holdQuote:'999000000',costsPaidQuote:'1000000',exitReserveQuote:'0',earnedFee0:String(f.amount0),earnedFee1:String(f.amount1),position:p};
  return sessionPerformance([{id:'1',market:m,budgetQuote:'1000000000',createdAt:'2026-09-11T13:59:00Z'}],[mark],[{sessionId:'1',block:'1',runId:'1',token:0,amountIn:'101000000',amountOut:'100000000'}]);
 });
 for(const r of reports){assert.equal(r.timeline[0].usdg,'900000000');assert.equal(r.timeline[0].nvda,'100000000');assert.equal(r.grouped.find(b=>b.key==='market')!.feeIncomeQuote,'2000000');assert.equal(r.grouped.find(b=>b.key==='market')!.swapCostVsSpotQuote,'1000000');}
});
test('generic paper exit validates actual tokens while live canary keeps NVDA restriction',()=>{
 const tokens=marketTokens(reverse),input={operator:reverse.rwa,owner:reverse.rwa,tokenId:1n,source:{rwaSymbol:reverse.symbol,rwaAddress:reverse.rwa,fee:500,...tokens},position:{...tokens,fee:500,tickLower:-20,tickUpper:20,liquidity:1000000n},sqrtPriceX96:1n<<96n,blockTimestamp:1n,slippageBps:50,ttlSeconds:300};
 assert(buildPaperExit(input).calldata.startsWith('0x'));assert.throws(()=>buildCanaryExit(input),/NVDA/);
 assert.throws(()=>buildPaperExit({...input,source:{...input.source,rwaAddress:NVDA_PAPER_MARKET.rwa}}),/selected asset/);
});
test('a different asset cannot inherit NVDA risk approval',()=>{
 const saved=JSON.parse(readFileSync(new URL('./fixtures/paper-usdg-session-37.json',import.meta.url),'utf8'));
 const r=evaluatePaperReference({...saved,checkpoint:{...saved.checkpoint,market:reverse}});assert.equal(r.eligible,false);assert.deepEqual(r.reasons,['paper_asset_risk_missing']);
});

test('restoration funds exact original liquidity despite manager intermediate rounding',async()=>{
 const {restorationFunding}=await import('../src/paper/execution-exit.js');
 const {replayPaperMint}=await import('../src/research/management-audit.js');
 for(const tick of [-300000,-230001,-200000,0,200000,230001,300000])for(const liquidity of [1000n,1000000000000000n,98765432123456789n]){
  const price=sqrtRatioAtTick(tick),range=marketRange(price,tick,20,10),fund=restorationFunding(price,range,liquidity);
  assert(replayPaperMint(price,range,fund.amount0,fund.amount1,0n).liquidity>=liquidity);
 }
});
