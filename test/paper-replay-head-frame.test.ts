import assert from 'node:assert/strict';
import test from 'node:test';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../src/client.js';
import type {MarketProfile} from '../src/deployments/market-profile.js';
import {readCanonicalPaperReplayHeadFrame} from '../src/deployments/paper-replay-head-frame.js';

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
