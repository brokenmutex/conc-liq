import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {it} from 'node:test';
import type {Address,Hex} from 'viem';
import type {RobinhoodClient} from '../src/client.js';
import {parseRangeKeeperConfig} from '../src/strategy/rangekeeper/config.js';
import {buildLiveSetupSimulationEvidence,simulateLiveSetupCandidate,
 type LiveSetupSimulationRequest} from '../src/deployments/rangekeeper-live-setup-simulation.js';

const config=parseRangeKeeperConfig(JSON.parse(readFileSync('config/rangekeeper-v1-aapl-disabled.json','utf8')));
const source={block:'100',hash:`0x${'ab'.repeat(32)}`,timestamp:1000};
const request:LiveSetupSimulationRequest={profile:{pool:config.pool,referencePolicy:config.referencePolicy},source,
 operator:'0x0000000000000000000000000000000000000011',limits:config.limits,
 allocation:{token0Raw:'100000000',token1Raw:'0',nativeWei:'1000000000000000'},
 prices:{price0:10n**18n,price1:330n*10n**18n,nativePrice:2500n*10n**18n},
 baseFeePerGasWei:2n,marketGasPriceWei:3n,
 candidate:{kind:'entry',range:{tickLower:217900,tickUpper:217940},swap:{token:0,amountIn:50_000_000n,
  quotedOut:150_000_000_000_000_000n,minOut:149_000_000_000_000_000n,priceAfter:1n,
  feeValue:10n,shortfallValue:20n},amount0Desired:50_000_000n,amount1Desired:150_000_000_000_000_000n,
  amount0Min:49_000_000n,amount1Min:149_000_000_000_000_000n,liquidity:10n,
  deployedValue:100n*10n**18n,sourceBlock:100n,sourceHash:source.hash as Hex,expiresAt:1090}};
const report={source:{block:100n,hash:source.hash as Hex,timestamp:1000},createdTokenId:5n,
 gasByStage:[{phase:'entry' as const,kind:'mint',gasUsed:100n},{phase:'entry' as const,kind:'approve',gasUsed:10n},
  {phase:'exit' as const,kind:'withdraw',gasUsed:200n},{phase:'exit' as const,kind:'swap',gasUsed:20n}]};

it('allocated lifecycle evidence prices entry cleanup and complete exit separately and binds scope',()=>{
 const evidence=buildLiveSetupSimulationEvidence(request,report);
 assert.equal(evidence.actionGasWei,'572');
 assert.equal(evidence.completeExitGasWei,'1144');
 assert.equal(evidence.exitReserveWei,String(config.limits.exitReserveWei));
 assert.equal(evidence.estimatedCostValue,String(572n*2500n+30n));
 assert.equal(evidence.syntheticNativeFunding,true);
 const another=buildLiveSetupSimulationEvidence({...request,operator:'0x0000000000000000000000000000000000000022'},report);
 assert.notEqual(evidence.sequenceHash,another.sequenceHash);
 const changed=buildLiveSetupSimulationEvidence({...request,allocation:{...request.allocation,token0Raw:'200000000'}},report);
 assert.notEqual(evidence.allocationHash,changed.allocationHash);
 assert.notEqual(evidence.sequenceHash,changed.sequenceHash);
});

it('entry-only or changed-source samples cannot become complete live setup cost evidence',()=>{
 assert.throws(()=>buildLiveSetupSimulationEvidence(request,{...report,gasByStage:report.gasByStage.filter(s=>s.phase==='entry')}),
  /Complete fork lifecycle/);
 assert.throws(()=>buildLiveSetupSimulationEvidence(request,{...report,source:{...report.source,hash:`0x${'cd'.repeat(32)}`}}));
 assert.throws(()=>buildLiveSetupSimulationEvidence(request,{...report,gasByStage:[...report.gasByStage,
  {phase:'entry',kind:'approve',gasUsed:0n}]}),/Fork gas stages/);
});

it('review confines the fork to its initial allocation and rejects a post-fork canonical change',async()=>{
 let reads=0,calls=0;
 const client={getChainId:async()=>4663,getBlock:async(input?:{blockNumber:bigint})=>{
  if(!input)return {number:164n};reads++;
  return {hash:reads===1?source.hash:`0x${'cd'.repeat(32)}`,timestamp:1000n};
 }} as unknown as RobinhoodClient;
 await assert.rejects(()=>simulateLiveSetupCandidate(request,{client,rpcUrl:'http://archive.invalid',anvilBinary:'/unused',
  runFork:async input=>{
   calls++;assert.deepEqual(input.allocation,{amount0:100_000_000n,amount1:0n});
   assert.equal(input.operator.toLowerCase(),(request.operator as Address).toLowerCase());
   assert(input.rehearseExit);
   assert.equal(input.allowancePolicy,'persistent_capped_v1','the shared wallet review simulates persistent capped allowances');
   return report;
  }}),/source changed/);
 assert.equal(calls,1);
});
