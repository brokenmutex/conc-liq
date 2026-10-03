import {getAddress,isAddress,keccak256,type Address} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import type {MarketProfile} from './market-profile.js';
import {marketProfileSchema} from './market-profile.js';
import {readLiveCustodySnapshot,type PinnedCustodySource} from './live-custody-snapshot.js';
import {allocateLiveWalletBalances,type LiveWalletCommitment,type LiveWalletAllocationSnapshot} from './live-wallet-allocation.js';

export type LiveWalletCommitmentRead={status:'available';rows:readonly LiveWalletCommitment[]}|{
 status:'unavailable';reasons:readonly string[];rows?:readonly LiveWalletCommitment[]};
export type CompleteNftCustodyEvidence={kind:'complete_position_manager_nft_custody';status:'available'|'unavailable';
 enumerationComplete:boolean;tokenIds:string[]|null;retiredEmptyTokenIds?:string[];missing:string[];source:unknown;
 operator:string|null;positionManager:string|null};
export type LiveWalletReview={kind:'live_wallet_review';status:'available'|'unavailable';walletAddress:string|null;
 source:{block:string;hash:string|null;timestamp:number|null;confirmed:boolean};
 tokens:LiveWalletAllocationSnapshot['tokens'];
 native:LiveWalletAllocationSnapshot['native']&{
  nonce:{status:'available';value:string}|{status:'unavailable';reason:string};
  pendingNonce:{status:'available';value:string}|{status:'unavailable';reason:string}};
 allowances:{token:string;spender:string;label:string;raw:{status:'available';value:string}|{status:'unavailable';reason:string}}[];
 nftCustody:CompleteNftCustodyEvidence|null;commitmentsHash:string;allocationSnapshot:LiveWalletAllocationSnapshot;
 blockers:string[];reasons:string[];actionAvailable:false;executionEligible:false};

const invalidAllocation=():LiveWalletAllocationSnapshot=>allocateLiveWalletBalances({tokens:[],nativeBalanceWei:null,
 commitments:[],commitmentsStatus:'unavailable',commitmentReasons:['wallet_snapshot_unavailable']});
const validAddress=(value:unknown):value is Address=>typeof value==='string'&&isAddress(value);
const MAX_SOURCE_AGE_SECONDS=180;

/** Resolve the sole server-configured wallet. Never accept a wallet override
 * from a request or return key material. */
export function resolveLiveWalletAddress(configured:unknown):Address|null{
 return validAddress(configured)?getAddress(configured):null;
}

/** Build a read-only, JSON-safe shared-wallet allocation review at a caller
 * selected pinned source. The caller supplies repository-backed commitments
 * and indexed NFT evidence; neither dependency can sign or submit transactions. */
export async function readLiveWalletAllocation(input:{walletAddress:unknown;client:RobinhoodClient;
 source:PinnedCustodySource;profiles:readonly unknown[];commitments:LiveWalletCommitmentRead;
 allowanceTargets?:readonly {address:string;label:string}[];
 readCompleteNftCustody?:(input:{client:RobinhoodClient;operator:Address;positionManager:Address;
  source:PinnedCustodySource})=>Promise<CompleteNftCustodyEvidence>}):Promise<LiveWalletReview>{
 const wallet=resolveLiveWalletAddress(input.walletAddress),blockers:string[]=[],reasons:string[]=[];
 const emptyAllocation=invalidAllocation();
 const base:Omit<LiveWalletReview,'status'|'blockers'|'reasons'>={kind:'live_wallet_review',walletAddress:wallet,source:{block:String(input.source?.block??''),
  hash:input.source?.hash??null,timestamp:input.source?.timestamp??null,confirmed:false},
  native:{...emptyAllocation.native,
   nonce:{status:'unavailable' as const,reason:'wallet_snapshot_unavailable'} as LiveWalletReview['native']['nonce'],
   pendingNonce:{status:'unavailable' as const,reason:'wallet_snapshot_unavailable'} as LiveWalletReview['native']['pendingNonce']},
  allowances:[],
  nftCustody:null as CompleteNftCustodyEvidence|null,commitmentsHash:'',allocationSnapshot:emptyAllocation,
  tokens:[] as LiveWalletAllocationSnapshot['tokens'],
  actionAvailable:false as const,executionEligible:false as const};
 const finish=():LiveWalletReview=>({...base,status:blockers.length?'unavailable':'available',
  blockers:[...new Set(blockers)].sort(),reasons:[...new Set([...reasons,...blockers])].sort()});
 if(!wallet){blockers.push('server_operator_wallet_address_invalid');return finish();}
 const nowSeconds=Math.floor(Date.now()/1000);
 if(!input.source||typeof input.source.block!=='bigint'||input.source.block<0n||
  typeof input.source.hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(input.source.hash)||
  !Number.isSafeInteger(input.source.timestamp)||input.source.timestamp>nowSeconds||
  nowSeconds-input.source.timestamp>MAX_SOURCE_AGE_SECONDS){blockers.push('pinned_source_stale_or_invalid');return finish();}
 if(!Array.isArray(input.profiles)||input.profiles.length===0){blockers.push('registered_market_profiles_unavailable');return finish();}
 const parsed:MarketProfile[]=[];
 for(const raw of input.profiles){const result=marketProfileSchema.safeParse(raw);
  if(!result.success){blockers.push('registered_market_profile_invalid');continue;}parsed.push(result.data);}
 if(!parsed.length){return finish();}
 if(parsed.some(profile=>profile.pool.chainId!==ROBINHOOD_CHAIN_ID))blockers.push('registered_market_profile_chain_mismatch');
 if(new Set(parsed.map(profile=>profile.pool.positionManager.toLowerCase())).size!==1)
  blockers.push('registered_profiles_position_manager_mismatch');
 if(new Set(parsed.map(profile=>profile.pool.managerCodeHash.toLowerCase())).size!==1)
  blockers.push('registered_profiles_manager_code_hash_mismatch');
 const tokenMap=new Map<string,{address:Address;decimals:number;reference:string}>();
 const targets=new Map<string,{address:Address;label:string}>();
 for(const profile of parsed){const p=profile.pool;
  for(const [address,decimals,reference] of [[p.token0,p.decimals0,p.reference0],[p.token1,p.decimals1,p.reference1]] as const){
   const normalized=getAddress(address),key=normalized.toLowerCase(),prior=tokenMap.get(key);
   if(prior&&prior.decimals!==decimals)blockers.push('registered_market_token_metadata_conflict');
   else tokenMap.set(key,{address:normalized,decimals,reference});
  }
  for(const [address,label] of [[p.router,'router'],[p.positionManager,'position_manager']] as const){
   const normalized=getAddress(address),key=normalized.toLowerCase();if(!targets.has(key))targets.set(key,{address:normalized,label});
  }
 }
 for(const target of input.allowanceTargets??[]){
  if(!validAddress(target.address)||typeof target.label!=='string'||!target.label.trim()){
   blockers.push('wallet_allowance_target_invalid');continue;}
  const address=getAddress(target.address),key=address.toLowerCase();if(!targets.has(key))targets.set(key,{address,label:target.label});
 }
 if(targets.size>8)blockers.push('registered_allowance_target_scope_out_of_bounds');
 if(blockers.length)return finish();
 const manager=getAddress(parsed[0]!.pool.positionManager),expectedManagerCodeHash=parsed[0]!.pool.managerCodeHash.toLowerCase();
 try{
  const code=await input.client.getBytecode({address:manager,blockNumber:input.source.block});
  if(!code||code==='0x'||keccak256(code).toLowerCase()!==expectedManagerCodeHash)
   blockers.push('position_manager_code_hash_mismatch_at_source');
 }catch{blockers.push('position_manager_code_unavailable_at_source');}
 if(blockers.length)return finish();
 let snapshot:Awaited<ReturnType<typeof readLiveCustodySnapshot>>;
 try{snapshot=await readLiveCustodySnapshot({client:input.client,targetStrategyId:'rangekeeper_v1',operator:wallet,
  source:input.source,tokens:[...tokenMap.values()].map(t=>({address:t.address,symbol:t.reference})),
  allowanceTargets:[...targets.values()],
   positionManager:manager});}
 catch{blockers.push('canonical_wallet_snapshot_unavailable');return finish();}
 base.source={...snapshot.source};
 if(snapshot.status==='unavailable')blockers.push(...snapshot.unavailableReasons);
 base.native.nonce=snapshot.nonce;
 let pendingNonce:LiveWalletReview['native']['pendingNonce'];
 try{pendingNonce={status:'available',value:String(await input.client.getTransactionCount({address:wallet,blockTag:'pending'}))};}
 catch{pendingNonce={status:'unavailable',reason:'wallet_pending_nonce_unavailable'};}
 const tokenBalances=snapshot.tokenBalances.map(row=>{
  const meta=tokenMap.get(row.token.toLowerCase());
  return {address:row.token,decimals:meta?.decimals,symbol:meta?.reference,reference:meta?.reference,
   balanceRaw:row.raw.status==='available'?row.raw.value:null};
 });
 if(tokenBalances.some(t=>t.balanceRaw===null))blockers.push(...snapshot.tokenBalances.filter(t=>t.raw.status==='unavailable')
  .map(t=>t.raw.status==='unavailable'?t.raw.reason:''));
 const commitments=input.commitments;
 if(commitments.status==='unavailable')blockers.push(...commitments.reasons);
 const alloc=allocateLiveWalletBalances({tokens:tokenBalances,nativeBalanceWei:
  snapshot.nativeBalanceWei.status==='available'?snapshot.nativeBalanceWei.value:null,
  commitments:commitments.rows??[],commitmentsStatus:commitments.status,
  commitmentReasons:commitments.status==='unavailable'?commitments.reasons:undefined});
 base.allocationSnapshot=alloc;base.tokens=alloc.tokens;base.native={...alloc.native,nonce:snapshot.nonce,pendingNonce};
 base.commitmentsHash=alloc.commitmentsHash;blockers.push(...alloc.blockers);
 base.allowances=snapshot.allowances;
 for(const allowance of snapshot.allowances){
  if(allowance.raw.status==='unavailable')blockers.push(allowance.raw.reason);
  else if(!/^(0|[1-9][0-9]*)$/.test(allowance.raw.value))blockers.push('wallet_allowance_value_malformed');
  else if(BigInt(allowance.raw.value)!==0n)blockers.push(`wallet_preexisting_allowance_not_zero:${allowance.token.toLowerCase()}:${allowance.label}`);
 }
 if(snapshot.nonce.status==='available'&&pendingNonce.status==='available'&&snapshot.nonce.value!==pendingNonce.value)
  blockers.push('wallet_canonical_pending_nonce_mismatch');
 if(pendingNonce.status==='unavailable')blockers.push(pendingNonce.reason);
 let nft:CompleteNftCustodyEvidence|null=null;
 if(snapshot.nftCount.status==='available'&&snapshot.nftCount.value==='0'){
  nft={kind:'complete_position_manager_nft_custody',status:'available',enumerationComplete:true,tokenIds:[],
   missing:[],source:snapshot.source,operator:wallet,positionManager:manager};
 }else if(input.readCompleteNftCustody){
  try{nft=await input.readCompleteNftCustody({client:input.client,operator:wallet,
   positionManager:manager,source:input.source});}
  catch{nft={kind:'complete_position_manager_nft_custody',status:'unavailable',enumerationComplete:false,
   tokenIds:null,missing:['complete_nft_custody_read_unavailable'],source:snapshot.source,operator:wallet,
   positionManager:manager};}
 }else nft=snapshot.nftEnumeration as CompleteNftCustodyEvidence;
 if(nft&&nft.status==='available'){
  const nftSource=nft.source as {block?:unknown;hash?:unknown;timestamp?:unknown;confirmed?:unknown}|null;
  const ids=nft.tokenIds;
  const bound=nft.operator?.toLowerCase()===wallet.toLowerCase()&&
   nft.positionManager?.toLowerCase()===manager.toLowerCase()&&
   nftSource?.confirmed===true&&nftSource.block===String(input.source.block)&&
   typeof nftSource.hash==='string'&&nftSource.hash.toLowerCase()===input.source.hash.toLowerCase()&&
   nftSource.timestamp===input.source.timestamp&&Array.isArray(ids)&&ids.every(id=>typeof id==='string'&&/^(0|[1-9][0-9]*)$/.test(id))&&
   new Set(ids).size===ids.length&&snapshot.nftCount.status==='available'&&ids.length===Number(snapshot.nftCount.value);
  if(!bound)nft={...nft,status:'unavailable',enumerationComplete:false,
   missing:[...new Set([...nft.missing,'complete_nft_custody_source_or_count_mismatch'])]};
 }
 base.nftCustody=nft;
 if(!nft||nft.status!=='available'||nft.enumerationComplete!==true)blockers.push(...(nft?.missing.length?nft.missing:['complete_nft_custody_unavailable']));
 if(nft?.status==='available'&&nft.enumerationComplete&&Array.isArray(nft.tokenIds)){
  const expected:string[]=[],retired=nft.retiredEmptyTokenIds??[],rows=commitments.rows??[];
  if(retired.some(id=>typeof id!=='string'||! /^(0|[1-9][0-9]*)$/.test(id))||
   new Set(retired).size!==retired.length||retired.some(id=>!nft!.tokenIds!.includes(id)))
   blockers.push('retired_empty_nft_attestation_invalid');
  for(const row of rows){if(row?.active!==true)continue;
   if(row.known!==true||!Array.isArray(row.nftTokenIds)||row.nftTokenIds.some(id=>typeof id!=='string'||! /^(0|[1-9][0-9]*)$/.test(id))){
    blockers.push('active_live_nft_ownership_commitment_unknown');continue;}
   expected.push(...row.nftTokenIds as string[]);
  }
  if(new Set([...expected,...retired]).size!==expected.length+retired.length||
   [...expected,...retired].sort().join(',')!==[...nft.tokenIds].sort().join(','))
   blockers.push('wallet_nft_set_does_not_match_active_campaign_ownership');
 }
 if(snapshot.nonce.status==='unavailable')blockers.push(snapshot.nonce.reason);
 if(snapshot.nativeBalanceWei.status==='unavailable')blockers.push(snapshot.nativeBalanceWei.reason);
 const finishedAt=Math.floor(Date.now()/1000);
 if(finishedAt-input.source.timestamp>MAX_SOURCE_AGE_SECONDS||input.source.timestamp>finishedAt)
  blockers.push('pinned_source_stale_or_invalid');
 try{
  const [chainId,latest,pinned]=await Promise.all([input.client.getChainId(),input.client.getBlock(),
   input.client.getBlock({blockNumber:input.source.block})]);
  if(chainId!==ROBINHOOD_CHAIN_ID||latest.number<input.source.block+64n||!pinned.hash||
   pinned.hash.toLowerCase()!==input.source.hash.toLowerCase()||Number(pinned.timestamp)!==input.source.timestamp)
   blockers.push('canonical_source_changed_after_wallet_custody_reads');
 }catch{blockers.push('canonical_source_recheck_after_wallet_custody_reads_unavailable');}
 return finish();
}
