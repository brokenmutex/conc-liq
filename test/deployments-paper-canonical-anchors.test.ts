import test from 'node:test';
import assert from 'node:assert/strict';
import type {RobinhoodClient} from '../src/client.js';
import {verifyCanonicalPaperAnchors} from '../src/deployments/paper-canonical-anchors.js';

const anchor={block:'100',hash:`0x${'a'.repeat(64)}`,timestamp:1_700_000_000};
const otherHash=`0x${'b'.repeat(64)}`;

test('paper anchor verifier reads each canonical source twice',async()=>{
 let reads=0,chainReads=0;
 const client={getChainId:async()=>{chainReads++;return 4663;},
  getBlock:async()=>{reads++;return {hash:anchor.hash,timestamp:BigInt(anchor.timestamp)};}} as unknown as RobinhoodClient;
 await verifyCanonicalPaperAnchors(client,4663,[anchor,anchor]);
 assert.equal(reads,2);
 assert.equal(chainReads,2);
});

test('paper anchor verifier rejects a reorg on its second read',async()=>{
 let reads=0;
 const client={getChainId:async()=>4663,getBlock:async()=>{
  reads++;return {hash:reads===1?anchor.hash:otherHash,timestamp:BigInt(anchor.timestamp)};
 }} as unknown as RobinhoodClient;
 await assert.rejects(verifyCanonicalPaperAnchors(client,4663,[anchor]),
  /Paper anchor changed during verification/);
 assert.equal(reads,2);
});

test('paper anchor verifier rejects conflicting saved identities for one block',async()=>{
 const client={getChainId:async()=>4663,getBlock:async()=>{
  throw Error('No block read expected');
 }} as unknown as RobinhoodClient;
 await assert.rejects(verifyCanonicalPaperAnchors(client,4663,
  [anchor,{...anchor,hash:otherHash}]),/Paper same-block anchors conflict/);
});

test('paper anchor passes keep a complete barrier and bounded reads before checking for reorg',async()=>{
 const anchors=Array.from({length:5},(_,index)=>({...anchor,block:String(100+index)}));
 const pending:Array<{block:string;resolve:(value:{hash:string;timestamp:bigint})=>void}>=[];
 let reads=0;
 const client={getChainId:async()=>4663,getBlock:({blockNumber}:{blockNumber:bigint})=>{
  reads++;
  return new Promise<{hash:string;timestamp:bigint}>(resolve=>pending.push({block:String(blockNumber),resolve}));
 }} as unknown as RobinhoodClient;
 const verification=verifyCanonicalPaperAnchors(client,4663,anchors);
 const rejected=assert.rejects(verification,/Paper anchor changed during verification/);
 const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
 const valid={hash:anchor.hash,timestamp:BigInt(anchor.timestamp)};
 await tick();assert.equal(reads,4,'at most four upstream anchor reads may be outstanding');
 pending.splice(0,3).forEach(read=>read.resolve(valid));
 await tick();assert.equal(reads,4,'a pending first-pass batch must not start the next batch');
 pending.shift()!.resolve(valid);
 await tick();assert.equal(reads,5);assert.equal(pending[0]!.block,'104');
 pending.shift()!.resolve(valid);
 await tick();assert.equal(reads,9,'second pass starts only after every first-pass anchor passed');
 pending.shift()!.resolve({...valid,hash:otherHash});
 pending.splice(0).forEach(read=>read.resolve(valid));
 await rejected;
});

test('failed anchor reads settle their outstanding batch before verification rejects',async()=>{
 const anchors=Array.from({length:3},(_,index)=>({...anchor,block:String(100+index)}));
 const pending:Array<{resolve:(value:{hash:string;timestamp:bigint})=>void;reject:(error:Error)=>void}>=[];
 let reads=0,settled=false;
 const client={getChainId:async()=>4663,getBlock:()=>{
  reads++;
  return new Promise<{hash:string;timestamp:bigint}>((resolve,reject)=>pending.push({resolve,reject}));
 }} as unknown as RobinhoodClient;
 const outcome=verifyCanonicalPaperAnchors(client,4663,anchors).then(
  ()=>{settled=true;return null;},error=>{settled=true;return error as Error;});
 const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
 await tick();assert.equal(reads,3);
 pending.shift()!.reject(new Error('source_unavailable'));
 await tick();assert.equal(settled,false,'verification cannot leave its sibling RPC reads running');
 pending.splice(0).forEach(read=>read.resolve({hash:anchor.hash,timestamp:BigInt(anchor.timestamp)}));
 assert.equal((await outcome)?.message,'source_unavailable');
 assert.equal(reads,3,'a failed first pass never begins second-pass reads');
});
