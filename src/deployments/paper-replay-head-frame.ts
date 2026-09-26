import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../client.js';
import type {MarketProfile} from './market-profile.js';
import {readCanonicalPaperOpenFrame,type PaperOpenFrame} from './paper-preview.js';

/** Reads the exact complete-through replay cursor as a pinned canonical frame.
 * Fee replay still validates target-set identity and complete coverage for the
 * same source before producing any evidence. */
export async function readCanonicalPaperReplayHeadFrame(input:{client:RobinhoodClient;
 indexer:Pool;profile:MarketProfile;stream:string;targetSetHash:string;
 previous:{sourceBlock:string;sourceHash:string};now?:number;
 readFrame?:(source:PaperOpenFrame['source'])=>Promise<PaperOpenFrame>}):Promise<PaperOpenFrame>{
 const {client,indexer,profile,stream,targetSetHash,previous}=input;
 const queryClient=await indexer.connect();
 let cursor:{block:string;hash:string}|undefined;
 try{
  await queryClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
   await queryClient.query("SET LOCAL statement_timeout='5s'");
   cursor=(await queryClient.query<{block:string;hash:string}>(`
    SELECT c.complete_through_block::text AS block,c.complete_through_hash AS hash
    FROM v3_replay_cursors c JOIN v3_replay_pools p USING(stream_key)
    WHERE c.stream_key=$1 AND p.chain_id=$2 AND lower(p.pool_address)=lower($3)
     AND p.fee=$4 AND p.initialized=true AND c.target_set_hash=$5
     AND c.complete_through_block IS NOT NULL AND c.complete_through_hash IS NOT NULL
     AND (c.last_block_number IS NULL OR c.last_block_number<=c.complete_through_block)`,
    [stream,profile.pool.chainId,profile.pool.pool,profile.pool.fee,targetSetHash])).rows[0];
   await queryClient.query('COMMIT');
  }catch(error){await queryClient.query('ROLLBACK');throw error;}
 }finally{queryClient.release();}
 assert(cursor&&/^(0|[1-9][0-9]*)$/.test(cursor.block)&&
  /^0x[0-9a-fA-F]{64}$/.test(cursor.hash),'paper_replay_head_unavailable');
 assert(BigInt(cursor.block)>BigInt(previous.sourceBlock),
  'paper_replay_head_not_later_than_previous_mark');
 const previousBlock=await client.getBlock({blockNumber:BigInt(previous.sourceBlock)});
 assert.equal(previousBlock.hash.toLowerCase(),previous.sourceHash.toLowerCase(),
  'paper_replay_previous_mark_reorged');
 const block=await client.getBlock({blockNumber:BigInt(cursor.block)});
 assert.equal(block.hash.toLowerCase(),cursor.hash.toLowerCase(),
  'paper_replay_head_not_canonical');
 const source={block:cursor.block,hash:cursor.hash,timestamp:Number(block.timestamp)};
 const frame=input.readFrame?await input.readFrame(source):
  await readCanonicalPaperOpenFrame(client,profile,source);
 assert.equal(frame.source.block,source.block,'paper_replay_frame_block_changed');
 assert.equal(frame.source.hash.toLowerCase(),source.hash.toLowerCase(),
  'paper_replay_frame_hash_changed');
 assert.equal(frame.source.timestamp,source.timestamp,'paper_replay_frame_timestamp_changed');
 const now=input.now??Date.now(),age=now-source.timestamp*1000;
 assert(age>=0&&age<=180_000,'paper_replay_head_stale');
 assert(frame.referenceEligible,'paper_replay_head_reference_unavailable');
 const previousAfter=await client.getBlock({blockNumber:BigInt(previous.sourceBlock)});
 assert.equal(previousAfter.hash.toLowerCase(),previous.sourceHash.toLowerCase(),
  'paper_replay_previous_mark_reorged');
 return frame;
}

/** Waits on the cheap replay cursor only. It performs no full-frame RPC work
 * until indexed coverage advances beyond the frozen mark, then delegates once
 * to the exact canonical frame reader above. */
export async function waitCanonicalPaperReplayHeadFrame(input:{client:RobinhoodClient;indexer:Pool;
 profile:MarketProfile;stream:string;targetSetHash:string;
 previous:{sourceBlock:string;sourceHash:string};maxWaitMs?:number;pollMs?:number;
 assertPreparationLeaseHealthy?:()=>Promise<void>;
 readFrame?:(source:PaperOpenFrame['source'])=>Promise<PaperOpenFrame>}):Promise<PaperOpenFrame>{
 const maxWaitMs=input.maxWaitMs??60_000,pollMs=input.pollMs??1_000;
 if(!Number.isSafeInteger(maxWaitMs)||maxWaitMs<1_000||maxWaitMs>120_000||
  !Number.isSafeInteger(pollMs)||pollMs<100||pollMs>5_000)
  throw Error('paper_replay_head_wait_budget_invalid');
 const p=input.profile.pool,deadline=Date.now()+maxWaitMs;
 while(Date.now()<deadline){
  await input.assertPreparationLeaseHealthy?.();
  const row=(await input.indexer.query<{targetSetHash:string;block:string|null;hash:string|null;
   lastBlock:string|null}>(`
   SELECT c.target_set_hash AS "targetSetHash",c.complete_through_block::text AS block,
    c.complete_through_hash AS hash,c.last_block_number::text AS "lastBlock"
   FROM v3_replay_cursors c JOIN v3_replay_pools p USING(stream_key)
   WHERE c.stream_key=$1 AND p.chain_id=$2 AND lower(p.pool_address)=lower($3)
    AND p.fee=$4 AND p.initialized=true`,[input.stream,p.chainId,p.pool,p.fee])).rows;
  if(row.length!==1)throw Error('paper_replay_head_unavailable');
  const cursor=row[0]!;
  if(cursor.targetSetHash.toLowerCase()!==input.targetSetHash.toLowerCase())
   throw Error('paper_replay_head_target_set_changed');
  const coverageIncomplete=cursor.block!==null&&cursor.lastBlock!==null&&
   BigInt(cursor.lastBlock)>BigInt(cursor.block);
  if(Date.now()>=deadline)throw Error('paper_replay_head_wait_timeout');
  if(!coverageIncomplete&&cursor.block!==null&&cursor.hash!==null&&
   BigInt(cursor.block)>BigInt(input.previous.sourceBlock)){
   await input.assertPreparationLeaseHealthy?.();
   if(Date.now()>=deadline)throw Error('paper_replay_head_wait_timeout');
   return readCanonicalPaperReplayHeadFrame({client:input.client,indexer:input.indexer,
    profile:input.profile,stream:input.stream,targetSetHash:input.targetSetHash,previous:input.previous,
    readFrame:input.readFrame});
  }
  await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,Math.max(1,deadline-Date.now()))));
 }
 throw Error('paper_replay_head_wait_timeout');
}
