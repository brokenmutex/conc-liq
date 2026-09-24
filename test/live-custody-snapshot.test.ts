import assert from 'node:assert/strict';
import test from 'node:test';
import {readLiveCustodySnapshot} from '../src/deployments/live-custody-snapshot.js';

const operator='0x1111111111111111111111111111111111111111';
const token0='0x2222222222222222222222222222222222222222';
const token1='0x3333333333333333333333333333333333333333';
const manager='0x4444444444444444444444444444444444444444';
const router='0x5555555555555555555555555555555555555555';
const hash=`0x${'a'.repeat(64)}` as const;
const source={block:100n,hash,timestamp:1_790_000_000};
const goodClient=(overrides:Record<string,unknown>={})=>{
 const calls:{method:string;args:unknown[]}[]=[];
 const client={
  getChainId:async()=>4663,
  getBlock:async(...args:unknown[])=>{
   calls.push({method:'getBlock',args});
   if(args.length===0)return {number:200n,hash,timestamp:BigInt(source.timestamp)};
   return {number:100n,hash,timestamp:BigInt(source.timestamp)};
  },
  getTransactionCount:async(args:unknown)=>{calls.push({method:'nonce',args:[args]});return 7;},
  getBalance:async(args:unknown)=>{calls.push({method:'balance',args:[args]});return 123n;},
  readContract:async(args:Record<string,unknown>)=>{
   calls.push({method:String(args.functionName),args:[args]});
   if(args.functionName==='balanceOf')return args.address===manager?2n:10n;
   if(args.functionName==='allowance')return 0n;
   if(args.functionName==='ownerOf')return operator;
   throw new Error('unexpected contract read');
  },
  ...overrides,
 };
 return {client:client as never,calls};
};
const request=(client:unknown,overrides:Record<string,unknown>={})=>readLiveCustodySnapshot({
 client:client as never,targetStrategyId:'static_manual_v1',operator,source,
 tokens:[{address:token0,symbol:'A'},{address:token1,symbol:'B'}],
 allowanceTargets:[{address:router,label:'router'},{address:manager,label:'position_manager'}],
 positionManager:manager,knownNftIds:['17'],...overrides,
});

test('reads bounded custody fields at one pinned confirmed source and rechecks its hash',async()=>{
 const {client,calls}=goodClient();
 const result=await request(client);
 assert.equal(result.status,'snapshot_partial');assert.equal(result.targetStrategyId,'static_manual_v1');
 assert.equal(result.actionAvailable,false);assert.equal(result.executionEligible,false);
 assert.equal(result.chainId.status,'available');if(result.chainId.status==='available')assert.equal(result.chainId.value,4663);
 assert.equal(result.nonce.status,'available');if(result.nonce.status==='available')assert.equal(result.nonce.value,'7');
 assert.equal(result.nativeBalanceWei.status,'available');
 assert.deepEqual(result.tokenBalances.map(x=>x.raw),[
  {status:'available',value:'10'},{status:'available',value:'10'},
 ]);
 assert.equal(result.allowances.length,4);assert(result.allowances.every(x=>x.raw.status==='available'));
 assert.equal(result.nftCount.status,'available');
 assert.equal(result.knownNftOwnership[0]?.owner.status,'available');
 assert.equal(result.nftEnumeration.status,'unavailable');
 assert(result.nftEnumeration.missing.includes('balance_of_count_and_sampled_owner_reads_do_not_prove_complete_token_id_set'));
 assert(result.unavailableReasons.includes('position_manager_transfer_history_not_indexed'));
 const pinned=calls.filter(c=>c.method==='getBlock'&&c.args.length>0);
 assert.equal(pinned.length,2);assert(pinned.every(c=>(c.args[0] as {blockNumber:bigint}).blockNumber===source.block));
 for(const call of calls.filter(c=>['balanceOf','allowance','ownerOf','nonce','balance'].includes(c.method))){
  const arg=call.args[0] as Record<string,unknown>;
  assert.equal(arg.blockNumber,source.block,'every state read is pinned');
 }
});

test('does not read custody if source identity is wrong or confirmation depth is insufficient',async()=>{
 const wrong=goodClient({getBlock:async(...args:unknown[])=>args.length===0?
  {number:200n,hash,timestamp:BigInt(source.timestamp)}:{number:100n,hash:`0x${'b'.repeat(64)}`,timestamp:BigInt(source.timestamp)}});
 const wrongResult=await request(wrong.client);
 assert.equal(wrongResult.status,'unavailable');assert(wrongResult.unavailableReasons.includes('pinned_source_identity_mismatch'));
 assert.equal(wrong.calls.some(c=>['balanceOf','allowance','ownerOf','nonce','balance'].includes(c.method)),false);
 const shallow=goodClient({getBlock:async(...args:unknown[])=>args.length===0?
  {number:150n,hash,timestamp:BigInt(source.timestamp)}:{number:100n,hash,timestamp:BigInt(source.timestamp)}});
 const shallowResult=await request(shallow.client);
 assert.equal(shallowResult.status,'unavailable');
 assert(shallowResult.unavailableReasons.includes('pinned_source_not_confirmed_to_required_depth'));
});

test('keeps individual failed reads unavailable and rejects a source reorg during reads',async()=>{
 const partial=goodClient({readContract:async(args:Record<string,unknown>)=>{
  if(args.functionName==='allowance')throw new Error('read failed');
  if(args.functionName==='balanceOf')return args.address===manager?1n:10n;
  if(args.functionName==='ownerOf')return operator;
  return 0n;
 }});
 const partialResult=await request(partial.client);
 assert.equal(partialResult.status,'snapshot_partial');
 assert(partialResult.unavailableReasons.includes(`allowance_unavailable:A:router`));
 assert(partialResult.allowances.every(x=>x.raw.status==='unavailable'));
 let pinnedReads=0;
 const reorg=goodClient({getBlock:async(...args:unknown[])=>{
  if(args.length===0)return {number:200n,hash,timestamp:BigInt(source.timestamp)};
  pinnedReads++;return {number:100n,hash:pinnedReads===1?hash:`0x${'c'.repeat(64)}`,timestamp:BigInt(source.timestamp)};
 }});
 const reorgResult=await request(reorg.client);
 assert.equal(reorgResult.status,'unavailable');
 assert(reorgResult.unavailableReasons.includes('pinned_source_changed_during_snapshot'));
 assert.equal(reorgResult.actionAvailable,false);
});

test('supports the two product strategies and bounds caller-selected scope',async()=>{
 const {client}=goodClient();
 const rk=await request(client,{targetStrategyId:'rangekeeper_v1'});
 assert.equal(rk.targetStrategyId,'rangekeeper_v1');
 const tooMany=await request(client,{knownNftIds:Array.from({length:101},(_,i)=>String(i+1))});
 assert.equal(tooMany.status,'unavailable');assert(tooMany.unavailableReasons.includes('known_nft_id_scope_invalid_or_out_of_bounds'));
 const legacy=await request(client,{targetStrategyId:'live_pilot_v1'});
 assert.equal(legacy.targetStrategyId,null);assert(legacy.unavailableReasons.includes('target_strategy_unsupported'));
 const duplicateToken=await request(client,{tokens:[{address:token0,symbol:'A'},{address:token0,symbol:'A2'}]});
 assert.equal(duplicateToken.status,'unavailable');
 assert(duplicateToken.unavailableReasons.includes('token_scope_contains_duplicates'));
});
