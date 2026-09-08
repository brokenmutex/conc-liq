import assert from "node:assert/strict";
import {it} from "node:test";
import {boundaryContinuity,boundaryFeeIncrement,boundaryInside,type BoundaryFeeProof} from "../src/paper/boundary-fees.js";
import type {PaperCheckpoint} from "../src/paper/engine.js";
import {paperPolicy} from "../src/paper/config.js";
import {paperEntryRange} from "../src/paper/engine.js";
import {sqrtRatioAtTick} from "../src/backtest/principal.js";
const q=1n<<128n;
const cp=(block:number,tick:number,growth:bigint)=>({block:String(block),hash:`0x${"1".repeat(64)}`,tick,
 feeGrowth0:String(growth),feeGrowth1:"0"}) as PaperCheckpoint;
const proof=(block:number,upper=0n):BoundaryFeeProof=>({block:String(block),hash:`0x${"1".repeat(64)}`,tickLower:-20,tickUpper:20,
 lower:{gross:"100",outside0:"0",outside1:"0"},upper:{gross:"100",outside0:String(upper),outside1:"0"}});
it("tracks earned fees through an exit, an entirely inactive interval, and reentry",()=>{
 const start=cp(1,0,10n*q),outside=cp(2,25,15n*q),later=cp(3,25,20n*q),inside=cp(4,0,25n*q);
 // Cross upper at global 12; cross back at global 22 (outside becomes 22-12=10).
 assert.equal(boundaryFeeIncrement(start,outside,proof(1),proof(2,12n*q),1n).fee0,2n);
 assert.equal(boundaryFeeIncrement(outside,later,proof(2,12n*q),proof(3,12n*q),1n).fee0,0n);
 assert.equal(boundaryFeeIncrement(later,inside,proof(3,12n*q),proof(4,10n*q),1n).fee0,3n);
});
it("does not reuse fee baselines after a boundary clears and reinitializes",()=>{
 const changes=[{eventName:"Burn",args:{tickLower:-20,tickUpper:20,amount:"100"}},
 {eventName:"Mint",args:{tickLower:-20,tickUpper:20,amount:"100"}}];
 assert.equal(boundaryContinuity(proof(1),proof(2),changes),false);
 assert.equal(boundaryContinuity(proof(1),proof(2),[]),true);
 const changed=proof(2);changed.lower.gross="101";assert.equal(boundaryContinuity(proof(1),changed,[]),false);
});
it("retains fractional fees and rejects uninitialized or mismatched source proofs",()=>{
 const a=boundaryFeeIncrement(cp(1,0,0n),cp(2,0,q/2n),proof(1),proof(2),1n);
 assert.equal(a.fee0,0n);assert.equal(a.remainder0,q/2n);
 assert.equal(boundaryFeeIncrement(cp(2,0,q/2n),cp(3,0,q),proof(2),proof(3),1n,a.remainder0).fee0,1n);
 assert.throws(()=>boundaryInside(cp(1,0,q),proof(2)),/source mismatch/);
 const bad=proof(1);bad.lower.gross="0";assert.throws(()=>boundaryInside(cp(1,0,q),bad),/initialized/);
});
it("freezes explicit raw-width trial settings while preserving old policy defaults",()=>{
 const defaults=paperPolicy();assert(!('feeAccounting' in defaults));assert(!('lpAllocationPpm' in defaults));
 const policy=paperPolicy({halfWidthSpacings:2,feeAccounting:"initialized_boundaries_v1",lpAllocationPpm:800000,inventoryExitPpm:600000,
 referencePolicy:{...defaults.referencePolicy,maxDeviationPpm:50000}});
 assert.equal(policy.halfWidthSpacings*10,20);assert.equal(policy.referencePolicy!.maxDeviationPpm,50000);
 assert.throws(()=>paperPolicy({lpAllocationPpm:1000001}));assert.throws(()=>paperPolicy({inventoryExitPpm:0}));
});
it("centers the narrow trial on the nearest feasible grid midpoint",()=>{
 const source={tick:221899,sqrtPriceX96:String(sqrtRatioAtTick(221899))};
 assert.deepEqual(paperEntryRange(source,{halfWidthSpacings:2,feeAccounting:"initialized_boundaries_v1"}),{tickLower:221880,tickUpper:221920});
 assert.deepEqual(paperEntryRange(source,{halfWidthSpacings:2}),{tickLower:221870,tickUpper:221910});
});
