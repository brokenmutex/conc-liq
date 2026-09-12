import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import { assertPinnedRead } from "../src/paper/fork.js";
import { gasComponents, prestateOverrides,operatorForkGas } from "../src/paper/execution-gas.js";
import { locateMappingSlot, priorGrowthForFee } from "../src/paper/execution-exit.js";
import { advancePaper, DEFAULT_PAPER_POLICY, initialPaperState, type PaperInput } from "../src/paper/engine.js";
import { paperGasQuote } from "../src/paper/transaction-engine.js";
import { principalAmounts, sqrtRatioAtTick } from "../src/backtest/principal.js";
import type { PaperRoundTrip } from "../src/paper/execution.js";
import type { PaperExitSimulation } from "../src/paper/execution-exit.js";
import type { PaperEntryQuote, PaperGasValuation } from "../src/paper/execution-domain.js";
import type {BoundaryFeeProof} from "../src/paper/boundary-fees.js";
import { readFileSync } from "node:fs";
import { evaluatePaperReference } from "../src/paper/reference.js";

const Q128 = 1n << 128n;
const source = { number: 100n, hash: `0x${"1".repeat(64)}` as Hex, timestamp: 1n };
const account = `0x${"a".repeat(40)}` as const;
describe('operator fork gas affordability',()=>{
  it('fits measured gas in the real balance when the fixed 8m default would fail',()=>{
    const balance=4907000000000000n,price=100000000n;
    assert(8000000n*2000000000n>balance);
    const envelope=operatorForkGas(51000n,55000n,price,balance);
    assert.equal(BigInt(envelope.gas),71500n);assert.equal(BigInt(envelope.gasPrice),price);
    assert(BigInt(envelope.gas)*price<balance);
  });
  it('takes the larger local estimate and rounds its headroom upward',()=>{
    assert.equal(BigInt(operatorForkGas(100001n,55000n,10n,2000000n).gas),130002n);
  });
  it('rejects actually insufficient funds, invalid prices and oversized simulations',()=>{
    assert.throws(()=>operatorForkGas(55000n,55000n,100000000n,1n),/cannot cover/);
    assert.throws(()=>operatorForkGas(1n,1n,0n,100n),/Invalid/);
    assert.throws(()=>operatorForkGas(8000000n,8000000n,1n,100000000n),/simulation budget/);
  });
});
function input(index: number): PaperInput {
  const timestamp = Date.parse("2026-09-08T14:00:00Z") + index * 300000;
  return { now: new Date(timestamp + 1000).toISOString(), checkpoint: {
    id: String(index), block: String(index * 1000), hash: `0x${String(index).repeat(64)}`,
    blockTimestamp: new Date(timestamp).toISOString(), capturedAt: new Date(timestamp).toISOString(),
    tick: 0, sqrtPriceX96: String(sqrtRatioAtTick(0)), liquidity: "10000000000000000",
    feeGrowth0: String(BigInt(index) * Q128 / 1000000n), feeGrowth1: String(BigInt(index) * Q128 / 2000000n), targetSetHash: "fixture",
  }, dataReasons: [], entryReasons: [], chainHealthy: true, pathMinTick: -1, pathMaxTick: 1, swapCount: "2", execution: { available: true } };
}
function valuation(index: number): PaperGasValuation {
  return { sourceBlock: input(index).checkpoint.block, sourceHash: input(index).checkpoint.hash, computedAt: input(index).now,
    ethUsdAnswer: "200000000000", ethUsdDecimals: 8, quoteUsdAnswer: "100000000", quoteUsdDecimals: 8 };
}
const quote: PaperEntryQuote = { sourceBlock: input(1).checkpoint.block, sourceHash: input(1).checkpoint.hash,
  quotedAt: input(1).now, tickLower: -200, tickUpper: 200, swapAmountQuote: "500000000", minRwaOut: "497000000" };
function entry() {
  const p = principalAmounts({ liquidity: 10000000000n, tickLower: -200, tickUpper: 200, sqrtPriceX96: sqrtRatioAtTick(0) });
  return { runId: "101", valuation: valuation(2), result: {
    source: { block: input(2).checkpoint.block, hash: input(2).checkpoint.hash },
    policy: DEFAULT_PAPER_POLICY, range: { tickLower: -200, tickUpper: 200 },
    entrySwap: { amountIn: "500000000", actualOut: "499000000" }, liquidity: "10000000000",
    entryGasWei: "8000000000000", exitGasWei: "4000000000000", allowances: [],
    balances: { inventory: { quote: "500000000", rwa: "499000000" }, afterMint: { quote: String(500000000n - p.amount0), rwa: String(499000000n - p.amount1) } },
    transactions: ["approve_entry_swap", "buy_nvda", "approve_mint_usdg", "approve_mint_nvda", "mint"].map((action, i) => ({action, estimate: {totalFeeWei: i === 4 ? "4000000000000" : "1000000000000"}})),
  } as unknown as PaperRoundTrip };
}
function pending() { return advancePaper(initialPaperState(), DEFAULT_PAPER_POLICY, { ...input(1), execution: { available: true, quote } }); }
function opened() { return advancePaper(pending(), DEFAULT_PAPER_POLICY, { ...input(2), execution: { available: true, entry: entry() } }); }

describe("paper initialized-boundary accounting lifecycle",()=>{
  const policy={...DEFAULT_PAPER_POLICY,feeAccounting:"initialized_boundaries_v1" as const};
  function proof(index:number,upper0="0",upper1="0"):BoundaryFeeProof{return {block:input(index).checkpoint.block,hash:input(index).checkpoint.hash,
    tickLower:-200,tickUpper:200,lower:{gross:"100",outside0:"0",outside1:"0"},upper:{gross:"100",outside0:upper0,outside1:upper1}};}
  function start(){return advancePaper(pending(),policy,{...input(2),boundaryFees:proof(2),execution:{available:true,entry:entry()}});}
  it("keeps the position open when the USDG reference has only a grace warning",()=>{
    const saved=JSON.parse(readFileSync(new URL('./fixtures/paper-usdg-session-37.json',import.meta.url),'utf8'));
    const reference=evaluatePaperReference({...saved,policy:{...saved.policy,usdgHeartbeatGraceSeconds:1800}});
    const r=advancePaper(start(),policy,{...input(3),boundaryFees:proof(3),boundaryContinuity:true,
      entryReasons:reference.reasons,reference});
    assert.equal(r.status,"open");assert.equal(r.action,"mark");
    assert.deepEqual(r.reference?.usdgFreshness?.warnings,["paper_usdg_heartbeat_grace"]);
    assert.deepEqual(r.reasons,[]);
  });
  it("keeps an out-of-range position valid and credits no fees for an entirely inactive interval",()=>{
    const i=input(3),p=proof(3,i.checkpoint.feeGrowth0,i.checkpoint.feeGrowth1);
    const crossed=advancePaper(start(),policy,{...i,checkpoint:{...i.checkpoint,tick:201,sqrtPriceX96:String(sqrtRatioAtTick(201))},pathMaxTick:201,boundaryFees:p,boundaryContinuity:true});
    assert.equal(crossed.status,"open");assert.equal(crossed.action,"mark");
    const next=input(4),outside=advancePaper(crossed,policy,{...next,checkpoint:{...next.checkpoint,tick:201,sqrtPriceX96:String(sqrtRatioAtTick(201))},
      pathMinTick:201,pathMaxTick:201,boundaryFees:proof(4,p.upper.outside0,p.upper.outside1),boundaryContinuity:true});
    assert.equal(outside.status,"open");assert.equal(outside.position!.fee0,crossed.position!.fee0);assert.equal(outside.position!.fee1,crossed.position!.fee1);
  });
  it("invalidates performance when continuous boundary evidence is missing",()=>{
    const r=advancePaper(start(),policy,{...input(3),boundaryFees:proof(3),boundaryContinuity:false});
    assert.equal(r.status,"invalid");assert.equal(r.alphaQuote,null);assert(r.reasons.includes("paper_boundary_fee_continuity_unproven"));
  });
  it("signals a delayed full exit when reference-valued NVDA inventory exceeds the threshold",()=>{
    const previous=start();previous.position!.idle1="2000000000";
    const r=advancePaper(previous,{...policy,inventoryExitPpm:600000},{...input(3),boundaryFees:proof(3),boundaryContinuity:true,
      reference:{eligible:true,reasons:[],basis:"heartbeat_valid",ageSeconds:1,referencePriceX18:String(10n**30n),poolPriceX18:String(10n**30n),
        deviationPpm:"0",referenceUpdatedAt:input(3).now,sourceBlock:input(3).checkpoint.block,maxAgeSeconds:86400,maxDeviationPpm:50000}});
    assert.equal(r.status,"exit_pending");assert.equal(r.action,"signal_exit");assert.equal(r.execution!.exitRunId,null);
    assert(r.reasons.includes("paper_inventory_threshold_exit_to_cash"));
  });
});

describe("paper transaction boundaries and cost measurements", () => {
  it("never forwards signing, broadcasts, debug methods or unpinned state reads", () => {
    for (const method of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "anvil_setStorageAt", "debug_traceCall", "personal_unlockAccount"]) {
      assert.throws(() => assertPinnedRead(method, [{}, "0x64"], source));
    }
    assert.doesNotThrow(() => assertPinnedRead("eth_estimateGas", [{}, "0x64", {}], source));
    assert.doesNotThrow(() => assertPinnedRead("eth_call", [{}, "0x64", {}], source));
    assert.throws(() => assertPinnedRead("eth_getStorageAt", [account, "0x0", "latest"], source));
    assert.throws(() => assertPinnedRead("eth_call", [{}, "0x65"], source));
  });
  it("uses the total gas estimate once and preserves a measured zero parent component", () => {
    const gas = gasComponents([100000n, 25000n, 123456789n, 10n]);
    assert.equal(BigInt(gas.totalFeeWei), 100000n * 123456789n);
    assert.equal(BigInt(gas.executionFeeWei) + BigInt(gas.parentFeeWei), BigInt(gas.totalFeeWei));
    assert.equal(gasComponents([100000n, 0n, 1n, 0n]).parentFeeWei, "0");
    assert.throws(() => gasComponents([100n, 101n, 1n, 1n]));
    assert.throws(() => gasComponents([100n, 0n, 0n, 0n]));
    assert.equal(paperGasQuote("1000000000000", valuation(1)), 2000n);
  });
  it("restores touched storage without replacing code or erasing untouched canonical slots", () => {
    const override = prestateOverrides({ [account]: { balance: "0xde0b6b3a7640000", nonce: 3, code: "0x00", storage: { "0x1": "0x2" } } });
    assert.deepEqual(override[account], { balance: "0xde0b6b3a7640000", nonce: "0x3", stateDiff: { [toHex(1n,{size:32})]: toHex(2n,{size:32}) } });
    assert.throws(() => prestateOverrides({ pre: {}, post: {} }));
    assert.throws(() => prestateOverrides({ [account]: { storage: { "0x1": `0x${"f".repeat(65)}` } } }));
  });
  it("derives unique mapping slots from getter evidence instead of assuming storage offsets", () => {
    const key = toHex(17n,{size:32});
    const base = BigInt(keccak256(encodeAbiParameters([{type:"bytes32"},{type:"uint256"}],[key,42n])));
    const storage: Record<Hex,Hex> = { [toHex(base,{size:32})]: toHex(77n,{size:32}) };
    assert.equal(locateMappingSlot(key, storage, read => read(0n) === 77n), base);
    assert.throws(() => locateMappingSlot(key, storage, read => read(0n) === 78n));
    const second = BigInt(keccak256(encodeAbiParameters([{type:"bytes32"},{type:"uint256"}],[key,43n])));
    storage[toHex(second,{size:32})] = toHex(77n,{size:32});
    assert.throws(() => locateMappingSlot(key, storage, read => read(0n) === 77n));
  });
  it("restores exactly the fee inputs, including uint256 wrap, without minting fee income", () => {
    for (const liquidity of [1n, 1234567890123456789n, Q128 - 1n]) for (const fee of [0n, 1n, 1234n]) {
      const growth = 42n;
      const prior = priorGrowthForFee(growth, liquidity, fee);
      const delta = (growth - prior + (1n << 256n)) % (1n << 256n);
      assert.equal(delta * liquidity / Q128, fee);
    }
  });
});

describe("forward paper execution accounting", () => {
  it("freezes a quote before a later fill and uses returned balances and measured entry gas", () => {
    const signal = pending();
    assert.equal(signal.status, "entry_pending"); assert.equal(signal.pnlQuote, null);
    assert.deepEqual(signal.execution?.intent, quote);
    const state = opened();
    assert.equal(state.status, "open");
    assert.equal(state.execution?.entryRunId, "101");
    assert.equal(state.costsPaidQuote, "16000"); assert.equal(state.exitReserveQuote, "8000");
    assert.equal(state.pnlQuote, "-1024000");
    assert.equal(state.alphaQuote, "-20000");
    assert.equal(state.position?.enteredAt, input(2).checkpoint.blockTimestamp);
  });
  it("fails preflight without pretending a transaction was submitted or charging gas", () => {
    const result = advancePaper(pending(), DEFAULT_PAPER_POLICY, { ...input(2), execution: {available: true, error: "swap reverted"} });
    assert.equal(result.status, "waiting"); assert.equal(result.position, null); assert.equal(result.costsPaidQuote, "0");
    assert.equal(result.execution?.intent, null); assert.equal(result.pnlQuote, null);
  });
  it("rejects stale intents and mismatched execution or valuation sources", () => {
    assert.equal(advancePaper(pending(), DEFAULT_PAPER_POLICY, input(6)).status, "waiting");
    const forged = entry(); forged.valuation.sourceHash = "0xwrong";
    assert.throws(() => advancePaper(pending(), DEFAULT_PAPER_POLICY, { ...input(2), execution: {available: true, entry: forged} }), /valuation source/);
  });
  it("replaces the exit reserve with its fresh charge and does not count collected fees twice", () => {
    const signal = advancePaper(opened(), DEFAULT_PAPER_POLICY, { ...input(3), entryReasons: ["equity_session_closed"] });
    assert.equal(signal.status, "exit_pending");
    const prepared = advancePaper(signal, DEFAULT_PAPER_POLICY, input(4));
    assert.ok(prepared.reasons.includes("paper_exit_simulation_required"));
    const mark = { ...valuation(4), ethUsdAnswer: "220000000000" };
    const result = { source: {block:input(4).checkpoint.block,hash:input(4).checkpoint.hash}, inventory: {...prepared.position!},
      balances: {afterExit: {quote:"1001000000",rwa:"0"}}, totalGasWei:"4000000000000" } as unknown as PaperExitSimulation;
    const closed = advancePaper(signal, DEFAULT_PAPER_POLICY, {...input(4),execution:{available:true,exit:{runId:"102",result,valuation:mark}}});
    assert.equal(closed.status,"closed"); assert.equal(closed.position?.liquidity,"0");
    assert.equal(closed.position?.fee0,"0"); assert.equal(closed.position?.fee1,"0");
    assert.equal(closed.exitReserveQuote,"0"); assert.equal(closed.costsPaidQuote,"24800");
    assert.equal(closed.pnlQuote,"975200"); assert.equal(closed.execution?.gasSpentWei,"12000000000000");
    assert.equal(closed.execution?.exitRunId,"102");
    assert.ok(BigInt(closed.feeValueQuote!) > 0n);
  });
  it("does not value a position with missing entry execution evidence", () => {
    const state=opened(); delete state.execution;
    assert.equal(advancePaper(state, DEFAULT_PAPER_POLICY, input(3)).status,"invalid");
  });
});
