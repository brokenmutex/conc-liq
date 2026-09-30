import {randomUUID} from 'node:crypto';
import {contentHash} from './contracts.js';

const MAX_AGE_MS=180_000;
const MAX_ENTRIES=128;

export type RangeKeeperPaperSetupReviewInput={reviewId:string;profileId:string;capitalQuoteRaw:string;
 fullWidthSpacings:number;limits:unknown;reviewed:Record<string,unknown>};

type CapturedReview={id:string;bindingHash:string;costs:Record<string,unknown>;
 expiresAt:number;profileId:string;capitalQuoteRaw:string;fullWidthSpacings:number;limitsHash:string};

/** Process-local, server-owned snapshot of the exact provisional setup costs
 * shown to the operator for a RangeKeeper setup review. A restart
 * intentionally invalidates outstanding reviews; a saved draft retry is
 * reconciled first. Mirrors StaticPaperSetupReviewCache exactly, except the
 * shape check below accepts the RangeKeeper cost scope, not the static one. */
export class RangeKeeperPaperSetupReviewCache{
 private readonly entries=new Map<string,CapturedReview>();
 constructor(private readonly now:()=>number=Date.now,maxEntries=MAX_ENTRIES){
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>MAX_ENTRIES)
   throw new Error('rangekeeper_setup_review_cache_capacity_invalid');
  this.maxEntries=maxEntries;
 }
 private readonly maxEntries:number;

 capture(review:unknown):{setupReviewId:string;setupReviewExpiresAt:string}|null{
  const parsed=readReview(review);
  if(!parsed)return null;
  const now=this.now(),sourceAt=Number(parsed.source.timestamp)*1000,
   costAt=Date.parse(String(parsed.costs.gasPriceObservedAt));
  if(!fresh(sourceAt,now)||!fresh(costAt,now))return null;
  const expiresAt=Math.min(sourceAt+MAX_AGE_MS,costAt+MAX_AGE_MS,now+MAX_AGE_MS);
  if(expiresAt<=now)return null;
  this.prune(now);
  const id=randomUUID();
  const captured:CapturedReview={id,bindingHash:reviewBindingHash(parsed),costs:clone(parsed.costs),
   expiresAt,profileId:String(parsed.profileId),capitalQuoteRaw:String(parsed.input.capitalQuoteRaw),
   fullWidthSpacings:Number(parsed.input.fullWidthSpacings),limitsHash:contentHash(parsed.input.limits??null)};
  this.entries.set(id,captured);
  while(this.entries.size>this.maxEntries){const oldest=this.entries.keys().next().value as string|undefined;
   if(oldest===undefined)break;this.entries.delete(oldest);}
  return {setupReviewId:id,setupReviewExpiresAt:new Date(expiresAt).toISOString()};
 }

 lookup(input:RangeKeeperPaperSetupReviewInput):{costs:Record<string,unknown>}|null{
  const now=this.now(),entry=this.entries.get(input.reviewId);
  if(!entry){this.prune(now);return null;}
  if(entry.expiresAt<=now){this.entries.delete(entry.id);return null;}
  const parsed=readReview(input.reviewed);
  if(!parsed||entry.profileId!==input.profileId||entry.capitalQuoteRaw!==input.capitalQuoteRaw||
   entry.fullWidthSpacings!==input.fullWidthSpacings||
   entry.limitsHash!==contentHash(input.limits??null)||entry.bindingHash!==reviewBindingHash(parsed)||
   contentHash(parsed.costs)!==contentHash(entry.costs))return null;
  return {costs:clone(entry.costs)};
 }

 private prune(now:number){for(const [id,entry] of this.entries)if(entry.expiresAt<=now)this.entries.delete(id);}
}

function readReview(value:unknown):Record<string,any>|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const review=value as Record<string,any>,input=review.input,costs=review.costs;
 if(!review.profileId||typeof review.profileId!=='string'||!input||typeof input!=='object'||
  !review.source||typeof review.source!=='object'||!review.profileHash||!review.profile||!review.range||
  !review.requirements||!review.references||!costs||costs.status!=='provisional'||
  costs.scope!=='range_keeper_open_and_retain_exit_gas_only'||
  typeof costs.gasPriceObservedAt!=='string'||!Number.isFinite(Date.parse(costs.gasPriceObservedAt)))return null;
 return {profileId:review.profileId,profileHash:review.profileHash,input:review.input,source:review.source,
  profile:review.profile,range:review.range,requirements:review.requirements,references:review.references,
  costs:review.costs};
}

function reviewBindingHash(review:Record<string,any>){
 const {costs:_costs,...binding}=review;
 return contentHash(binding);
}
function fresh(observedAt:number,now:number){return Number.isSafeInteger(observedAt)&&observedAt>=0&&observedAt<=now&&now-observedAt<=MAX_AGE_MS;}
function clone<T>(value:T):T{return structuredClone(value);}
