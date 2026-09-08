import assert from "node:assert/strict";
import { test } from "node:test";
import { paperPolicy } from "../src/paper/config.js";
import { initialPaperState } from "../src/paper/engine.js";
import { closedPaperCash, continuationPolicy, paperCampaignSummary } from "../src/paper/reentry.js";
import type { PaperSessionRow } from "../src/paper/store.js";
import { NitroPaperExecutor } from "../src/paper/executor.js";
import { sqrtRatioAtTick } from "../src/backtest/principal.js";

function closed(): PaperSessionRow {
  const state = initialPaperState();
  Object.assign(state, {status:"closed",action:"exit",costsPaidQuote:"2000000",navQuote:"998000000",pnlQuote:"-2000000",
    position:{liquidity:"0",tickLower:221800,tickUpper:221840,idle0:"1000000000",idle1:"0",fee0:"0",fee1:"0",hold0:"400000000",hold1:"2500000000000000000",enteredAt:"2026-09-08T10:00:00Z"},
    execution:{entryRunId:"1",exitRunId:"2",holdGasQuote:"100000"},
    last:{id:"1",block:"1",hash:"0x01",tick:221820,sqrtPriceX96:String(sqrtRatioAtTick(221820)),blockTimestamp:"2026-09-08T11:00:00Z"}});
  return {id:"5",stream_key:"test",created_at:new Date(),updated_at:new Date(),heartbeat_at:null,runtime_identity:null,
    policy:paperPolicy(),policy_hash:"",state,monitor_reasons:[]};
}
test("continuation carries losses and gas without topping up or double charging", () => {
  const parent=closed();
  assert.equal(closedPaperCash(parent),"998000000");
  const next=continuationPolicy(parent,paperPolicy({reentry:{cooldownSeconds:600}}));
  assert.equal(next.budgetQuote,"998000000");
  assert.equal(next.reentry?.previousSessionId,"5");
  const child={...parent,id:"6",policy:next,state:initialPaperState()};
  const waiting=paperCampaignSummary([parent,child]);
  assert.equal(waiting.navQuote,"998000000");
  assert.equal(waiting.pnlQuote,"-2000000");
  assert.equal(waiting.costsPaidQuote,"2000000");
  Object.assign(child.state,{navQuote:"995000000",pnlQuote:"-3000000",costsPaidQuote:"1000000",last:parent.state.last});
  const active=paperCampaignSummary([parent,child]);
  assert.equal(active.pnlQuote,"-5000000");
  assert.equal(active.costsPaidQuote,"3000000");
  assert.equal(active.holdQuote,waiting.holdQuote); // Original holdings are not reset at each entry.
  assert.equal(BigInt(active.alphaQuote!),995000000n-BigInt(active.holdQuote!));
});
test("continuation rejects incomplete, invalid, unfunded and unreconciled exits", () => {
  for(const mutate of [
    (r:PaperSessionRow)=>{r.state.status="invalid";},
    (r:PaperSessionRow)=>{r.state.execution!.exitRunId=null;},
    (r:PaperSessionRow)=>{r.state.position!.idle1="1";},
    (r:PaperSessionRow)=>{r.state.position!.liquidity="1";},
    (r:PaperSessionRow)=>{r.state.exitReserveQuote="1";},
    (r:PaperSessionRow)=>{r.state.navQuote="1000000000";},
    (r:PaperSessionRow)=>{r.state.position!.idle0="0";},
  ]) {const row=closed();mutate(row);assert.throws(()=>closedPaperCash(row));}
  assert.throws(()=>paperPolicy({reentry:{cooldownSeconds:599}}));
  assert.throws(()=>continuationPolicy(closed(),paperPolicy()));
});
test("boundary reader records bounded fresh proofs across repeated position marks",async()=>{
  const executor=Object.create(NitroPaperExecutor.prototype) as NitroPaperExecutor;
  const hash=`0x${"a".repeat(64)}`;
  const reads:number[]=[];
  Object.assign(executor,{client:()=>({
    readContract:async(args:{args:number[]})=>{reads.push(args.args[0]!);return [100n,0n,0n,0n,0n,0n,0n,true];},
    getBlock:async()=>({hash}),
  })});
  const cp={id:"1",block:"1",hash,tick:221820,sqrtPriceX96:String(sqrtRatioAtTick(221820)),liquidity:"1000",feeGrowth0:"0",feeGrowth1:"0",blockTimestamp:"2026-09-08T11:00:00Z",capturedAt:"2026-09-08T11:00:00Z",targetSetHash:"test"};
  const position=closed().state.position!;
  for(let i=0;i<100;i++) {
    position.boundaryFees=await executor.boundaryFees(cp,position);
    assert.deepEqual(Object.keys(position.boundaryFees).sort(),["block","hash","tickLower","tickUpper","lower","upper"].sort());
    assert(JSON.stringify(position.boundaryFees).length<400);
  }
  assert.equal(reads.length,200);
});
