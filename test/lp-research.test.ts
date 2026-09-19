import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Hash } from "viem";
import { FeeReplay } from "../src/research/fee-replay.js";
import { referenceBand } from "../src/research/reference.js";
import { percentageRange, rawTickRange, screenRanges, type RangeObservation } from "../src/research/range-screen.js";
import { reconstructSwap, swapStep } from "../src/research/swap.js";
import { MIN_SQRT_RATIO, sqrtRatioAtTick } from "../src/backtest/principal.js";
import type { StoredReplayEvent } from "../src/replay/domain.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/v3-research-swap-steps.json", import.meta.url), "utf8")) as {
  commit: string; vectors: { input: [string,string,string,string,number]; expected: string[] }[];
};
const pool = "0x0000000000000000000000000000000000000001", owner = "0x0000000000000000000000000000000000000002";
const hash = `0x${"1".repeat(64)}` as Hash;
function event(logIndex: number, eventName: string, args: Record<string, unknown>): StoredReplayEvent {
  return { poolAddress: pool, blockNumber: 1n, blockHash: hash, transactionHash: hash, transactionIndex: 0, logIndex, eventName, args };
}

describe("research swap reconstruction", () => {
  it("matches all 217 results independently executed by official Solidity SwapMath", () => {
    assert.equal(fixture.commit, "d0831dc6b8a318df3872b6d68f6de135c9f3ec29");
    assert.equal(fixture.vectors.length, 217);
    for (const vector of fixture.vectors) {
      const [p,target,l,remaining,fee] = vector.input;
      const actual = swapStep(BigInt(p),BigInt(target),BigInt(l),BigInt(remaining),fee);
      assert.deepEqual([actual.price,actual.amountIn,actual.amountOut,actual.fee],vector.expected.map(BigInt));
    }
  });
  it("reconstructs the observed partial fill followed by empty-liquidity traversal", () => {
    const f = JSON.parse(readFileSync(new URL("./fixtures/v3-research-empty-liquidity.json", import.meta.url), "utf8"));
    const input = { ...f.source, price: BigInt(f.source.price), liquidity: BigInt(f.source.liquidity),
      ticks: f.source.ticks.map((t: { tick: number }) => t.tick), net: (tick: number) => BigInt(f.source.ticks.find((t: { tick: number }) => t.tick === tick).net) };
    const observed = { price: BigInt(f.observed.price),tick: f.observed.tick,liquidity: BigInt(f.observed.liquidity),amount0: BigInt(f.observed.amount0),amount1: BigInt(f.observed.amount1) };
    const segments = reconstructSwap(input,observed);
    assert.equal(segments.filter(s => s.crossed !== null).length,3);
    assert.equal(segments.at(-1)!.to,MIN_SQRT_RATIO+1n);
    assert(segments.some(s => s.liquidity === 0n && s.from !== s.to && s.fee === 0n));
    assert.throws(() => reconstructSwap(input,{...observed,amount0:observed.amount0+10000n}),/cannot be reconstructed/);
  });
  it("rejects liquidity or token cashflows inconsistent with the observed endpoint", () => {
    const v=fixture.vectors.find(v=>v.input[0]===sqrtRatioAtTick(0).toString() && v.input[1]===sqrtRatioAtTick(120).toString() && v.input[2]==='1000000000000000000' && v.input[3]==='1000000' && v.input[4]===500)!;
    const [price,,l,amount]=v.input, expected=v.expected.map(BigInt);
    const input={price:BigInt(price),tick:0,liquidity:BigInt(l),fee:500,spacing:10,ticks:[-120,120],net:(t:number)=>t===-120?BigInt(l):-BigInt(l)};
    const observed={price:expected[0]!,tick:0,liquidity:BigInt(l),amount0:-expected[2]!,amount1:BigInt(amount)};
    assert(reconstructSwap(input,observed).length>0);
    assert.throws(()=>reconstructSwap(input,{...observed,liquidity:1n}),/cannot be reconstructed/);
  });
});

describe("research fee ledger", () => {
  it("accounts for flash donations, protocol fractions and fee settlement without double accrual", () => {
    const replay=new FeeReplay(pool,500),l=1000000n;
    replay.apply(event(0,"Initialize",{tick:0,sqrtPriceX96:sqrtRatioAtTick(0).toString()}));
    const range={owner,tickLower:-60,tickUpper:60};
    replay.apply(event(1,"Mint",{...range,sender:owner,amount:l.toString(),amount0:"0",amount1:"0"}));
    replay.apply(event(2,"SetFeeProtocol",{feeProtocol0Old:0,feeProtocol1Old:0,feeProtocol0New:4,feeProtocol1New:5}));
    replay.apply(event(3,"Flash",{paid0:"800",paid1:"400"}));
    const q=1n<<128n;
    assert.equal(replay.global0,600n*q/l); assert.equal(replay.global1,320n*q/l);
    replay.apply(event(4,"Burn",{...range,amount:"0",amount0:"0",amount1:"0"}));
    const p=replay.positions.get(`${owner}:-60:60`)!;
    assert.equal(p.owed0,599n); assert.equal(p.owed1,319n);
    replay.apply(event(5,"Burn",{...range,amount:"0",amount0:"0",amount1:"0"}));
    assert.equal(p.owed0,599n);
    replay.apply(event(6,"Collect",{...range,amount0:"599",amount1:"319"}));
    assert.equal(p.owed0,0n); assert.equal(p.owed1,0n);
    assert.throws(()=>replay.apply(event(7,"Collect",{...range,amount0:"1",amount1:"0"})),/exceed reconstructed/);
  });
  it("requires initialization and strictly ordered canonical event identities", () => {
    const replay=new FeeReplay(pool,500),init=event(0,"Initialize",{tick:0,sqrtPriceX96:sqrtRatioAtTick(0).toString()});
    assert.throws(()=>replay.apply(event(1,"Swap",{})),/initialization/);
    replay.apply(init); assert.throws(()=>replay.apply(init),/strictly ordered/);
    assert.throws(()=>replay.apply({...event(1,"Flash",{paid0:"0",paid1:"0"}),blockHash:`0x${"2".repeat(64)}`}),/Block hash changed/);
  });
});

describe("five-percent reference tolerance", () => {
  const price=230n*10n**18n, reference={priceX18:price,publishedAt:100,expiresAt:200,canonical:true,qualityPassing:true};
  it("includes both exact bounds and rejects a single price unit beyond either", () => {
    for(const p of [price*95n/100n,price,price*105n/100n]) assert(referenceBand(p,150,reference).inside);
    for(const p of [price*95n/100n-1n,price*105n/100n+1n]) assert.equal(referenceBand(p,150,reference).inside,false);
  });
  it("fails closed for missing, expired, future, revoked and invalid reference evidence", () => {
    for(const r of [null,{...reference,expiresAt:150},{...reference,publishedAt:151},{...reference,canonical:false},
      {...reference,qualityPassing:false},{...reference,priceX18:0n}]) assert.deepEqual(referenceBand(price,150,r),{available:false,inside:false,reason:"independent_reference_unavailable"});
  });
});

describe("bounded geometry screen", () => {
  it("uses total raw tick width and valid grid bounds for every price phase", () => {
    for(const tick of [-223019,-1,0,1,223001,223005,223009]) for(const width of [10,20,30,40,50]) {
      const price=sqrtRatioAtTick(tick),r=rawTickRange(price,width,10);
      assert.equal(r.tickUpper-r.tickLower,width);assert(r.tickLower%10===0);assert(r.tickUpper%10===0);
      assert(sqrtRatioAtTick(r.tickLower)<=price && price<sqrtRatioAtTick(r.tickUpper));
    }
    assert.throws(()=>rawTickRange(sqrtRatioAtTick(223000),50,60),/multiple/);
    assert.throws(()=>rawTickRange(sqrtRatioAtTick(223000),15,10),/multiple/);
  });
  it("does not repeatedly recenter an unchanged price sitting on a grid boundary", () => {
    const samples:RangeObservation[]=[0,1,2,3].map(i=>({at:i*60,tick:223000,price:sqrtRatioAtTick(223000),liquidity:10n**17n,pathMinTick:223000,pathMaxTick:223000}));
    const r=screenRanges(samples,500,"immediate70",0,800_000_000n,10);
    assert.equal(r.halfWidthBps,null);assert.equal(r.totalWidthTicks,10);assert.equal(r.recenterSignals,0);
    assert.equal(r.initialRange.tickUpper-r.initialRange.tickLower,10);
  });
  it("rounds inward in the inverse human price direction for both fee tiers", () => {
    for(const tick of [-223001,0,223031]) for(const spacing of [10,60]) for(const width of [50,100,200,400]) {
      if(tick===0 && spacing===60 && width===50) { assert.throws(()=>percentageRange(sqrtRatioAtTick(tick),width,spacing),/No feasible/); continue; }
      const p=sqrtRatioAtTick(tick),r=percentageRange(p,width,spacing);
      assert(r.tickLower%spacing===0); assert(r.tickUpper%spacing===0);
      assert(r.tickLower<=tick && r.tickUpper>tick);
      assert(sqrtRatioAtTick(r.tickLower)**2n*BigInt(10000+width)>=p*p*10000n);
      assert(sqrtRatioAtTick(r.tickUpper)**2n*BigInt(10000-width)<=p*p*10000n);
    }
  });
  it("uses distinct observations and delayed frozen ranges, preserving unavailable economics", () => {
    const samples:RangeObservation[]=[0,80,80,80,80,80].map((tick,i)=>({at:i*60,tick,price:sqrtRatioAtTick(tick),liquidity:10n**18n,pathMinTick:Math.min(tick,i?80:0),pathMaxTick:tick}));
    const immediate=screenRanges(samples,500,"immediate70",100),persistent=screenRanges(samples,500,"persistent70",100),fixed=screenRanges(samples,500,"fixed",100);
    assert.equal(immediate.geometricRangeChanges,1); assert.equal(persistent.geometricRangeChanges,1); assert.equal(fixed.geometricRangeChanges,0);
    assert.equal(screenRanges(samples.slice(0,3),500,"persistent70",100).geometricRangeChanges,0);
    assert.equal(persistent.executionEligible,false); assert.equal(persistent.netAlphaQuote,null); assert.equal(persistent.feesQuote,null);
    assert.throws(()=>screenRanges([{...samples[0]!}, {...samples[1]!,at:61}],500,"fixed",100),/one-minute/);
  });
  it("records between-observation excursions without using them as a recenter signal", () => {
    const samples:RangeObservation[]=[0,1,2].map(i=>({at:i*60,tick:0,price:sqrtRatioAtTick(0),liquidity:10n**18n,pathMinTick:i?-200:0,pathMaxTick:i?200:0}));
    const r=screenRanges(samples,500,"immediate70",100);
    assert.equal(r.outOfRangeObservations,0); assert.equal(r.intervalsWithRangeCrossing,2); assert.equal(r.recenterSignals,0);
  });
  it("sizes each capital independently and includes our liquidity in the denominator", () => {
    const samples:RangeObservation[]=[0,1,2].map(i=>({at:i*60,tick:223000,price:sqrtRatioAtTick(223000),liquidity:10n**17n,pathMinTick:223000,pathMaxTick:223000}));
    const small=screenRanges(samples,500,"fixed",200,200_000_000n),large=screenRanges(samples,500,"fixed",200,4_000_000_000n);
    const s=small.capacity!,l=large.capacity!;
    const own=BigInt(l.placements[0]!.liquidity);
    assert.equal(l.placementShares.maxPpm,Number(own*1000000n/(10n**17n+own)));
    assert(l.placementShares.maxPpm!>s.placementShares.maxPpm!);
    assert(l.placementShares.maxPpm!<s.placementShares.maxPpm!*20);
    assert.equal(l.activeMinuteShares.count,3); assert.equal(l.placements.length,1);
    assert.equal(large.netAlphaQuote,null); assert.equal(large.recenterSignals,small.recenterSignals);
  });
  it("counts overlapping swap segments, including empty liquidity, without driving decisions", () => {
    const samples:RangeObservation[]=[0,1,2].map(i=>({at:i*60,tick:223000,price:sqrtRatioAtTick(223000),liquidity:10n**17n,pathMinTick:223000,pathMaxTick:223000,
      segments:[{from:sqrtRatioAtTick(222000),to:sqrtRatioAtTick(224000),tickBefore:222000,liquidity:0n},
        {from:sqrtRatioAtTick(224000),to:sqrtRatioAtTick(224100),tickBefore:224000,liquidity:0n}]}));
    const result=screenRanges(samples,500,"persistent70",200,200_000_000n);
    assert.equal(result.capacity!.overlappingObservedSwapSegmentShares.count,2);
    assert.equal(result.capacity!.overlappingObservedSwapSegmentShares.maxPpm,1000000);
    assert.equal(result.recenterSignals,0);
    assert.throws(()=>screenRanges(samples,500,"fixed",200,0n));
  });
  it("records new placement sizing only after a delayed range change succeeds", () => {
    const samples:RangeObservation[]=[223000,223080,223080,223080].map((tick,i)=>({at:i*60,tick,price:sqrtRatioAtTick(tick),liquidity:i?10n**16n:10n**17n,pathMinTick:tick,pathMaxTick:tick}));
    const r=screenRanges(samples,500,"persistent70",100,200_000_000n);
    assert.deepEqual(r.capacity!.placements.map(p=>p.at),[0,180]);
    assert.equal(r.capacity!.placements.length,1+r.geometricRangeChanges);
    assert(r.capacity!.placements[1]!.sharePpm>r.capacity!.placements[0]!.sharePpm);
  });
});
