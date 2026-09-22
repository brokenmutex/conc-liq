import assert from 'node:assert/strict';
import {poolAbi} from '../abi.js';
import type {RobinhoodClient} from '../client.js';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {readRangeKeeperReferences} from '../strategy/rangekeeper/reference.js';
import {marketProfileSchema,referenceProofHash} from './market-profile.js';
import {buildIndicativePaperOpenPreview} from './paper-preview.js';
import {verifyPaperGasEvidence} from './paper-gas-evidence.js';

/** Replays the report's candidate from its canonical block and independent
 * references before an isolated database may ingest the fork gas sample. */
export async function verifyPaperGasSource(client:RobinhoodClient,raw:unknown){
 const report=verifyPaperGasEvidence(raw),profile=marketProfileSchema.parse(report.profile);
 const source=report.source as {block:string;hash:`0x${string}`;timestamp:number};
 const sampledAt=Date.parse(report.sampledAt as string),age=Date.now()-sampledAt;
 assert(Number.isFinite(sampledAt)&&age>=0&&age<=86_400_000,'Paper gas sample is stale or future');
 assert.equal(await client.getChainId(),ROBINHOOD_CHAIN_ID);
 const latest=await client.getBlock(),blockNumber=BigInt(source.block);
 assert(latest.number>=blockNumber+64n,'Paper gas source is not confirmed');
 const block=await client.getBlock({blockNumber});
 assert.equal(block.hash.toLowerCase(),source.hash.toLowerCase());
 assert.equal(Number(block.timestamp),source.timestamp);
 const chainSource={block:blockNumber,hash:block.hash,timestamp:source.timestamp};
 await new RangeKeeperChain(client,profile.pool).verify(chainSource);
 const [slot,liquidity,references]=await Promise.all([
  client.readContract({address:profile.pool.pool,abi:poolAbi,functionName:'slot0',blockNumber}),
  client.readContract({address:profile.pool.pool,abi:poolAbi,functionName:'liquidity',blockNumber}),
  readRangeKeeperReferences(client,chainSource,profile),
 ]);
 assert(references.eligible&&references.price0&&references.price1&&references.nativePrice,
  'Paper gas independent references unavailable');
 const proof=JSON.parse(JSON.stringify(references.proof,(_,value)=>
  typeof value==='bigint'?String(value):value)) as Record<string,unknown>;
 const recordedReference=report.reference as {price0:string;price1:string;nativePrice:string;proofHash:string};
 const frame={source,tick:slot[1],sqrtPriceX96:slot[0],poolLiquidity:liquidity,
  price0:references.price0,price1:references.price1,nativePrice:references.nativePrice,
  referenceEligible:references.eligible,referenceReasons:references.reasons,
  referenceProofHash:recordedReference.proofHash};
 const draft={id:report.campaignId as string,revision:report.revision as number,
  allocation:report.allocation as {token0Raw:string;token1Raw:string;nativeWei:string},
  profile,profileHash:report.profileHash as string,
  strategyId:'static_manual_v1' as const,parameters:report.parameters as Record<string,unknown>,
  configHash:report.configHash as string};
 const preview=buildIndicativePaperOpenPreview(draft,frame,sampledAt);
 assert.equal(preview.status,'indicative');
 assert.equal(preview.candidateHash,report.candidateHash,'Paper gas candidate source replay changed');
 const reference=recordedReference;
 assert.equal(reference.price0,String(references.price0));
 assert.equal(reference.price1,String(references.price1));
 assert.equal(reference.nativePrice,String(references.nativePrice));
 const recordedProof=report.referenceProof as Record<string,unknown>;
 for(const key of ['token0','token1','native'] as const)
  assert.equal(referenceProofHash(recordedProof[key]),referenceProofHash(proof[key]),
   `Paper gas ${key} oracle proof changed`);
 const finalBlock=await client.getBlock({blockNumber});
 assert.equal(finalBlock.hash.toLowerCase(),source.hash.toLowerCase(),'Paper gas source reorged');
 return {verificationClass:'canonical_candidate_replay_v1' as const,
  reportHash:report.reportHash as string,sourceHash:source.hash,profileHash:report.profileHash as string,
  verifiedAt:new Date().toISOString()};
}
