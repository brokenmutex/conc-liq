import assert from "node:assert/strict";
import {describe,it} from "node:test";
import {sqrtRatioAtTick} from "../src/backtest/principal.js";
import {nvdaPriceX18} from "../src/research/range-screen.js";
import {positionAmounts,historicalSwapQuote,modeledFeeGrowth,nvdaValueQuote} from "../src/research/portfolio-math.js";
import {ResearchPortfolio,type PortfolioMarket} from "../src/research/portfolio.js";
import {sessionReferenceAt} from "../src/research/session-reference.js";
import type {OracleFeedMetadata} from "../src/risk/domain.js";
import type {PublishedOracleRound} from "../src/research/historical-reference.js";

const tick=222220,price=sqrtRatioAtTick(tick),reference=nvdaPriceX18(price);
function market(at=1000,t=tick):PortfolioMarket {return {at,price:sqrtRatioAtTick(t),tick:t,liquidity:10n**22n,
 fee:500,spacing:10,ticks:[],net:()=>0n,referenceX18:reference,referenceMode:"active_session",tokenSafe:true};}
function portfolio(cost=0n,mode:"fixed"|"persistent70"="persistent70") {return new ResearchPortfolio(1000n*1000000n,reference,
 {halfWidthTicks:20,mode,transactionCostQuote:cost,feeIncomePpm:1000000});}

describe("self-financing research portfolio",()=>{
 it("rounds mint funding up and burned principal down at all range locations",()=>{
  const range={tickLower:tick-20,tickUpper:tick+20};
  for(const t of [tick-30,tick-20,tick,tick+20,tick+30]){
   const up=positionAmounts(sqrtRatioAtTick(t),range,12345678987654321n,true),down=positionAmounts(sqrtRatioAtTick(t),range,12345678987654321n,false);
   for(const key of ["amount0","amount1"] as const)assert(up[key]>=down[key]&&up[key]-down[key]<=1n);
  }
 });
 it("preserves tokens with only rounding dust on a no-motion zero-fee round trip",()=>{
  const p=portfolio();p.decision(market());assert(p.position);
  assert(p.cash>=200000000n);const b=p.balances(price);
  assert(b.amount0<=p.initialCash&&p.initialCash-b.amount0<=1n);
  assert(b.amount1<=p.initialNvda&&p.initialNvda-b.amount1<=1n);
  const r=p.finish(market(1060));assert.equal(r.terminalRemovalCompleted,true);
  assert(BigInt(r.modeledNetAlphaQuoteRaw!)<=0n&&BigInt(r.modeledNetAlphaQuoteRaw!)>=-2n);
 });
 it("charges entry and terminal exit from cash and never resets the budget on reentry",()=>{
  const p=portfolio(250000n);p.decision(market());const initial=p.initialCash;
  p.decision({...market(1060),tokenSafe:false});assert(p.position,"Guard removal must wait 60 seconds");
  p.decision({...market(1120),tokenSafe:false});assert.equal(p.position,null);
  p.decision(market(1180));assert(p.position);const r=p.finish(market(1240));
  assert.equal(r.modeledTransactionCostsQuoteRaw,"1000000");assert(p.cash<initial);
  assert(BigInt(r.modeledNetAlphaQuoteRaw!)<=-1000000n&&BigInt(r.modeledNetAlphaQuoteRaw!)>=-1000004n);
 });
 it("does not credit historical fees before entry; credits only diluted in-range income",()=>{
  const p=portfolio(),s={from:price,to:price,tickBefore:tick,liquidity:100n,fee:1000000n,token:0 as const,crossed:null};
  p.accrue(s,0);assert.equal(p.cash,p.initialCash);p.decision(market());p.accrue(s,4);
  const r=p.finish(market(1060));assert(BigInt(r.modeledFees0Raw)>0n&&BigInt(r.modeledFees0Raw)<=750000n);
 });
 it("shares risk interventions with the fixed-range control and reaches 50% only after delay",()=>{
  for(const mode of ["fixed","persistent70"] as const){
   const p=portfolio(10000n,mode);p.decision(market());const m=market(1060,tick+30);
   p.decision(m);assert(!p.actions.some(a=>a.action==="sell_nvda"));
   p.decision({...m,at:1120});const sale=p.actions.find(a=>a.action==="sell_nvda");assert(sale);
   const b=p.balances(sqrtRatioAtTick(tick+30)),value=nvdaValueQuote(b.amount1,reference);
   assert(value*1000000n/(b.amount0+value)<501000n);assert(BigInt(String(sale.receivedQuoteRaw))>0n);
  }
 });
 it("cancels a delayed inventory intervention if exposure recovers",()=>{
  const p=portfolio();p.decision(market());p.decision(market(1060,tick+30));p.decision(market(1120));
  assert(!p.actions.some(a=>a.action==="sell_nvda"||a.reason==="inventory"));
 });
 it("requires persistence, cooldown and delay before a routine recenter",()=>{
  const p=portfolio();p.decision(market());p.decision(market(1060,tick-16));p.decision(market(1120,tick-16));
  assert.equal(p.actions.filter(a=>a.action==="mint").length,1);
  p.decision(market(1600,tick-16));assert.equal(p.actions.filter(a=>a.action==="mint").length,1);
  p.decision(market(1660,tick-16));assert(p.actions.some(a=>a.reason==="routine_recenter"&&a.action==="mint"));
  assert(!p.actions.some(a=>a.action==="sell_nvda"));
 });
 it("expires a frozen range if price leaves it before execution without paying move costs",()=>{
  const p=portfolio(10000n);p.decision(market());p.decision(market(1060,tick-16));p.decision(market(1600,tick-16));
  p.decision(market(1660,tick-50));const r=p.finish(market(1720,tick-50));
  assert.equal(r.expiredRoutineChanges,1);assert.equal(r.routineMoves,0);assert.equal(r.modeledTransactionCostsQuoteRaw,"20000");
 });
 it("leaves missing terminal valuation unavailable and rejects spending unaffordable costs",()=>{
  const p=portfolio(1000000000n);p.decision(market());assert.equal(p.position,null);
  const r=p.finish({...market(1060),referenceX18:null});assert.equal(r.modeledNetAlphaQuoteRaw,null);assert.equal(r.measuredNetAlphaQuoteRaw,null);
 });
 it("does not act beyond the five-percent guard",()=>{
  const p=portfolio();p.decision({...market(),referenceX18:reference*110n/100n});assert.equal(p.position,null);
 });
});

describe("counterfactual fee and swap accounting",()=>{
 it("dilutes fees, subtracts protocol fees, and excludes external segments",()=>{
  const range={tickLower:-10,tickUpper:10},s={from:sqrtRatioAtTick(0),to:sqrtRatioAtTick(0),tickBefore:0,liquidity:100n,fee:1000n,token:0 as const,crossed:null};
  const earned=modeledFeeGrowth(s,range,100n,4)*100n/(1n<<128n);assert(earned>=374n&&earned<=375n);
  assert.equal(modeledFeeGrowth({...s,tickBefore:10},range,100n,0),0n);
  const partial={...s,from:sqrtRatioAtTick(-20),to:sqrtRatioAtTick(20),liquidity:10n**18n};
  const all=modeledFeeGrowth(partial,{tickLower:-20,tickUpper:20},10n**18n,0),clipped=modeledFeeGrowth(partial,range,10n**18n,0);
  assert(clipped>0n&&clipped<all);
 });
 it("quotes both directions, conserves fee input, and rejects excessive impact",()=>{
  for(const token of [0,1] as const){const m=market();const input=token===0?1000000n:10n**16n;
   const q=historicalSwapQuote(m,input,token);assert(q.fullyFilled&&q.passesSlippage&&q.amountOut>0n&&q.feeInput>0n);
   assert(token===0?q.sqrtPriceAfter<m.price:q.sqrtPriceAfter>m.price);assert.equal(m.price,price);
  }
  assert.equal(historicalSwapQuote({...market(),liquidity:10n**8n},10n**18n,1).passesSlippage,false);
 });
});

describe("explicit session reference policy",()=>{
 const feed:OracleFeedMetadata={address:`0x${"1".repeat(40)}`,baseAsset:"NVDA",quoteAsset:"USD",decimals:8,heartbeatSeconds:86400,
  marketHours:"us_equities_24/5",name:"NVDA / USD",productTypeCode:"primaryTokenizedPrice"};
 const round:PublishedOracleRound={blockNumber:1,blockHash:`0x${"2".repeat(64)}`,availableAt:100,state:{answer:"20000000000",answeredInRound:"1",roundId:"1",
  startedAt:"100",updatedAt:"100",decimals:8,description:"RHNVDA / USD",codeHash:`0x${"3".repeat(64)}`}};
 const quote={...round,state:{...round.state,answer:"100000000",description:"USDG / USD"}};
 const source={rwa:{feed,rounds:[round]},quote:{feed:{...feed,baseAsset:"USDG",name:"USDG / USD"},rounds:[quote]}};
 const policy={rwaMaxAgeSeconds:300,quoteMaxAgeSeconds:86400,closures:[{start:300,end:1000}]};
 it("holds only a valid close anchor and still expires the quote feed",()=>{
  assert(sessionReferenceAt(source,policy,900).available);assert.equal(sessionReferenceAt(source,{...policy,quoteMaxAgeSeconds:300},900).available,false);
  assert.equal(sessionReferenceAt(source,{...policy,rwaMaxAgeSeconds:100},900).available,false);
 });
 it("requires a new published round after reopening and never uses future publications",()=>{
  assert(sessionReferenceAt(source,policy,1000).reasons.includes("awaiting_post_reopening_round"));
  const fresh={...round,blockNumber:2,availableAt:1100,state:{...round.state,updatedAt:"1050"}};
  const updated={...source,rwa:{feed,rounds:[round,fresh]}};
  assert.equal(sessionReferenceAt(updated,policy,1099).available,false);assert.equal(sessionReferenceAt(updated,policy,1100).available,true);
 });
});
