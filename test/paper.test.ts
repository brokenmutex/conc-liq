import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sqrtRatioAtTick } from "../src/backtest/principal.js";
import { advancePaper, DEFAULT_PAPER_POLICY, initialPaperState, invalidatePaper, policyHash, type PaperInput, type PaperState } from "../src/paper/engine.js";
import { paperPolicy } from "../src/paper/config.js";
const Q128 = 1n << 128n;
const base = Date.parse("2026-09-08T14:00:00Z");
function input(index: number, overrides: Partial<PaperInput> = {}): PaperInput {
  const at = new Date(base + index * 300_000).toISOString();
  return { now: new Date(base + index * 300_000 + 2000).toISOString(), checkpoint: {
    id: String(index), block: String(index * 3000), hash: `0x${String(index).padStart(64,"0")}`,
    blockTimestamp: at, capturedAt: at, tick: 0, sqrtPriceX96: String(sqrtRatioAtTick(0)),
    liquidity: "10000000000000000", feeGrowth0: String(10n * Q128 + BigInt(index) * Q128 / 1_000_000n),
    feeGrowth1: String(20n * Q128 + BigInt(index) * Q128 / 2_000_000n), targetSetHash: "fixed", },
    dataReasons: [], entryReasons: [], chainHealthy: true, pathMinTick: -1, pathMaxTick: 1, swapCount: "2", ...overrides };
}
function opened(): PaperState {
  return advancePaper(advancePaper(initialPaperState(),DEFAULT_PAPER_POLICY,input(1)),DEFAULT_PAPER_POLICY,input(2));
}
describe("forward paper position accounting", () => {
  it("waits for gates, records an intent, and earns no fees before its later fill", () => {
    let state = advancePaper(initialPaperState(),DEFAULT_PAPER_POLICY,input(1,{entryReasons:["equity_session_closed"]}));
    assert.equal(state.status,"waiting"); assert.equal(state.navQuote,null);
    state = advancePaper(state,DEFAULT_PAPER_POLICY,input(2));
    assert.equal(state.status,"entry_pending"); assert.equal(state.position,null);
    state = advancePaper(state,DEFAULT_PAPER_POLICY,input(3));
    assert.equal(state.status,"open"); assert.equal(state.position?.fee0,"0");
    assert.equal(state.intervals,0); assert.equal(state.costsPaidQuote,"2000000");
    assert.equal(state.exitReserveQuote,"1000000");
    assert.equal(BigInt(state.pnlQuote!), BigInt(state.navQuote!) - BigInt(DEFAULT_PAPER_POLICY.budgetQuote));
    assert.equal(BigInt(state.alphaQuote!),-1_000_000n);
    assert.ok(BigInt(state.navQuote!) <= 997_000_000n);
    assert.ok(BigInt(state.maxDrawdownPpm) >= 3000n);
  });
  it("does not fill from a checkpoint that predates the recorded decision time", () => {
    const first = input(1, { now: new Date(Date.parse(input(1).checkpoint.blockTimestamp)+150_000).toISOString() });
    const pending = advancePaper(initialPaperState(),DEFAULT_PAPER_POLICY,first);
    const next = input(2, { checkpoint: { ...input(2).checkpoint, blockTimestamp: new Date(Date.parse(first.checkpoint.blockTimestamp)+120_000).toISOString(), capturedAt:first.now }, now:first.now });
    assert.equal(advancePaper(pending,DEFAULT_PAPER_POLICY,next).status,"entry_pending");
  });
  it("fixes the proposed range before seeing the later fill price", () => {
    const signal=advancePaper(initialPaperState(),DEFAULT_PAPER_POLICY,input(1));
    const moved=input(2,{checkpoint:{...input(2).checkpoint,tick:100,sqrtPriceX96:String(sqrtRatioAtTick(100))}});
    const filled=advancePaper(signal,DEFAULT_PAPER_POLICY,moved);
    assert.equal(filled.status,"open");
    assert.equal(filled.position?.tickLower,-200); assert.equal(filled.position?.tickUpper,200);
    const outside=input(2,{checkpoint:{...input(2).checkpoint,tick:201,sqrtPriceX96:String(sqrtRatioAtTick(201))}});
    const cancelled=advancePaper(signal,DEFAULT_PAPER_POLICY,outside);
    assert.equal(cancelled.status,"waiting"); assert.equal(cancelled.position,null);
    assert.equal(cancelled.costsPaidQuote,"0");
  });
  it("carries exact fee deltas and accounts for the same hold inventory", () => {
    const start=opened(); const state=advancePaper(start,DEFAULT_PAPER_POLICY,input(3));
    const expected=(BigInt(input(3).checkpoint.feeGrowth0)-BigInt(input(2).checkpoint.feeGrowth0))*BigInt(start.position!.liquidity)/Q128;
    assert.equal(BigInt(state.position!.fee0),expected);
    assert.equal(state.intervals,1); assert.equal(state.observedSwaps,"2");
    assert.equal(BigInt(state.alphaQuote!),BigInt(state.navQuote!)-BigInt(state.holdQuote!));
    assert.equal(BigInt(state.pnlQuote!)-BigInt(start.pnlQuote!),BigInt(state.feeValueQuote!));
  });
  it("does not treat an entry-only snapshot alignment wait as a forced exit", () => {
    const state=advancePaper(opened(),DEFAULT_PAPER_POLICY,input(3,{entryReasons:["checkpoint_not_latest_risk_snapshot"]}));
    assert.equal(state.status,"open");
    assert.ok(state.reasons.includes("checkpoint_not_latest_risk_snapshot"));
  });
  it("reserves the exit once and moves released principal into paper balances", () => {
    const exit=advancePaper(opened(),DEFAULT_PAPER_POLICY,input(3,{entryReasons:["equity_session_closed"]}));
    assert.equal(exit.status,"exit_pending"); assert.equal(exit.action,"signal_exit");
    const closed=advancePaper(exit,DEFAULT_PAPER_POLICY,input(4));
    assert.equal(closed.status,"closed"); assert.equal(closed.position?.liquidity,"0");
    assert.equal(closed.exitReserveQuote,"0"); assert.equal(closed.costsPaidQuote,"3000000");
    assert.equal(BigInt(closed.pnlQuote!)-BigInt(exit.pnlQuote!),BigInt(closed.feeValueQuote!)-BigInt(exit.feeValueQuote!));
    assert.deepEqual(advancePaper(closed,DEFAULT_PAPER_POLICY,input(5)),closed);
  });
  it("stops economic claims on range crossings, reorgs, missing coverage and missed decisions", () => {
    const state=opened();
    for (const next of [input(3,{pathMinTick:-201}), input(3,{dataReasons:["checkpoint_canonicality_unproven"]}), input(3,{now:"2026-09-08T15:00:00Z"}), input(7)]) {
      const result=advancePaper(state,DEFAULT_PAPER_POLICY,next);
      assert.equal(result.status,"invalid"); assert.equal(result.navQuote,null); assert.equal(result.alphaQuote,null);
      assert.equal(result.position?.fee0,state.position?.fee0);
    }
    assert.equal(invalidatePaper(state,input(3).now,["reorg"]).pnlQuote,null);
  });
  it("rejects duplicate or regressing source blocks", () => {
    assert.throws(()=>advancePaper(opened(),DEFAULT_PAPER_POLICY,input(2)),/advance strictly/);
  });
  it("keeps research gate failures visible and still requires chain/data proof", () => {
    const policy={...DEFAULT_PAPER_POLICY,mode:"research" as const};
    const reasons=["oracle_price_stale","equity_session_closed"];
    const signal=advancePaper(initialPaperState(),policy,input(1,{entryReasons:reasons}));
    const state=advancePaper(signal,policy,input(2,{entryReasons:reasons}));
    assert.equal(state.status,"open"); assert.deepEqual(state.reasons,reasons);
    assert.equal(advancePaper(initialPaperState(),policy,input(1,{chainHealthy:false})).status,"waiting");
  });
  it("enforces the hypothetical liquidity share ceiling", () => {
    const next=input(2,{checkpoint:{...input(2).checkpoint,liquidity:"1"}});
    const state=advancePaper(advancePaper(initialPaperState(),DEFAULT_PAPER_POLICY,input(1)),DEFAULT_PAPER_POLICY,next);
    assert.equal(state.status,"waiting"); assert.equal(state.position,null); assert.equal(state.costsPaidQuote,"0");
  });
  it("keeps policy hashes stable through PostgreSQL JSON key ordering", () => {
    assert.equal(policyHash(DEFAULT_PAPER_POLICY),policyHash(Object.fromEntries(Object.entries(DEFAULT_PAPER_POLICY).reverse()) as typeof DEFAULT_PAPER_POLICY));
    assert.notEqual(policyHash(DEFAULT_PAPER_POLICY),policyHash({...DEFAULT_PAPER_POLICY,halfWidthSpacings:50}));
    assert.throws(()=>paperPolicy({budgetQuote:"1000"}),/Costs/);
    assert.throws(()=>paperPolicy({slippageBps:-1}));
  });
});
