import {createHash} from 'node:crypto';
import {zeroAddress} from 'viem';
import {z} from 'zod';
import type {RobinhoodClient} from '../client.js';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {rangeKeeperConfirmedSource} from '../strategy/rangekeeper/source.js';
import {rangeKeeperPoolSchema,rangeKeeperReferencePolicySchema} from '../strategy/rangekeeper/config.js';
import {readRangeKeeperReferences} from '../strategy/rangekeeper/reference.js';
import {contentHash} from './contracts.js';

const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uint=z.string().regex(/^(0|[1-9][0-9]*)$/);
export const marketProfileSchema=z.object({
 pool:rangeKeeperPoolSchema,
 referencePolicy:rangeKeeperReferencePolicySchema,
}).strict().superRefine((value,ctx)=>{
 const p=value.pool;
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(p.chainId!==ROBINHOOD_CHAIN_ID)fail('unsupported_chain');
 if(p.token0.toLowerCase()>=p.token1.toLowerCase())fail('noncanonical_token_order');
 if([p.pool,p.token0,p.token1,p.factory,p.positionManager,p.router,p.quoter].some(a=>a===zeroAddress))fail('zero_contract_address');
 if(p.reference0===p.reference1)fail('duplicate_reference_identity');
 if(p.nativeReference!=='ETH/USD'||p.numeraire!=='USD')fail('unsupported_reporting_reference');
});
export type MarketProfile=z.infer<typeof marketProfileSchema>;

export const verifiedMarketProfileSchema=z.object({
 profile:marketProfileSchema,
 profileHash:z.string().regex(/^[0-9a-f]{64}$/),
 streamKey:z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/),
 source:z.object({block:uint,hash,timestamp:z.number().int().positive()}).strict(),
 contractHashes:z.object({poolCodeHash:hash,token0CodeHash:hash,token1CodeHash:hash,
  managerCodeHash:hash,quoterCodeHash:hash}).strict(),
 references:z.object({price0:uint,price1:uint,nativePrice:uint,proofHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),
 referenceProof:z.record(z.string(),z.unknown()),
 verifiedAt:z.iso.datetime({offset:true}),
}).strict();
export type VerifiedMarketProfile=z.infer<typeof verifiedMarketProfileSchema>;
export const marketProfileEvidenceSchema=z.object({
 verificationClass:z.literal('canonical_chain_and_independent_reference_v1'),
 source:verifiedMarketProfileSchema.shape.source,
 streamKey:verifiedMarketProfileSchema.shape.streamKey,
 indexerTargetSetHash:z.string().min(1),
 contractHashes:verifiedMarketProfileSchema.shape.contractHashes,
 references:verifiedMarketProfileSchema.shape.references,
 referenceProof:verifiedMarketProfileSchema.shape.referenceProof,
}).strict();

function stableProofJson(value:unknown):string{
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'){
  if(!Number.isFinite(value))throw Error('invalid_reference_proof');
  return JSON.stringify(value);
 }
 if(Array.isArray(value))return `[${value.map(stableProofJson).join(',')}]`;
 if(typeof value==='object'){
  const row=value as Record<string,unknown>;
  return `{${Object.keys(row).sort().map(key=>`${JSON.stringify(key)}:${stableProofJson(row[key])}`).join(',')}}`;
 }
 throw Error('invalid_reference_proof');
}
export const referenceProofHash=(proof:unknown)=>createHash('sha256').update(stableProofJson(proof)).digest('hex');

/** Canonical, read-only proof for a configured Robinhood V3 pool. No wallet,
 * signer, transaction constructor or legacy evaluation engine is loaded. */
export async function verifyMarketProfile(client:RobinhoodClient,raw:unknown,streamKey:string):Promise<VerifiedMarketProfile>{
 const profile=marketProfileSchema.parse(raw);
 const source=await rangeKeeperConfirmedSource(client);
 const chain=new RangeKeeperChain(client,profile.pool);
 const contracts=await chain.verify(source);
 const references=await readRangeKeeperReferences(client,source,profile);
 if(!references.eligible||!references.price0||!references.price1||!references.nativePrice)
  throw Error(`market_profile_reference_unavailable:${references.reasons.join(',')}`);
 const referenceProof=JSON.parse(JSON.stringify(references.proof,(_,value)=>typeof value==='bigint'?String(value):value)) as Record<string,unknown>;
 const proofHash=referenceProofHash(referenceProof);
 return verifiedMarketProfileSchema.parse({profile,profileHash:contentHash(profile),streamKey,
  source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},
  contractHashes:{poolCodeHash:contracts.poolCodeHash,token0CodeHash:contracts.token0CodeHash,
   token1CodeHash:contracts.token1CodeHash,managerCodeHash:contracts.managerCodeHash,
   quoterCodeHash:contracts.quoterCodeHash},
  references:{price0:String(references.price0),price1:String(references.price1),
   nativePrice:String(references.nativePrice),proofHash},referenceProof,
  verifiedAt:new Date().toISOString()});
}
