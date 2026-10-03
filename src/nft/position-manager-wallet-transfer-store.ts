import pg, {type PoolClient} from 'pg';
import {getAddress,isAddress,type Address,type Hash} from 'viem';
import {assertPositionManagerWalletTransferSchemaReady} from '../storage/compatibility.js';
import type {PositionManagerCheckpoint,PositionManagerTransfer,PositionManagerTransferChunk,
 PositionManagerTransferCursor,PositionManagerTransferIndexStore} from './position-manager-transfer-index.js';

const {Pool}=pg;
const HASH=/^0x[0-9a-f]{64}$/i;
const MAX_REPLAY_EVENTS=1_000_000,MAX_REPLAY_CHECKPOINT_BLOCKS=10_000;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
type CursorRow={chain_id:string;position_manager:string;start_block:string;next_block:string;
 covered_through_block:string|null;covered_through_hash:Hash|null;last_scanned_block:string|null;last_scanned_hash:Hash|null};
type CheckpointRow={block_number:string;block_hash:Hash;parent_hash:Hash;block_timestamp:Date};
type TransferRow={block_number:string;block_hash:Hash;transaction_hash:Hash;transaction_index:number;log_index:number;
 from_address:string;to_address:string;token_id:string};
function cursor(row:CursorRow):PositionManagerTransferCursor{return {chainId:Number(row.chain_id),
 manager:getAddress(row.position_manager),startBlock:BigInt(row.start_block),nextBlock:BigInt(row.next_block),
 coveredThroughBlock:row.covered_through_block===null?null:BigInt(row.covered_through_block),
 coveredThroughHash:row.covered_through_hash,lastScannedBlock:row.last_scanned_block===null?null:BigInt(row.last_scanned_block),
 lastScannedHash:row.last_scanned_hash};}
function checkpoint(row:CheckpointRow):PositionManagerCheckpoint{return {number:BigInt(row.block_number),hash:row.block_hash,
 parentHash:row.parent_hash,timestamp:Math.floor(row.block_timestamp.getTime()/1000)};}
function transfer(row:TransferRow):PositionManagerTransfer{return {blockNumber:BigInt(row.block_number),blockHash:row.block_hash,
 transactionHash:row.transaction_hash,transactionIndex:row.transaction_index,logIndex:row.log_index,
 from:getAddress(row.from_address),to:getAddress(row.to_address),tokenId:BigInt(row.token_id)};}
function scope(manager:Address,startBlock:bigint,chainId:number){
 if(!Number.isSafeInteger(chainId)||chainId<=0||!isAddress(manager)||startBlock<0n)
  throw Error('position_manager_wallet_transfer_scope_invalid');
 return [chainId,getAddress(manager).toLowerCase(),startBlock.toString()] as const;
}

/** Persistent wallet-specific transfer evidence. The immutable wallet scope
 * is part of every SQL predicate and primary key; this store cannot read or
 * mutate another operator's rows. Construction and reads never execute DDL. */
export class PostgresPositionManagerWalletTransferStore implements PositionManagerTransferIndexStore {
 readonly walletScope:Address;
 private readonly pool:InstanceType<typeof Pool>;
 constructor(connectionString:string,walletScope:Address){
  if(!isAddress(walletScope))throw Error('position_manager_wallet_transfer_wallet_scope_invalid');
  this.walletScope=getAddress(walletScope);
  Object.defineProperty(this,'walletScope',{value:this.walletScope,writable:false,configurable:false,enumerable:true});
  this.pool=new Pool({connectionString,max:2});
 }
 async assertReady(){await assertPositionManagerWalletTransferSchemaReady(this.pool);}
 private key(chainId:number,manager:Address,startBlock:bigint){return [...scope(manager,startBlock,chainId).slice(0,2),this.walletScope.toLowerCase(),startBlock.toString()];}
 async getCursor(chainId:number,manager:Address,startBlock:bigint){
  const result=await this.pool.query<CursorRow>(`SELECT chain_id::text,position_manager,start_block::text,next_block::text,
   covered_through_block::text,covered_through_hash,last_scanned_block::text,last_scanned_hash
   FROM position_manager_wallet_transfer_cursors WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4`,
   this.key(chainId,manager,startBlock));
  return result.rows[0]?cursor(result.rows[0]):null;
 }
 async initializeCursor(chainId:number,manager:Address,startBlock:bigint){
  const key=this.key(chainId,manager,startBlock);
  await this.pool.query(`INSERT INTO position_manager_wallet_transfer_cursors
   (chain_id,position_manager,wallet_address,start_block,next_block) VALUES($1,$2,$3,$4,$4)
   ON CONFLICT(chain_id,position_manager,wallet_address,start_block) DO NOTHING`,key);
  const value=await this.getCursor(chainId,manager,startBlock);
  if(!value)throw Error('position_manager_wallet_transfer_cursor_initialize_failed');return value;
 }
 async recentCheckpoints(chainId:number,manager:Address,startBlock:bigint,limit:number){
  const rows=await this.pool.query<CheckpointRow>(`SELECT block_number::text,block_hash,parent_hash,block_timestamp
   FROM position_manager_wallet_transfer_checkpoints WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4
   ORDER BY block_number DESC LIMIT $5`,[...this.key(chainId,manager,startBlock),Math.min(512,Math.max(1,limit))]);
  return rows.rows.map(checkpoint);
 }
 async rewind(chainId:number,manager:Address,startBlock:bigint,fromBlock:bigint,boundary:PositionManagerCheckpoint|null){
  if((fromBlock===startBlock)!==(boundary===null)||boundary&&boundary.number!==fromBlock-1n)
   throw Error('position_manager_wallet_transfer_rewind_boundary_invalid');
  const db=await this.pool.connect(),key=this.key(chainId,manager,startBlock);
  try{await db.query('BEGIN');
   const current=(await db.query<CursorRow>(`SELECT chain_id::text,position_manager,start_block::text,next_block::text,
    covered_through_block::text,covered_through_hash,last_scanned_block::text,last_scanned_hash
    FROM position_manager_wallet_transfer_cursors WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4 FOR UPDATE`,key)).rows[0];
   if(!current)throw Error('position_manager_wallet_transfer_cursor_missing');
   if(boundary){const saved=(await db.query<CheckpointRow>(`SELECT block_number::text,block_hash,parent_hash,block_timestamp
    FROM position_manager_wallet_transfer_checkpoints WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4 AND block_number=$5`,
    [...key,boundary.number.toString()])).rows[0];
    if(!saved||!same(saved.block_hash,boundary.hash)||!same(saved.parent_hash,boundary.parentHash)||
     Math.floor(saved.block_timestamp.getTime()/1000)!==boundary.timestamp)throw Error('position_manager_wallet_transfer_rewind_boundary_mismatch');}
   await db.query(`DELETE FROM position_manager_wallet_transfers WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4 AND block_number >= $5`,
    [...key,fromBlock.toString()]);
   await db.query(`DELETE FROM position_manager_wallet_transfer_checkpoints WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4 AND block_number >= $5`,
    [...key,fromBlock.toString()]);
   await db.query(`UPDATE position_manager_wallet_transfer_cursors SET next_block=$5,covered_through_block=$6,
    covered_through_hash=$7,last_scanned_block=$8,last_scanned_hash=$9,updated_at=clock_timestamp()
    WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4`,
    [...key,fromBlock.toString(),boundary?.number.toString()??null,boundary?.hash??null,
     boundary?.number.toString()??null,boundary?.hash??null]);
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async saveChunk(chunk:PositionManagerTransferChunk){
  const key=this.key(chunk.chainId,chunk.manager,chunk.startBlock),db=await this.pool.connect();
  try{await db.query('BEGIN');
   const row=(await db.query<CursorRow>(`SELECT chain_id::text,position_manager,start_block::text,next_block::text,
    covered_through_block::text,covered_through_hash,last_scanned_block::text,last_scanned_hash
    FROM position_manager_wallet_transfer_cursors WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4 FOR UPDATE`,key)).rows[0];
   if(!row||BigInt(row.next_block)!==chunk.fromBlock||chunk.toBlock<chunk.fromBlock||
    chunk.checkpoint.number!==chunk.toBlock||chunk.checkpoint.number<chunk.startBlock||chunk.checkpoint.timestamp<0||
    chunk.fromCheckpoint&&chunk.fromCheckpoint.number!==chunk.fromBlock-1n)
    throw Error('position_manager_wallet_transfer_chunk_not_contiguous');
   if(chunk.fromBlock===chunk.startBlock){
    if(chunk.fromCheckpoint!==null||row.covered_through_block!==null)
     throw Error('position_manager_wallet_transfer_initial_boundary_invalid');
   }else{
    const expected=chunk.fromBlock-1n;
    if(!chunk.fromCheckpoint||row.covered_through_block===null||BigInt(row.covered_through_block)!==expected||
     !row.covered_through_hash||!same(row.covered_through_hash,chunk.fromCheckpoint.hash)||
     chunk.fromCheckpoint.number!==expected)
     throw Error('position_manager_wallet_transfer_coverage_gap');
    const persisted=(await db.query<CheckpointRow>(`SELECT block_number::text,block_hash,parent_hash,block_timestamp
     FROM position_manager_wallet_transfer_checkpoints WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3
     AND start_block=$4 AND block_number=$5`,[...key,expected.toString()])).rows[0];
    if(!persisted||!same(persisted.block_hash,chunk.fromCheckpoint.hash)||
     !same(persisted.parent_hash,chunk.fromCheckpoint.parentHash)||
     Math.floor(persisted.block_timestamp.getTime()/1000)!==chunk.fromCheckpoint.timestamp)
     throw Error('position_manager_wallet_transfer_previous_checkpoint_mismatch');
   }
   if(chunk.transfers.some(event=>!same(event.from,this.walletScope)&&!same(event.to,this.walletScope)))
    throw Error('position_manager_wallet_transfer_event_out_of_scope');
   const unique=new Map<string,PositionManagerCheckpoint>();
   for(const header of [...chunk.eventBlocks,chunk.checkpoint]){
    if(!HASH.test(header.hash)||!HASH.test(header.parentHash)||!Number.isSafeInteger(header.timestamp)||header.timestamp<0)
     throw Error('position_manager_wallet_transfer_checkpoint_invalid');
    if(header.number<chunk.fromBlock||header.number>chunk.toBlock||
     (!same(header.hash,chunk.checkpoint.hash)&&header.number===chunk.checkpoint.number))
     throw Error('position_manager_wallet_transfer_checkpoint_out_of_range');
    const id=header.number.toString(),prior=unique.get(id);
    if(prior&&(!same(prior.hash,header.hash)||!same(prior.parentHash,header.parentHash)||prior.timestamp!==header.timestamp))
     throw Error('position_manager_wallet_transfer_checkpoint_conflict');
    unique.set(id,header);
   }
   if(chunk.transfers.some(event=>{const h=unique.get(event.blockNumber.toString());return !h||!same(h.hash,event.blockHash)||
    event.blockNumber<chunk.fromBlock||event.blockNumber>chunk.toBlock||event.tokenId<=0n||
    !Number.isSafeInteger(event.transactionIndex)||event.transactionIndex<0||!Number.isSafeInteger(event.logIndex)||event.logIndex<0||
    !HASH.test(event.blockHash)||!HASH.test(event.transactionHash);}))
    throw Error('position_manager_wallet_transfer_event_checkpoint_mismatch');
   if(chunk.fromCheckpoint){const from=chunk.fromCheckpoint;
    await this.insertCheckpoint(db,key,from);}
   for(const h of unique.values())await this.insertCheckpoint(db,key,h);
   for(const event of chunk.transfers){
    const inserted=await db.query(`INSERT INTO position_manager_wallet_transfers
     (chain_id,position_manager,wallet_address,start_block,block_number,block_hash,transaction_hash,transaction_index,
      log_index,from_address,to_address,token_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT(chain_id,position_manager,wallet_address,start_block,transaction_hash,log_index) DO NOTHING RETURNING transaction_hash`,
     [...key,event.blockNumber.toString(),event.blockHash,event.transactionHash.toLowerCase(),event.transactionIndex,event.logIndex,
      event.from.toLowerCase(),event.to.toLowerCase(),event.tokenId.toString()]);
    if(!inserted.rowCount){const saved=(await db.query<TransferRow>(`SELECT block_number::text,block_hash,transaction_hash,
     transaction_index,log_index,from_address,to_address,token_id::text FROM position_manager_wallet_transfers
     WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4 AND transaction_hash=$5 AND log_index=$6`,
     [...key,event.transactionHash.toLowerCase(),event.logIndex])).rows[0];
     if(!saved||BigInt(saved.block_number)!==event.blockNumber||!same(saved.block_hash,event.blockHash)||
      saved.transaction_index!==event.transactionIndex||!same(saved.from_address,event.from)||!same(saved.to_address,event.to)||
      BigInt(saved.token_id)!==event.tokenId)throw Error('position_manager_wallet_transfer_event_conflict');}
   }
   await db.query(`UPDATE position_manager_wallet_transfer_cursors SET next_block=$5,covered_through_block=$6,
    covered_through_hash=$7,last_scanned_block=$6,last_scanned_hash=$7,updated_at=clock_timestamp()
    WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4`,
    [...key,(chunk.toBlock+1n).toString(),chunk.toBlock.toString(),chunk.checkpoint.hash]);
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 private async insertCheckpoint(db:PoolClient,key:readonly unknown[],value:PositionManagerCheckpoint){
  await db.query(`INSERT INTO position_manager_wallet_transfer_checkpoints
   (chain_id,position_manager,wallet_address,start_block,block_number,block_hash,parent_hash,block_timestamp)
   VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8)) ON CONFLICT(chain_id,position_manager,wallet_address,start_block,block_number) DO NOTHING`,
   [...key,value.number.toString(),value.hash,value.parentHash,value.timestamp]);
  const saved=(await db.query<CheckpointRow>(`SELECT block_number::text,block_hash,parent_hash,block_timestamp
   FROM position_manager_wallet_transfer_checkpoints WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4 AND block_number=$5`,
   [...key,value.number.toString()])).rows[0];
  if(!saved||!same(saved.block_hash,value.hash)||!same(saved.parent_hash,value.parentHash)||
   Math.floor(saved.block_timestamp.getTime()/1000)!==value.timestamp)
   throw Error('position_manager_wallet_transfer_checkpoint_conflict');
 }
 async savePinnedCheckpoint(chainId:number,manager:Address,startBlock:bigint,value:PositionManagerCheckpoint){
  const key=this.key(chainId,manager,startBlock),db=await this.pool.connect();
  try{await db.query('BEGIN');
   if(value.number<startBlock||!HASH.test(value.hash)||!HASH.test(value.parentHash)||
    !Number.isSafeInteger(value.timestamp)||value.timestamp<0)
    throw Error('position_manager_wallet_transfer_checkpoint_invalid');
   const row=(await db.query<{covered_through_block:string|null}>(`SELECT covered_through_block::text FROM position_manager_wallet_transfer_cursors
    WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4 FOR UPDATE`,key)).rows[0];
   if(!row||row.covered_through_block===null||BigInt(row.covered_through_block)<value.number)
    throw Error('position_manager_wallet_transfer_source_checkpoint_outside_coverage');
   await this.insertCheckpoint(db,key,value);await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async loadTransfers(chainId:number,manager:Address,startBlock:bigint,toBlock:bigint,limit:number){
  if(!Number.isSafeInteger(limit)||limit<0)throw Error('position_manager_wallet_transfer_replay_bound_invalid');
  const rows=await this.pool.query<TransferRow>(`SELECT block_number::text,block_hash,transaction_hash,transaction_index,
   log_index,from_address,to_address,token_id::text FROM position_manager_wallet_transfers
   WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4 AND block_number<=$5
   ORDER BY block_number,transaction_index,log_index LIMIT $6`,
   [...this.key(chainId,manager,startBlock),toBlock.toString(),Math.min(MAX_REPLAY_EVENTS+1,limit+1)]);
  if(rows.rows.length>limit||rows.rows.length>MAX_REPLAY_EVENTS)
   throw Error('position_manager_wallet_transfer_replay_bound_exceeded');
  return rows.rows.map(transfer);
 }
 async loadReplayEvidence(chainId:number,manager:Address,startBlock:bigint,sourceBlock:bigint,limit:number){
  if(!Number.isSafeInteger(limit)||limit<0)throw Error('position_manager_wallet_transfer_replay_bound_invalid');
  const db=await this.pool.connect(),key=this.key(chainId,manager,startBlock);
  try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const cursorRow=(await db.query<CursorRow>(`SELECT chain_id::text,position_manager,start_block::text,next_block::text,
    covered_through_block::text,covered_through_hash,last_scanned_block::text,last_scanned_hash
    FROM position_manager_wallet_transfer_cursors WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3 AND start_block=$4`,key)).rows[0];
   if(!cursorRow){await db.query('COMMIT');return null;}
   const rows=await db.query<TransferRow>(`SELECT block_number::text,block_hash,transaction_hash,transaction_index,log_index,
    from_address,to_address,token_id::text FROM position_manager_wallet_transfers WHERE chain_id=$1 AND position_manager=$2
    AND wallet_address=$3 AND start_block=$4 AND block_number<=$5 ORDER BY block_number,transaction_index,log_index LIMIT $6`,
    [...key,sourceBlock.toString(),Math.min(MAX_REPLAY_EVENTS+1,limit+1)]);
   if(rows.rows.length>limit||rows.rows.length>MAX_REPLAY_EVENTS)throw Error('position_manager_wallet_transfer_replay_bound_exceeded');
   const events=rows.rows.map(transfer),blockNumbers=[...new Set(events.map(e=>e.blockNumber.toString()))];
   if(blockNumbers.length>MAX_REPLAY_CHECKPOINT_BLOCKS)throw Error('position_manager_wallet_transfer_checkpoint_replay_bound_exceeded');
   const current=cursor(cursorRow),required=[...new Set([...blockNumbers,sourceBlock.toString(),
    ...(current.coveredThroughBlock===null?[]:[current.coveredThroughBlock.toString()])])];
   const headers=required.length?await db.query<CheckpointRow>(`SELECT block_number::text,block_hash,parent_hash,block_timestamp
    FROM position_manager_wallet_transfer_checkpoints WHERE chain_id=$1 AND position_manager=$2 AND wallet_address=$3
    AND start_block=$4 AND block_number=ANY($5::numeric[])`,[...key,required]):{rows:[] as CheckpointRow[]};
   await db.query('COMMIT');return {cursor:current,transfers:events,checkpoints:headers.rows.map(checkpoint)};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async close(){await this.pool.end();}
}
