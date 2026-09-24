import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveCompleteNftCustodyFromRepository} from '../src/deployments/complete-nft-custody-resolver.js';

const operator='0x1111111111111111111111111111111111111111';
const manager='0x2222222222222222222222222222222222222222';
const source={block:'100',hash:`0x${'a'.repeat(64)}`,timestamp:1_790_000_000,confirmed:true};
const knownOwners=[{tokenId:'7',owner:{status:'available',value:operator}}];

test('matching balance count and sampled owners never imply complete NFT enumeration',()=>{
 for(const count of ['0','1','2']){
  const result=resolveCompleteNftCustodyFromRepository({targetStrategyId:'static_manual_v1',operator,
   positionManager:manager,source,balanceOf:{status:'available',value:count},knownOwners});
  assert.equal(result.status,'unavailable');assert.equal(result.enumerationComplete,false);
  assert.equal(result.tokenIds,null);assert.deepEqual(result.knownOwners,knownOwners);
  assert(result.missing.includes('position_manager_transfer_history_not_indexed'));
  assert(result.missing.includes('balance_of_count_and_sampled_owner_reads_do_not_prove_complete_token_id_set'));
  assert.equal(result.actionAvailable,false);assert.equal(result.executionEligible,false);
 }
});

test('resolver identifies repository coverage gaps for either supported product strategy',()=>{
 for(const strategy of ['static_manual_v1','rangekeeper_v1'] as const){
  const result=resolveCompleteNftCustodyFromRepository({targetStrategyId:strategy,operator,
   positionManager:manager,source,balanceOf:{status:'available',value:'0'}});
  assert.equal(result.targetStrategyId,strategy);assert.equal(result.source?.block,'100');
  assert.equal(result.indexedTransferCoverage.status,'unavailable');
  assert(result.missing.includes('pool_event_index_excludes_position_manager_transfer_logs'));
  assert(result.missing.includes('nft_snapshot_schema_has_no_complete_wallet_ownership_coverage'));
 }
});

test('invalid source, operator, manager and legacy strategy remain explicitly unavailable',()=>{
 const result=resolveCompleteNftCustodyFromRepository({targetStrategyId:'live_pilot_v1',operator:'bad',
  positionManager:null,source:{...source,confirmed:false},balanceOf:{status:'available',value:'5'}});
 assert.equal(result.targetStrategyId,null);assert.equal(result.source,null);
 for(const reason of ['target_strategy_unsupported','operator_address_invalid','position_manager_address_invalid',
  'pinned_canonical_source_unavailable'])assert(result.missing.includes(reason));
 assert.equal(result.status,'unavailable');assert.equal(result.actionAvailable,false);
});
