import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {advancePaper,paperEntryRange,type PaperInput,type PaperState,type TransactionPaperPolicy} from '../src/paper/engine.js';
import {paperPolicySchema} from '../src/paper/config.js';
import {advanceRecenter} from '../src/paper/recenter.js';
import {solveRecenterSwap,type PaperRecenterQuote} from '../src/paper/execution-recenter.js';
import {sqrtRatioAtTick,principalAmounts} from '../src/backtest/principal.js';
import {paperGasQuote} from '../src/paper/transaction-engine.js';
import {historicalSwapQuote} from '../src/research/portfolio-math.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/paper-state-rejected-exit-recovery.json',import.meta.url),'utf8'));
const policy=paperPolicySchema.parse(JSON.parse(readFileSync(new URL('../config/paper-nvda-5000-recenter-offhours.json',import.meta.url),'utf8'))) as TransactionPaperPolicy;
function frame(at='2026-09-12T12:00:00Z') {
  const previous:PaperState=structuredClone(fixture.previous),input:PaperInput=structuredClone(fixture.input);
  previous.status='open';previous.pendingSince=null;delete previous.holding;
  previous.last={...previous.last!,blockTimestamp:new Date(Date.parse(at)-60000).toISOString(),capturedAt:new Date(Date.parse(at)-60000).toISOString()};
  previous.position!.enteredAt='2026-09-11T20:00:00Z';
  return {previous,input:{...input,now:at,holdingChainReady:true,checkpoint:{...input.checkpoint,blockTimestamp:at,capturedAt:at}}};
}
function signaled() {
  const {previous,input}=frame();const range=paperEntryRange(input.checkpoint,policy),p=previous.position!;
  const quote:PaperRecenterQuote={kind:'outside_range_v1',sourceBlock:input.checkpoint.block,sourceHash:input.checkpoint.hash,quotedAt:input.now,
    oldRange:{tickLower:p.tickLower,tickUpper:p.tickUpper,liquidity:p.liquidity},...range,token:null,amountIn:'0',minOut:'0',minMint0:'0',minMint1:'0'};
  return {input,quote,state:advancePaper(previous,policy,{...input,execution:{available:true,recenterQuote:quote}})};
}
test('timeout removal requires a scheduled exit; old policies remain accepted',()=>{
  assert.equal(policy.maxHoldingSeconds,null);assert.equal(policy.budgetQuote,'5000000000');
  assert.equal(policy.lpAllocationPpm,1000000);assert.equal(policy.inventoryExitPpm,undefined);
  assert.throws(()=>paperPolicySchema.parse({...policy,tradingHours:undefined}),/timeout/);
  assert.throws(()=>paperPolicySchema.parse({...policy,inventoryExitPpm:1000000}),/no inventory cap/);
  assert.throws(()=>paperPolicySchema.parse({...policy,lpAllocationPpm:800000}),/full allocation/);
  assert.doesNotThrow(()=>paperPolicySchema.parse(fixture.session.policy));
});
test('position survives beyond 24h on weekend; scheduled exit overrides recenter Monday',()=>{
  const {previous,input}=frame('2026-09-13T12:00:00Z');
  const held=advancePaper(previous,policy,input);
  assert.equal(held.status,'open');assert(held.reasons.includes('paper_recenter_quote_required'));
  assert.equal(advancePaper(previous,{...policy,maxHoldingSeconds:86400},input).status,'exit_pending');
  const monday=frame('2026-09-14T07:50:00Z');
  const exit=advancePaper(monday.previous,policy,monday.input);
  assert.equal(exit.action,'signal_exit');assert(exit.reasons.includes('paper_scheduled_cash_exit'));assert.equal(exit.execution!.recenterIntent,null);
});
test('outside-range trigger has no persistence or cooldown; exact upper boundary is outside',()=>{
  const {state,input,quote}=signaled();assert.equal(state.action,'signal_recenter');assert.equal(state.status,'open');
  assert.deepEqual(state.execution!.recenterIntent,quote);assert.equal(state.position!.enteredAt,'2026-09-11T20:00:00Z');
  const p=state.position!;
  for(const [tick,outside] of [[p.tickLower,false],[p.tickUpper-1,false],[p.tickUpper,true],[p.tickLower-1,true]] as const){
    const s=structuredClone(state);s.reasons=[];s.execution!.recenterIntent=null;
    advanceRecenter(s,policy,{...input,checkpoint:{...input.checkpoint,tick,sqrtPriceX96:String(sqrtRatioAtTick(tick))}});
    assert.equal(s.reasons.includes('paper_recenter_quote_required'),outside);
  }
});
test('pending move is cancelled on return inside, quote expiry, chain trouble and entry cutoff',()=>{
  for(const change of ['inside','expired','chain','cutoff','risk'] as const){
    const {state,input}=signaled();const s=structuredClone(state);s.reasons=[];
    const i={...input,checkpoint:{...input.checkpoint}};
    if(change==='inside')i.checkpoint.tick=s.position!.tickLower;
    if(change==='expired')i.now='2026-09-12T12:02:00Z';
    if(change==='chain')Object.assign(i,{chainHealthy:false});
    if(change==='cutoff')i.now='2026-09-14T07:30:00Z';
    if(change==='risk')s.reasons=['paper_reference_band_exceeded'];
    const cost=s.costsPaidQuote,pos=structuredClone(s.position);
    advanceRecenter(s,policy,i);assert.equal(s.execution!.recenterIntent,null,change);assert.equal(s.costsPaidQuote,cost);assert.deepEqual(s.position,pos);
  }
});
test('later source required; failed preflight retains marked portfolio and charges no gas',()=>{
  const {state,input}=signaled();state.reasons=[];
  advanceRecenter(state,policy,input);assert(!state.reasons.includes('paper_recenter_simulation_required'));
  const next={...input,now:'2026-09-12T12:01:00Z',checkpoint:{...input.checkpoint,block:String(BigInt(input.checkpoint.block)+1n),blockTimestamp:'2026-09-12T12:01:00Z'}};
  advanceRecenter(state,policy,next);assert(state.reasons.includes('paper_recenter_simulation_required'));
  state.reasons=[];const before=structuredClone(state);
  advanceRecenter(state,policy,{...next,execution:{available:true,error:'Frozen mint minimum unavailable'}});
  assert.equal(state.execution!.recenterIntent,null);assert.equal(state.costsPaidQuote,before.costsPaidQuote);assert.deepEqual(state.position,before.position);
});
test('successful move charges gas once, keeps benchmark/fees, records proof and replaces exit reserve',()=>{
  const {state,input,quote}=signaled();state.reasons=[];
  const before=structuredClone(state),cp={...input.checkpoint,block:String(BigInt(input.checkpoint.block)+1n),blockTimestamp:'2026-09-12T12:01:00Z'};
  const valuation={sourceBlock:cp.block,sourceHash:cp.hash,computedAt:cp.blockTimestamp,ethUsdAnswer:'200000000000',ethUsdDecimals:8,quoteUsdAnswer:'100000000',quoteUsdDecimals:8};
  const boundaryFees={...input.boundaryFees!,block:cp.block,tickLower:quote.tickLower,tickUpper:quote.tickUpper};
  const result={scope:'paper_inventory_recenter',executionEligible:false,source:{block:cp.block,hash:cp.hash},intent:quote,
    inventory:{...state.position!,allowances:state.execution!.allowances,nativeBalanceWei:String(10n**18n-BigInt(state.execution!.gasSpentWei))},
    position:{tickLower:quote.tickLower,tickUpper:quote.tickUpper,liquidity:'10000000000',minted0:'10',minted1:'20'},
    balances:{after:{quote:'100',rwa:'200'}},allowances:state.execution!.allowances,trade:null,
    transactions:[{estimate:{totalFeeWei:'300000000000'}}],exitPreviewTransactions:[{estimate:{totalFeeWei:'200000000000'}}],totalGasWei:'300000000000',exitGasWei:'200000000000'};
  const next={...input,checkpoint:cp,now:cp.blockTimestamp,execution:{available:true,recenter:{runId:'500',result,valuation,boundaryFees}}} as unknown as PaperInput;
  advanceRecenter(state,policy,next);
  assert.equal(state.action,'recenter');assert.equal(state.status,'open');assert.equal(state.execution!.recenterIntent,null);
  assert.deepEqual(state.execution!.recenterRunIds,['500']);
  assert.equal(state.costsPaidQuote,String(BigInt(before.costsPaidQuote)+paperGasQuote(result.totalGasWei,valuation)));
  assert.equal(state.exitReserveQuote,String(paperGasQuote(result.exitGasWei,valuation)));
  for(const key of ['hold0','hold1','enteredAt'] as const)assert.equal(state.position![key],before.position![key]);
  assert.equal(state.execution!.earnedFee0,before.execution!.earnedFee0);assert.equal(state.execution!.earnedFee1,before.execution!.earnedFee1);
  assert.equal(state.position!.fee0,'0');assert.equal(state.position!.fee1,'0');
  const duplicated=structuredClone(state);duplicated.reasons=[];advanceRecenter(duplicated,policy,next);
  assert.deepEqual(duplicated.execution!.recenterRunIds,['500']);assert.equal(duplicated.costsPaidQuote,state.costsPaidQuote);
  // Next mark must add newly accrued fees to the lifetime total, not overwrite
  // it with the new NFT's zero fee balance.
  state.last=cp;const at='2026-09-12T12:02:00Z',later={...cp,block:String(BigInt(cp.block)+1n),blockTimestamp:at,capturedAt:at};
  const marked=advancePaper(state,policy,{...input,now:at,checkpoint:later,pathMinTick:cp.tick,pathMaxTick:cp.tick,swapCount:'0',
    boundaryFees:{...boundaryFees,block:later.block},boundaryContinuity:true,execution:{available:true}});
  assert.equal(marked.execution!.earnedFee0,state.execution!.earnedFee0);assert.equal(marked.execution!.earnedFee1,state.execution!.earnedFee1);
});
test('net-swap solver matches historical depth in both directions at full deployment',async()=>{
  const f=JSON.parse(readFileSync(new URL('./fixtures/inventory-recenter-fork.json',import.meta.url),'utf8'));
  const s=f.seed,net=new Map<number,bigint>(s.ticks.map((t:any)=>[t.tick,BigInt(t.net)]));
  const market={fee:500,spacing:10,price:BigInt(s.price),tick:s.tick,liquidity:BigInt(s.liquidity),ticks:[...net.keys()].sort((a,b)=>a-b),net:(t:number)=>net.get(t)??0n};
  const range=paperEntryRange({tick:market.tick,sqrtPriceX96:s.price},policy);
  for(const [cash,rwa,direction] of [[5000000000n,0n,0],[0n,20n*10n**18n,1]] as const){
    const p=await solveRecenterSwap(market.price,range,cash,rwa,async(amount,token)=>{const q=historicalSwapQuote(market,amount,token);assert(q.fullyFilled);return {amountOut:q.amountOut,price:q.sqrtPriceAfter};});
    assert.equal(p.token,direction);assert(p.amount>0n);
    const a=principalAmounts({sqrtPriceX96:p.price,...range,liquidity:10n**24n});
    const q=cash+(direction===0?-p.amount:p.amountOut),r=rwa+(direction===1?-p.amount:p.amountOut);
    assert(q>0n&&r>0n);const imbalance=q*a.amount1-r*a.amount0;
    assert(direction===0?imbalance<=0n:imbalance>=0n);
    const previous=historicalSwapQuote(market,p.amount-1n,direction);
    const b=principalAmounts({sqrtPriceX96:previous.sqrtPriceAfter,...range,liquidity:10n**24n});
    const before=(cash+(direction===0?-(p.amount-1n):previous.amountOut))*b.amount1-(rwa+(direction===1?-(p.amount-1n):previous.amountOut))*b.amount0;
    assert(direction===0?before>0n:before<0n,'Smallest integer trade crossing the funding ratio');
  }
});
