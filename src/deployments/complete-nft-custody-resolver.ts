import {isAddress,type Address} from 'viem';

export type NftCustodyStrategy='static_manual_v1'|'rangekeeper_v1';
type ObservedField<T>={status:'available';value:T}|{status:'unavailable';reason:string};
const reasons=[
 'position_manager_transfer_history_not_indexed',
 'pool_event_index_excludes_position_manager_transfer_logs',
 'nft_accounting_snapshots_require_caller_supplied_token_ids',
 'nft_snapshot_schema_has_no_complete_wallet_ownership_coverage',
 'balance_of_count_and_sampled_owner_reads_do_not_prove_complete_token_id_set',
] as const;
const HASH=/^0x[0-9a-f]{64}$/i;
const UINT=/^(0|[1-9][0-9]*)$/;

/** The repository's current pool event index and sampled NFT snapshots cannot
 * establish complete Position Manager ownership. Preserve supplied count and
 * sampled owner reads as observations, but never promote them to enumeration. */
export function resolveCompleteNftCustodyFromRepository(input:{targetStrategyId:unknown;operator:unknown;
 positionManager:unknown;source:unknown;balanceOf:unknown;knownOwners?:unknown}){
 const strategy=input.targetStrategyId==='static_manual_v1'||input.targetStrategyId==='rangekeeper_v1'?
  input.targetStrategyId as NftCustodyStrategy:null;
 const operator=typeof input.operator==='string'&&isAddress(input.operator)?input.operator:null;
 const manager=typeof input.positionManager==='string'&&isAddress(input.positionManager)?input.positionManager:null;
 const source=input.source&&typeof input.source==='object'&&!Array.isArray(input.source)?
  input.source as Record<string,unknown>:null;
 const sourceValid=source?.confirmed===true&&typeof source.block==='string'&&UINT.test(source.block)&&
  typeof source.hash==='string'&&HASH.test(source.hash)&&Number.isSafeInteger(source.timestamp);
 const balance=input.balanceOf&&typeof input.balanceOf==='object'&&!Array.isArray(input.balanceOf)?
  input.balanceOf as Record<string,unknown>:null;
 const count=balance?.status==='available'&&typeof balance.value==='string'&&UINT.test(balance.value)?
  {status:'available' as const,value:balance.value}:
  {status:'unavailable' as const,reason:typeof balance?.reason==='string'?balance.reason:'nft_count_not_supplied'};
 const knownOwners=Array.isArray(input.knownOwners)?input.knownOwners.slice(0,100).map((item)=>{
  const row=item&&typeof item==='object'&&!Array.isArray(item)?item as Record<string,unknown>:{};
  const owner=row.owner&&typeof row.owner==='object'&&!Array.isArray(row.owner)?row.owner as Record<string,unknown>:null;
  return {tokenId:typeof row.tokenId==='string'&&UINT.test(row.tokenId)?row.tokenId:null,
   owner:owner?.status==='available'&&typeof owner.value==='string'&&isAddress(owner.value)?
    {status:'available' as const,value:owner.value}:
    {status:'unavailable' as const,reason:typeof owner?.reason==='string'?owner.reason:'owner_read_not_supplied'}};
 }):[];
 const missing:string[]=[...reasons];
 if(!strategy)missing.unshift('target_strategy_unsupported');
 if(!operator)missing.unshift('operator_address_invalid');
 if(!manager)missing.unshift('position_manager_address_invalid');
 if(!sourceValid)missing.unshift('pinned_canonical_source_unavailable');
 return {kind:'complete_position_manager_nft_custody' as const,status:'unavailable' as const,
  targetStrategyId:strategy,operator,positionManager:manager,
  source:sourceValid?{block:source!.block as string,hash:source!.hash as string,
   timestamp:source!.timestamp as number,confirmed:true as const}:null,
  enumerationComplete:false as const,tokenIds:null,balanceOfCount:count,knownOwners,
  indexedTransferCoverage:{status:'unavailable' as const,reason:'no_manager_transfer_history_or_coverage_record'},
  missing:[...new Set(missing)],actionAvailable:false as const,executionEligible:false as const};
}
