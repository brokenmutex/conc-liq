import assert from 'node:assert/strict';
import {test} from 'node:test';
import {StaticPaperSetupReviewCache} from '../src/deployments/static-paper-setup-review-cache.js';

const origin=1_800_000_000_000;
const review=(now=origin)=>({profileId:'profile',profileHash:'f'.repeat(64),
 input:{capitalQuoteRaw:'100000000',halfWidthTicks:60,limits:{maxActionCost:'10'}},
 source:{block:'100',hash:`0x${'a'.repeat(64)}`,timestamp:Math.floor(now/1000)},
 profile:{pool:'pool'},range:{tickLower:-60,tickUpper:60},requirements:{token0Raw:'1'},
 references:{price0:'1',price1:'2',nativePrice:'3',proofHash:'a'.repeat(64)},
 costs:{status:'provisional',scope:'open_and_close_retain_gas_only',gasPriceWei:'100',
  gasPriceObservedAt:new Date(now).toISOString()}});
const request=(reviewed:ReturnType<typeof review>,reviewId:string)=>({reviewId,profileId:'profile',
 capitalQuoteRaw:'100000000',halfWidthTicks:60,limits:{maxActionCost:'10'},reviewed});

test('setup review cache returns only its unchanged server-captured quote and binding',()=>{
 const cache=new StaticPaperSetupReviewCache(()=>origin),snapshot=review();
 const captured=cache.capture(snapshot);assert(captured);
 const found=cache.lookup(request(snapshot,captured.setupReviewId));assert(found);
 assert.deepEqual(found.costs,snapshot.costs);
 const forged={...snapshot,costs:{...snapshot.costs,gasPriceWei:'99'}};
 assert.equal(cache.lookup(request(forged,captured.setupReviewId)),null);
 const rebound={...snapshot,input:{...snapshot.input,limits:{maxActionCost:'11'}}};
 assert.equal(cache.lookup(request(rebound,captured.setupReviewId)),null);
});

test('expired, evicted and invalid-capacity setup review entries fail closed',()=>{
 let now=origin;const cache=new StaticPaperSetupReviewCache(()=>now,1),first=review(now),
  one=cache.capture(first);assert(one);
 const second=review(now);second.input.capitalQuoteRaw='200000000';
 const two=cache.capture(second);assert(two);
 assert.equal(cache.lookup(request(first,one.setupReviewId)),null);
 now+=180_001;
 assert.equal(cache.lookup(request(second,two.setupReviewId)),null);
 assert.throws(()=>new StaticPaperSetupReviewCache(()=>now,129),/capacity_invalid/);
});
