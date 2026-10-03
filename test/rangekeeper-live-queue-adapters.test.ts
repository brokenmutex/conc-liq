import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {assertCleanupAllowanceIdentityCoverage,buildRangeKeeperLiveEntryState,buildRangeKeeperLiveTerminalSnapshot,
 configuredAllowanceTargets,rangeKeeperLiveCapabilityCacheKey,readRangeKeeperLiveTerminalEffect} from '../src/deployments/rangekeeper-live-queue-adapters.js';
import {mergeAllowanceTargetsBySpender} from '../src/deployments/rangekeeper-live-wallet-chain.js';
import {assertOwnedPaperFork} from '../src/paper/fork.js';
import {rangeKeeperJson} from '../src/strategy/rangekeeper/live-domain.js';

describe('RangeKeeper live stage capability cache binding',()=>{
 it('normalizes bigint plan values and binds the cache entry to exact intent and plan',()=>{
  const base={id:'intent-1',nonce:7,gas:'8000000'},plan={kind:'approve',amount:900719925474099312345n};
  const key=rangeKeeperLiveCapabilityCacheKey('job-1','approve:abc',base,plan);
  assert.match(key,/^job-1:approve:abc:[0-9a-f]{64}$/);
  assert.notEqual(key,rangeKeeperLiveCapabilityCacheKey('job-2','approve:abc',base,plan));
  assert.notEqual(key,rangeKeeperLiveCapabilityCacheKey('job-1','approve:abc',{...base,nonce:8},plan));
  assert.notEqual(key,rangeKeeperLiveCapabilityCacheKey('job-1','approve:abc',base,{...plan,amount:plan.amount+1n}));
 });
 it('builds the opening runtime state from the frozen review and campaign allocation',()=>{
  const candidate={kind:'entry',range:{tickLower:-10,tickUpper:10},swap:null,amount0Desired:'20',amount1Desired:'30',
   amount0Min:'18',amount1Min:'28',liquidity:'40',deployedValue:'50',sourceBlock:'100',sourceHash:`0x${'1'.repeat(64)}`,expiresAt:1000};
  const campaign:any={id:'c1',wallet:'0x0000000000000000000000000000000000000001',profile:{},profileHash:'a'.repeat(64),
   config:{operator:'0x0000000000000000000000000000000000000001',pool:{token0:'0x0000000000000000000000000000000000000002',
    token1:'0x0000000000000000000000000000000000000003'},campaignScope:{maxDurationSeconds:43200}},
   allocation:{liquidByTokenAddress:{'0x0000000000000000000000000000000000000002':20n,
    '0x0000000000000000000000000000000000000003':30n},nativeSpendWei:5n,exitReserveWei:7n},
   reviewPayload:{candidate,requirements:{strategyAllocationValueUsdX18:'50'},binding:{buildId:'b'.repeat(64)}}};
  const snapshot:any={source:{timestamp:100},nftCount:0n,operator:campaign.wallet};
  const state=buildRangeKeeperLiveEntryState(campaign,snapshot);
  assert.equal(state.phase,'entry');assert.equal(state.exitMode,null);assert.equal(state.last,snapshot);assert.equal(state.initial0,20n);assert.equal(state.initial1,30n);
  assert.equal(state.initialNativeWei,12n);assert.equal(state.reserveNativeWei,0n);assert.equal(state.candidate?.amount1Desired,30n);
 });
 it('does not accept a caller-created fork-shaped object as a test signing target',()=>{
  assert.throws(()=>assertOwnedPaperFork({localUrl:'http://127.0.0.1:8545',rpc:async()=>{},close:async()=>{}}));
 });
 it('deduplicates configured token allowance pairs into unique spender read targets',()=>{
  const spender='0x000000000022D473030F116dDEE9F6B43aC78BA3',token0='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
   token1='0xaf3d76f1834a1d425780943c99ea8a608f8a93f9';
  const targets=configuredAllowanceTargets([{token:token0,spender},{token:token1,spender}],[token0,token1]);
  assert.equal(targets.length,1);assert.equal(targets[0]?.address.toLowerCase(),spender.toLowerCase());
  const merged=mergeAllowanceTargetsBySpender([{address:spender,label:'configured:token0'},
   {address:spender.toLowerCase(),label:'configured:token1'},{address:token0,label:'router'}]);
  assert.equal(merged.length,2);assert(merged.some(t=>t.address.toLowerCase()===spender.toLowerCase()&&
   t.label==='configured:token0+configured:token1'));
  assert.throws(()=>configuredAllowanceTargets([{token:'0x3333333333333333333333333333333333333333',spender}],[token0]),
   /outside registered wallet token scope/);
 });
 it('requires cleanup to retain every allowance pair in the final canonical wallet image',()=>{
  const expected=[{token:'0x1111111111111111111111111111111111111111',spender:'0x2222222222222222222222222222222222222222'},
   {token:'0x3333333333333333333333333333333333333333',spender:'0x4444444444444444444444444444444444444444'}];
  assert.doesNotThrow(()=>assertCleanupAllowanceIdentityCoverage(expected,[...expected,
   {token:'0x5555555555555555555555555555555555555555',spender:'0x6666666666666666666666666666666666666666'}]));
  assert.throws(()=>assertCleanupAllowanceIdentityCoverage(expected,[expected[0]!]),/omitted a persisted allowance identity/);
  assert.throws(()=>assertCleanupAllowanceIdentityCoverage(expected,[...expected,expected[0]!]),/contains duplicates/);
 });
 it('decodes persisted terminal outbox bigints before binding pool, reference and cleanup sources',()=>{
  const source={block:'1234',hash:`0x${'a'.repeat(64)}`,timestamp:1000},snapshot={source:{...source,block:1234n},operator:'0x0000000000000000000000000000000000000001',
   nativeWei:9n,position:null,nftCount:0n},referenceValuation={source,proofHash:'b'.repeat(64),price0:'1',price1:'2',nativePrice:'3',evidence:{kind:'rangekeeper_live_independent_reference_v1'}};
  const effects=JSON.parse(JSON.stringify({source,afterPool:JSON.parse(rangeKeeperJson(snapshot)),referenceValuation}));
  const evidence=readRangeKeeperLiveTerminalEffect(effects,source);
  assert(evidence);assert.equal(evidence.snapshot.source.block,1234n);assert.equal(evidence.snapshot.nativeWei,9n);
  assert.equal(evidence.referenceValuation?.proofHash,referenceValuation.proofHash);
  assert.equal(evidence.positionFeeEvidence,null);
  const changedSnapshot=JSON.parse(JSON.stringify({...effects,afterPool:{...effects.afterPool,source:{...effects.afterPool.source,
   block:{__rangekeeper_bigint_v1__:'1235'}}}}));
  assert.equal(readRangeKeeperLiveTerminalEffect(changedSnapshot,source),null,'A changed terminal snapshot anchor must stay unavailable');
 });
 it('projects an after-withdraw zero-liquidity NFT as empty only with exact cleanup and retired-token proof',()=>{
  const source={block:'1234',hash:`0x${'a'.repeat(64)}`,timestamp:1000},wallet='0x0000000000000000000000000000000000000001',
   token0='0x0000000000000000000000000000000000000002',token1='0x0000000000000000000000000000000000000003';
  const campaign:any={wallet,config:{pool:{token0,token1,fee:500}},state:{reserve0:0n,reserve1:0n,reserveNativeWei:0n,
   retiredTokenIds:['42']},allocation:{liquidByTokenAddress:{[token0]:5n,[token1]:6n},nativeSpendWei:7n,exitReserveWei:8n,nftTokenIds:[]}};
  const snapshot:any={source:{...source,block:1234n},operator:wallet,wallet0:50n,wallet1:60n,nativeWei:99n,nftCount:1n,
   position:{tokenId:42n,owner:wallet,token0,token1,fee:500,tickLower:-10,tickUpper:10,liquidity:0n,tokensOwed0:0n,tokensOwed1:0n}};
  const storedEffects=JSON.parse(JSON.stringify({source,afterPool:JSON.parse(rangeKeeperJson(snapshot))}));
  const terminalEffect=readRangeKeeperLiveTerminalEffect(storedEffects,source);assert(terminalEffect);
  const canonicalAfterWithdraw=terminalEffect.snapshot as any;
  const cleanup={verified:true,custodyState:'closed_empty',source};
  const terminal=buildRangeKeeperLiveTerminalSnapshot(campaign,canonicalAfterWithdraw,cleanup);
  assert.equal(terminal.position,null);assert.equal(terminal.nftCount,0n);assert.equal(terminal.wallet0,5n);
  assert.equal(terminal.wallet1,6n);assert.equal(terminal.nativeWei,15n);
  assert.throws(()=>buildRangeKeeperLiveTerminalSnapshot(campaign,{...canonicalAfterWithdraw,position:{...canonicalAfterWithdraw.position,liquidity:1n}},cleanup),
   /liquidity or owed tokens/);
  assert.throws(()=>buildRangeKeeperLiveTerminalSnapshot(campaign,{...canonicalAfterWithdraw,position:{...canonicalAfterWithdraw.position,tokensOwed1:1n}},cleanup),
   /liquidity or owed tokens/);
  assert.throws(()=>buildRangeKeeperLiveTerminalSnapshot({...campaign,state:{...campaign.state,retiredTokenIds:[]}},canonicalAfterWithdraw,cleanup),
   /not recorded as retired/);
  assert.throws(()=>buildRangeKeeperLiveTerminalSnapshot(campaign,snapshot,{...cleanup,source:{...source,block:'1235'}}),
   /differs from cleanup source/);
 });
});
