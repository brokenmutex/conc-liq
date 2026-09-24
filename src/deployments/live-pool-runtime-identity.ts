import type {RobinhoodClient} from '../client.js';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {RangeKeeperChain,type RangeKeeperSource} from '../strategy/rangekeeper/chain.js';
import {contentHash} from './contracts.js';
import {marketProfileSchema,type MarketProfile} from './market-profile.js';
import type {LiveCustodyStrategy,PinnedCustodySource} from './live-custody-snapshot.js';

const CONFIRMATIONS=64;
type RuntimeIdentity={kind:'live_pool_runtime_identity';status:'available'|'unavailable';
 targetStrategyId:LiveCustodyStrategy|null;profileHash:string|null;
 source:{block:string;hash:string;timestamp:number;confirmed:boolean}|null;
 contractHashes:{poolCodeHash:string;token0CodeHash:string;token1CodeHash:string;
  managerCodeHash:string;quoterCodeHash:string}|null;missing:string[];actionAvailable:false};
function unavailable(strategy:LiveCustodyStrategy|null,profileHash:string|null,source:PinnedCustodySource|null,
 reason:string):RuntimeIdentity{
 return {kind:'live_pool_runtime_identity',status:'unavailable',targetStrategyId:strategy,profileHash,
  source:source?{block:String(source.block),hash:source.hash,timestamp:source.timestamp,confirmed:false}:null,
  contractHashes:null,missing:[reason],actionAvailable:false};
}

/** Recheck the saved static/manual or RangeKeeper market profile against the
 * approved read-only RangeKeeperChain verifier at one pinned confirmed source.
 * This proves deployment identity only; it is not strategy admission. */
export async function verifyLivePoolRuntimeIdentity(input:{client:RobinhoodClient;targetStrategyId:unknown;
 profile:unknown;profileHash:unknown;source:PinnedCustodySource}):Promise<RuntimeIdentity>{
 const strategy:LiveCustodyStrategy|null=input.targetStrategyId==='static_manual_v1'||input.targetStrategyId==='rangekeeper_v1'?
  input.targetStrategyId as LiveCustodyStrategy:null;
 const profile=marketProfileSchema.safeParse(input.profile);
 const profileHash=typeof input.profileHash==='string'?input.profileHash:null;
 if(!strategy)return unavailable(strategy,profileHash,input.source,'target_strategy_unsupported');
 if(!profile.success)return unavailable(strategy,profileHash,input.source,'saved_market_profile_invalid');
 if(profileHash===null||contentHash(profile.data)!==profileHash)
  return unavailable(strategy,profileHash,input.source,'saved_market_profile_hash_mismatch');
 const source=input.source;
 if(!source||typeof source.block!=='bigint'||source.block<0n||!Number.isSafeInteger(source.timestamp)||
  typeof source.hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(source.hash))
  return unavailable(strategy,profileHash,null,'pinned_source_invalid');
 try{
  const [chainId,latest,pinned]=await Promise.all([
   input.client.getChainId(),input.client.getBlock(),input.client.getBlock({blockNumber:source.block}),
  ]);
  if(chainId!==ROBINHOOD_CHAIN_ID||chainId!==profile.data.pool.chainId)
   return unavailable(strategy,profileHash,source,'pool_runtime_chain_id_mismatch');
  if(latest.number<source.block+BigInt(CONFIRMATIONS))
   return unavailable(strategy,profileHash,source,'pool_runtime_source_not_confirmed');
  if(!pinned.hash||pinned.hash.toLowerCase()!==source.hash.toLowerCase()||
   Number(pinned.timestamp)!==source.timestamp)
   return unavailable(strategy,profileHash,source,'pool_runtime_source_identity_mismatch');
  const rangeSource:RangeKeeperSource={block:source.block,hash:source.hash as `0x${string}`,timestamp:source.timestamp};
  const verified=await new RangeKeeperChain(input.client,profile.data.pool).verify(rangeSource);
  const after=await input.client.getBlock({blockNumber:source.block});
  if(!after.hash||after.hash.toLowerCase()!==source.hash.toLowerCase()||Number(after.timestamp)!==source.timestamp)
   return unavailable(strategy,profileHash,source,'pool_runtime_source_changed_during_verification');
  return {kind:'live_pool_runtime_identity',status:'available',targetStrategyId:strategy,profileHash,
   source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp,confirmed:true},
   contractHashes:{poolCodeHash:verified.poolCodeHash,token0CodeHash:verified.token0CodeHash,
    token1CodeHash:verified.token1CodeHash,managerCodeHash:verified.managerCodeHash,
    quoterCodeHash:verified.quoterCodeHash},missing:[],actionAvailable:false};
 }catch(error){
  const message=error instanceof Error?error.message:'';
  const reasons:[RegExp,string][]=[
   [/Unsupported chain|chain/i,'pool_runtime_chain_or_profile_mismatch'],
   [/Contract is not an approved deployment/i,'pool_runtime_contract_not_approved'],
   [/Source changed|Source reorged/i,'pool_runtime_source_identity_mismatch'],
   [/Deployment relation mismatch/i,'pool_runtime_factory_relation_mismatch'],
   [/Missing contract bytecode/i,'pool_runtime_contract_code_unavailable'],
   [/Router code changed/i,'pool_runtime_router_code_hash_mismatch'],
   [/Profile bytecode changed/i,'pool_runtime_profile_code_hash_mismatch'],
   [/Pool identity mismatch/i,'pool_runtime_pool_getter_mismatch'],
  ];
  const reason=reasons.find(([pattern])=>pattern.test(message))?.[1]??'pool_runtime_rpc_unavailable';
  return unavailable(strategy,profileHash,source,reason);
 }
}
