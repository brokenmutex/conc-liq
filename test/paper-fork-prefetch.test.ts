import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchFreshForkReadPrefetch,forkReadHintKey,type ForkReadHint,type ForkSource}
 from '../src/paper/fork.js';

const oldTag='0x100',address='0x1111111111111111111111111111111111111111',slot='0x'+'ab'.repeat(32);
const hint:ForkReadHint={method:'eth_getStorageAt',params:[address,slot,oldTag]};
const source=(number:bigint,hashChar:string):ForkSource=>({number,hash:`0x${hashChar.repeat(64)}` as `0x${string}`,
 timestamp:1_800_000_000n});

test('owned fork prefetch fetches fresh values at each new source and brackets them with anchors',async()=>{
 const reads:Array<readonly [string,unknown[]]>=[];let anchors=0;
 const first=await fetchFreshForkReadPrefetch({source:source(256n,'a'),hints:[hint],
  read:async(method,params)=>{reads.push([method,params]);return '0x'+'01'.repeat(32);},
  verifyAnchor:async()=>{anchors++;}});
 assert.equal(first.fetched,1);assert.equal(first.values.get(forkReadHintKey(hint.method,
  [address,slot,'0x100'])),'0x'+'01'.repeat(32));
 const second=await fetchFreshForkReadPrefetch({source:source(257n,'b'),hints:[hint],
  read:async(method,params)=>{reads.push([method,params]);return '0x'+'02'.repeat(32);},
  verifyAnchor:async()=>{anchors++;}});
 assert.equal(second.values.get(forkReadHintKey(hint.method,[address,slot,'0x101'])),'0x'+'02'.repeat(32));
 assert.equal(anchors,4);assert.equal(reads.length,2);
 assert.deepEqual(reads.map(([,params])=>params[2]),['0x100','0x101']);
});

test('malformed or unapproved hints are rejected before anchors or upstream reads',async()=>{
 let calls=0;
 await assert.rejects(fetchFreshForkReadPrefetch({source:source(2n,'c'),hints:[
  {method:'eth_call',params:[] } as unknown as ForkReadHint],
  read:async()=>{calls++;return '0x';},verifyAnchor:async()=>{calls++;}}),/Unsupported owned-fork read hint/);
 await assert.rejects(fetchFreshForkReadPrefetch({source:source(2n,'c'),hints:[
  {method:'eth_getStorageAt',params:[address,'0x01',oldTag]} as unknown as ForkReadHint],
  read:async()=>{calls++;return '0x';},verifyAnchor:async()=>{calls++;}}),/Malformed owned-fork storage hint/);
 assert.equal(calls,0);
});

test('prefetch anchor reorg fails closed and budget exhaustion does not become a cache miss',async()=>{
 let anchors=0,reads=0;
 await assert.rejects(fetchFreshForkReadPrefetch({source:source(9n,'d'),hints:[hint],
  read:async()=>{reads++;return '0x'+'00'.repeat(32);},
  verifyAnchor:async()=>{anchors++;if(anchors===2)throw new Error('anchor changed');}}),/anchor changed/);
 assert.equal(reads,1);
 await assert.rejects(fetchFreshForkReadPrefetch({source:source(9n,'d'),hints:[hint],
  read:async()=>{throw new Error('request limit');},verifyAnchor:async()=>{},canContinue:()=>false}),
  /exhausted its read\/time budget/);
});

test('missing or malformed fresh values remain uncached for normal upstream fallback',async()=>{
 let anchors=0;
 const result=await fetchFreshForkReadPrefetch({source:source(10n,'e'),hints:[hint],
  read:async()=> '0x01',verifyAnchor:async()=>{anchors++;}});
 assert.equal(result.fetched,0);assert.equal(result.skipped,1);assert.equal(result.values.size,0);
 assert.equal(anchors,2);
});

test('prefetch count and concurrent upstream work stay bounded and caller mutation cannot alter a plan',async()=>{
 const hints:ForkReadHint[]=Array.from({length:12},(_,index)=>({method:'eth_getCode',
  params:[`0x${index.toString(16).padStart(40,'0')}`,oldTag]}));
 let active=0,maxActive=0;const seenTags:string[]=[];
 const run=fetchFreshForkReadPrefetch({source:source(257n,'f'),hints,
  read:async(_method,params)=>{active++;maxActive=Math.max(maxActive,active);seenTags.push(String(params[1]));
   await new Promise(resolve=>setTimeout(resolve,3));active--;return '0x6000';},verifyAnchor:async()=>{}});
 (hints[0]!.params as [string,string])[0]='0x9999999999999999999999999999999999999999';
 const result=await run;
 assert.equal(result.hintCount,12);assert.equal(result.fetched,12);assert(maxActive<=4);
 assert(seenTags.every(tag=>tag==='0x101'));
 assert.equal(result.values.has(forkReadHintKey('eth_getCode',
  ['0x0000000000000000000000000000000000000000','0x101'])),true);
 const tooMany=Array.from({length:257},()=>hint);
 await assert.rejects(fetchFreshForkReadPrefetch({source:source(2n,'c'),hints:tooMany,
  read:async()=> '0x',verifyAnchor:async()=>{}}),/Too many owned-fork read hints/);
});
