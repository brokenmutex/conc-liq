import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {createRangeKeeperLiveRuntime} from '../src/deployments/rangekeeper-live-runtime.js';

const baseInput=()=>({pool:{} as any,client:{} as any,walletAddress:'0x0000000000000000000000000000000000000900',
 transferStore:{} as any,loadProfiles:async()=>[],rpcUrl:'http://127.0.0.1:8545',anvilBinary:'/tmp/anvil',buildId:'b'.repeat(64)});

describe('composed RangeKeeper live runtime',()=>{
 it('keeps execution and automatic management closed by default',async()=>{
 const runtime=createRangeKeeperLiveRuntime(baseInput());
  assert.equal(runtime.adapters.signIntent,undefined);
  assert.equal(runtime.adapters.publishRaw,undefined);
  assert.deepEqual(await runtime.planner.observeAndEnqueueManagement(),{status:'disabled',processed:0});
  const ready=await runtime.workerReadiness();assert.equal(ready.ready,false);
  assert(ready.missing.includes('live_signer_and_publisher_not_configured'));
 });

 it('installs only explicitly injected signer and publisher callbacks',()=>{
  const signIntent=async()=>`0x${'11'.repeat(32)}` as `0x${string}`;
  const publishRaw=async()=>`0x${'22'.repeat(32)}` as `0x${string}`;
  const runtime=createRangeKeeperLiveRuntime({...baseInput(),execution:{enabled:true,signIntent,publishRaw}});
  assert.equal(runtime.adapters.signIntent,signIntent);
  assert.equal(runtime.adapters.publishRaw,publishRaw);
 });

 it('requires explicit review persistence before enabling automatic management',()=>{
  assert.throws(()=>createRangeKeeperLiveRuntime({...baseInput(),managementEnabled:true}),/review persistence/i);
 });
});
