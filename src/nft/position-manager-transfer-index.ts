import pg, {type PoolClient} from 'pg';
import {getAddress,isAddress,parseAbi,type Address,type Hash} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {assertDeploymentSchemaReady} from '../storage/compatibility.js';

const {Pool}=pg;
const transferAbi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
const ZERO='0x0000000000000000000000000000000000000000';
const HASH=/^0x[0-9a-f]{64}$/i;
const MAX_CHUNK_BLOCKS=10_000n,MAX_BLOCKS_PER_RUN=100_000n,
 MAX_WALLET_CHUNK_BLOCKS=10_000_000n,MAX_WALLET_BLOCKS_PER_RUN=100_000_000n,MAX_LOGS_PER_CHUNK=25_000,
 MAX_REPLAY_EVENTS=1_000_000,MAX_REPLAY_CHECKPOINT_BLOCKS=10_000,HEADER_CONCURRENCY=12;

export interface PositionManagerCheckpoint {
 number:bigint;hash:Hash;parentHash:Hash;timestamp:number;
}
export interface PositionManagerTransfer {
 blockNumber:bigint;blockHash:Hash;transactionHash:Hash;transactionIndex:number;logIndex:number;
 from:Address;to:Address;tokenId:bigint;
}
export interface PositionManagerTransferCursor {
 chainId:number;manager:Address;startBlock:bigint;nextBlock:bigint;
 coveredThroughBlock:bigint|null;coveredThroughHash:Hash|null;
 lastScannedBlock:bigint|null;lastScannedHash:Hash|null;
}
export interface PositionManagerTransferChunk {
 chainId:number;manager:Address;startBlock:bigint;fromBlock:bigint;toBlock:bigint;
 fromCheckpoint:PositionManagerCheckpoint|null;checkpoint:PositionManagerCheckpoint;
 eventBlocks:readonly PositionManagerCheckpoint[];transfers:readonly PositionManagerTransfer[];
}
export interface PositionManagerTransferIndexStore {
 /** When present, replay evidence and scans are complete only for this wallet's
  * indexed `from`/`to` Transfer union. Generic/global stores omit this field. */
 walletScope?:Address;
 getCursor(chainId:number,manager:Address,startBlock:bigint):Promise<PositionManagerTransferCursor|null>;
 initializeCursor(chainId:number,manager:Address,startBlock:bigint):Promise<PositionManagerTransferCursor>;
 recentCheckpoints(chainId:number,manager:Address,startBlock:bigint,limit:number):Promise<PositionManagerCheckpoint[]>;
 rewind(chainId:number,manager:Address,startBlock:bigint,fromBlock:bigint,boundary:PositionManagerCheckpoint|null):Promise<void>;
 saveChunk(chunk:PositionManagerTransferChunk):Promise<void>;
 savePinnedCheckpoint(chainId:number,manager:Address,startBlock:bigint,checkpoint:PositionManagerCheckpoint):Promise<void>;
 loadTransfers(chainId:number,manager:Address,startBlock:bigint,toBlock:bigint,limit:number):Promise<PositionManagerTransfer[]>;
 loadReplayEvidence(chainId:number,manager:Address,startBlock:bigint,sourceBlock:bigint,limit:number):Promise<{
  cursor:PositionManagerTransferCursor;checkpoints:PositionManagerCheckpoint[];transfers:PositionManagerTransfer[];
 }|null>;
}

function same(a:string,b:string){return a.toLowerCase()===b.toLowerCase();}
function requireHash(value:unknown,name:string):Hash{
 if(typeof value!=='string'||!HASH.test(value))throw Error(`position_manager_transfer_${name}_invalid`);
 return value as Hash;
}
function parseLog(log:unknown,manager:Address,fromBlock:bigint,toBlock:bigint):PositionManagerTransfer{
 const row=log&&typeof log==='object'?log as Record<string,unknown>:{};
 const args=row.args&&typeof row.args==='object'?row.args as Record<string,unknown>:{};
 if(row.removed===true||row.eventName!=='Transfer'||!row.address||!same(String(row.address),manager)||
  typeof row.blockNumber!=='bigint'||row.blockNumber<fromBlock||row.blockNumber>toBlock||
  typeof row.transactionIndex!=='number'||!Number.isSafeInteger(row.transactionIndex)||row.transactionIndex<0||
  typeof row.logIndex!=='number'||!Number.isSafeInteger(row.logIndex)||row.logIndex<0||
  typeof args.from!=='string'||typeof args.to!=='string'||!/^0x[0-9a-f]{40}$/i.test(args.from)||
  !/^0x[0-9a-f]{40}$/i.test(args.to)||typeof args.tokenId!=='bigint'||args.tokenId<=0n)
  throw Error('position_manager_transfer_log_invalid');
 return {blockNumber:row.blockNumber,blockHash:requireHash(row.blockHash,'block_hash'),
  transactionHash:requireHash(row.transactionHash,'transaction_hash'),transactionIndex:row.transactionIndex,
  logIndex:row.logIndex,from:getAddress(args.from),to:getAddress(args.to),tokenId:args.tokenId};
}
function asCheckpoint(block:{number:bigint;hash:Hash;parentHash:Hash;timestamp:bigint}):PositionManagerCheckpoint{
 return {number:block.number,hash:block.hash,parentHash:block.parentHash,timestamp:Number(block.timestamp)};
}
async function concurrentMap<T,U>(items:readonly T[],limit:number,fn:(item:T)=>Promise<U>):Promise<U[]>{
 const result=new Array<U>(items.length);let next=0;
 const worker=async()=>{while(true){const index=next++;if(index>=items.length)return;result[index]=await fn(items[index]!);}};
 await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return result;
}

/** Scan a contiguous bounded range of Position Manager Transfer logs. The
 * cursor is scoped by exact chain, manager and start block. The index remains
 * diagnostic until a genesis/creation-to-source replay is reconciled. */
async function scanPositionManagerTransferHistoryWithBounds(input:{client:RobinhoodClient;
 store:PositionManagerTransferIndexStore;chainId:number;manager:Address;startBlock:bigint;
 source:{block:bigint;hash:Hash;timestamp:number};chunkBlocks?:bigint;maxBlocksPerRun?:bigint},bounds:{
 chunkBlocks:bigint;maxBlocksPerRun:bigint;maxChunkBlocks:bigint;maxRunBlocks:bigint}){
 const {client,store}=input,startBlock=input.startBlock,
  source=input.source,chunkBlocks=input.chunkBlocks??bounds.chunkBlocks,maxRun=input.maxBlocksPerRun??bounds.maxBlocksPerRun;
 if(input.chainId!==ROBINHOOD_CHAIN_ID||!isAddress(input.manager)||startBlock<0n||source.block<startBlock||
  !Number.isSafeInteger(source.timestamp)||source.timestamp<0||chunkBlocks<1n||
  chunkBlocks>bounds.maxChunkBlocks||maxRun<1n||maxRun>bounds.maxRunBlocks||!HASH.test(source.hash))
  return {status:'unavailable' as const,reason:'transfer_scan_scope_invalid',enumerationComplete:false as const,
   actionAvailable:false as const};
 try{
  const manager=getAddress(input.manager);
  if(await client.getChainId()!==input.chainId)
   return {status:'unavailable' as const,reason:'transfer_scan_chain_id_mismatch',enumerationComplete:false as const,
    actionAvailable:false as const};
  const [latest,sourceBefore]=await Promise.all([client.getBlock(),client.getBlock({blockNumber:source.block})]);
  if(latest.number<source.block+64n)return {status:'unavailable' as const,reason:'transfer_scan_source_not_confirmed',
   enumerationComplete:false as const,actionAvailable:false as const};
  if(!same(sourceBefore.hash,source.hash)||Number(sourceBefore.timestamp)!==source.timestamp)
   return {status:'unavailable' as const,reason:'transfer_scan_source_identity_mismatch',
    enumerationComplete:false as const,actionAvailable:false as const};
  const code=await client.getBytecode({address:manager,blockNumber:source.block});
  if(!code||code==='0x')return {status:'unavailable' as const,reason:'position_manager_code_unavailable_at_source',
   enumerationComplete:false as const,actionAvailable:false as const};
  let cursor=await store.getCursor(input.chainId,manager,startBlock)??
   await store.initializeCursor(input.chainId,manager,startBlock);
  if(cursor.chainId!==input.chainId||!same(cursor.manager,manager)||cursor.startBlock!==startBlock)
   return {status:'unavailable' as const,reason:'transfer_cursor_scope_mismatch',enumerationComplete:false as const,
    actionAvailable:false as const};
  if(cursor.coveredThroughBlock!==null){
   const anchor=await client.getBlock({blockNumber:cursor.coveredThroughBlock});
   if(!cursor.coveredThroughHash||!same(anchor.hash,cursor.coveredThroughHash)){
    const candidates=await store.recentCheckpoints(input.chainId,manager,startBlock,256);
    let boundary:PositionManagerCheckpoint|null=null;
    for(const candidate of candidates){
     const canonical=await client.getBlock({blockNumber:candidate.number});
     if(same(canonical.hash,candidate.hash)){boundary=candidate;break;}
    }
    const rewindFrom=boundary?boundary.number+1n:startBlock;
    await store.rewind(input.chainId,manager,startBlock,rewindFrom,boundary);
    cursor=await store.getCursor(input.chainId,manager,startBlock)??
     await store.initializeCursor(input.chainId,manager,startBlock);
   }
  }
  const maxEnd=cursor.nextBlock+maxRun-1n;
  const end=source.block<maxEnd?source.block:maxEnd;
  let chunks=0,transfers=0;
  while(cursor.nextBlock<=end){
   const fromBlock=cursor.nextBlock,toBlock=fromBlock+chunkBlocks-1n<end?fromBlock+chunkBlocks-1n:end;
   const prior=fromBlock>startBlock?await client.getBlock({blockNumber:fromBlock-1n}):null;
   if(fromBlock>startBlock&&(!prior||!cursor.coveredThroughHash||!same(prior.hash,cursor.coveredThroughHash)))
    return {status:'unavailable' as const,reason:'transfer_scan_coverage_boundary_changed',
     enumerationComplete:false as const,actionAvailable:false as const};
   const [startHeader,endHeader,rawLogs]=await Promise.all([
    client.getBlock({blockNumber:fromBlock}),client.getBlock({blockNumber:toBlock}),
    (async()=>{
     if(!store.walletScope)return client.getLogs({address:manager,events:transferAbi,fromBlock,toBlock});
     if(!isAddress(store.walletScope))throw Error('position_manager_transfer_wallet_scope_invalid');
     const scope=getAddress(store.walletScope);
     const getIndexedLogs=client.getLogs as unknown as (args:{address:Address;event:typeof transferAbi[0];
      args:{from?:Address;to?:Address};fromBlock:bigint;toBlock:bigint})=>Promise<any[]>;
     const [outgoing,incoming]=await Promise.all([
      getIndexedLogs({address:manager,event:transferAbi[0]!,args:{from:scope},fromBlock,toBlock}),
      getIndexedLogs({address:manager,event:transferAbi[0]!,args:{to:scope},fromBlock,toBlock}),
     ]);
     if(outgoing.length>MAX_LOGS_PER_CHUNK||incoming.length>MAX_LOGS_PER_CHUNK)
      throw Error('position_manager_transfer_chunk_log_bound_exceeded');
     const unique=new Map<string,unknown>();
     for(const row of [...outgoing,...incoming]){
      if(!row||typeof row.transactionHash!=='string'||!HASH.test(row.transactionHash)||
       typeof row.logIndex!=='number'||!Number.isSafeInteger(row.logIndex)||row.logIndex<0)
       throw Error('position_manager_transfer_log_invalid');
      const key=`${row.transactionHash.toLowerCase()}:${row.logIndex}`;
      const prior=unique.get(key) as any;
      if(prior){
       const fields=['address','blockNumber','blockHash','transactionHash','transactionIndex','logIndex','removed'];
       const sameFields=fields.every(field=>String(prior[field]??'').toLowerCase()===String(row[field]??'').toLowerCase())&&
        String(prior.args?.from??'').toLowerCase()===String(row.args?.from??'').toLowerCase()&&
        String(prior.args?.to??'').toLowerCase()===String(row.args?.to??'').toLowerCase()&&
        String(prior.args?.tokenId??'')===String(row.args?.tokenId??'');
       if(!sameFields)throw Error('position_manager_transfer_duplicate_log');
      }else unique.set(key,row);
     }
     return [...unique.values()];
    })(),
   ]);
   if(startHeader.number!==fromBlock||endHeader.number!==toBlock||
    (prior&&!same(startHeader.parentHash,prior.hash)))
    return {status:'unavailable' as const,reason:'transfer_scan_noncontiguous_canonical_headers',
     enumerationComplete:false as const,actionAvailable:false as const};
   if(rawLogs.length>MAX_LOGS_PER_CHUNK)
    return {status:'unavailable' as const,reason:'transfer_scan_chunk_log_bound_exceeded',
     enumerationComplete:false as const,actionAvailable:false as const};
   const parsed=rawLogs.map(log=>parseLog(log,manager,fromBlock,toBlock));
   if(store.walletScope&&parsed.some(log=>!same(log.from,store.walletScope!)&&!same(log.to,store.walletScope!)))
    return {status:'unavailable' as const,reason:'transfer_scan_wallet_filter_mismatch',enumerationComplete:false as const,
     actionAvailable:false as const};
   parsed.sort((a,b)=>a.blockNumber!==b.blockNumber?a.blockNumber<b.blockNumber?-1:1:
    a.transactionIndex-b.transactionIndex||a.logIndex-b.logIndex);
   const keys=new Set<string>();
   for(const log of parsed){const key=`${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    if(keys.has(key))throw Error('position_manager_transfer_duplicate_log');keys.add(key);}
   const eventBlockNumbers=[...new Set(parsed.map(log=>log.blockNumber.toString()))].map(BigInt);
   const eventBlocks=await concurrentMap(eventBlockNumbers,HEADER_CONCURRENCY,async number=>{
    const block=await client.getBlock({blockNumber:number});
    const matching=parsed.filter(log=>log.blockNumber===number);
    if(matching.some(log=>!same(block.hash,log.blockHash)))throw Error('position_manager_transfer_log_block_hash_mismatch');
    return asCheckpoint(block);
   });
   const checkpoint=asCheckpoint(endHeader);
   const fromCheckpoint=prior?asCheckpoint(prior):null;
   await store.saveChunk({chainId:input.chainId,manager,startBlock,fromBlock,toBlock,
    fromCheckpoint,checkpoint,eventBlocks,transfers:parsed});
   chunks++;transfers+=parsed.length;
   cursor=await store.getCursor(input.chainId,manager,startBlock)??cursor;
   const sourceStillCanonical=await client.getBlock({blockNumber:source.block});
   if(!same(sourceStillCanonical.hash,source.hash))
    return {status:'unavailable' as const,reason:'transfer_scan_source_reorged',enumerationComplete:false as const,
     actionAvailable:false as const};
  }
  if(cursor.coveredThroughBlock!==null&&cursor.coveredThroughBlock>=source.block){
   await store.savePinnedCheckpoint(input.chainId,manager,startBlock,asCheckpoint(sourceBefore));
  }
  return {status:'scanned' as const,chainId:input.chainId,manager,startBlock,
   coveredThroughBlock:cursor.coveredThroughBlock?.toString()??null,
   coveredThroughHash:cursor.coveredThroughHash,chunks,transfers,
   completeThroughSource:cursor.coveredThroughBlock!==null&&cursor.coveredThroughBlock>=source.block,
   historyStartIsGenesis:startBlock===0n,enumerationComplete:false as const,
   missing:['owner_set_replay_and_balance_of_owner_of_reconciliation_not_run'],actionAvailable:false as const};
 }catch(error){
  const reason=error instanceof Error&&/^position_manager_transfer_[a-z0-9_]+$/.test(error.message)?error.message:
   'transfer_scan_rpc_or_store_unavailable';
  return {status:'unavailable' as const,reason,enumerationComplete:false as const,actionAvailable:false as const};
 }
}

/** Legacy/global indexing stays deliberately small to respect broad manager
 * log limits. Wallet-scoped history has a separate durable namespace and may
 * use the larger bounded window below during explicit maintenance only. */
export function scanPositionManagerTransferHistory(input:{client:RobinhoodClient;
 store:PositionManagerTransferIndexStore;chainId:number;manager:Address;startBlock:bigint;
 source:{block:bigint;hash:Hash;timestamp:number};chunkBlocks?:bigint;maxBlocksPerRun?:bigint}){
 return scanPositionManagerTransferHistoryWithBounds(input,{chunkBlocks:1_000n,maxBlocksPerRun:MAX_BLOCKS_PER_RUN,
  maxChunkBlocks:MAX_CHUNK_BLOCKS,maxRunBlocks:MAX_BLOCKS_PER_RUN});
}

/** Explicit maintenance-only backfill for a dedicated wallet-scoped cursor.
 * It always starts at genesis, persists resumable canonical chunks and caps
 * each run at 100M blocks; requests should only read its persisted evidence. */
export function scanPositionManagerWalletTransferHistory(input:{client:RobinhoodClient;
 store:PositionManagerTransferIndexStore;chainId:number;manager:Address;
 source:{block:bigint;hash:Hash;timestamp:number};chunkBlocks?:bigint;maxBlocksPerRun?:bigint}){
 if(!input.store.walletScope||!isAddress(input.store.walletScope))
  return Promise.resolve({status:'unavailable' as const,reason:'wallet_scoped_transfer_store_required',
   enumerationComplete:false as const,actionAvailable:false as const});
 return scanPositionManagerTransferHistoryWithBounds({...input,startBlock:0n},{
  chunkBlocks:MAX_WALLET_CHUNK_BLOCKS,maxBlocksPerRun:MAX_WALLET_BLOCKS_PER_RUN,
  maxChunkBlocks:MAX_WALLET_CHUNK_BLOCKS,maxRunBlocks:MAX_WALLET_BLOCKS_PER_RUN,
 });
}

/** Replay every Transfer log in an indexed range. Exact identity and sequence
 * checks make holes, duplicate mints and unknown prior owners unavailable. */
export function replayPositionManagerOwnerSet(input:{chainId:number;expectedChainId:number;
 manager:Address;expectedManager:Address;startBlock:bigint;sourceBlock:bigint;
 coveredThroughBlock:bigint|null;coveredThroughHash:Hash|null;sourceHash:Hash;sourceCheckpointHash:Hash|null;
 transfers:readonly PositionManagerTransfer[];operator:Address}):
 {status:'replayed';owners:ReadonlyMap<string,Address>;operatorTokenIds:readonly string[];enumerationComplete:false;missing:string[]}|
 {status:'unavailable';reason:string;enumerationComplete:false;operatorTokenIds:readonly string[]}{
 const unavailable=(reason:string)=>({status:'unavailable' as const,reason,enumerationComplete:false as const,
  operatorTokenIds:[] as string[]});
 if(input.chainId!==input.expectedChainId||input.chainId!==ROBINHOOD_CHAIN_ID||!same(input.manager,input.expectedManager))
  return unavailable('transfer_replay_chain_or_manager_mismatch');
 if(input.startBlock!==0n||input.coveredThroughBlock===null||input.coveredThroughBlock<input.sourceBlock||
  !input.coveredThroughHash||!HASH.test(input.sourceHash)||!input.sourceCheckpointHash||
  !same(input.sourceCheckpointHash,input.sourceHash))return unavailable('transfer_replay_genesis_to_source_coverage_incomplete');
 if(input.transfers.length>MAX_REPLAY_EVENTS)return unavailable('transfer_replay_event_bound_exceeded');
 const events=[...input.transfers].filter(event=>event.blockNumber<=input.sourceBlock).sort((a,b)=>
  a.blockNumber!==b.blockNumber?a.blockNumber<b.blockNumber?-1:1:
   a.transactionIndex-b.transactionIndex||a.logIndex-b.logIndex);
 const owners=new Map<string,Address>(),seen=new Set<string>();
 for(const event of events){
  if(event.blockNumber<0n||event.blockNumber>input.sourceBlock||!HASH.test(event.blockHash)||
   !HASH.test(event.transactionHash)||event.tokenId<=0n||!Number.isSafeInteger(event.transactionIndex)||
   !Number.isSafeInteger(event.logIndex))return unavailable('transfer_replay_event_invalid');
  const key=`${event.transactionHash.toLowerCase()}:${event.logIndex}`;
  if(seen.has(key))return unavailable('transfer_replay_duplicate_log');seen.add(key);
  const id=event.tokenId.toString(),prior=owners.get(id);
  if(same(event.from,ZERO)){
   if(prior!==undefined)return unavailable('transfer_replay_duplicate_mint');
  }else if(prior===undefined||!same(prior,event.from))return unavailable('transfer_replay_unknown_prior_owner');
  if(same(event.to,ZERO))owners.delete(id);else owners.set(id,event.to);
 }
 const operatorTokenIds=[...owners.entries()].filter(([,owner])=>same(owner,input.operator))
  .map(([id])=>id).sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
 return {status:'replayed',owners,operatorTokenIds,enumerationComplete:false,
  missing:['persisted_checkpoint_binding_not_verified','balance_of_and_owner_of_reconciliation_not_run']};
}

/** Replay a wallet-indexed `from`/`to` log stream from genesis. Events which do
 * not involve the exact wallet indicate a broken scope filter and invalidate
 * the entire proof. An incoming event establishes ownership at the first point
 * it enters the wallet; an outgoing event is allowed only for a token already
 * owned. Self-transfers must reference an owned token and preserve ownership. */
export function replayPositionManagerWalletOwnerSet(input:{chainId:number;expectedChainId:number;
 manager:Address;expectedManager:Address;startBlock:bigint;sourceBlock:bigint;
 coveredThroughBlock:bigint|null;coveredThroughHash:Hash|null;sourceHash:Hash;sourceCheckpointHash:Hash|null;
 transfers:readonly PositionManagerTransfer[];operator:Address;walletScope:Address}):
 {status:'replayed';operatorTokenIds:readonly string[];enumerationComplete:false;missing:string[]}|{
 status:'unavailable';reason:string;enumerationComplete:false;operatorTokenIds:readonly string[]} {
 const unavailable=(reason:string)=>({status:'unavailable' as const,reason,enumerationComplete:false as const,
  operatorTokenIds:[] as string[]});
 if(input.chainId!==input.expectedChainId||input.chainId!==ROBINHOOD_CHAIN_ID||!same(input.manager,input.expectedManager))
  return unavailable('transfer_replay_chain_or_manager_mismatch');
 if(!same(input.operator,input.walletScope))return unavailable('transfer_replay_wallet_scope_mismatch');
 if(input.startBlock!==0n||input.coveredThroughBlock===null||input.coveredThroughBlock<input.sourceBlock||
  !input.coveredThroughHash||!HASH.test(input.sourceHash)||!input.sourceCheckpointHash||
  !same(input.sourceCheckpointHash,input.sourceHash))return unavailable('transfer_replay_genesis_to_source_coverage_incomplete');
 if(input.transfers.length>MAX_REPLAY_EVENTS)return unavailable('transfer_replay_event_bound_exceeded');
 if(input.transfers.some(event=>event.blockNumber<0n||event.blockNumber>input.sourceBlock))
  return unavailable('transfer_replay_event_invalid');
 const events=[...input.transfers].sort((a,b)=>
  a.blockNumber!==b.blockNumber?a.blockNumber<b.blockNumber?-1:1:
   a.transactionIndex-b.transactionIndex||a.logIndex-b.logIndex);
 const owned=new Set<string>(),seen=new Set<string>();let priorOrder:{block:bigint;tx:number;log:number}|null=null;
 for(const event of events){
  if(event.blockNumber<0n||event.blockNumber>input.sourceBlock||!HASH.test(event.blockHash)||
   !HASH.test(event.transactionHash)||event.tokenId<=0n||!Number.isSafeInteger(event.transactionIndex)||event.transactionIndex<0||
   !Number.isSafeInteger(event.logIndex)||event.logIndex<0||!isAddress(event.from)||!isAddress(event.to))
   return unavailable('transfer_replay_event_invalid');
  const key=`${event.transactionHash.toLowerCase()}:${event.logIndex}`;
  if(seen.has(key))return unavailable('transfer_replay_duplicate_log');seen.add(key);
  const order={block:event.blockNumber,tx:event.transactionIndex,log:event.logIndex};
  if(priorOrder&&(order.block<priorOrder.block||order.block===priorOrder.block&&
   (order.tx<priorOrder.tx||order.tx===priorOrder.tx&&order.log<=priorOrder.log)))
   return unavailable('transfer_replay_event_order_invalid');
  priorOrder=order;
  const id=event.tokenId.toString(),fromWallet=same(event.from,input.walletScope),toWallet=same(event.to,input.walletScope);
  if(!fromWallet&&!toWallet)return unavailable('transfer_replay_wallet_scope_event_mismatch');
  if(same(event.from,ZERO)){
   if(!toWallet)return unavailable('transfer_replay_wallet_scope_event_mismatch');
   if(owned.has(id))return unavailable('transfer_replay_duplicate_mint');
   owned.add(id);continue;
  }
  if(fromWallet&&!owned.has(id))return unavailable('transfer_replay_wallet_unknown_prior_owner');
  if(fromWallet&&toWallet)continue;
  if(fromWallet){owned.delete(id);continue;}
  if(toWallet){if(owned.has(id))return unavailable('transfer_replay_wallet_duplicate_acquire');owned.add(id);}
 }
 return {status:'replayed',operatorTokenIds:[...owned].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0),
  enumerationComplete:false,missing:['persisted_checkpoint_binding_not_verified','balance_of_and_owner_of_reconciliation_not_run']};
}

export async function closePositionManagerTransferIndex(store:PostgresPositionManagerTransferStore){await store.close();}

type CursorRow={chain_id:string;position_manager:string;start_block:string;next_block:string;
 covered_through_block:string|null;covered_through_hash:Hash|null;last_scanned_block:string|null;last_scanned_hash:Hash|null};
type CheckpointRow={block_number:string;block_hash:Hash;parent_hash:Hash;block_timestamp:Date};
function mapCursor(row:CursorRow):PositionManagerTransferCursor{return {chainId:Number(row.chain_id),
 manager:getAddress(row.position_manager),startBlock:BigInt(row.start_block),nextBlock:BigInt(row.next_block),
 coveredThroughBlock:row.covered_through_block===null?null:BigInt(row.covered_through_block),
 coveredThroughHash:row.covered_through_hash,lastScannedBlock:row.last_scanned_block===null?null:BigInt(row.last_scanned_block),
 lastScannedHash:row.last_scanned_hash};}
function mapCheckpoint(row:CheckpointRow):PositionManagerCheckpoint{return {number:BigInt(row.block_number),
 hash:row.block_hash,parentHash:row.parent_hash,timestamp:Math.floor(row.block_timestamp.getTime()/1000)};}

/** Additive SQL adapter. It performs writes only when an explicit caller runs
 * a scan; construction and reads never migrate or repair schema. */
export class PostgresPositionManagerTransferStore {
 private readonly pool:InstanceType<typeof Pool>;
 constructor(connectionString:string){this.pool=new Pool({connectionString,max:2});}
 async assertReady(){await assertDeploymentSchemaReady(this.pool);}
 async getCursor(chainId:number,manager:Address,startBlock:bigint){
  const result=await this.pool.query<CursorRow>(`SELECT chain_id::text,position_manager,start_block::text,next_block::text,
   covered_through_block::text,covered_through_hash,last_scanned_block::text,last_scanned_hash
   FROM position_manager_transfer_cursors WHERE chain_id=$1 AND position_manager=$2 AND start_block=$3`,
   [chainId,manager.toLowerCase(),startBlock.toString()]);
  return result.rows[0]?mapCursor(result.rows[0]):null;
 }
 async initializeCursor(chainId:number,manager:Address,startBlock:bigint){
  await this.pool.query(`INSERT INTO position_manager_transfer_cursors
   (chain_id,position_manager,start_block,next_block) VALUES($1,$2,$3,$3)
   ON CONFLICT(chain_id,position_manager,start_block) DO NOTHING`,[chainId,manager.toLowerCase(),startBlock.toString()]);
  const cursor=await this.getCursor(chainId,manager,startBlock);
  if(!cursor)throw Error('position_manager_transfer_cursor_initialize_failed');return cursor;
 }
 async recentCheckpoints(chainId:number,manager:Address,startBlock:bigint,limit:number){
  const rows=await this.pool.query<CheckpointRow>(`SELECT block_number::text,block_hash,parent_hash,block_timestamp
   FROM position_manager_transfer_checkpoints WHERE chain_id=$1 AND position_manager=$2 AND start_block=$3
   ORDER BY block_number DESC LIMIT $4`,[chainId,manager.toLowerCase(),startBlock.toString(),Math.min(512,Math.max(1,limit))]);
  return rows.rows.map(mapCheckpoint);
 }
 async rewind(chainId:number,manager:Address,startBlock:bigint,fromBlock:bigint,boundary:PositionManagerCheckpoint|null){
  if((fromBlock===startBlock)!==(boundary===null)||boundary&&boundary.number!==fromBlock-1n)
   throw Error('position_manager_transfer_rewind_boundary_invalid');
  const db=await this.pool.connect();
  try{await db.query('BEGIN');
   await db.query(`DELETE FROM position_manager_transfers WHERE chain_id=$1 AND position_manager=$2 AND start_block=$3 AND block_number >= $4`,
    [chainId,manager.toLowerCase(),startBlock.toString(),fromBlock.toString()]);
   await db.query(`DELETE FROM position_manager_transfer_checkpoints WHERE chain_id=$1 AND position_manager=$2 AND start_block=$3 AND block_number >= $4`,
    [chainId,manager.toLowerCase(),startBlock.toString(),fromBlock.toString()]);
   await db.query(`UPDATE position_manager_transfer_cursors SET next_block=$4,covered_through_block=$5,
    covered_through_hash=$6,last_scanned_block=$7,last_scanned_hash=$8,updated_at=clock_timestamp()
    WHERE chain_id=$1 AND position_manager=$2 AND start_block=$3`,[chainId,manager.toLowerCase(),startBlock.toString(),
    fromBlock.toString(),boundary?.number.toString()??null,boundary?.hash??null,boundary?.number.toString()??null,boundary?.hash??null]);
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async saveChunk(chunk:PositionManagerTransferChunk){
  const db=await this.pool.connect();
  try{await db.query('BEGIN');
   const cursor=(await db.query<CursorRow>(`SELECT chain_id::text,position_manager,start_block::text,next_block::text,
    covered_through_block::text,covered_through_hash,last_scanned_block::text,last_scanned_hash
    FROM position_manager_transfer_cursors WHERE chain_id=$1 AND position_manager=$2 AND start_block=$3 FOR UPDATE`,
    [chunk.chainId,chunk.manager.toLowerCase(),chunk.startBlock.toString()])).rows[0];
   if(!cursor||BigInt(cursor.next_block)!==chunk.fromBlock||chunk.toBlock<chunk.fromBlock||
    chunk.checkpoint.number!==chunk.toBlock||chunk.checkpoint.number<chunk.startBlock||
    chunk.checkpoint.timestamp<0||chunk.fromCheckpoint&&chunk.fromCheckpoint.number!==chunk.fromBlock-1n)
    throw Error('position_manager_transfer_chunk_not_contiguous');
   if(cursor.covered_through_block!==null&&chunk.fromBlock!==BigInt(cursor.covered_through_block)+1n)
    throw Error('position_manager_transfer_coverage_gap');
   const checkpoints=[...chunk.eventBlocks,chunk.checkpoint];
   const unique=new Map<string,PositionManagerCheckpoint>();
   for(const header of checkpoints){
    const key=header.number.toString(),prior=unique.get(key);
    if(prior&&(!same(prior.hash,header.hash)||!same(prior.parentHash,header.parentHash)||prior.timestamp!==header.timestamp))
     throw Error('position_manager_transfer_checkpoint_conflict');
    unique.set(key,header);
   }
   if(chunk.transfers.some(event=>{
    const header=unique.get(event.blockNumber.toString());return !header||!same(header.hash,event.blockHash)||
     event.blockNumber<chunk.fromBlock||event.blockNumber>chunk.toBlock;
   }))throw Error('position_manager_transfer_event_checkpoint_mismatch');
   if(chunk.fromCheckpoint){
    await db.query(`INSERT INTO position_manager_transfer_checkpoints
     (chain_id,position_manager,start_block,block_number,block_hash,parent_hash,block_timestamp)
     VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7)) ON CONFLICT(chain_id,position_manager,start_block,block_number)
     DO UPDATE SET block_hash=EXCLUDED.block_hash,parent_hash=EXCLUDED.parent_hash,block_timestamp=EXCLUDED.block_timestamp`,
     [chunk.chainId,chunk.manager.toLowerCase(),chunk.startBlock.toString(),chunk.fromCheckpoint.number.toString(),
      chunk.fromCheckpoint.hash,chunk.fromCheckpoint.parentHash,chunk.fromCheckpoint.timestamp]);
   }
   for(const header of checkpoints){
    await db.query(`INSERT INTO position_manager_transfer_checkpoints
     (chain_id,position_manager,start_block,block_number,block_hash,parent_hash,block_timestamp)
     VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7)) ON CONFLICT(chain_id,position_manager,start_block,block_number)
     DO UPDATE SET block_hash=EXCLUDED.block_hash,parent_hash=EXCLUDED.parent_hash,block_timestamp=EXCLUDED.block_timestamp`,
     [chunk.chainId,chunk.manager.toLowerCase(),chunk.startBlock.toString(),header.number.toString(),
      header.hash,header.parentHash,header.timestamp]);
   }
   for(const event of chunk.transfers){
    await db.query(`INSERT INTO position_manager_transfers
     (chain_id,position_manager,start_block,block_number,block_hash,transaction_hash,transaction_index,
      log_index,from_address,to_address,token_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT(chain_id,position_manager,start_block,transaction_hash,log_index) DO NOTHING`,
     [chunk.chainId,chunk.manager.toLowerCase(),chunk.startBlock.toString(),event.blockNumber.toString(),
      event.blockHash,event.transactionHash,event.transactionIndex,event.logIndex,event.from.toLowerCase(),
      event.to.toLowerCase(),event.tokenId.toString()]);
   }
   await db.query(`UPDATE position_manager_transfer_cursors SET next_block=$4,covered_through_block=$5,
    covered_through_hash=$6,last_scanned_block=$5,last_scanned_hash=$6,updated_at=clock_timestamp()
    WHERE chain_id=$1 AND position_manager=$2 AND start_block=$3`,
    [chunk.chainId,chunk.manager.toLowerCase(),chunk.startBlock.toString(),(chunk.toBlock+1n).toString(),
     chunk.toBlock.toString(),chunk.checkpoint.hash]);
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async savePinnedCheckpoint(chainId:number,manager:Address,startBlock:bigint,checkpoint:PositionManagerCheckpoint){
  const db=await this.pool.connect();
  try{await db.query('BEGIN');
   const cursor=(await db.query<{covered_through_block:string|null}>(`SELECT covered_through_block::text
    FROM position_manager_transfer_cursors WHERE chain_id=$1 AND position_manager=$2 AND start_block=$3 FOR UPDATE`,
    [chainId,manager.toLowerCase(),startBlock.toString()])).rows[0];
   if(!cursor||cursor.covered_through_block===null||BigInt(cursor.covered_through_block)<checkpoint.number)
    throw Error('position_manager_transfer_source_checkpoint_outside_coverage');
   await db.query(`INSERT INTO position_manager_transfer_checkpoints
    (chain_id,position_manager,start_block,block_number,block_hash,parent_hash,block_timestamp)
    VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7))
    ON CONFLICT(chain_id,position_manager,start_block,block_number) DO NOTHING`,
    [chainId,manager.toLowerCase(),startBlock.toString(),checkpoint.number.toString(),checkpoint.hash,
     checkpoint.parentHash,checkpoint.timestamp]);
   const saved=(await db.query<{block_hash:Hash;parent_hash:Hash;block_timestamp:Date}>(`SELECT block_hash,parent_hash,block_timestamp
    FROM position_manager_transfer_checkpoints WHERE chain_id=$1 AND position_manager=$2 AND start_block=$3 AND block_number=$4`,
    [chainId,manager.toLowerCase(),startBlock.toString(),checkpoint.number.toString()])).rows[0];
   if(!saved||!same(saved.block_hash,checkpoint.hash)||!same(saved.parent_hash,checkpoint.parentHash)||
    Math.floor(saved.block_timestamp.getTime()/1000)!==checkpoint.timestamp)
    throw Error('position_manager_transfer_checkpoint_conflict');
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async loadTransfers(chainId:number,manager:Address,startBlock:bigint,toBlock:bigint,limit:number){
  const rows=await this.pool.query<{block_number:string;block_hash:Hash;transaction_hash:Hash;
   transaction_index:number;log_index:number;from_address:string;to_address:string;token_id:string}>(
   `SELECT block_number::text,block_hash,transaction_hash,transaction_index,log_index,
    from_address,to_address,token_id::text FROM position_manager_transfers
    WHERE chain_id=$1 AND position_manager=$2 AND start_block=$3 AND block_number<=$4
    ORDER BY block_number,transaction_index,log_index LIMIT $5`,
   [chainId,manager.toLowerCase(),startBlock.toString(),toBlock.toString(),Math.min(MAX_REPLAY_EVENTS+1,limit+1)]);
  if(rows.rows.length>limit)throw Error('position_manager_transfer_replay_bound_exceeded');
  return rows.rows.map(row=>({blockNumber:BigInt(row.block_number),blockHash:row.block_hash,
   transactionHash:row.transaction_hash,transactionIndex:row.transaction_index,logIndex:row.log_index,
   from:getAddress(row.from_address),to:getAddress(row.to_address),tokenId:BigInt(row.token_id)}));
 }
 async loadReplayEvidence(chainId:number,manager:Address,startBlock:bigint,sourceBlock:bigint,limit:number){
  const db=await this.pool.connect();
  try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const cursorRow=(await db.query<CursorRow>(`SELECT chain_id::text,position_manager,start_block::text,next_block::text,
    covered_through_block::text,covered_through_hash,last_scanned_block::text,last_scanned_hash
    FROM position_manager_transfer_cursors WHERE chain_id=$1 AND position_manager=$2 AND start_block=$3`,
    [chainId,manager.toLowerCase(),startBlock.toString()])).rows[0];
   if(!cursorRow){await db.query('COMMIT');return null;}
   const eventRows=await db.query<{block_number:string;block_hash:Hash;transaction_hash:Hash;transaction_index:number;
    log_index:number;from_address:string;to_address:string;token_id:string}>(`SELECT block_number::text,block_hash,transaction_hash,
     transaction_index,log_index,from_address,to_address,token_id::text FROM position_manager_transfers
     WHERE chain_id=$1 AND position_manager=$2 AND start_block=$3 AND block_number<=$4
     ORDER BY block_number,transaction_index,log_index LIMIT $5`,
    [chainId,manager.toLowerCase(),startBlock.toString(),sourceBlock.toString(),Math.min(MAX_REPLAY_EVENTS+1,limit+1)]);
   if(eventRows.rows.length>limit||eventRows.rows.length>MAX_REPLAY_EVENTS)
    throw Error('position_manager_transfer_replay_bound_exceeded');
   const transfers=eventRows.rows.map(row=>({blockNumber:BigInt(row.block_number),blockHash:row.block_hash,
    transactionHash:row.transaction_hash,transactionIndex:row.transaction_index,logIndex:row.log_index,
    from:getAddress(row.from_address),to:getAddress(row.to_address),tokenId:BigInt(row.token_id)}));
   const blockNumbers=[...new Set(transfers.map(event=>event.blockNumber.toString()))];
   if(blockNumbers.length>MAX_REPLAY_CHECKPOINT_BLOCKS)
    throw Error('position_manager_transfer_checkpoint_replay_bound_exceeded');
   const cursor=mapCursor(cursorRow),requiredBlocks=[...new Set([
    ...blockNumbers,sourceBlock.toString(),...(cursor.coveredThroughBlock===null?[]:[cursor.coveredThroughBlock.toString()]),
   ])];
   const checkpointRows=await db.query<CheckpointRow>(`SELECT block_number::text,block_hash,parent_hash,block_timestamp
    FROM position_manager_transfer_checkpoints WHERE chain_id=$1 AND position_manager=$2 AND start_block=$3
    AND block_number=ANY($4::numeric[])`,[chainId,manager.toLowerCase(),startBlock.toString(),requiredBlocks]);
   await db.query('COMMIT');
   return {cursor,transfers,checkpoints:checkpointRows.rows.map(mapCheckpoint)};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async close(){await this.pool.end();}
}
