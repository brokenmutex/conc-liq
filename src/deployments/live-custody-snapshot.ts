import {isAddress,getAddress,parseAbi,type Address,type Hex} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {paperTokenAbi} from '../paper/execution-abi.js';
import {nonfungiblePositionManagerReadAbi} from '../nft/abi.js';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {resolveCompleteNftCustodyFromRepository} from './complete-nft-custody-resolver.js';

export type LiveCustodyStrategy='static_manual_v1'|'rangekeeper_v1';
export type PinnedCustodySource={block:bigint;hash:Hex;timestamp:number};
export type CustodyToken={address:Address;symbol:string};
export type CustodyAllowanceTarget={address:Address;label:string};
const nftBalanceAbi=parseAbi(['function balanceOf(address owner) view returns(uint256)']);
const HASH=/^0x[0-9a-f]{64}$/i;
const UINT=/^(0|[1-9][0-9]*)$/;
const MAX_TOKENS=8,MAX_SPENDERS=8,MAX_NFT_IDS=100,CONFIRMATIONS=64;
type Field<T>={status:'available';value:T}|{status:'unavailable';reason:string};
type Client=Pick<RobinhoodClient,'getChainId'|'getBlock'|'getTransactionCount'|'getBalance'|'readContract'>;

function unavailable<T>(reason:string):Field<T>{return {status:'unavailable',reason};}
function isValidAddress(value:unknown):value is Address{return typeof value==='string'&&isAddress(value);}
function normalizeSource(source:PinnedCustodySource){
 return source&&typeof source.block==='bigint'&&source.block>=0n&&typeof source.timestamp==='number'&&
  Number.isSafeInteger(source.timestamp)&&source.timestamp>0&&typeof source.hash==='string'&&HASH.test(source.hash);
}
async function settled<T>(work:()=>Promise<T>,reason:string):Promise<Field<T>>{
 try{return {status:'available',value:await work()};}catch{return unavailable(reason);}
}

/** Read a bounded wallet/custody snapshot at one already-selected confirmed
 * source. This reports evidence only; it performs no strategy admission,
 * signing, or transaction submission. */
export async function readLiveCustodySnapshot(input:{client:Client;targetStrategyId:LiveCustodyStrategy|unknown;
 operator:unknown;source:PinnedCustodySource;tokens:readonly CustodyToken[];
 allowanceTargets:readonly CustodyAllowanceTarget[];positionManager:unknown;knownNftIds?:readonly string[]}){
 const {client}=input;
 const target=input.targetStrategyId==='static_manual_v1'||input.targetStrategyId==='rangekeeper_v1'?
  input.targetStrategyId:null;
 const empty=()=>({kind:'live_custody_snapshot' as const,status:'unavailable' as 'unavailable'|'snapshot_partial',
  targetStrategyId:target,operator:null as string|null,source:{block:String(input.source?.block??''),hash:input.source?.hash??null,
   timestamp:input.source?.timestamp??null,confirmed:false},positionManager:null as string|null,
  chainId:unavailable<number>('not_checked'),
  nonce:unavailable<string>('not_checked'),nativeBalanceWei:unavailable<string>('not_checked'),
  tokenBalances:[] as {symbol:string;token:string;raw:Field<string>}[],
  allowances:[] as {token:string;spender:string;label:string;raw:Field<string>}[],
  nftCount:unavailable<string>('not_checked'),knownNftOwnership:[] as {tokenId:string;owner:Field<string>}[],
  nftEnumeration:resolveCompleteNftCustodyFromRepository({targetStrategyId:target,operator:null,
   positionManager:input.positionManager,source:null,balanceOf:null}),
  unavailableReasons:[] as string[],actionAvailable:false as const,executionEligible:false as const});
 const result=empty(),reasons:string[]=[];
 if(!target)reasons.push('target_strategy_unsupported');
 if(!isValidAddress(input.operator))reasons.push('operator_address_invalid');
 if(!isValidAddress(input.positionManager))reasons.push('position_manager_address_invalid');
 if(!normalizeSource(input.source))reasons.push('pinned_source_invalid');
 if(!Array.isArray(input.tokens)||input.tokens.length===0||input.tokens.length>MAX_TOKENS||
  input.tokens.some(t=>!t||!isValidAddress(t.address)||typeof t.symbol!=='string'||!t.symbol.trim()))
  reasons.push('token_scope_invalid_or_out_of_bounds');
 else if(new Set(input.tokens.map(t=>t.address.toLowerCase())).size!==input.tokens.length)
  reasons.push('token_scope_contains_duplicates');
 if(!Array.isArray(input.allowanceTargets)||input.allowanceTargets.length===0||input.allowanceTargets.length>MAX_SPENDERS||
  input.allowanceTargets.some(s=>!s||!isValidAddress(s.address)||typeof s.label!=='string'||!s.label.trim()))
  reasons.push('allowance_target_scope_invalid_or_out_of_bounds');
 else if(new Set(input.allowanceTargets.map(s=>s.address.toLowerCase())).size!==input.allowanceTargets.length)
  reasons.push('allowance_target_scope_contains_duplicates');
 const nftIds=input.knownNftIds??[];
 if(!Array.isArray(nftIds)||nftIds.length>MAX_NFT_IDS||nftIds.some(id=>typeof id!=='string'||!UINT.test(id)||id==='0'))
  reasons.push('known_nft_id_scope_invalid_or_out_of_bounds');
 else if(new Set(nftIds).size!==nftIds.length)reasons.push('known_nft_id_scope_contains_duplicates');
 if(reasons.length){result.unavailableReasons=reasons;return result;}
 const operator=getAddress(input.operator as Address),manager=getAddress(input.positionManager as Address),
  blockNumber=input.source.block;
 result.operator=operator;result.positionManager=manager;
 result.source={block:String(blockNumber),hash:input.source.hash,timestamp:input.source.timestamp,confirmed:false};
 const failSource=(reason:string)=>{result.unavailableReasons=[reason];result.source={...result.source,confirmed:false};return result;};
 let chainId:number,latest:Awaited<ReturnType<Client['getBlock']>>,
  pinned:Awaited<ReturnType<Client['getBlock']>>;
 try{[chainId,latest,pinned]=await Promise.all([
  client.getChainId(),client.getBlock(),client.getBlock({blockNumber}),
 ]);}catch{return failSource('canonical_source_unavailable');}
 result.chainId={status:'available',value:chainId};
 if(chainId!==ROBINHOOD_CHAIN_ID)return failSource('chain_id_mismatch');
 if(latest.number===null||latest.number<blockNumber+BigInt(CONFIRMATIONS))
  return failSource('pinned_source_not_confirmed_to_required_depth');
 if(!pinned.hash||pinned.hash.toLowerCase()!==input.source.hash.toLowerCase()||
  Number(pinned.timestamp)!==input.source.timestamp)return failSource('pinned_source_identity_mismatch');
 result.source={block:String(blockNumber),hash:input.source.hash,timestamp:input.source.timestamp,confirmed:true};

 const tokenBalances=await Promise.all(input.tokens.map(async token=>({symbol:token.symbol,token:getAddress(token.address),
  raw:await settled(async()=>String(await client.readContract({address:getAddress(token.address),abi:paperTokenAbi,
   functionName:'balanceOf',args:[operator],blockNumber})),`token_balance_unavailable:${token.symbol}`)})));
 const allowances=await Promise.all(input.tokens.flatMap(token=>input.allowanceTargets.map(async spender=>({
  token:getAddress(token.address),spender:getAddress(spender.address),label:spender.label,
  raw:await settled(async()=>String(await client.readContract({address:getAddress(token.address),abi:paperTokenAbi,
   functionName:'allowance',args:[operator,getAddress(spender.address)],blockNumber})),
   `allowance_unavailable:${token.symbol}:${spender.label}`)}))));
 const [nonce,nativeBalanceWei,nftCount,knownNftOwnership]=await Promise.all([
  settled(async()=>String(await client.getTransactionCount({address:operator,blockNumber})), 'wallet_nonce_unavailable'),
  settled(async()=>String(await client.getBalance({address:operator,blockNumber})), 'native_balance_unavailable'),
  settled(async()=>String(await client.readContract({address:manager,abi:nftBalanceAbi,functionName:'balanceOf',
   args:[operator],blockNumber})), 'nft_count_unavailable'),
  Promise.all(nftIds.map(async tokenId=>({tokenId,owner:await settled(async()=>getAddress(await client.readContract({
   address:manager,abi:nonfungiblePositionManagerReadAbi,functionName:'ownerOf',args:[BigInt(tokenId)],blockNumber})),
   `nft_owner_unavailable:${tokenId}`)}))),
 ]);
 result.nonce=nonce;result.nativeBalanceWei=nativeBalanceWei;result.tokenBalances=tokenBalances;
 result.allowances=allowances;result.nftCount=nftCount;result.knownNftOwnership=knownNftOwnership;
 let after:Awaited<ReturnType<Client['getBlock']>>;
 try{after=await client.getBlock({blockNumber});}catch{return failSource('pinned_source_recheck_unavailable');}
 if(!after.hash||after.hash.toLowerCase()!==input.source.hash.toLowerCase()||
  Number(after.timestamp)!==input.source.timestamp)return failSource('pinned_source_changed_during_snapshot');
 const fieldReasons=[nonce,nativeBalanceWei,nftCount,...tokenBalances.map(x=>x.raw),...allowances.map(x=>x.raw),
  ...knownNftOwnership.map(x=>x.owner)].filter((field)=>field.status==='unavailable').map(field=>
   field.status==='unavailable'?field.reason:'');
 result.nftEnumeration=resolveCompleteNftCustodyFromRepository({targetStrategyId:target,operator,
  positionManager:manager,source:result.source,balanceOf:nftCount,knownOwners:knownNftOwnership});
 result.unavailableReasons=[...new Set([...fieldReasons,...result.nftEnumeration.missing])];
 result.status='snapshot_partial';
 return result;
}
