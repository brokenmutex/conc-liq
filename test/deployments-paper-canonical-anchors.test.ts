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
