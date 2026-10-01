import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {assertRangeKeeperPaperTerminalInventory,rangeKeeperPaperCandidateFunding,
 rangeKeeperPaperTerminalAllowances,sampleRangeKeeperPaperGasStages,
 assertSameRangeKeeperPinnedReferenceProof,assertRangeKeeperTerminalReferenceMatch,
 assertRangeKeeperPaperRetiredPosition,rangeKeeperPaperWithdrawalMinimum}
 from '../src/deployments/rangekeeper-paper-gas-sampler.js';
import {replayPaperMint} from '../src/v3/position-math.js';
import type {RangeKeeperCandidate} from '../src/strategy/rangekeeper/domain.js';

const base:RangeKeeperCandidate={kind:'entry',range:{tickLower:-10,tickUpper:10},swap:null,
 amount0Desired:100n,amount1Desired:50n,amount0Min:99n,amount1Min:49n,liquidity:1n,
 deployedValue:150n,sourceBlock:7n,sourceHash:`0x${'1'.repeat(64)}`,expiresAt:1_000};

describe('RangeKeeper owned-fork gas sampler inventory',()=>{
 it('normalizes only pinned external-source fetch time while preserving byte and feed identity',()=>{
  const proof={token1:{oracle:{state:{roundId:'17',answer:'101'}}},
   registry:{fetchedAt:'2026-09-24T10:00:00.000Z',sha256:'sha256:'+'a'.repeat(64),url:'https://example.test/registry'},
   feedDirectory:{fetchedAt:'2026-09-24T10:00:00.000Z',sha256:'sha256:'+'b'.repeat(64),url:'https://example.test/feeds'}};
  const reread={...proof,registry:{...proof.registry,fetchedAt:'2026-09-24T10:00:02.000Z'},
   feedDirectory:{...proof.feedDirectory,fetchedAt:'2026-09-24T10:00:02.000Z'}};
  assert.doesNotThrow(()=>assertSameRangeKeeperPinnedReferenceProof(proof,reread));
  assert.throws(()=>assertSameRangeKeeperPinnedReferenceProof(proof,{...reread,
   registry:{...reread.registry,sha256:'sha256:'+'c'.repeat(64)}}),/source bytes or URL changed/);
  assert.throws(()=>assertSameRangeKeeperPinnedReferenceProof(proof,{...reread,
   feedDirectory:{...reread.feedDirectory,url:'https://example.test/other-feeds'}}),/source bytes or URL changed/);
  assert.throws(()=>assertSameRangeKeeperPinnedReferenceProof(proof,{...reread,
   token1:{oracle:{state:{roundId:'18',answer:'101'}}}}),/round, or chain reference proof changed/);
 });
 it('requires terminal replay to match native price as well as token prices and stable proof bytes',()=>{
  const proof={token1:{oracle:{state:{roundId:'17',answer:'101'}}},
   registry:{fetchedAt:'2026-09-24T10:00:00.000Z',sha256:'sha256:'+'a'.repeat(64),url:'https://example.test/registry'},
   feedDirectory:{fetchedAt:'2026-09-24T10:00:00.000Z',sha256:'sha256:'+'b'.repeat(64),url:'https://example.test/feeds'}};
  const frame={price0:2n,price1:3n,nativePrice:4n,referenceProof:proof} as any;
  assert.doesNotThrow(()=>assertRangeKeeperTerminalReferenceMatch(frame,{eligible:true,price0:2n,price1:3n,
   nativePrice:4n,proof:{...proof,registry:{...proof.registry,fetchedAt:'2026-09-24T10:00:02.000Z'}}}));
  assert.throws(()=>assertRangeKeeperTerminalReferenceMatch(frame,{eligible:true,price0:2n,price1:3n,
   nativePrice:5n,proof}),/reference values mismatch/);
  assert.throws(()=>assertRangeKeeperTerminalReferenceMatch(frame,{eligible:true,price0:2n,price1:3n,
   nativePrice:4n,proof:{...proof,token1:{oracle:{state:{roundId:'18',answer:'101'}}}}}),
   /round, or chain reference proof changed/);
 });
 it('models V3 decrease-and-collect as an owned retired NFT and applies basis-point slippage',()=>{
  assert.equal(rangeKeeperPaperWithdrawalMinimum(10_000n,50),9_950n);
  assert.equal(rangeKeeperPaperWithdrawalMinimum(10_000n,10_000),0n);
  const retired={nftCount:1n,owner:'0x0000000000000000000000000000000000000001',
   liquidity:0n,tokensOwed0:0n,tokensOwed1:0n};
  assert.doesNotThrow(()=>assertRangeKeeperPaperRetiredPosition(retired,retired.owner));
  assert.throws(()=>assertRangeKeeperPaperRetiredPosition({...retired,nftCount:0n},retired.owner),/retain its one/);
  assert.throws(()=>assertRangeKeeperPaperRetiredPosition({...retired,owner:'0x0000000000000000000000000000000000000002'},retired.owner),
   /changed NFT owner/);
  assert.throws(()=>assertRangeKeeperPaperRetiredPosition({...retired,liquidity:1n},retired.owner),/0n/);
  assert.throws(()=>rangeKeeperPaperWithdrawalMinimum(100n,10_001),/slippage input is invalid/);
 });
 it('keeps trusted draft idle inventory when replaying either swap direction',()=>{
  const candidate={...base,swap:{token:0 as const,amountIn:20n,quotedOut:15n,minOut:14n,
   priceAfter:1n,feeValue:0n,shortfallValue:0n}};
  assert.deepEqual(rangeKeeperPaperCandidateFunding(candidate,[140n,55n]),[120n,70n]);
  assert.deepEqual(rangeKeeperPaperCandidateFunding({...candidate,swap:{...candidate.swap,token:1}},[140n,75n]),[155n,55n]);
 });
 it('fails closed if trusted draft inventory cannot fund the swap or mint',()=>{
  const candidate={...base,amount1Desired:14n,swap:{token:0 as const,amountIn:20n,quotedOut:15n,
   minOut:14n,priceAfter:1n,feeValue:0n,shortfallValue:0n}};
  assert.throws(()=>rangeKeeperPaperCandidateFunding(candidate,[100n,50n]),/cannot fund frozen mint candidate/);
  assert.throws(()=>rangeKeeperPaperCandidateFunding(candidate,[10n,50n]),/cannot fund frozen swap input/);
 });
 it('reconstructs persisted terminal idle balances and exact residual approvals',()=>{
  const minted=replayPaperMint(1n<<96n,base.range,base.amount0Desired,base.amount1Desired,0n);
  const result=rangeKeeperPaperTerminalAllowances({candidate:{...base,liquidity:minted.liquidity},
   allocation:{token0Raw:String(minted.amount0+7n),token1Raw:String(minted.amount1+9n)},
   openSqrtPriceX96:1n<<96n,openPrice0:1n,openPrice1:1n,decimals0:0,decimals1:0,
   maxDeploymentValue:1_000n});
  assert.equal(result.idle0,7n);assert.equal(result.idle1,9n);
  assert.equal(result.manager0,7n);assert.equal(result.manager1,9n);
  assert.equal(result.router0,0n);assert.equal(result.router1,0n);
 });
 it('rejects terminal inventory that differs from the saved mark',()=>{
  const fake={previous:{idle:{token0:'7',token1:'9'}},kernel:{wallet0:7n,wallet1:9n,
   released0:0n,released1:0n}} as any;
  const frame={sqrtPriceX96:1n<<96n} as any;
  assert.throws(()=>assertRangeKeeperPaperTerminalInventory(fake,base,frame,{idle0:8n,idle1:9n}),
   /differs from saved mark/);
 });
 it('fails closed on convert-exit without trusted context or a persisted conversion quote',async()=>{
  await assert.rejects(()=>sampleRangeKeeperPaperGasStages({kind:'convert_exit'} as any,{} as any),
   /trusted persisted mark and kernel context/);
  await assert.rejects(()=>sampleRangeKeeperPaperGasStages({kind:'convert_exit'} as any,
   {terminalContext:{} as any} as any),/persisted conversion quote contract/);
 });
});
