// Read-only source-indexer precondition diagnostic for the static V3 terminal
// gate. This script never creates a schema, changes index data, or reads a
// signer. Database transactions are explicitly read-only.
import assert from 'node:assert/strict';
import {parseEnv} from 'node:util';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {createRobinhoodClient} from '../../src/client.ts';
import {UNISWAP_V3_FACTORY,NONFUNGIBLE_POSITION_MANAGER,USDG} from '../../src/constants.ts';
import {PAPER_QUOTER,PAPER_ROUTER} from '../../src/paper/execution-abi.ts';
import {marketProfileSchema} from '../../src/deployments/market-profile.ts';
import {readCanonicalPaperOpenFrame} from '../../src/deployments/paper-preview.ts';
import {readCanonicalPaperReplayHeadFrame} from '../../src/deployments/paper-replay-head-frame.ts';
import {parseRangeKeeperConfig} from '../../src/strategy/rangekeeper/config.ts';

const safeError=error=>{
 const message=error instanceof Error?error.message:'V3 source preflight failed';
 process.stderr.write(`${message.replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,400)}\n`);
 process.exitCode=1;
};

async function main(){try{
 assert(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required');
 const dotenv=parseEnv(readFileSync('.env','utf8')),
  archive=dotenv.ROBINHOOD_READ_HTTP_URL??dotenv.RH_ARCHIVE_RPC_URL,
  stream=dotenv.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1';
 assert(archive,'Canonical read RPC unavailable');
  const raw=parseRangeKeeperConfig(JSON.parse(readFileSync(
  'config/rangekeeper-v1-aapl-disabled.json','utf8'))),
  profile=marketProfileSchema.parse({pool:{...raw.pool,factory:UNISWAP_V3_FACTORY,
   positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER},
   referencePolicy:raw.referencePolicy}),
  rpc=createRobinhoodClient(archive,20_000,{retryCount:0}),
  db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:1,
   options:'-c default_transaction_read_only=on -c search_path=public'}),client=await db.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
  const row=(await client.query(`SELECT p.pool_address,p.chain_id::text,p.fee,
   p.target_set_hash AS pool_target,i.target_set_hash AS indexer_target,
   i.last_scanned_block::text AS indexer_last_scanned,
   (to_jsonb(i)->>'covered_through_block') AS indexer_covered,
   r.chain_id::text AS replay_chain,r.target_set_hash AS replay_target,
   r.complete_through_block::text,r.complete_through_hash,
   rp.initialized,rp.tick,rp.sqrt_price_x96::text,rp.liquidity::text,
   (SELECT count(*)::int FROM v3_replay_ticks t WHERE t.stream_key=p.stream_key
    AND lower(t.pool_address)=lower(p.pool_address)) AS tick_count,
   (SELECT count(*)::int FROM v3_pool_events e WHERE e.stream_key=p.stream_key
    AND lower(e.pool_address)=lower(p.pool_address)
    AND e.block_number>(r.complete_through_block-256)) AS recent_event_count,
   checkpoint.block_number::text AS nearest_checkpoint_block,checkpoint.block_hash AS nearest_checkpoint_hash,
   (SELECT max(block_number)::text FROM indexer_checkpoints c WHERE c.stream_key=p.stream_key)
    AS max_indexer_checkpoint,
   (SELECT max(block_number)::text FROM v3_pool_events e WHERE e.stream_key=p.stream_key
    AND lower(e.pool_address)=lower(p.pool_address)) AS max_pool_event_block
   FROM indexer_pools p JOIN indexer_cursors i USING(stream_key)
   JOIN v3_replay_cursors r USING(stream_key)
   JOIN v3_replay_pools rp ON rp.stream_key=p.stream_key AND lower(rp.pool_address)=lower(p.pool_address)
   LEFT JOIN LATERAL (SELECT block_number,block_hash FROM indexer_checkpoints c
    WHERE c.stream_key=p.stream_key AND c.block_number<=r.complete_through_block
    ORDER BY c.block_number DESC LIMIT 1) checkpoint ON TRUE
   WHERE p.stream_key=$1 AND lower(p.pool_address)=lower($2)`,
   [stream,profile.pool.pool])).rows[0];
  if(!row){
   await client.query('ROLLBACK');
   console.log(JSON.stringify({eligible:false,reason:'source_indexer_pool_or_replay_missing',stream,
    pool:profile.pool.pool}));return;
  }
  if(!row.complete_through_block||!row.complete_through_hash){
   await client.query('ROLLBACK');
   console.log(JSON.stringify({eligible:false,reason:'source_replay_coverage_unavailable',stream,
    pool:row.pool_address,targetSetHash:row.pool_target,indexerTargetSetHash:row.indexer_target,
    replayTargetSetHash:row.replay_target}));return;
  }
  const deploymentSchemaAvailable=Boolean((await client.query(
   `SELECT to_regclass('deployment_campaigns') IS NOT NULL AS available`)).rows[0]?.available),
   liveMarks=deploymentSchemaAvailable?(await client.query(`SELECT c.lifecycle,
    m.source_block::text AS source_block,m.source_hash,
    m.provenance->>'classification' AS classification
    FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN LATERAL (SELECT source_block,source_hash,provenance FROM deployment_marks
     WHERE campaign_id=c.id ORDER BY id DESC LIMIT 1) m ON TRUE
    WHERE c.mode='paper' AND c.chain_id=$1 AND c.lifecycle IN ('active','paused')
     AND r.strategy_id='static_manual_v1'
     AND lower(p.profile->'pool'->>'pool')=lower($2)`,
    [profile.pool.chainId,row.pool_address])).rows:[],
   markCursorGaps=liveMarks.map(mark=>({lifecycle:mark.lifecycle,
    classification:mark.classification,latestMarkBlock:mark.source_block,
    latestMarkHash:mark.source_hash,
    replayHeadAfterLatestMark:mark.source_block!==null&&
     BigInt(row.complete_through_block)>BigInt(mark.source_block),
    replayHeadSameOrAfterLatestMark:mark.source_block!==null&&
     BigInt(row.complete_through_block)>=BigInt(mark.source_block)}));
  const frame=await readCanonicalPaperOpenFrame(rpc,profile),block=await rpc.getBlock({
   blockNumber:BigInt(row.complete_through_block)}),
   consistent=Number(row.chain_id)===profile.pool.chainId&&Number(row.replay_chain)===profile.pool.chainId&&
    Number(row.fee)===profile.pool.fee&&row.pool_target===row.indexer_target&&
    row.pool_target===row.replay_target&&row.initialized===true&&
    block.hash.toLowerCase()===row.complete_through_hash?.toLowerCase(),
   frameCovered=BigInt(row.complete_through_block)>=BigInt(frame.source.block),
   frameAgeMs=Date.now()-frame.source.timestamp*1000,
   replayAgeMs=Date.now()-Number(block.timestamp)*1000,
   checkpointMatchesReplay=Boolean(row.nearest_checkpoint_block===row.complete_through_block&&
    row.nearest_checkpoint_hash?.toLowerCase()===row.complete_through_hash.toLowerCase()),
   genesis=await rpc.getBlock({blockNumber:0n}),
   pinnedFrame=await readCanonicalPaperReplayHeadFrame({client:rpc,indexer:db,profile,stream,
    targetSetHash:row.pool_target,previous:{sourceBlock:'0',sourceHash:genesis.hash}}),
   pinnedFrameAgeMs=Date.now()-pinnedFrame.source.timestamp*1000,
   report={currentHeadEligible:Boolean(consistent&&frameCovered&&frameAgeMs>=0&&frameAgeMs<=180_000),
    pinnedReplayFrameEligible:Boolean(consistent&&pinnedFrame.referenceEligible&&pinnedFrameAgeMs>=0&&
     pinnedFrameAgeMs<=180_000),
    stream,pool:row.pool_address,targetSetHash:row.pool_target,
    indexerLastScanned:row.indexer_last_scanned,indexerCoveredThrough:row.indexer_covered,
    replayCompleteThrough:row.complete_through_block,replayCompleteHash:row.complete_through_hash,
    replayCompleteTimestamp:Number(block.timestamp),replayFrameAgeMs:replayAgeMs,
    replayTickCount:row.tick_count,recentPoolEventCount:row.recent_event_count,
    currentCanonicalBlock:frame.source.block,currentCanonicalHash:frame.source.hash,
    currentFrameAgeMs:frameAgeMs,currentFrameCoveredByReplay:frameCovered,
    pinnedReplayFrameBlock:pinnedFrame.source.block,pinnedReplayFrameHash:pinnedFrame.source.hash,
    pinnedReplayFrameAgeMs:pinnedFrameAgeMs,
    pinnedReplayFrameReferenceEligible:pinnedFrame.referenceEligible,
    replayCheckpointBlock:row.nearest_checkpoint_block,
    replayCheckpointHash:row.nearest_checkpoint_hash,
    maxIndexerCheckpoint:row.max_indexer_checkpoint,
    maxPoolEventBlock:row.max_pool_event_block,
    sparseIndexerCheckpointAtOrBeforeReplay:row.nearest_checkpoint_block?{
     block:row.nearest_checkpoint_block,hash:row.nearest_checkpoint_hash,
     equalsReplayCursor:checkpointMatchesReplay}:null,
    replayCompleteMatchesCanonical:Boolean(consistent)};
  report.activeStaticCampaignMarkCoverage=deploymentSchemaAvailable?markCursorGaps:
   {available:false,reason:'deployment_tables_absent_from_source_schema'};
  await client.query('ROLLBACK');
  console.log(JSON.stringify(report,null,2));
 }finally{client.release();await db.end();}
}catch(error){safeError(error);}}
await main();
