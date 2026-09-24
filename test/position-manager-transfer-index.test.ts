import test from 'node:test';
import assert from 'node:assert/strict';
import {getAddress,type Address,type Hash} from 'viem';
import type {RobinhoodClient} from '../src/client.js';
import {POSITION_MANAGER_TRANSFER_SQL} from '../src/storage/position-manager-transfer-migration.js';
import {MIGRATIONS} from '../src/storage/migrations.js';
import {
 PositionManagerTransferIndexStore,PositionManagerTransferCursor,PositionManagerCheckpoint,
 PositionManagerTransfer,scanPositionManagerTransferHistory,replayPositionManagerOwnerSet,
} from '../src/nft/position-manager-transfer-index.js';
import {readCompletePositionManagerNftCustody} from '../src/deployments/live-transfer-nft-enumeration.js';

const manager=getAddress('0x1111111111111111111111111111111111111111');
const alice=getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const bob=getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hash;
const header=(number:bigint,epoch=0)=>{
 const fork=epoch&&number>=2n?100:0;
 const parentFork=epoch&&number-1n>=2n?100:0;
 return {number,hash:hash(Number(number)+1+fork),parentHash:hash(Number(number)+parentFork),
  timestamp:BigInt(1_700_000_000+Number(number))};
};

class MemoryIndex implements PositionManagerTransferIndexStore {
 cursor:PositionManagerTransferCursor|null=null;
 checkpoints:PositionManagerCheckpoint[]=[];
 transfers:PositionManagerTransfer[]=[];
 rewinds:Array<{from:bigint;boundary:PositionManagerCheckpoint|null}>=[];
 async getCursor(){return this.cursor;}
 async initializeCursor(chainId:number,address:Address,startBlock:bigint){
  return this.cursor??=( {chainId,manager:address,startBlock,nextBlock:startBlock,coveredThroughBlock:null,
   coveredThroughHash:null,lastScannedBlock:null,lastScannedHash:null} );
 }
 async recentCheckpoints(){return [...this.checkpoints].sort((a,b)=>a.number>b.number?-1:1).slice(0,256);}
 async rewind(_chain:number,_manager:Address,_start:bigint,from:bigint,boundary:PositionManagerCheckpoint|null){
  this.rewinds.push({from,boundary});this.transfers=this.transfers.filter(row=>row.blockNumber<from);
  this.checkpoints=this.checkpoints.filter(row=>row.number<from);
  this.cursor={...this.cursor!,nextBlock:from,coveredThroughBlock:boundary?.number??null,
   coveredThroughHash:boundary?.hash??null,lastScannedBlock:boundary?.number??null,lastScannedHash:boundary?.hash??null};
 }
 async saveChunk(chunk:{chainId:number;manager:Address;startBlock:bigint;fromBlock:bigint;toBlock:bigint;
  fromCheckpoint:PositionManagerCheckpoint|null;checkpoint:PositionManagerCheckpoint;
  eventBlocks:readonly PositionManagerCheckpoint[];transfers:readonly PositionManagerTransfer[]}){
  assert.equal(this.cursor!.nextBlock,chunk.fromBlock);
  this.transfers.push(...chunk.transfers);
  this.checkpoints.push(...chunk.eventBlocks,chunk.checkpoint);
  this.cursor={...this.cursor!,nextBlock:chunk.toBlock+1n,coveredThroughBlock:chunk.toBlock,
   coveredThroughHash:chunk.checkpoint.hash,lastScannedBlock:chunk.toBlock,lastScannedHash:chunk.checkpoint.hash};
 }
 async savePinnedCheckpoint(_chain:number,_manager:Address,_start:bigint,checkpoint:PositionManagerCheckpoint){
  const at=this.checkpoints.findIndex(row=>row.number===checkpoint.number);
  if(at<0)this.checkpoints.push(checkpoint);else this.checkpoints[at]=checkpoint;
 }
 async loadTransfers(_chain:number,_manager:Address,_start:bigint,to:bigint,limit:number){
  return this.transfers.filter(row=>row.blockNumber<=to).slice(0,limit+1);
 }
 async loadReplayEvidence(_chain:number,_manager:Address,_start:bigint,source:bigint,limit:number){
  if(!this.cursor)return null;
  const transfers=this.transfers.filter(row=>row.blockNumber<=source).slice(0,limit+1);
  const blocks=new Set(transfers.map(row=>row.blockNumber.toString()));blocks.add(source.toString());
  if(this.cursor.coveredThroughBlock!==null)blocks.add(this.cursor.coveredThroughBlock.toString());
  return {cursor:this.cursor,transfers,checkpoints:this.checkpoints.filter(row=>blocks.has(row.number.toString()))};
 }
}

function mockClient(epoch=0,logs:boolean=true,balance=1n,owner:Address=alice){
 const getBlock=async(args?:{blockNumber?:bigint})=>{
  if(args?.blockNumber!==undefined)return header(args.blockNumber,epoch);
  return header(100n,epoch);
 };
 const transfer=logs?{address:manager,eventName:'Transfer',blockNumber:1n,blockHash:header(1n,epoch).hash,
  transactionHash:hash(500),transactionIndex:0,logIndex:0,args:{from:'0x0000000000000000000000000000000000000000',
   to:alice,tokenId:7n}}:null;
 return {getChainId:async()=>4663,getBlock,getBytecode:async()=> '0x6000',
  readContract:async({functionName}:{functionName:string})=>functionName==='balanceOf'?balance:owner,
  getLogs:async(args:{fromBlock:bigint;toBlock:bigint})=>transfer&&transfer.blockNumber>=args.fromBlock&&
   transfer.blockNumber<=args.toBlock?[transfer]:[]} as unknown as RobinhoodClient;
}

test('migration 11 is additive and uses dedicated manager-history tables',()=>{
 assert.equal(MIGRATIONS.length,11);
 assert.match(POSITION_MANAGER_TRANSFER_SQL,/CREATE TABLE position_manager_transfer_cursors/);
 assert.match(POSITION_MANAGER_TRANSFER_SQL,/CREATE TABLE position_manager_transfer_checkpoints/);
 assert.match(POSITION_MANAGER_TRANSFER_SQL,/CREATE TABLE position_manager_transfers/);
 assert.doesNotMatch(POSITION_MANAGER_TRANSFER_SQL,/indexer_pools|v3_pool_events/);
});

test('scanner advances only contiguous bounded chunks and never claims complete enumeration',async()=>{
 const store=new MemoryIndex();
 const source={block:3n,hash:header(3n).hash,timestamp:Number(header(3n).timestamp)};
 const first=await scanPositionManagerTransferHistory({client:mockClient(),store,chainId:4663,manager,
  startBlock:0n,source,chunkBlocks:2n,maxBlocksPerRun:2n});
 assert.equal(first.status,'scanned',`status=${first.status}${'reason'in first?`,reason=${first.reason}`:''}`);
 assert.equal(first.coveredThroughBlock,'1');
 assert.equal(first.completeThroughSource,false);
 assert.equal(first.enumerationComplete,false);
 assert.equal(store.cursor?.nextBlock,2n);
 const second=await scanPositionManagerTransferHistory({client:mockClient(),store,chainId:4663,manager,
  startBlock:0n,source,chunkBlocks:2n,maxBlocksPerRun:2n});
 assert.equal(second.status,'scanned',`status=${second.status}${'reason'in second?`,reason=${second.reason}`:''}`);
 assert.equal(second.coveredThroughBlock,'3');
 assert.equal(second.completeThroughSource,true);
 assert.equal(second.enumerationComplete,false);
 assert.deepEqual(store.transfers.map(row=>row.tokenId),[7n]);
});

test('scanner rewinds to the newest canonical checkpoint after a reorg',async()=>{
 const store=new MemoryIndex(),oldSource={block:3n,hash:header(3n).hash,timestamp:Number(header(3n).timestamp)};
 await scanPositionManagerTransferHistory({client:mockClient(),store,chainId:4663,manager,startBlock:0n,
  source:oldSource,chunkBlocks:2n,maxBlocksPerRun:10n});
 const newSource={block:3n,hash:header(3n,1).hash,timestamp:Number(header(3n,1).timestamp)};
 const result=await scanPositionManagerTransferHistory({client:mockClient(1),store,chainId:4663,manager,
  startBlock:0n,source:newSource,chunkBlocks:2n,maxBlocksPerRun:10n});
 assert.equal(result.status,'scanned',`status=${result.status}${'reason'in result?`,reason=${result.reason}`:''}`);
 assert.deepEqual(store.rewinds.map(item=>item.from),[2n]);
 assert.equal(result.enumerationComplete,false);
});

test('owner replay requires genesis coverage and validates each previous owner',()=>{
 const transfer=(from:Address,to:Address,block:number,logIndex:number):PositionManagerTransfer=>({
  blockNumber:BigInt(block),blockHash:hash(block+1),transactionHash:hash(600+block),transactionIndex:0,
  logIndex,from,to,tokenId:7n,
 });
 const common={chainId:4663,expectedChainId:4663,manager,expectedManager:manager,startBlock:0n,
  sourceBlock:10n,coveredThroughBlock:10n,coveredThroughHash:hash(11),sourceHash:hash(11),
  sourceCheckpointHash:hash(11),operator:bob};
 const result=replayPositionManagerOwnerSet({...common,transfers:[transfer(getAddress('0x0000000000000000000000000000000000000000'),alice,2,0),
  transfer(alice,bob,4,1)]});
 assert.equal(result.status,'replayed');
 assert.deepEqual(result.operatorTokenIds,['7']);
 assert.equal(result.enumerationComplete,false);
 assert.deepEqual(result.missing,['persisted_checkpoint_binding_not_verified','balance_of_and_owner_of_reconciliation_not_run']);
 const unknown=replayPositionManagerOwnerSet({...common,transfers:[transfer(alice,bob,4,1)]});
 assert.equal(unknown.status,'unavailable');
 if(unknown.status==='unavailable')assert.equal(unknown.reason,'transfer_replay_unknown_prior_owner');
 const partial=replayPositionManagerOwnerSet({...common,startBlock:1n,transfers:[]});
 assert.equal(partial.status,'unavailable');
 const wrongSource=replayPositionManagerOwnerSet({...common,sourceCheckpointHash:hash(12),transfers:[]});
 assert.equal(wrongSource.status,'unavailable');
});

test('pinned-source resolver reconciles canonical indexed ownership with balanceOf and ownerOf',async()=>{
 const store=new MemoryIndex(),source={block:3n,hash:header(3n).hash,timestamp:Number(header(3n).timestamp)};
 await scanPositionManagerTransferHistory({client:mockClient(),store,chainId:4663,manager,startBlock:0n,
  source,chunkBlocks:2n,maxBlocksPerRun:10n});
 const result=await readCompletePositionManagerNftCustody({client:mockClient(),store,
  targetStrategyId:'static_manual_v1',operator:alice,positionManager:manager,startBlock:0n,source});
 assert.equal(result.status,'available');assert.equal(result.enumerationComplete,true);
 assert.deepEqual(result.tokenIds,['7']);assert.deepEqual(result.knownOwners.map(row=>row.owner),[
  {status:'available',value:alice},
 ]);assert.equal(result.actionAvailable,false);
 const wrongSource=await readCompletePositionManagerNftCustody({client:mockClient(),store,
  targetStrategyId:'static_manual_v1',operator:alice,positionManager:manager,startBlock:0n,
  source:{...source,hash:hash(99)}});
 assert.equal(wrongSource.status,'unavailable');assert.equal(wrongSource.enumerationComplete,false);
});

test('reconciliation rejects missing event checkpoints and balance or owner mismatches',async()=>{
 const source={block:3n,hash:header(3n).hash,timestamp:Number(header(3n).timestamp)};
 const scanStore=async()=>{
  const store=new MemoryIndex();
  await scanPositionManagerTransferHistory({client:mockClient(),store,chainId:4663,manager,startBlock:0n,
   source,chunkBlocks:2n,maxBlocksPerRun:10n});
  return store;
 };
 const checkpointStore=await scanStore();
 checkpointStore.checkpoints=checkpointStore.checkpoints.filter(row=>row.number!==1n);
 const noEventCheckpoint=await readCompletePositionManagerNftCustody({client:mockClient(),store:checkpointStore,
  targetStrategyId:'static_manual_v1',operator:alice,positionManager:manager,startBlock:0n,source});
 assert.equal(noEventCheckpoint.status,'unavailable');
 assert.equal(noEventCheckpoint.missing[0],'transfer_event_not_bound_to_persisted_checkpoint');
 const noBalanceMatch=await readCompletePositionManagerNftCustody({client:mockClient(0,true,0n),store:await scanStore(),
  targetStrategyId:'static_manual_v1',operator:alice,positionManager:manager,startBlock:0n,source});
 assert.equal(noBalanceMatch.status,'unavailable');assert.equal(noBalanceMatch.enumerationComplete,false);
 const noOwnerMatch=await readCompletePositionManagerNftCustody({client:mockClient(0,true,1n,bob),store:await scanStore(),
  targetStrategyId:'static_manual_v1',operator:alice,positionManager:manager,startBlock:0n,source});
 assert.equal(noOwnerMatch.status,'unavailable');assert.equal(noOwnerMatch.enumerationComplete,false);
});
