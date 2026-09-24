import {getAddress,isAddress,parseAbi,type Address,type Hash} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {replayPositionManagerOwnerSet,type PositionManagerTransferIndexStore} from '../nft/position-manager-transfer-index.js';
import {nonfungiblePositionManagerReadAbi} from '../nft/abi.js';
import type {LiveCustodyStrategy,PinnedCustodySource} from './live-custody-snapshot.js';

const balanceAbi=parseAbi(['function balanceOf(address owner) view returns(uint256)']);
const HASH=/^0x[0-9a-f]{64}$/i,CONFIRMATIONS=64,MAX_OWNER_READS=12,MAX_OPERATOR_NFTS=1_000;
type Client=Pick<RobinhoodClient,'getChainId'|'getBlock'|'getBytecode'|'readContract'>;
type Result={kind:'complete_position_manager_nft_custody';status:'available'|'unavailable';
 targetStrategyId:LiveCustodyStrategy|null;operator:string|null;positionManager:string|null;
 source:{block:string;hash:string;timestamp:number;confirmed:boolean}|null;
 enumerationComplete:boolean;tokenIds:string[]|null;balanceOfCount:{status:'available';value:string}|{status:'unavailable';reason:string};
 knownOwners:{tokenId:string;owner:{status:'available';value:string}|{status:'unavailable';reason:string}}[];
 indexedTransferCoverage:{status:'available';startBlock:string;coveredThroughBlock:string;coveredThroughHash:string;
  sourceCheckpointHash:string;transferCount:number;checkpointBlockCount:number}|{status:'unavailable';reason:string};
 missing:string[];actionAvailable:false;executionEligible:false};

function failure(input:{strategy:LiveCustodyStrategy|null;operator:string|null;manager:string|null;
 source:PinnedCustodySource|null;reason:string}):Result{
 return {kind:'complete_position_manager_nft_custody',status:'unavailable',targetStrategyId:input.strategy,
  operator:input.operator,positionManager:input.manager,source:input.source?{block:String(input.source.block),
   hash:input.source.hash,timestamp:input.source.timestamp,confirmed:false}:null,enumerationComplete:false,tokenIds:null,
  balanceOfCount:{status:'unavailable',reason:input.reason},knownOwners:[],
  indexedTransferCoverage:{status:'unavailable',reason:input.reason},missing:[input.reason],
  actionAvailable:false,executionEligible:false};
}
async function mapLimit<T,U>(items:readonly T[],limit:number,work:(item:T)=>Promise<U>):Promise<U[]>{
 const result=new Array<U>(items.length);let next=0;
 const worker=async()=>{while(true){const index=next++;if(index>=items.length)return;result[index]=await work(items[index]!);}};
 await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return result;
}

/** Reconstruct operator ownership from genesis-scoped indexed Transfer logs,
 * verify each event/source checkpoint against the canonical RPC at the same
 * confirmed source, then reconcile the resulting set to balanceOf/ownerOf.
 * Reads only; no cursor repair, signer, route or transaction path is exposed. */
export async function readCompletePositionManagerNftCustody(input:{client:Client;
 store:PositionManagerTransferIndexStore;targetStrategyId:unknown;operator:unknown;positionManager:unknown;
 source:PinnedCustodySource;startBlock:bigint}) :Promise<Result>{
 const strategy:LiveCustodyStrategy|null=input.targetStrategyId==='static_manual_v1'||input.targetStrategyId==='rangekeeper_v1'?
  input.targetStrategyId as LiveCustodyStrategy:null;
 const operator:Address|null=typeof input.operator==='string'&&isAddress(input.operator)?getAddress(input.operator):null;
 const manager:Address|null=typeof input.positionManager==='string'&&isAddress(input.positionManager)?
  getAddress(input.positionManager):null;
 const scope={strategy,operator,manager,source:input.source};
 if(!strategy)return failure({...scope,reason:'target_strategy_unsupported'});
 if(!operator)return failure({...scope,reason:'operator_address_invalid'});
 if(!manager)return failure({...scope,reason:'position_manager_address_invalid'});
 if(input.startBlock!==0n)return failure({...scope,reason:'transfer_index_must_start_at_genesis'});
 if(!input.source||input.source.block<0n||!Number.isSafeInteger(input.source.timestamp)||
  !HASH.test(input.source.hash))return failure({...scope,reason:'pinned_canonical_source_invalid'});
 try{
  const chainId=await input.client.getChainId();
  if(chainId!==ROBINHOOD_CHAIN_ID)return failure({...scope,reason:'transfer_replay_chain_id_mismatch'});
  const [latest,pinned,code]=await Promise.all([
   input.client.getBlock(),input.client.getBlock({blockNumber:input.source.block}),
   input.client.getBytecode({address:manager,blockNumber:input.source.block}),
  ]);
  if(latest.number<input.source.block+BigInt(CONFIRMATIONS))
   return failure({...scope,reason:'pinned_source_not_confirmed_to_required_depth'});
  if(!pinned.hash||pinned.hash.toLowerCase()!==input.source.hash.toLowerCase()||
   Number(pinned.timestamp)!==input.source.timestamp)
   return failure({...scope,reason:'pinned_source_identity_mismatch'});
  if(!code||code==='0x')return failure({...scope,reason:'position_manager_code_unavailable_at_source'});
  const evidence=await input.store.loadReplayEvidence(ROBINHOOD_CHAIN_ID,manager,0n,input.source.block,1_000_000);
  if(!evidence)return failure({...scope,reason:'transfer_index_cursor_unavailable'});
  const {cursor,transfers,checkpoints}=evidence;
  if(cursor.chainId!==ROBINHOOD_CHAIN_ID||cursor.startBlock!==0n||cursor.manager.toLowerCase()!==manager.toLowerCase())
   return failure({...scope,reason:'transfer_index_scope_mismatch'});
  if(cursor.coveredThroughBlock===null||cursor.coveredThroughBlock<input.source.block||!cursor.coveredThroughHash)
   return failure({...scope,reason:'transfer_index_genesis_to_source_coverage_incomplete'});
  if(cursor.nextBlock!==cursor.coveredThroughBlock+1n||cursor.lastScannedBlock!==cursor.coveredThroughBlock||
   !cursor.lastScannedHash||cursor.lastScannedHash.toLowerCase()!==cursor.coveredThroughHash.toLowerCase())
   return failure({...scope,reason:'transfer_index_cursor_coverage_binding_invalid'});
  const checkpointMap=new Map(checkpoints.map(checkpoint=>[checkpoint.number.toString(),checkpoint]));
  const sourceCheckpoint=checkpointMap.get(input.source.block.toString());
  if(!sourceCheckpoint||sourceCheckpoint.hash.toLowerCase()!==input.source.hash.toLowerCase()||
   sourceCheckpoint.timestamp!==input.source.timestamp)
   return failure({...scope,reason:'persisted_source_checkpoint_missing_or_mismatched'});
  const coveredCheckpoint=checkpointMap.get(cursor.coveredThroughBlock.toString());
  if(!coveredCheckpoint||coveredCheckpoint.hash.toLowerCase()!==cursor.coveredThroughHash.toLowerCase())
   return failure({...scope,reason:'persisted_coverage_checkpoint_missing_or_mismatched'});
  for(const event of transfers){
   const checkpoint=checkpointMap.get(event.blockNumber.toString());
   if(!checkpoint||checkpoint.hash.toLowerCase()!==event.blockHash.toLowerCase())
    return failure({...scope,reason:'transfer_event_not_bound_to_persisted_checkpoint'});
  }
  if(checkpointMap.size>10_002)return failure({...scope,reason:'transfer_checkpoint_replay_bound_exceeded'});
  const ordered=[...checkpointMap.values()].sort((a,b)=>a.number<b.number?-1:a.number>b.number?1:0);
  const canonical=await mapLimit(ordered,MAX_OWNER_READS,async checkpoint=>{
   const block=await input.client.getBlock({blockNumber:checkpoint.number});
   return Boolean(block.hash&&block.hash.toLowerCase()===checkpoint.hash.toLowerCase()&&
    Number(block.timestamp)===checkpoint.timestamp);
  });
  if(canonical.some(value=>!value))return failure({...scope,reason:'persisted_checkpoint_no_longer_canonical'});
  const replay=replayPositionManagerOwnerSet({chainId:ROBINHOOD_CHAIN_ID,expectedChainId:ROBINHOOD_CHAIN_ID,
   manager,expectedManager:manager,startBlock:0n,sourceBlock:input.source.block,
   coveredThroughBlock:cursor.coveredThroughBlock,coveredThroughHash:cursor.coveredThroughHash,
   sourceHash:input.source.hash,sourceCheckpointHash:sourceCheckpoint.hash,transfers,operator});
  if(replay.status!=='replayed')return failure({...scope,reason:replay.reason});
  const tokenIds=[...replay.operatorTokenIds];
  if(tokenIds.length>MAX_OPERATOR_NFTS)
   return failure({...scope,reason:'operator_nft_owner_read_bound_exceeded'});
  const [balanceOf,owners]=await Promise.all([
   input.client.readContract({address:manager,abi:balanceAbi,functionName:'balanceOf',args:[operator],blockNumber:input.source.block}),
   mapLimit(tokenIds,MAX_OWNER_READS,async tokenId=>({tokenId,owner:getAddress(await input.client.readContract({
    address:manager,abi:nonfungiblePositionManagerReadAbi,functionName:'ownerOf',args:[BigInt(tokenId)],
    blockNumber:input.source.block}))})),
  ]);
  if(BigInt(balanceOf)!==BigInt(tokenIds.length))return failure({...scope,reason:'transfer_replay_balance_of_mismatch'});
  if(owners.some(value=>value.owner.toLowerCase()!==operator.toLowerCase()))
   return failure({...scope,reason:'transfer_replay_owner_of_mismatch'});
  const after=await input.client.getBlock({blockNumber:input.source.block});
  if(!after.hash||after.hash.toLowerCase()!==input.source.hash.toLowerCase()||
   Number(after.timestamp)!==input.source.timestamp)
   return failure({...scope,reason:'pinned_source_changed_during_reconciliation'});
  return {kind:'complete_position_manager_nft_custody',status:'available',targetStrategyId:strategy,
   operator,positionManager:manager,source:{block:String(input.source.block),hash:input.source.hash,
    timestamp:input.source.timestamp,confirmed:true},enumerationComplete:true,tokenIds,
   balanceOfCount:{status:'available',value:String(balanceOf)},
   knownOwners:owners.map(value=>({tokenId:value.tokenId,owner:{status:'available' as const,value:value.owner}})),
   indexedTransferCoverage:{status:'available',startBlock:'0',coveredThroughBlock:String(cursor.coveredThroughBlock),
    coveredThroughHash:cursor.coveredThroughHash,sourceCheckpointHash:sourceCheckpoint.hash,
    transferCount:transfers.length,checkpointBlockCount:ordered.length},
   missing:[],actionAvailable:false,executionEligible:false};
 }catch(error){
  const reason=error instanceof Error&&/^position_manager_transfer_[a-z0-9_]+$/.test(error.message)?error.message:
   'position_manager_owner_reconciliation_rpc_or_store_unavailable';
  return failure({...scope,reason});
 }
}
