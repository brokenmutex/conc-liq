import assert from 'node:assert/strict';
import test from 'node:test';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../src/client.js';
import type {MarketProfile} from '../src/deployments/market-profile.js';
import type {PaperOpenFrame} from '../src/deployments/paper-preview.js';
import {readCanonicalPaperReplayHeadFrame,waitCanonicalPaperReplayHeadFrame} from
 '../src/deployments/paper-replay-head-frame.js';

const previous={sourceBlock:'100',sourceHash:`0x${'a'.repeat(64)}`},
 cursor={block:'120',hash:`0x${'b'.repeat(64)}`},
 timestamp=1_800_000_000;
function setup(input:{timestamp?:number;referenceEligible?:boolean;cursorBlock?:string}={}){
 const calls:string[]=[];
 const dbClient={query:async(sql:string)=>{
  calls.push(sql.trim().split(/\s+/).slice(0,2).join(' '));
  if(sql.includes('SELECT c.complete_through_block'))return {rows:[{block:input.cursorBlock??cursor.block,
   hash:cursor.hash}]};
  return {rows:[]};
 },release:()=>calls.push('release')};
 const indexer={connect:async()=>dbClient} as unknown as Pool;
 const block=(number:bigint)=>({hash:number===100n?previous.sourceHash:cursor.hash,
  timestamp:number===100n?timestamp-60:Number(input.timestamp??timestamp)});
 const client={getBlock:async({blockNumber}:{blockNumber:bigint})=>block(blockNumber)} as unknown as RobinhoodClient;
 const profile={pool:{chainId:4663,pool:'0x0000000000000000000000000000000000000001'}} as unknown as MarketProfile;
 const readFrame=async(source:{block:string;hash:string;timestamp:number})=>({source,tick:1,
  sqrtPriceX96:1n,poolLiquidity:1n,price0:1n,price1:1n,nativePrice:1n,
  referenceEligible:input.referenceEligible??true,referenceReasons:[],referenceProofHash:'proof'});
 return {indexer,client,profile,readFrame,calls};
}

test('pins a fresh canonical, reference-eligible replay cursor after latest mark',async()=>{
 const ctx=setup(),frame=await readCanonicalPaperReplayHeadFrame({client:ctx.client,
  indexer:ctx.indexer,profile:ctx.profile,stream:'stream',targetSetHash:'target',previous,
  now:timestamp*1000+5000,readFrame:ctx.readFrame});
 assert.equal(frame.source.block,cursor.block);
 assert.equal(frame.source.hash,cursor.hash);
 assert.equal(frame.referenceEligible,true);
 assert(ctx.calls.includes('BEGIN ISOLATION'));
 assert(!ctx.calls.includes('ROLLBACK'));
 assert(ctx.calls.includes('COMMIT'));
 assert(ctx.calls.includes('release'));
});

test('rejects replay cursor at or before latest saved mark',async()=>{
 const ctx=setup({cursorBlock:'100'});
 await assert.rejects(readCanonicalPaperReplayHeadFrame({client:ctx.client,indexer:ctx.indexer,
  profile:ctx.profile,stream:'stream',targetSetHash:'target',previous,now:timestamp*1000,
  readFrame:ctx.readFrame}),/paper_replay_head_not_later_than_previous_mark/);
});

test('rejects stale or reference-ineligible pinned replay frame',async()=>{
 const stale=setup();
 await assert.rejects(readCanonicalPaperReplayHeadFrame({client:stale.client,indexer:stale.indexer,
  profile:stale.profile,stream:'stream',targetSetHash:'target',previous,
  now:(timestamp+181)*1000,readFrame:stale.readFrame}),/paper_replay_head_stale/);
 const ineligible=setup({referenceEligible:false});
 await assert.rejects(readCanonicalPaperReplayHeadFrame({client:ineligible.client,
  indexer:ineligible.indexer,profile:ineligible.profile,stream:'stream',targetSetHash:'target',
  previous,now:timestamp*1000,readFrame:ineligible.readFrame}),
 /paper_replay_head_reference_unavailable/);
});

test('preparation polls only the scoped cursor until coverage advances',async()=>{
 const rows=[{block:'99',hash:cursor.hash,targetSetHash:'target',lastBlock:'99'},
  {block:'120',hash:cursor.hash,targetSetHash:'target',lastBlock:'125'},
  {block:'120',hash:cursor.hash,targetSetHash:'target',lastBlock:'120'}];
 let fullReads=0,healthChecks=0;
 const freshTimestamp=Math.floor(Date.now()/1000),source={block:cursor.block,hash:cursor.hash,
  timestamp:freshTimestamp};
 const frame:PaperOpenFrame={source,tick:1,sqrtPriceX96:1n,poolLiquidity:1n,price0:1n,
  price1:1n,nativePrice:1n,referenceEligible:true,referenceReasons:[],referenceProofHash:'proof'};
 const ctx=setup();
 const pollingPool={...ctx.indexer,async query(){return {rows:[rows.shift()!]};}} as unknown as Pool;
 const freshClient={getBlock:async({blockNumber}:{blockNumber:bigint})=>({hash:
  blockNumber===100n?previous.sourceHash:cursor.hash,
  timestamp:freshTimestamp,number:blockNumber})} as unknown as RobinhoodClient;
 const result=await waitCanonicalPaperReplayHeadFrame({client:freshClient,indexer:pollingPool,
  profile:ctx.profile,stream:'stream',targetSetHash:'target',previous,
  maxWaitMs:2_000,pollMs:100,assertPreparationLeaseHealthy:async()=>{healthChecks++;},
  readFrame:async(pinned)=>{fullReads++;assert.deepEqual(pinned,source);return frame;}});
 assert.equal(result,frame);assert.equal(fullReads,1);assert.equal(healthChecks,4);
});

test('preparation fails closed on target-set changes before frame reads',async()=>{
 let fullReads=0;const ctx=setup();
 const indexer={...ctx.indexer,async query(){return {rows:[{block:'120',hash:cursor.hash,
  targetSetHash:'other-target',lastBlock:'120'}]};}} as unknown as Pool;
 await assert.rejects(waitCanonicalPaperReplayHeadFrame({client:ctx.client,indexer,
  profile:ctx.profile,stream:'stream',targetSetHash:'target',previous,maxWaitMs:1_000,
  readFrame:async()=>{fullReads++;return ctx.readFrame({block:cursor.block,hash:cursor.hash,timestamp});}}),
 /paper_replay_head_target_set_changed/);
 assert.equal(fullReads,0);
});
