import assert from 'node:assert/strict';
import {getAddress,type Address,type Hex} from 'viem';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../client.js';
import {nonfungiblePositionManagerReadAbi} from '../nft/abi.js';
import type {PositionManagerTransferIndexStore} from '../nft/position-manager-transfer-index.js';
import {RangeKeeperChain,type RangeKeeperSource} from '../strategy/rangekeeper/chain.js';
import type {MarketProfile} from './market-profile.js';
import {readLiveWalletCommitments} from './live-wallet-commitments.js';
import {readCommitments,type LiveWalletCommitments,type LiveWalletIdentity} from './live-wallet-store.js';
import {readLiveWalletAllocation,resolveLiveWalletAddress,type LiveWalletReview} from './live-wallet-reader.js';
import {readCompletePositionManagerNftCustody} from './live-transfer-nft-enumeration.js';
import type {RangeKeeperWholeWalletSnapshot} from './rangekeeper-live-wallet-reconcile.js';
import type {WalletAllowanceScope} from '../strategy/rangekeeper/allowance-policy.js';

export interface RangeKeeperLiveWalletChainResult {
 status:'available'|'unavailable'; source:RangeKeeperSource; wallet:RangeKeeperWholeWalletSnapshot|null;
 profiles:readonly MarketProfile[]; review:LiveWalletReview|null; commitments:LiveWalletCommitments|null;
 reasons:string[];
}
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const uniq=(xs:string[])=>[...new Set(xs)].sort();

/** Custody snapshots take a spender scope and form the token × spender product.
 * Merge labels for repeated spenders so per-token allowance config rows do not
 * become duplicate query targets. */
export function mergeAllowanceTargetsBySpender(targets:readonly {address:string;label:string}[]){
 const grouped=new Map<string,{address:Address;labels:Set<string>}>();
 for(const item of targets){const address=getAddress(item.address),key=address.toLowerCase(),prior=grouped.get(key);
  if(prior)prior.labels.add(item.label);else grouped.set(key,{address,labels:new Set([item.label])});}
 return [...grouped.values()].sort((a,b)=>a.address.toLowerCase().localeCompare(b.address.toLowerCase()))
  .map(item=>({address:item.address,label:[...item.labels].sort().join('+')}));
}

/** Canonical, read-only wallet reader shared by RangeKeeper queue adapters.
 * Every registered profile is checked at the same source, and the entire
 * position-manager owner set must reconcile to the persisted custody ledger. */
export async function readRangeKeeperLiveWallet(input:{client:RobinhoodClient;pool:Pool;walletAddress:unknown;
 source:RangeKeeperSource;profiles:readonly MarketProfile[];transferStore:PositionManagerTransferIndexStore;
 allowanceTargets?:readonly {address:string;label:string}[];allowanceScope?:WalletAllowanceScope}):Promise<RangeKeeperLiveWalletChainResult>{
 const reasons:string[]=[];
 const wallet=resolveLiveWalletAddress(input.walletAddress);
 if(!wallet)reasons.push('server_operator_wallet_address_invalid');
 if(input.profiles.length===0)reasons.push('registered_market_profiles_unavailable');
 if(input.profiles.length>100)reasons.push('registered_market_profile_read_bound_exceeded');
 if(input.source.block<0n||!/^0x[0-9a-f]{64}$/i.test(input.source.hash)||!Number.isSafeInteger(input.source.timestamp))
  reasons.push('canonical_source_invalid');
 if(reasons.length)return {status:'unavailable',source:input.source,wallet:null,profiles:input.profiles,review:null,commitments:null,reasons};
 const ids=new Set(input.profiles.map(p=>p.pool.pool.toLowerCase()));
 if(ids.size!==input.profiles.length)reasons.push('registered_market_profile_duplicate');
 const managers=new Set(input.profiles.map(p=>p.pool.positionManager.toLowerCase()));
 if(managers.size!==1)reasons.push('registered_profiles_position_manager_mismatch');
 if(reasons.length)return {status:'unavailable',source:input.source,wallet:null,profiles:input.profiles,review:null,commitments:null,reasons:uniq(reasons)};
 for(const profile of input.profiles){
  try{await new RangeKeeperChain(input.client,profile.pool).verify(input.source);}
  catch{reasons.push(`registered_profile_chain_verification_failed:${profile.pool.pool.toLowerCase()}`);}
 }
 const walletIdentity:LiveWalletIdentity={chainId:4663,address:wallet!};
 let commitments:LiveWalletCommitments|null=null;
 try{commitments=await readCommitments(input.pool,walletIdentity);}
 catch{reasons.push('live_wallet_custody_ledger_unavailable');}
 let commitmentRead;
 try{commitmentRead=await readLiveWalletCommitments(input.pool,wallet!,{source:input.source,
  verifySource:async anchor=>{const b=await input.client.getBlock({blockNumber:BigInt(anchor.block)});
   assert(b.hash&&same(b.hash,anchor.hash)&&Number(b.timestamp)===anchor.timestamp,'Allocation source is no longer canonical');}});}
 catch{commitmentRead={status:'unavailable' as const,reasons:['live_wallet_commitment_read_unavailable']};}
 if(commitmentRead.status!=='available')reasons.push(...commitmentRead.reasons);
 const profileTokens=new Map<string,{address:Address;decimals:number;reference:string}>();
 const targets=new Map<string,{address:Address;label:string}>();
 for(const p of input.profiles){
  for(const [address,decimals,reference] of [[p.pool.token0,p.pool.decimals0,p.pool.reference0],
   [p.pool.token1,p.pool.decimals1,p.pool.reference1]] as const){
   const key=address.toLowerCase(),old=profileTokens.get(key);
   if(old&&old.decimals!==decimals)reasons.push('registered_market_token_metadata_conflict');
   else profileTokens.set(key,{address:getAddress(address),decimals,reference});
  }
  for(const [address,label] of [[p.pool.router,'router'],[p.pool.positionManager,'position_manager']] as const)
   targets.set(address.toLowerCase(),{address:getAddress(address),label});
 }
 let review:LiveWalletReview|null=null;
 try{review=await readLiveWalletAllocation({walletAddress:wallet,client:input.client,source:input.source,
  profiles:input.profiles,commitments:commitmentRead,
  allowanceTargets:mergeAllowanceTargetsBySpender([...targets.values(),...(input.allowanceTargets??[])]),
  allowanceScope:input.allowanceScope,
  readCompleteNftCustody:async request=>{
   const evidence=await readCompletePositionManagerNftCustody({...request,targetStrategyId:'rangekeeper_v1',
    store:input.transferStore,startBlock:0n});
   if(evidence.status!=='available'||!evidence.tokenIds||!commitments)return evidence;
   const custody=commitments.nftCustody.filter(n=>same(n.manager,request.positionManager));
   const registeredPools=input.profiles.map(profile=>profile.pool);
   const actual=new Set(evidence.tokenIds),ledger=new Set(custody.filter(n=>n.status!=='released').map(n=>n.tokenId));
   if(actual.size!==ledger.size||[...actual].some(id=>!ledger.has(id)))return {...evidence,status:'unavailable',
    enumerationComplete:false,missing:[...evidence.missing,'wallet_nft_set_differs_from_persisted_custody']};
   const retired:string[]=[];
   for(let offset=0;offset<evidence.tokenIds.length;offset+=8){
    const ids=evidence.tokenIds.slice(offset,offset+8);
    const positions=await Promise.all(ids.map(tokenId=>input.client.readContract({address:request.positionManager,
     abi:nonfungiblePositionManagerReadAbi,functionName:'positions',args:[BigInt(tokenId)],blockNumber:request.source.block})));
    for(let index=0;index<ids.length;index++){
     const id=ids[index]!,p=positions[index]!,row=custody.find(n=>n.tokenId===id);
     if(!row)return {...evidence,status:'unavailable',enumerationComplete:false,missing:['wallet_nft_ledger_row_missing']};
     if(row.status==='active'){
      const profilePool=registeredPools.find(pool=>same(pool.token0,p[2])&&same(pool.token1,p[3])&&pool.fee===p[4]);
      if(!profilePool||String(p[7])!==row.liquidity||String(p[10])!==row.tokensOwed0||String(p[11])!==row.tokensOwed1)
       return {...evidence,status:'unavailable',enumerationComplete:false,missing:['active_wallet_nft_position_changed']};
     }else if(row.status==='retired_empty'){
      if(p[7]!==0n||p[10]!==0n||p[11]!==0n)return {...evidence,status:'unavailable',enumerationComplete:false,
       missing:['retired_wallet_nft_is_not_empty']};
      retired.push(id);
     }else return {...evidence,status:'unavailable',enumerationComplete:false,missing:['wallet_nft_custody_status_unknown']};
    }
   }
   return {...evidence,retiredEmptyTokenIds:retired};
  }});}
 catch{reasons.push('canonical_wallet_read_unavailable');}
 if(review?.status!=='available')reasons.push(...(review?.blockers??['canonical_wallet_read_unavailable']));
 const sourceHeader=await input.client.getBlock({blockNumber:input.source.block}).catch(()=>null);
 if(!sourceHeader?.hash||!same(sourceHeader.hash,input.source.hash)||Number(sourceHeader.timestamp)!==input.source.timestamp)
  reasons.push('canonical_source_changed_after_wallet_read');
 if(!review||review.native.nonce.status!=='available'||review.native.pendingNonce.status!=='available')
  return {status:'unavailable',source:input.source,wallet:null,profiles:input.profiles,review,commitments,reasons:uniq(reasons)};
 const tokenBalances=review.tokens;
 if(tokenBalances.some(t=>typeof t.balanceRaw!=='string'||! /^(0|[1-9][0-9]*)$/.test(t.balanceRaw)))
  reasons.push('wallet_token_balance_incomplete');
 const allowances=review.allowances.flatMap(a=>a.raw.status==='available'?[{token:getAddress(a.token),spender:getAddress(a.spender),amount:BigInt(a.raw.value)}]:[]);
 const nft=review.nftCustody;
 if(!nft||nft.status!=='available'||!nft.enumerationComplete||!nft.tokenIds)reasons.push('complete_wallet_nft_custody_unavailable');
 if(reasons.length)return {status:'unavailable',source:input.source,wallet:null,profiles:input.profiles,review,commitments,reasons:uniq(reasons)};
 const balances=Object.fromEntries(tokenBalances.map(t=>[getAddress(t.address).toLowerCase(),BigInt(t.balanceRaw!)]));
 return {status:'available',source:input.source,profiles:input.profiles,review,commitments,reasons:[],wallet:{
  operator:wallet!,source:{...input.source},nonce:Number(review.native.nonce.value),
  nativeWei:BigInt(review.native.balanceWei!),tokens:balances,nftTokenIds:[...nft!.tokenIds!],allowances}};
}
