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

test('stale complete cursor is checked once and waits for a fresh cursor before frame reads',async()=>{
 const nowSeconds=Math.floor(Date.now()/1000),fresh={block:'121',hash:`0x${'c'.repeat(64)}`},
  staleTimestamp=nowSeconds-60;
 const rows=[{block:'120',hash:cursor.hash,targetSetHash:'target',lastBlock:'120'},
  {block:'120',hash:cursor.hash,targetSetHash:'target',lastBlock:'120'},
  {block:fresh.block,hash:fresh.hash,targetSetHash:'target',lastBlock:fresh.block}];
 let pinned={block:'120',hash:cursor.hash},fullReads=0;
 const dbClient={query:async(sql:string)=>sql.includes('SELECT c.complete_through_block')?
  {rows:[pinned]}:{rows:[]},release:()=>{}};
 const indexer={connect:async()=>dbClient,async query(){
  const row=rows.shift()??{block:fresh.block,hash:fresh.hash,targetSetHash:'target',lastBlock:fresh.block};
  if(row.block!==null&&row.hash!==null)pinned={block:row.block,hash:row.hash};
  return {rows:[row]};
 }} as unknown as Pool;
 const headerReads=new Map<string,number>();
 const client={getBlock:async({blockNumber}:{blockNumber:bigint})=>{
  const key=blockNumber.toString();headerReads.set(key,(headerReads.get(key)??0)+1);
  return {hash:blockNumber===100n?previous.sourceHash:blockNumber===120n?cursor.hash:fresh.hash,
   timestamp:blockNumber===120n?staleTimestamp:nowSeconds};
 }} as unknown as RobinhoodClient;
 const profile={pool:{chainId:4663,pool:'0x0000000000000000000000000000000000000001',fee:3000}} as unknown as MarketProfile;
 const frame:PaperOpenFrame={source:{block:fresh.block,hash:fresh.hash,timestamp:nowSeconds},tick:1,
  sqrtPriceX96:1n,poolLiquidity:1n,price0:1n,price1:1n,nativePrice:1n,referenceEligible:true,
  referenceReasons:[],referenceProofHash:'proof'};
 const result=await waitCanonicalPaperReplayHeadFrame({client,indexer,profile,stream:'stream',
  targetSetHash:'target',previous,maxWaitMs:2_000,pollMs:100,maxSourceAgeMs:30_000,
  readFrame:async source=>{fullReads++;assert.deepEqual(source,frame.source);return frame;}});
 assert.equal(result,frame);assert.equal(fullReads,1);
 assert.equal(headerReads.get('120'),1,'same stale cursor header must not be reread');
 assert(headerReads.get('121')!>=2,'fresh cursor is checked before frame reads and pinned again');
});

test('freshness wait rejects a noncanonical cursor before full-frame reads',async()=>{
 const nowSeconds=Math.floor(Date.now()/1000),ctx=setup();let fullReads=0;
 const indexer={...ctx.indexer,async query(){return {rows:[{block:'120',hash:cursor.hash,
  targetSetHash:'target',lastBlock:'120'}]};}} as unknown as Pool;
 const client={getBlock:async({blockNumber}:{blockNumber:bigint})=>({hash:
  blockNumber===100n?previous.sourceHash:`0x${'c'.repeat(64)}`,timestamp:nowSeconds})} as unknown as RobinhoodClient;
 await assert.rejects(waitCanonicalPaperReplayHeadFrame({client,indexer,profile:ctx.profile,
  stream:'stream',targetSetHash:'target',previous,maxWaitMs:1_000,maxSourceAgeMs:30_000,
  readFrame:async()=>{fullReads++;return ctx.readFrame({block:cursor.block,hash:cursor.hash,
   timestamp:nowSeconds});}}),/paper_replay_head_not_canonical/);
 assert.equal(fullReads,0);
});

test('freshness wait keeps its bounded timeout without repeating a stale header read',async()=>{
 const nowSeconds=Math.floor(Date.now()/1000),ctx=setup();let candidateReads=0,fullReads=0;
 const indexer={...ctx.indexer,async query(){return {rows:[{block:'120',hash:cursor.hash,
  targetSetHash:'target',lastBlock:'120'}]};}} as unknown as Pool;
 const client={getBlock:async({blockNumber}:{blockNumber:bigint})=>{
  if(blockNumber===120n)candidateReads++;
  return {hash:blockNumber===100n?previous.sourceHash:cursor.hash,
   timestamp:blockNumber===120n?nowSeconds-60:nowSeconds};
 }} as unknown as RobinhoodClient;
 await assert.rejects(waitCanonicalPaperReplayHeadFrame({client,indexer,profile:ctx.profile,
  stream:'stream',targetSetHash:'target',previous,maxWaitMs:1_000,pollMs:100,
  maxSourceAgeMs:30_000,readFrame:async()=>{fullReads++;return ctx.readFrame({block:cursor.block,
   hash:cursor.hash,timestamp:nowSeconds});}}),/paper_replay_head_wait_timeout/);
 assert.equal(candidateReads,1);assert.equal(fullReads,0);
});

test('frame that ages out during full reads waits for a new cursor',async()=>{
 const ctx=setup(),fresh={block:'121',hash:`0x${'c'.repeat(64)}`};
 const rows=[{block:'120',hash:cursor.hash,targetSetHash:'target',lastBlock:'120'},
  {block:fresh.block,hash:fresh.hash,targetSetHash:'target',lastBlock:fresh.block}];
 let pinned={block:'120',hash:cursor.hash};
 const dbClient={query:async(sql:string)=>sql.includes('SELECT c.complete_through_block')?
  {rows:[pinned]}:{rows:[]},release:()=>{}};
 const indexer={connect:async()=>dbClient,async query(){
  const row=rows.shift()??{block:fresh.block,hash:fresh.hash,targetSetHash:'target',lastBlock:fresh.block};
  pinned={block:row.block!,hash:row.hash!};return {rows:[row]};
 }} as unknown as Pool;
 const client={getBlock:async({blockNumber}:{blockNumber:bigint})=>({hash:
  blockNumber===100n?previous.sourceHash:blockNumber===120n?cursor.hash:fresh.hash,
  timestamp:blockNumber===120n?Math.floor(Date.now()/1000)-1:Math.floor(Date.now()/1000)})} as unknown as RobinhoodClient;
 const profile=ctx.profile,readBlocks:string[]=[];
 const frameFor=(source:PaperOpenFrame['source']):PaperOpenFrame=>({source,tick:1,sqrtPriceX96:1n,
  poolLiquidity:1n,price0:1n,price1:1n,nativePrice:1n,referenceEligible:true,
  referenceReasons:[],referenceProofHash:'proof'});
 const result=await waitCanonicalPaperReplayHeadFrame({client,indexer,profile,stream:'stream',
  targetSetHash:'target',previous,maxWaitMs:5_000,pollMs:100,maxSourceAgeMs:2_000,
  readFrame:async source=>{
   readBlocks.push(source.block);
   if(source.block==='120')await new Promise(resolve=>setTimeout(resolve,2_100));
   return frameFor(source);
  }});
 assert.equal(result.source.block,fresh.block);
 assert.deepEqual(readBlocks,['120',fresh.block]);
});
