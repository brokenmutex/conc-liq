import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {rangeKeeperPinnedSemanticIdentity,revalidateRangeKeeperPinnedReferences,revalidateRangeKeeperPinnedSemanticHash} from '../src/deployments/rangekeeper-live-review-runtime.js';
import {rangeKeeperLiveWalletReviewMatchesPayload} from '../src/deployments/rangekeeper-live-setup-runtime.js';

describe('RangeKeeper pinned live review identity',()=>{
 it('ignores transport-only fetch metadata but binds values and proof semantics',()=>{
  const base={profileHash:'a'.repeat(64),source:{block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:10},
   references:{price0:'123',price1:'456',nativePrice:'789',proofHash:'x',semanticProofHash:'derived-a'},
   referenceProof:{feed:{address:'0xfeed',baseAsset:'ABC',quoteAsset:'USD'},state:{answer:'123',updatedAt:'9',fetchedAt:'now'},registry:{active:true}}};
  const changedTransport={...base,references:{...base.references,proofHash:'volatile-new-hash',semanticProofHash:'derived-b'},
   referenceProof:{...base.referenceProof,state:{...base.referenceProof.state,fetchedAt:'later'}}};
  assert.equal(rangeKeeperPinnedSemanticIdentity(base),rangeKeeperPinnedSemanticIdentity(changedTransport));
  const changedAnswer={...base,referenceProof:{...base.referenceProof,state:{...base.referenceProof.state,answer:'124'}}};
  assert.notEqual(rangeKeeperPinnedSemanticIdentity(base),rangeKeeperPinnedSemanticIdentity(changedAnswer));
  const changedFeed={...base,referenceProof:{...base.referenceProof,feed:{...base.referenceProof.feed,address:'0xother'}}};
  assert.notEqual(rangeKeeperPinnedSemanticIdentity(base),rangeKeeperPinnedSemanticIdentity(changedFeed));
  const changedMetadata={...base,referenceProof:{...base.referenceProof,state:{...base.referenceProof.state,observedAt:'changed'}}};
  assert.notEqual(rangeKeeperPinnedSemanticIdentity(base),rangeKeeperPinnedSemanticIdentity(changedMetadata));
  assert.notEqual(rangeKeeperPinnedSemanticIdentity(base),rangeKeeperPinnedSemanticIdentity({...base,referenceProof:{...base.referenceProof,feedDirectory:{revision:2}}}));
 });
 it('binds independent prices and canonical source identity',()=>{
  const base={profileHash:'a'.repeat(64),source:{block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:10},
   references:{price0:'123',price1:'456',nativePrice:'789'},referenceProof:{proof:'stable'}};
  assert.notEqual(rangeKeeperPinnedSemanticIdentity(base),rangeKeeperPinnedSemanticIdentity({...base,references:{...base.references,price0:'124'}}));
  assert.notEqual(rangeKeeperPinnedSemanticIdentity(base),rangeKeeperPinnedSemanticIdentity({...base,source:{...base.source,hash:`0x${'2'.repeat(64)}`}}));
 });
 it('revalidates against the exact canonical anchor and semantic feed proof',async()=>{
  const frozen={profileHash:'p'.repeat(64),source:{block:'12',hash:`0x${'a'.repeat(64)}`,timestamp:10},references:{price:'22'},
   referenceProof:{feed:{address:'0xfeed'},state:{answer:'22',updatedAt:'9',fetchedAt:'old'}}};
  const same={...frozen,referenceProof:{feed:{address:'0xfeed'},state:{answer:'22',updatedAt:'9',fetchedAt:'new'}}};
  assert.equal((await revalidateRangeKeeperPinnedReferences({frozen,fresh:same,verifyCanonical:async()=>{}})).status,'valid');
  const changed={...same,referenceProof:{feed:{address:'0xfeed'},state:{answer:'23',updatedAt:'9',fetchedAt:'new'}}};
  assert.deepEqual(await revalidateRangeKeeperPinnedReferences({frozen,fresh:changed,verifyCanonical:async()=>{}}),
   {status:'unavailable',reason:'reference_semantics_changed'});
  assert.deepEqual(await revalidateRangeKeeperPinnedReferences({frozen,fresh:same,verifyCanonical:async()=>{throw Error('reorg');}}),
   {status:'unavailable',reason:'pinned_source_changed'});
  const identity=rangeKeeperPinnedSemanticIdentity({profileHash:frozen.profileHash,source:frozen.source,references:frozen.references,referenceProof:frozen.referenceProof});
  assert.equal(await revalidateRangeKeeperPinnedSemanticHash({expectedSemanticProofHash:identity,profileHash:frozen.profileHash,source:frozen.source,
   freshProfileHash:frozen.profileHash,freshSource:frozen.source,freshReferences:frozen.references,freshReferenceProof:same.referenceProof,
   verifyCanonical:async()=>{}}),true);
 });
 it('revalidates all frozen pair/native/nonce/NFT wallet fields without changing the review',()=>{
  const hash=`0x${'1'.repeat(64)}`,profile:any={pool:{token0:'0x1000000000000000000000000000000000000001',
   token1:'0x2000000000000000000000000000000000000002',decimals0:6,decimals1:18}};
  const payload:any={source:{block:'100',hash,timestamp:10},wallet:{address:'0x9000000000000000000000000000000000000001',
   nonce:'7',commitmentsHash:'a'.repeat(64),nftTokenIds:['12'],
   token0:{balanceRaw:'100',allocatedRaw:'20',pendingRaw:'5',freeRaw:'75'},
   token1:{balanceRaw:'200',allocatedRaw:'30',pendingRaw:'10',freeRaw:'160'},
   native:{balanceWei:'1000',allocatedWei:'100',pendingWei:'50',exitReserveWei:'100',freeWei:'750'}}};
  const review:any={status:'available',walletAddress:payload.wallet.address,source:{block:'100',hash,timestamp:10,confirmed:true},
   commitmentsHash:payload.wallet.commitmentsHash,
   tokens:[{address:profile.pool.token0,decimals:6,balanceRaw:'100',allocatedRaw:'20',pendingRaw:'5',availableRaw:'75'},
    {address:profile.pool.token1,decimals:18,balanceRaw:'200',allocatedRaw:'30',pendingRaw:'10',availableRaw:'160'}],
   native:{balanceWei:'1000',allocatedWei:'100',pendingWei:'50',exitReserveWei:'100',availableWei:'750',
    nonce:{status:'available',value:'7'},pendingNonce:{status:'available',value:'7'}},
   nftCustody:{status:'available',enumerationComplete:true,tokenIds:['12']}};
  assert.equal(rangeKeeperLiveWalletReviewMatchesPayload(review,payload,profile),true);
  assert.equal(rangeKeeperLiveWalletReviewMatchesPayload({...review,native:{...review.native,pendingNonce:{status:'available',value:'8'}}},payload,profile),false);
  assert.equal(rangeKeeperLiveWalletReviewMatchesPayload({...review,native:{...review.native,availableWei:'749'}},payload,profile),false);
  assert.equal(rangeKeeperLiveWalletReviewMatchesPayload({...review,nftCustody:{...review.nftCustody,tokenIds:[]}},payload,profile),false);
 });
});
