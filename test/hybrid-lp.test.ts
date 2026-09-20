import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {getAddress} from 'viem';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {configSchema} from '../src/adaptive-paper.js';
import {NVDA_PAPER_MARKET} from '../src/paper/market.js';
import {applyHybridStage,hybridRanges,passesHybridEconomicGate,planHybridAction,HybridLpReplay,
  type HybridGrid,type HybridPlannerInput,type HybridStageJournal} from '../src/research/hybrid-lp.js';
import type {AdaptivePolicy,ResearchSource} from '../src/research/adaptive-lp.js';

const grid:HybridGrid={spanSpacings:[1,2,4,8],lowerOffsetPpm:[-1000000,-500000,0,1000000],
  deploymentPpm:[500000,1000000],swapInputPpm:[100000,250000,500000],maxSwapInputPpm:500000,minLiquidity:1n};
const source=(tick=222003,at=0):ResearchSource=>({price:sqrtRatioAtTick(tick),tick,at,block:String(at+1),liquidity:10n**24n,fee:500,spacing:10,
  ticks:[-887270,887270],net:t=>t===-887270?10n**24n:t===887270?-(10n**24n):0n});
const stats=(at=0,growth=(1n<<128n)/100n)=>({asOf:at,spanMs:3600000,count:61,varianceTicksPerMs:0,growth0:growth,growth1:growth});
const stageCosts={approval:0n,withdrawCollect:2n,swap:2n,mint:2n,exit:2n,adverseSelectionPpm:0,approvalRequired:false};

function planner(overrides:Partial<HybridPlannerInput>={}):HybridPlannerInput{
  const m=source();return {market:NVDA_PAPER_MARKET,source:m,portfolio:{amount0:240000000n,amount1:0n,position:null},
    balances:{amount0:240000000n,amount1:0n},stats:stats(),horizonMs:600000,feePpm:1000000,slippageBps:50,
    costBufferPpm:500000,feeBufferPpm:250000,grid,costs:stageCosts,gasSpent:0n,gasBudgetQuote:10000000n,...overrides};
}

test('hybrid range grid is exact, aligned, bounded, and includes inactive residual bands',()=>{
  for(const tick of [222003,-226024]){const ranges=hybridRanges(tick,10,grid),base=Math.floor(tick/10)*10;
    assert.equal(new Set(ranges.map(r=>`${r.tickLower}:${r.tickUpper}`)).size,ranges.length);
    assert(ranges.some(r=>r.tickUpper===base));assert(ranges.some(r=>r.tickLower>tick));
    for(const range of ranges){assert.equal(Math.abs(range.tickLower%10),0);assert.equal(Math.abs(range.tickUpper%10),0);assert(range.tickLower<range.tickUpper);}
  }
});

test('hybrid planner keeps when every move fails the strict economic buffer',()=>{
  const result=planHybridAction(planner({stats:stats(0,0n),costs:{...stageCosts,swap:1000000n,mint:1000000n,exit:1000000n}}));
  assert(result.keepTerminalQuote!==null);assert(result.selected);assert.equal(result.selected.accepted,false);
  assert.equal(result.rejected.hybrid_economic_gate,1);
});

test('hybrid planner can pay for a small optional swap to activate otherwise idle inventory',()=>{
  const result=planHybridAction(planner());assert(result.selected?.accepted);
  assert.notEqual(result.selected.token,null);assert(result.selected.amountIn>0n);
  assert(result.selected.amountIn<=240000000n*500000n/1000000n);
  assert(result.selected.minimumAmountOut<=result.selected.amountOut);
  assert(result.selected.benefitQuote>result.selected.bufferQuote);
});

test('hybrid planner uses verified token order and raw units when USDG is token1',()=>{
  const market={...NVDA_PAPER_MARKET,symbol:'REVERSED',rwa:getAddress('0x1000000000000000000000000000000000000000')};
  const m={...source(-222003),price:sqrtRatioAtTick(-222003),tick:-222003};
  const result=planHybridAction(planner({market,source:m,portfolio:{amount0:0n,amount1:240000000n,position:null},
    balances:{amount0:0n,amount1:240000000n}}));
  assert(result.selected?.accepted);assert.equal(result.selected.token,1);assert(result.selected.amountOut>0n);
});

test('when swap cannot improve a no-swap plan, the planner chooses zero input and equality fails the gate',()=>{
  const m=source(),balanced={amount0:120000000n,amount1:500000000000000000n};
  const local={...grid,spanSpacings:[4],lowerOffsetPpm:[-500000],deploymentPpm:[500000],swapInputPpm:[100000]};
  const result=planHybridAction(planner({source:m,grid:local,balances:balanced,portfolio:{...balanced,position:null},stats:stats(0,0n),
    costs:{...stageCosts,approval:0n,withdrawCollect:0n,swap:0n,mint:0n,exit:0n},costBufferPpm:0,feeBufferPpm:0}));
  assert.equal(result.selected?.token,null);assert.equal(result.selected?.amountIn,0n);
  assert((result.selected?.benefitQuote??0n)<=(result.selected?.bufferQuote??0n));assert.equal(result.selected?.accepted,false);
  assert.equal(passesHybridEconomicGate(10n,10n),false);assert.equal(passesHybridEconomicGate(11n,10n),true);
});

test('stage journal charges submitted reverts once and never replays a completed swap',()=>{
  const state:HybridStageJournal={stage:'withdraw_collect',completedReceiptIds:[],gasChargedQuote:0n,positionActive:true,
    wallet:{amount0:10n,amount1:20n},failedReason:null};
  assert(applyHybridStage(state,{stage:'withdraw_collect',receiptId:'w',canonical:true,submitted:true,success:true,gasQuote:2n,nextStage:'swap',
    walletAfter:{amount0:15n,amount1:25n},positionActiveAfter:false}));
  assert.equal(state.positionActive,false);assert.equal(state.stage,'swap');
  assert(applyHybridStage(state,{stage:'swap',receiptId:'s-revert',canonical:true,submitted:true,success:false,gasQuote:3n,nextStage:'mint'}));
  assert.equal(state.stage,'swap');assert.deepEqual(state.wallet,{amount0:15n,amount1:25n});
  assert(applyHybridStage(state,{stage:'swap',receiptId:'s-ok',canonical:true,submitted:true,success:true,gasQuote:3n,nextStage:'mint',
    walletAfter:{amount0:5n,amount1:40n}}));
  assert.equal(applyHybridStage(state,{stage:'swap',receiptId:'s-ok',canonical:true,submitted:true,success:true,gasQuote:3n,nextStage:'mint'}),false);
  assert.deepEqual(state.wallet,{amount0:5n,amount1:40n});assert.equal(state.gasChargedQuote,8n);
});

test('stage journal fails closed on noncanonical and out-of-order receipts',()=>{
  const state:HybridStageJournal={stage:'swap',completedReceiptIds:[],gasChargedQuote:0n,positionActive:false,wallet:{amount0:1n,amount1:2n},failedReason:null};
  assert.throws(()=>applyHybridStage(state,{stage:'swap',receiptId:'x',canonical:false,submitted:true,success:true,gasQuote:1n,nextStage:'mint'}),/noncanonical/);
  assert.throws(()=>applyHybridStage(state,{stage:'mint',receiptId:'y',canonical:true,submitted:true,success:true,gasQuote:1n,nextStage:null}),/out_of_order/);
  assert.equal(state.gasChargedQuote,0n);
});

test('partial collection failure cannot replace the old position or wallet',()=>{
  const state:HybridStageJournal={stage:'withdraw_collect',completedReceiptIds:[],gasChargedQuote:0n,positionActive:true,
    wallet:{amount0:10n,amount1:20n},failedReason:null};
  assert(applyHybridStage(state,{stage:'withdraw_collect',receiptId:'partial',canonical:true,submitted:true,success:false,gasQuote:2n,
    nextStage:'swap',walletAfter:{amount0:100n,amount1:200n},positionActiveAfter:false,failureReason:'hybrid_partial_collection'}));
  assert.equal(state.stage,'withdraw_collect');assert.equal(state.positionActive,true);
  assert.deepEqual(state.wallet,{amount0:10n,amount1:20n});assert.equal(state.failedReason,'hybrid_partial_collection');
});

const replayCosts={entry:4n,recenter:6n,exit:2n,hold:1n,holdExit:1n,residual:4n};
const policy:AdaptivePolicy={name:'hybrid_test',halfWidthsTicks:[10,20],adaptive:true,economicGate:true,budget:240000000n,
  decisionMs:30000,quoteTtlMs:90000,horizonMs:600000,slippageBps:50,costBufferPpm:0,feeBufferPpm:0,
  gasMultiplier:1,feePpm:1000000,failEveryRecenter:0};
const replayOptions={grid,costs:stageCosts,gasBudgetQuote:10000000n,cooldownMs:60000,confirmations:2,stageTtlMs:180000,
  stageDelayMs:{approval:30000,withdraw_collect:30000,swap:30000,mint:30000}};

test('staged replay retains a completed swap across mint revert and recovery',async()=>{
  const model=new HybridLpReplay(NVDA_PAPER_MARKET,replayCosts,policy,replayOptions);
  await model.step(source(222003,0),stats(0));await model.step(source(222003,30000),stats(30000));assert(model.hybridPending);
  await model.advanceHybrid(source(222003,60000),stats(60000),'swap-ok');assert.equal(model.hybridPending?.stage,'mint');
  const afterSwap={amount0:model.cash0,amount1:model.cash1};
  await model.advanceHybrid(source(222003,90000),stats(90000),'mint-revert',true);assert.equal(model.hybridPending?.stage,'mint');
  assert.deepEqual({amount0:model.cash0,amount1:model.cash1},afterSwap);
  await model.advanceHybrid(source(222003,120000),stats(120000),'mint-ok');assert(model.position);assert.equal(model.entries,1);
  assert.equal(model.actions.filter(a=>a.kind==='entry').length,1);
});

test('snapshot reload resumes at mint and cannot replay its completed swap',async()=>{
  const first=new HybridLpReplay(NVDA_PAPER_MARKET,replayCosts,policy,replayOptions);
  await first.step(source(222003,0),stats(0));await first.step(source(222003,30000),stats(30000));
  await first.advanceHybrid(source(222003,60000),stats(60000),'swap-complete');assert.equal(first.hybridPending?.stage,'mint');
  const saved=Object.fromEntries(Object.entries(first).filter(([key])=>!['market','costs','policy','hybrid'].includes(key)));
  const restored=new HybridLpReplay(NVDA_PAPER_MARKET,replayCosts,policy,replayOptions);Object.assign(restored,structuredClone(saved));
  const wallet={amount0:restored.cash0,amount1:restored.cash1};
  await restored.advanceHybrid(source(222003,90000),stats(90000),'mint-complete');assert(restored.position);
  assert.equal(restored.hybridStages.filter(stage=>stage.stage==='swap').length,1);
  assert.equal(restored.actions.length,1);assert.notDeepEqual({amount0:restored.cash0,amount1:restored.cash1},wallet);
});

test('expired staged quotes and unavailable canonical coverage fail closed without cost',async()=>{
  const expired=new HybridLpReplay(NVDA_PAPER_MARKET,replayCosts,policy,replayOptions);
  await expired.step(source(222003,0),stats(0));await expired.step(source(222003,30000),stats(30000));assert(expired.hybridPending);
  await expired.advanceHybrid(source(222003,240001),stats(240001),'late');assert.equal(expired.hybridPending,null);assert.equal(expired.gas,0n);
  const blocked=new HybridLpReplay(NVDA_PAPER_MARKET,replayCosts,policy,replayOptions);
  await blocked.step(source(222003,0),stats(0));await blocked.step(source(222003,30000),stats(30000));assert(blocked.hybridPending);
  await blocked.advanceHybrid({...source(222003,60000),canonical:false} as ResearchSource&{canonical:false},stats(60000),'noncanonical');
  assert(blocked.hybridPending);assert.equal(blocked.gas,0n);assert.equal(blocked.rejected.hybrid_stage_source_unavailable,1);
});

test('exit reserve rejects an otherwise feasible action before custody changes',()=>{
  const result=planHybridAction(planner({gasBudgetQuote:1n}));assert.equal(result.selected,null);
  assert((result.rejected.hybrid_exit_reserve??0)>0);
});

test('cancellation before withdrawal preserves LP; cancellation after withdrawal preserves wallet inventory',async()=>{
  const entered=new HybridLpReplay(NVDA_PAPER_MARKET,replayCosts,policy,replayOptions);
  await entered.step(source(222003,0),stats(0));await entered.step(source(222003,30000),stats(30000));
  assert(entered.hybridPending);const plan=structuredClone(entered.hybridPending.plan);
  await entered.advanceHybrid(source(222003,60000),stats(60000),'swap');await entered.advanceHybrid(source(222003,90000),stats(90000),'mint');assert(entered.position);
  const oldPosition=structuredClone(entered.position),before=entered.balances(source(222003,90000));
  entered.hybridPending={plan,kind:'recenter',quotedAt:90000,quotedBlock:'90001',stage:'withdraw_collect',stageStartedAt:90000,
    completedReceiptIds:[],afterSwap:null,actualSwap:null,before:{amount0:String(before.amount0),amount1:String(before.amount1)}};
  assert(entered.cancelPending());assert.deepEqual(entered.position,oldPosition);
  // Model the reconciled post-withdraw boundary, then prove cancellation cannot
  // restore the NFT or spend the released wallet inventory.
  entered.cash0=before.amount0;entered.cash1=before.amount1;entered.position=null;
  entered.hybridPending={plan,kind:'recenter',quotedAt:90000,quotedBlock:'90001',stage:'swap',stageStartedAt:120000,
    completedReceiptIds:['withdraw'],afterSwap:null,actualSwap:null,before:{amount0:String(before.amount0),amount1:String(before.amount1)}};
  const wallet={amount0:entered.cash0,amount1:entered.cash1};assert(entered.cancelPending());
  assert.equal(entered.position,null);assert.deepEqual({amount0:entered.cash0,amount1:entered.cash1},wallet);
});

test('inactive hybrid paper config is isolated, fully costed, and reserves exactly $10 gas',()=>{
  const config=configSchema.parse(JSON.parse(readFileSync('config/hybrid-lp-250-paper.json','utf8')));
  assert(config.hybridRange);assert.equal(config.assets.length,1);assert(config.assets[0]!.hybridCosts);
  assert.equal(BigInt(config.budgetQuote)+BigInt(config.hybridRange.gasBudgetQuote),250000000n);
  const mixed=structuredClone(config) as Record<string,unknown>;mixed.inventoryRange={kind:'inventory_preserving_v1',spanSpacings:[1],cooldownMs:60000,confirmations:2,gasBudgetQuote:'1'};
  assert.throws(()=>configSchema.parse(mixed),/mutually exclusive/);
});
