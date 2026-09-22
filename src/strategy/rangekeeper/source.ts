import assert from 'node:assert/strict';
import type {RobinhoodClient} from '../../client.js';

/** Read-only confirmed source shared by paper and live preflight. */
export async function rangeKeeperConfirmedSource(client:RobinhoodClient,depth=64){
 const latest=await client.getBlock();assert(latest.number>BigInt(depth));
 const block=await client.getBlock({blockNumber:latest.number-BigInt(depth)});
 const age=Math.floor(Date.now()/1000)-Number(block.timestamp);
 assert(age>=0&&age<=180,'Confirmed source is stale or ahead of local clock');
 return {block:block.number,hash:block.hash,timestamp:Number(block.timestamp)};
}
