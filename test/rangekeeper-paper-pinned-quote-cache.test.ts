import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe,it} from 'node:test';
import {parseRangeKeeperConfig} from '../src/strategy/rangekeeper/config.js';
import {marketProfileSchema} from '../src/deployments/market-profile.js';
import {RangeKeeperPaperPinnedQuoteCache} from
 '../src/deployments/rangekeeper-paper-pinned-quote-cache.js';
import type {RobinhoodClient} from '../src/client.js';

const config=parseRangeKeeperConfig(JSON.parse(readFileSync('config/rangekeeper-v1-aapl-disabled.json','utf8')));
const profile=marketProfileSchema.parse({pool:config.pool,referencePolicy:config.referencePolicy});
const hash=(n:string)=>`0x${n.repeat(64)}` as `0x${string}`;
const source={block:123n,hash:hash('1'),timestamp:1_800_000_000};
function fakeClient(){
 let blockHash=source.hash,blockTimestamp=source.timestamp,simulations=0,anchors=0;
 const client={
  getBlock:async({blockNumber}:{blockNumber:bigint})=>{assert.equal(blockNumber,source.block);anchors++;
   return {hash:blockHash,timestamp:BigInt(blockTimestamp)};},
  simulateContract:async(input:unknown)=>{simulations++;return {result:[1_000n,1n<<96n]};},
 } as unknown as RobinhoodClient;
 return {client,simulations:()=>simulations,anchors:()=>anchors,
  setBlock:(hashValue:string,timestamp:number)=>{blockHash=hashValue as `0x${string}`;blockTimestamp=timestamp;}};
}

describe('RangeKeeper paper pinned quote cache',()=>{
 it('memoizes only identical pinned quotes and checks the canonical header on every hit',async()=>{
  const fake=fakeClient(),cache=new RangeKeeperPaperPinnedQuoteCache(fake.client,profile);
  const first=await cache.quote(source,0,10n,1_000n,2_000n);
  first.amountOut=0n;
  const second=await cache.quote(source,0,10n,1_000n,2_000n);
  assert.equal(second.amountOut,1_000n);assert.equal(fake.simulations(),1);assert.equal(fake.anchors(),2);
  assert.deepEqual(cache.metrics(),{calls:2,cacheHits:1,uniqueQuotes:1,uncachedAnchors:1});
 });
 it('rejects use after the trusted profile object is mutated',async()=>{
  const fake=fakeClient(),cache=new RangeKeeperPaperPinnedQuoteCache(fake.client,profile);
  (profile.pool as {fee:number}).fee++;
  try{await assert.rejects(cache.quote(source,0,10n,1_000n,2_000n),/profile changed/);}
  finally{(profile.pool as {fee:number}).fee--;}
 });
 it('rejects a cached result after a pinned source hash or timestamp changes',async()=>{
  const fake=fakeClient(),cache=new RangeKeeperPaperPinnedQuoteCache(fake.client,profile);
  await cache.quote(source,0,10n,1_000n,2_000n);
  fake.setBlock(hash('2'),source.timestamp);
  await assert.rejects(cache.quote(source,0,10n,1_000n,2_000n),/cached quote source changed/);
  fake.setBlock(source.hash,source.timestamp+1);
  await assert.rejects(cache.quote(source,0,10n,1_000n,2_000n),/cached quote source changed/);
  assert.equal(fake.simulations(),1);
 });
 it('coalesces simultaneous cache-hit anchors for one source and rejects the whole batch on reorg',async()=>{
  const fake=fakeClient(),cache=new RangeKeeperPaperPinnedQuoteCache(fake.client,profile);
  await cache.quote(source,0,10n,1_000n,2_000n);
  const before=fake.anchors();
  const batch=await Promise.all(Array.from({length:9},()=>cache.quote(source,0,10n,1_000n,2_000n)));
  assert(batch.every(quote=>quote.amountOut===1_000n));
  assert.equal(fake.anchors()-before,1,'Concurrent exact-source quote hits made redundant anchor reads');
  assert.equal(cache.metrics().uncachedAnchors,1);
  fake.setBlock(hash('2'),source.timestamp);
  await assert.rejects(Promise.all(Array.from({length:9},()=>cache.quote(source,0,10n,1_000n,2_000n))),
   /cached quote source changed/);
 });
 it('keeps token, size, price, and source identity in the cache key',async()=>{
  const fake=fakeClient(),cache=new RangeKeeperPaperPinnedQuoteCache(fake.client,profile);
  await cache.quote(source,0,10n,1_000n,2_000n);
  await cache.quote(source,1,10n,1_000n,2_000n);
  await cache.quote(source,0,11n,1_000n,2_000n);
  await cache.quote(source,0,10n,1_001n,2_000n);
  const later={...source,hash:hash('2'),timestamp:source.timestamp+1};
  fake.setBlock(later.hash,later.timestamp);
  await cache.quote(later,0,10n,1_000n,2_000n);
  assert.equal(fake.simulations(),5);assert.equal(cache.metrics().uniqueQuotes,5);
 });
 it('enforces a finite entry bound',async()=>{
  const fake=fakeClient(),cache=new RangeKeeperPaperPinnedQuoteCache(fake.client,profile,1);
  await cache.quote(source,0,10n,1_000n,2_000n);
  await cache.quote(source,0,11n,1_000n,2_000n);
  await cache.quote(source,0,10n,1_000n,2_000n);
  assert.equal(fake.simulations(),2);assert.equal(cache.metrics().uniqueQuotes,1);
 });
});
