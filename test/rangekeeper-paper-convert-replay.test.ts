import assert from 'node:assert/strict';
import test from 'node:test';
import {assertRangeKeeperPaperConvertReplayCapability,
 assertRangeKeeperPaperConvertReplayCost,isRangeKeeperPaperConvertReplayCapability,replayRangeKeeperPaperConvertOnOwnedFork}
 from '../src/deployments/rangekeeper-paper-convert-replay.js';

const binding={operationId:'10000000-0000-4000-8000-000000000001',
 previewId:'10000000-0000-4000-8000-000000000002',campaignId:'10000000-0000-4000-8000-000000000003',
 revision:1,operationSnapshotHash:'a'.repeat(64),modelHash:'b'.repeat(64),quoteHash:'c'.repeat(64),
 sourceBlock:'100',sourceHash:`0x${'d'.repeat(64)}`};
test('conversion completion rejects serialized and caller-authored replay claims',()=>{
 const fabricated={...binding,status:'matched',simulationHash:'e'.repeat(64),actionAvailable:false};
 for(const value of [null,{},fabricated,JSON.parse(JSON.stringify(fabricated))]){
  assert.equal(isRangeKeeperPaperConvertReplayCapability(value,binding),false);
  assert.throws(()=>assertRangeKeeperPaperConvertReplayCapability(value,binding),
   /rangekeeper_paper_convert_replay_capability_invalid/);
 }
});
test('conversion replay admits price movement inside the accepted budget and rejects overruns',()=>{
 const costs={boundGasPriceWei:'125',boundGasUnits:'130',boundWei:'16250',boundValue:'16260'},
  input={costs,gasUnits:100n,marketGasPriceWei:110n,nativePrice:10n**18n,swapCost:10n,nativeWei:17000n};
 assert.doesNotThrow(()=>assertRangeKeeperPaperConvertReplayCost(input));
 for(const changed of [{marketGasPriceWei:126n},{gasUnits:131n},{nativeWei:10999n},
  {swapCost:5261n},{costs:{...costs,boundWei:'10999'}}])
  assert.throws(()=>assertRangeKeeperPaperConvertReplayCost({...input,...changed}),
   /rangekeeper_paper_convert_replay_cost_exceeds_accepted_bound/);
});
test('changed operation snapshots cannot trigger canonical reads or a fork',async()=>{
 await assert.rejects(replayRangeKeeperPaperConvertOnOwnedFork({
  snapshot:{campaignId:binding.campaignId,snapshotHash:'f'.repeat(64)},
  client:{} as never,rpcUrl:'http://127.0.0.1:1'}),/rangekeeper_exit_operation_snapshot_hash_mismatch/);
});
