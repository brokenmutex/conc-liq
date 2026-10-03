import {allocateLiveWalletBalances,type LiveWalletCommitment} from './live-wallet-allocation.js';
import type {LiveWalletCommitments,LiveWalletState} from './live-wallet-store.js';

/** Shared shape used by persistent allocations and the existing wallet review.
 * Pending amounts are separate from still-available liquid allocations; NFT
 * principal is never inserted into this token inventory. */
export function projectLiveWalletCommitmentRows(input:LiveWalletCommitments):LiveWalletCommitment[]{
 return [...input.allocations].sort((a,b)=>a.campaignId.localeCompare(b.campaignId)).map(a=>({
  campaignId:`deployment:${a.campaignId}`,active:true,known:['reserved','active','release_pending'].includes(a.state),
  allocatedByTokenAddress:Object.fromEntries(a.tokens.map(t=>[t.address.toLowerCase(),t.allocatedRaw])),
  pendingByTokenAddress:Object.fromEntries(a.tokens.map(t=>[t.address.toLowerCase(),t.pendingSpendRaw])),
  allocatedNativeWei:a.nativeSpendWei,pendingNativeWei:a.pendingNativeSpendWei,exitReserveWei:a.exitReserveWei,
  nftTokenIds:a.nftTokenIds,
  nftCustody:input.nftCustody.filter(n=>n.campaignId===a.campaignId&&n.status==='active'),
 }));
}

/** Fingerprint only, using the exact allocator serialization used by HTTP
 * review. The dummy balances are never returned as inventory evidence. */
export function liveWalletCommitmentFingerprint(input:LiveWalletCommitments):string{
 const addresses=[...new Set(input.allocations.flatMap(a=>a.tokens.map(t=>t.address.toLowerCase())))];
 return allocateLiveWalletBalances({tokens:addresses.map(address=>({address,decimals:0,symbol:address,balanceRaw:'0'})),
  nativeBalanceWei:'0',commitments:projectLiveWalletCommitmentRows(input),commitmentsStatus:'available'}).commitmentsHash;
}

/** A fresh read cannot create free capital from an unattributed wallet delta. */
export function liveWalletInventoryMatchesState(state:LiveWalletState,observed:{
 nonce:string|null;nativeBalanceWei:string|null;tokens:readonly {address:string;balanceRaw:string|null}[];
 commitmentsHash:string}):boolean{
 if(state.status!=='available'||state.nonce!==observed.nonce||state.pendingNonce!==observed.nonce||
  state.nativeBalanceWei!==observed.nativeBalanceWei||state.commitmentsHash!==observed.commitmentsHash)return false;
 const expected=new Map(state.tokens.map(t=>[t.address.toLowerCase(),t.balanceRaw]));
 return expected.size===state.tokens.length&&expected.size===observed.tokens.length&&
  new Set(observed.tokens.map(t=>t.address.toLowerCase())).size===observed.tokens.length&&
  observed.tokens.every(t=>t.balanceRaw!==null&&expected.get(t.address.toLowerCase())===t.balanceRaw);
}
