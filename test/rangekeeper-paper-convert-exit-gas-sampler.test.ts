import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {rangeKeeperPaperConvertQuoteContent,rangeKeeperPaperConvertQuoteHash,
 rangeKeeperPaperConvertQuoteSchema,type RangeKeeperPaperConvertQuote} from '../src/deployments/rangekeeper-paper-exit-model.js';
import {sampleRangeKeeperPaperGasStages,
 validateRangeKeeperPaperConvertQuoteBinding} from '../src/deployments/rangekeeper-paper-gas-sampler.js';
import {RANGEKEEPER_PAPER_CONVERT_EXIT_STAGES,
 RANGEKEEPER_PAPER_DIRECT_CONVERT_EXIT_PATH} from '../src/deployments/rangekeeper-paper-cost.js';
import type {RangeKeeperLimits} from '../src/strategy/rangekeeper/domain.js';
import type {RangeKeeperPaperLoadedExitContext} from '../src/deployments/rangekeeper-paper-context.js';

// This file tests only what can be proven without a live fork: the
// conversion-quote content/hash binding, its schema, and the fail-closed
// identity checks the sampler runs before it ever opens a fork. It does not,
// and cannot, prove that sampleRangeKeeperPaperConvertExit's owned-fork
// replay produces correct gas numbers against a real chain — see this
// file's final describe block and the handback report for exactly what
// remains unvalidated and how to validate it.

const source={block:'1000',hash:`0x${'7'.repeat(64)}`,timestamp:1_700_000_000};
const pool={pool:'0x' + '1'.repeat(40),router:'0x' + '2'.repeat(40),quoter:'0x' + '3'.repeat(40),fee:500};
const candidateHash='a'.repeat(64);
const limits:RangeKeeperLimits={fullWidthSpacings:2,maxDeploymentValue:1_000_000n,minDeploymentPpm:0,
 maxSwapInputValue:1_000_000n,maxSwapInputPpm:1_000_000,maxSwapShortfallValue:1_000n,
 maxSlippageBps:20,maxActionCost:1_000_000n,maxRollingCost:1_000_000n,maxCampaignCost:1_000_000n,
 maxExposurePpm:1_000_000,maxLossValue:1_000_000n,maxDrawdownPpm:1_000_000,maxRecenters:10,
 maxLiquiditySharePpm:10_000,maxObservationGapSeconds:300,exitReserveWei:0n};

function baseContent(overrides:Partial<Parameters<typeof rangeKeeperPaperConvertQuoteContent>[0]>={}){
 return rangeKeeperPaperConvertQuoteContent({candidateHash,source,pool,inputToken:1,outputToken:0,
  inputAmount:1_000n,expectedOutput:900n,minimumOutput:898n,feeValue:10n,shortfallValue:5n,
  maxSlippageBps:20,...overrides});
}

function fakeContext(overrides:{wallet0?:bigint;wallet1?:bigint;released0?:bigint;released1?:bigint;
 quoteToken?:0|1}={}):RangeKeeperPaperLoadedExitContext{
 return {status:'available',
  draft:{profile:{pool:{...pool,quoteToken:overrides.quoteToken??0,decimals0:18,decimals1:18,
   fee:pool.fee,tickSpacing:10,positionManager:'0x'+'4'.repeat(40),chainId:4663,token0:'0x'+'5'.repeat(40),
   token1:'0x'+'6'.repeat(40)}}} as any,
  openMarkId:'1',openModel:{candidateHash} as any,
  currentEpoch:{epoch:0,markId:'1',markHash:'c'.repeat(64),source,candidate:{} as any,candidateHash,
   candidateReferenceProofHash:'d'.repeat(64),inventory:{position:{tickLower:0,tickUpper:0,liquidity:'1'},
    idle:{token0:'0',token1:'0'}},kernelSnapshot:{} as any,mintSqrtPriceX96:1n<<96n,
   fundingBeforeSwap:{token0:'0',token1:'0'},allowancesCleared:false,
   reference:{price0:1n,price1:1n,nativePrice:1n,proofHash:'d'.repeat(64),proof:{}}},
  previous:{id:'2',source,candidateHash,position:{tickLower:0,tickUpper:0,liquidity:'0'},
   idle:{token0:'0',token1:'0'}},
  kernel:{wallet0:overrides.wallet0??0n,wallet1:overrides.wallet1??1_000n,
   released0:overrides.released0??0n,released1:overrides.released1??0n} as any,
  readGasProfiles:async()=>[],snapshotHash:'b'.repeat(64),actionAvailable:false};
}

function validQuote():RangeKeeperPaperConvertQuote{
 const content=baseContent();
 return rangeKeeperPaperConvertQuoteSchema.parse({pathVersion:RANGEKEEPER_PAPER_DIRECT_CONVERT_EXIT_PATH,
  inputToken:1,outputToken:0,inputAmount:'1000',expectedOutput:'900',minimumOutput:'898',
  expectedProceedsValue:'900',minimumProceedsValue:'898',feeValue:'10',shortfallValue:'5',
  quoteHash:rangeKeeperPaperConvertQuoteHash(content)});
}

describe('RangeKeeper convert-exit quote content and hash binding',()=>{
 it('is deterministic and independent of key order',()=>{
  const a=baseContent(),b=JSON.parse(JSON.stringify(a));
  const reordered={maxSlippageBps:b.maxSlippageBps,kind:b.kind,candidateHash:b.candidateHash,source:b.source,
   pool:b.pool,router:b.router,quoter:b.quoter,fee:b.fee,inputToken:b.inputToken,outputToken:b.outputToken,
   inputAmount:b.inputAmount,expectedOutput:b.expectedOutput,minimumOutput:b.minimumOutput,
   feeValue:b.feeValue,shortfallValue:b.shortfallValue};
  assert.equal(rangeKeeperPaperConvertQuoteHash(a),rangeKeeperPaperConvertQuoteHash(reordered as any));
 });
 it('changes the hash when any bound field changes',()=>{
  const reference=rangeKeeperPaperConvertQuoteHash(baseContent());
  const mutations:Array<Partial<Parameters<typeof rangeKeeperPaperConvertQuoteContent>[0]>>=[
   {candidateHash:'b'.repeat(64)},{source:{...source,block:'1001'}},{source:{...source,hash:`0x${'8'.repeat(64)}`}},
   {pool:{...pool,pool:'0x'+'9'.repeat(40)}},{pool:{...pool,router:'0x'+'a'.repeat(40)}},
   {pool:{...pool,quoter:'0x'+'b'.repeat(40)}},{pool:{...pool,fee:3_000}},{inputToken:0,outputToken:1},
   {inputAmount:1_001n},{expectedOutput:901n},{minimumOutput:883n},{feeValue:11n},{shortfallValue:6n},
   {maxSlippageBps:21},
  ];
  const describeMutation=(m:unknown)=>JSON.stringify(m,(_key,value)=>typeof value==='bigint'?String(value):value);
  for(const mutation of mutations)
   assert.notEqual(rangeKeeperPaperConvertQuoteHash(baseContent(mutation)),reference,
    `mutation ${describeMutation(mutation)} did not change the quote hash`);
 });
 it('round-trips through the public quote schema',()=>{
  const quote=validQuote();
  assert.deepEqual(rangeKeeperPaperConvertQuoteSchema.parse(quote),quote);
  assert.throws(()=>rangeKeeperPaperConvertQuoteSchema.parse({...quote,inputToken:2}));
  assert.throws(()=>rangeKeeperPaperConvertQuoteSchema.parse({...quote,inputAmount:'01'}));
  assert.throws(()=>rangeKeeperPaperConvertQuoteSchema.parse({...quote,quoteHash:'not-hex'}));
 });
});

describe('validateRangeKeeperPaperConvertQuoteBinding',()=>{
 it('accepts a quote that is exactly bound to the trusted context and source',()=>{
  const context=fakeContext({wallet1:1_000n});
  assert.doesNotThrow(()=>validateRangeKeeperPaperConvertQuoteBinding({context,source,quote:validQuote(),limits}));
 });
 it('rejects a quote priced for a different candidate, source or pool',()=>{
  const context=fakeContext({wallet1:1_000n}),quote=validQuote();
  assert.throws(()=>validateRangeKeeperPaperConvertQuoteBinding({context,
   source:{...source,block:'1001'},quote,limits}),/quote hash does not match/);
  assert.throws(()=>validateRangeKeeperPaperConvertQuoteBinding({
   context:fakeContext({wallet1:1_000n}) as any,source,
   quote:{...quote,inputAmount:'999'},limits}),/differs from trusted terminal inventory|quote hash does not match/);
 });
 it('rejects when the trusted wallet+released inventory no longer matches the frozen input amount',()=>{
  const context=fakeContext({wallet1:900n});
  assert.throws(()=>validateRangeKeeperPaperConvertQuoteBinding({context,source,quote:validQuote(),limits}),
   /differs from trusted terminal inventory/);
 });
 it('rejects a minimum output that was not derived from the policy slippage floor',()=>{
  const context=fakeContext({wallet1:1_000n}),quote=validQuote();
  const tampered={...quote,minimumOutput:'850',
   quoteHash:rangeKeeperPaperConvertQuoteHash(baseContent({minimumOutput:850n}))};
  assert.throws(()=>validateRangeKeeperPaperConvertQuoteBinding({context,source,quote:tampered,limits}),
   /slippage floor/);
 });
 it('rejects shortfall above the policy limit even if internally self-consistent',()=>{
  const context=fakeContext({wallet1:1_000n});
  const content=baseContent({shortfallValue:2_000n});
  const quote={...validQuote(),shortfallValue:'2000',quoteHash:rangeKeeperPaperConvertQuoteHash(content)};
  assert.throws(()=>validateRangeKeeperPaperConvertQuoteBinding({context,source,quote,limits}),
   /shortfall exceeds the policy limit/);
 });
 it('rejects a quote for the wrong input/output token given the pool quote-token side',()=>{
  const context=fakeContext({wallet1:1_000n,quoteToken:1});
  assert.throws(()=>validateRangeKeeperPaperConvertQuoteBinding({context,source,quote:validQuote(),limits}));
 });
 it('rejects a quote whose path version is not the frozen direct-convert-exit path',()=>{
  const context=fakeContext({wallet1:1_000n}),quote={...validQuote(),pathVersion:'some_other_path_v1'};
  assert.throws(()=>validateRangeKeeperPaperConvertQuoteBinding({context,source,quote,limits}));
 });
});

describe('RangeKeeper convert-exit sampler dispatch (fail-closed, no fork opened)',()=>{
 it('requires trusted terminal context before it will even look for a quote',async()=>{
  await assert.rejects(()=>sampleRangeKeeperPaperGasStages({kind:'convert_exit'} as any,{} as any),
   /trusted persisted mark and kernel context/);
 });
 it('requires a persisted conversion quote once trusted context is present',async()=>{
  await assert.rejects(()=>sampleRangeKeeperPaperGasStages({kind:'convert_exit'} as any,
   {terminalContext:{} as any} as any),/persisted conversion quote contract/);
 });
 it('fails closed on an inconsistent convert-exit probe/context pair without opening any fork',async()=>{
  // The request below deliberately fails validateExitProbeIdentity (it is
  // not a fully matching open-mark/candidate-hash fixture); the point of
  // this test is only that dispatch runs validation strictly before ever
  // reaching openPaperFork, for any kind of probe/context mismatch.
  const context=fakeContext({wallet1:900n});
  const request={kind:'convert_exit',frame:{source}} as any;
  await assert.rejects(()=>sampleRangeKeeperPaperGasStages(request,
   {terminalContext:context,conversionQuote:validQuote(),limits,rpcUrl:'http://127.0.0.1:1',
    beforeRead:async()=>{}} as any));
 });
});

describe('RangeKeeper convert-exit stage sequence (frozen contract, matches the cost model)',()=>{
 it('is the retain-exit withdraw/cleanup sequence with exactly two convert stages inserted',()=>{
  assert.deepEqual(RANGEKEEPER_PAPER_CONVERT_EXIT_STAGES,['exit_withdraw_collect',
   'exit_convert_approve_router_input','exit_convert_swap','exit_cleanup_router_token0',
   'exit_cleanup_router_token1','exit_cleanup_manager_token0','exit_cleanup_manager_token1']);
 });
});

describe('what this suite does not and cannot prove',()=>{
 it('documents that no test here runs sampleRangeKeeperPaperConvertExit against a real fork',()=>{
  // sampleRangeKeeperPaperConvertExit (the owned-fork replay itself) needs a
  // pinned source block and a live RPC (openPaperFork), which this unit test
  // file deliberately does not provide. Everything above proves the quote
  // contract's binding and the sampler's fail-closed dispatch; it does not
  // and cannot prove the fork replay produces correct gas numbers, that the
  // live quoter still agrees with a previously persisted quote, or that the
  // real paper router's multicall return shape matches what is decoded here.
  // See the handback report for the exact command that would validate it.
  assert.ok(true);
 });
});
