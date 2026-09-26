import assert from 'node:assert/strict';
import type {RobinhoodClient} from '../client.js';
import {RangeKeeperChain,type RangeKeeperSource} from '../strategy/rangekeeper/chain.js';
import type {SwapQuote} from '../strategy/rangekeeper/planner.js';
import type {MarketProfile} from './market-profile.js';
import {contentHash} from './contracts.js';

export interface RangeKeeperPaperPinnedQuoteMetrics {
 calls:number;cacheHits:number;uniqueQuotes:number;uncachedAnchors:number;
}
function deepFreeze<T>(value:T):T{
 if(value&&typeof value==='object'){
  for(const child of Object.values(value as Record<string,unknown>))deepFreeze(child);
  Object.freeze(value);
 }
 return value;
}

/** Request-scoped memoization for exact quoter calls at one pinned source.
 * It caches only successful exact quote results; every repeat still rereads
 * the canonical source header. Owned-fork simulation does not use this cache. */
export class RangeKeeperPaperPinnedQuoteCache {
 private readonly entries=new Map<string,SwapQuote>();
 private readonly pendingAnchors=new Map<string,Promise<void>>();
 private readonly chain:RangeKeeperChain;
 private readonly chainProfile:MarketProfile;
 private calls=0;private cacheHits=0;private uncachedAnchors=0;
 readonly profileHash:string;
 constructor(readonly client:RobinhoodClient,readonly profile:MarketProfile,
  private readonly maxEntries=512){
  assert(Number.isSafeInteger(maxEntries)&&maxEntries>0&&maxEntries<=1024,
   'RangeKeeper quote cache bound is invalid');
  this.profileHash=contentHash(profile);this.chainProfile=deepFreeze(structuredClone(profile));
  this.chain=new RangeKeeperChain(client,this.chainProfile.pool);
 }
 matches(client:RobinhoodClient,profile:MarketProfile){
  return this.client===client&&this.profileHash===contentHash(profile);
 }
 metrics():RangeKeeperPaperPinnedQuoteMetrics{
  return {calls:this.calls,cacheHits:this.cacheHits,uniqueQuotes:this.entries.size,
   uncachedAnchors:this.uncachedAnchors};
 }
 async quote(source:RangeKeeperSource,token:0|1,amountIn:bigint,price0:bigint,price1:bigint):Promise<SwapQuote>{
  assert.equal(contentHash(this.profile),this.profileHash,'RangeKeeper quote cache profile changed');
  this.calls++;
  const key=contentHash({profileHash:this.profileHash,chainId:this.chainProfile.pool.chainId,
   pool:this.chainProfile.pool.pool.toLowerCase(),quoter:this.chainProfile.pool.quoter.toLowerCase(),
   source:{block:String(source.block),
    hash:source.hash.toLowerCase(),timestamp:source.timestamp},token,amountIn:String(amountIn),
   price0:String(price0),price1:String(price1)}),cached=this.entries.get(key);
  if(cached){
   const anchorKey=`${source.block}:${source.hash.toLowerCase()}:${source.timestamp}`;
   let anchor=this.pendingAnchors.get(anchorKey);
   if(!anchor){
    anchor=(async()=>{
     const block=await this.client.getBlock({blockNumber:source.block});
     assert(block.hash&&block.hash.toLowerCase()===source.hash.toLowerCase()&&
      Number(block.timestamp)===source.timestamp,'RangeKeeper cached quote source changed');
    })();
    this.pendingAnchors.set(anchorKey,anchor);this.uncachedAnchors++;
   }
   try{await anchor;}finally{if(this.pendingAnchors.get(anchorKey)===anchor)this.pendingAnchors.delete(anchorKey);}
   this.cacheHits++;return {...cached};
  }
  const result=await this.chain.quote(source,token,amountIn,price0,price1);
  if(this.entries.size<this.maxEntries)this.entries.set(key,{...result});
  return {...result};
 }
}
