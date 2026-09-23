import assert from 'node:assert/strict';
import type {RobinhoodClient} from '../client.js';

export interface PaperCanonicalAnchor {
 block:string;hash:string;timestamp:number;
}

/** Verify every saved source against chain data twice. Call this within the
 * append transaction immediately before the write; a changed source aborts
 * the entire append. Historical anchors need no freshness assumption. */
export async function verifyCanonicalPaperAnchors(client:RobinhoodClient,
 chainId:number,sources:readonly PaperCanonicalAnchor[]){
 assert(sources.length>0&&sources.length<=100,'Paper anchor set invalid');
 assert.equal(await client.getChainId(),chainId,'Paper anchor chain changed');
 const unique=new Map<string,PaperCanonicalAnchor>();
 for(const source of sources){
  assert(/^(0|[1-9][0-9]*)$/.test(source.block)&&
   /^0x[0-9a-fA-F]{64}$/.test(source.hash)&&
   Number.isSafeInteger(source.timestamp)&&source.timestamp>=0,
   'Paper anchor malformed');
  const prior=unique.get(source.block);
  if(prior)assert(prior.hash.toLowerCase()===source.hash.toLowerCase()&&
   prior.timestamp===source.timestamp,'Paper same-block anchors conflict');
  else unique.set(source.block,source);
 }
 const read=async(source:PaperCanonicalAnchor)=>{
  const block=await client.getBlock({blockNumber:BigInt(source.block)});
  return {hash:block.hash.toLowerCase(),timestamp:Number(block.timestamp)};
 };
 const first=new Map<string,{hash:string;timestamp:number}>();
 for(const source of unique.values()){
  const actual=await read(source);
  assert(actual.hash===source.hash.toLowerCase()&&actual.timestamp===source.timestamp,
   'Paper canonical anchor changed');
  first.set(source.block,actual);
 }
 for(const source of unique.values()){
  const actual=await read(source);
  assert.deepEqual(actual,first.get(source.block),'Paper anchor changed during verification');
 }
 assert.equal(await client.getChainId(),chainId,'Paper anchor chain changed during verification');
}
