import {createHash} from 'node:crypto';
import {getAddress,isAddress,type Address} from 'viem';

export type LiveWalletTokenBalance={address:unknown;decimals:unknown;symbol:unknown;reference?:unknown;balanceRaw:unknown};
export type LiveWalletCommitment={
 campaignId:unknown;active:unknown;known:unknown;
 allocatedByTokenAddress?:unknown;pendingByTokenAddress?:unknown;
 allocatedNativeWei?:unknown;pendingNativeWei?:unknown;exitReserveWei?:unknown;
 nftTokenIds?:unknown;
 nftCustody?:unknown;
};
export type LiveWalletAllocationInput={tokens:readonly LiveWalletTokenBalance[];nativeBalanceWei:unknown;
 commitments:readonly LiveWalletCommitment[];commitmentsStatus?:'available'|'unavailable';commitmentReasons?:readonly string[]};
export type LiveWalletTokenAllocation={address:Address;decimals:number;symbol:string;reference:string|null;balanceRaw:string|null;
 allocatedRaw:string|null;pendingRaw:string|null;availableRaw:string|null};
export type LiveWalletAllocationSnapshot={tokens:LiveWalletTokenAllocation[];
 native:{balanceWei:string|null;allocatedWei:string|null;pendingWei:string|null;exitReserveWei:string|null;availableWei:string|null};
 commitmentsHash:string;blockers:string[];status:'available'|'unavailable'};

const UINT=/^(0|[1-9][0-9]*)$/;
const canonical=(value:unknown)=>typeof value==='string'&&isAddress(value)?getAddress(value):null;
const decimal=(value:unknown)=>typeof value==='string'&&UINT.test(value)?BigInt(value):null;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Deterministic read-only accounting for wallet-held, pending, and free liquid
 * balances. NFT principal is intentionally outside this liquid inventory. */
export function allocateLiveWalletBalances(input:LiveWalletAllocationInput):LiveWalletAllocationSnapshot{
 const blockers:string[]=[],tokens=new Map<string,{address:Address;decimals:number;symbol:string;reference:string|null;balance:bigint|null}>();
 for(const row of input.tokens){
  const address=canonical(row.address),balance=decimal(row.balanceRaw),decimals=row.decimals,symbol=row.symbol;
  if(!address||!Number.isInteger(decimals)||typeof decimals!=='number'||decimals<0||decimals>255||
   typeof symbol!=='string'||!symbol.trim()) {blockers.push('wallet_token_inventory_malformed');continue;}
  if(balance===null)blockers.push(`wallet_token_balance_unavailable:${address.toLowerCase()}`);
  const key=address.toLowerCase();
  if(tokens.has(key)){blockers.push('wallet_token_inventory_duplicate_address');continue;}
  tokens.set(key,{address,decimals,symbol,reference:typeof row.reference==='string'?row.reference:null,balance});
 }
 const nativeBalance=decimal(input.nativeBalanceWei);
 if(nativeBalance===null)blockers.push('wallet_native_balance_unavailable_or_malformed');
 if(input.commitmentsStatus==='unavailable')blockers.push(...(input.commitmentReasons?.length?input.commitmentReasons:['active_live_commitments_unavailable']));
 const commitmentRows:unknown[]=[],seenCampaigns=new Set<string>(),allocated=new Map<string,bigint>(),pending=new Map<string,bigint>();
 let allocatedNative=0n,pendingNative=0n,exitReserve=0n;
 for(const row of input.commitments){
  if(!row||row.active!==true)continue;
  const campaignId=typeof row.campaignId==='string'&&row.campaignId.trim()?row.campaignId.trim():null;
  if(!campaignId||row.known!==true){blockers.push('active_live_custody_commitment_unknown');commitmentRows.push({campaignId,campaignUnknown:true});continue;}
  if(seenCampaigns.has(campaignId)){blockers.push(`active_live_commitment_duplicate_campaign:${campaignId}`);
   commitmentRows.push({campaignId,duplicate:true});continue;}seenCampaigns.add(campaignId);
  const allocatedMap=row.allocatedByTokenAddress,pendingMap=row.pendingByTokenAddress;
  if(!allocatedMap||typeof allocatedMap!=='object'||Array.isArray(allocatedMap)||
   !pendingMap||typeof pendingMap!=='object'||Array.isArray(pendingMap)){
   blockers.push(`active_live_commitment_malformed:${campaignId}`);commitmentRows.push({campaignId,malformed:true});continue;
  }
  const norm=(source:Record<string,unknown>,target:Map<string,bigint>)=>{
   const entries=Object.entries(source).map(([address,raw])=>[canonical(address),decimal(raw)] as const);
   if(entries.some(([address,amount])=>!address||amount===null)){blockers.push(`active_live_commitment_malformed:${campaignId}`);return null;}
   if(new Set(entries.map(([address])=>address!.toLowerCase())).size!==entries.length){
    blockers.push(`active_live_commitment_duplicate_token:${campaignId}`);return null;}
   for(const [address,amount] of entries){const key=address!.toLowerCase();
    if(!tokens.has(key)){blockers.push(`active_live_commitment_token_outside_inventory:${campaignId}`);continue;}
    target.set(key,(target.get(key)??0n)+amount!);
   }
   return Object.fromEntries(entries.map(([address,amount])=>[address!.toLowerCase(),amount!.toString()])
    .sort((left,right)=>String(left[0]).localeCompare(String(right[0]))));
  };
  const a=norm(allocatedMap as Record<string,unknown>,allocated),p=norm(pendingMap as Record<string,unknown>,pending);
  const an=decimal(row.allocatedNativeWei),pn=decimal(row.pendingNativeWei),er=decimal(row.exitReserveWei);
  if(a===null||p===null||an===null||pn===null||er===null){blockers.push(`active_live_commitment_malformed:${campaignId}`);continue;}
  allocatedNative+=an;pendingNative+=pn;exitReserve+=er;
  commitmentRows.push({campaignId,allocatedByTokenAddress:a,pendingByTokenAddress:p,
   allocatedNativeWei:an.toString(),pendingNativeWei:pn.toString(),exitReserveWei:er.toString(),
   nftTokenIds:Array.isArray(row.nftTokenIds)?row.nftTokenIds.filter(x=>typeof x==='string').sort():[]});
 }
 const tokenRows:LiveWalletTokenAllocation[]=[...tokens.values()].sort((a,b)=>a.address.toLowerCase().localeCompare(b.address.toLowerCase()))
  .map(token=>{
   const key=token.address.toLowerCase(),a=allocated.get(key)??0n,p=pending.get(key)??0n,
    free=token.balance===null?null:token.balance-a-p;
   if(free!==null&&free<0n)blockers.push(`wallet_token_balance_oversubscribed:${key}`);
   return {address:token.address,decimals:token.decimals,symbol:token.symbol,reference:token.reference,
    balanceRaw:token.balance?.toString()??null,allocatedRaw:a.toString(),pendingRaw:p.toString(),
    availableRaw:free===null||free<0n?null:free.toString()};
  });
 const nativeFree=nativeBalance===null?null:nativeBalance-allocatedNative-pendingNative-exitReserve;
 if(nativeFree!==null&&nativeFree<0n)blockers.push('wallet_native_balance_oversubscribed');
 const normalizedCommitments=commitmentRows.sort((a,b)=>String((a as {campaignId?:unknown}).campaignId??'')
  .localeCompare(String((b as {campaignId?:unknown}).campaignId??'')));
 const commitmentsHash=hash(normalizedCommitments);
 const unique=[...new Set(blockers)].sort();
 const uncertain=unique.length>0;
 return {tokens:tokenRows.map(row=>uncertain?{...row,allocatedRaw:null,pendingRaw:null,availableRaw:null}:row),native:{
  balanceWei:nativeBalance?.toString()??null,allocatedWei:uncertain?null:allocatedNative.toString(),
  pendingWei:uncertain?null:pendingNative.toString(),exitReserveWei:uncertain?null:exitReserve.toString(),
  availableWei:nativeFree===null||nativeFree<0n||uncertain?null:nativeFree.toString()},
  commitmentsHash,blockers:unique,status:unique.length?'unavailable':'available'};
}
