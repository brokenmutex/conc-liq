import {evaluateOracleRisk} from '../risk/evaluate.js';
import type {OracleFeedMetadata,OracleRoundState} from '../risk/domain.js';

/**
 * Display-only valuation basis for RangeKeeper positions.
 *
 * The strategy trades on its profile reference policy, which accepts a held equity reference when the market is
 * closed. The accounting records are stricter: they withhold economics whenever a selected oracle reports
 * priceFresh=false. This module decides, from data already persisted in the reference proof and the recorded
 * reason codes, whether an unusable reference is unusable ONLY because of freshness (a closed or slow off-hours
 * market). In that case inventory can be shown at the last oracle answers, labeled with their age. Anything
 * structural stays unavailable. Nothing here feeds the planner, trading gates or any persisted decision input.
 */

/** A held oracle answer older than this is treated as a dead feed, not a closed market (longest holiday weekends
 * are about four days). It is a display bound only. */
export const HELD_ORACLE_MAX_AGE_SECONDS=7*24*3600;

export type ReferenceReasonClass='freshness'|'derived'|'structural';
export type ReferenceBasisKind='oracle_fresh'|'last_oracle_price'|'unavailable';

/**
 * The single place that classifies RangeKeeper reference reason codes (as emitted by evaluateRangeKeeperReferences
 * and stored in a mark's referenceUnavailable list).
 *
 * freshness  The feed itself is valid but its last answer is older than the allowed age. Only these may be valued
 *            at the last oracle answer:
 *              token0_reference_age_unacceptable / token1_reference_age_unacceptable
 *              native_oracle_price_stale
 * derived    A consequence of another reason, never a cause on its own:
 *              reference_value_unavailable (some price is null because of the reasons above or below)
 * structural Everything else, and anything unrecognized (fail closed). Emitted today:
 *              risk_source_identity, market_session_unverified,
 *              token{0,1}_unsupported_stablecoin, token{0,1}_asset_identity, token{0,1}_asset_health
 *              (oracle paused, registry inactive, multiplier inconsistent, corporate action pending, trading
 *              capabilities incomplete or not tradable),
 *              token{0,1}_oracle_missing, token{0,1}_oracle_identity,
 *              token{0,1}_oracle_answer_nonpositive / _decimals_mismatch / _description_mismatch /
 *              _round_incomplete / _timestamp_future / _read_failed,
 *              native_oracle_missing, native_oracle_answer_nonpositive / _decimals_mismatch /
 *              _description_mismatch / _round_incomplete / _timestamp_future / _read_failed.
 */
const FRESHNESS_REASONS=/^(?:token[01]_reference_age_unacceptable|native_oracle_price_stale)$/;
const DERIVED_REASONS=new Set(['reference_value_unavailable']);
export function classifyReferenceReason(code:unknown):ReferenceReasonClass{
 if(typeof code!=='string')return 'structural';
 if(FRESHNESS_REASONS.test(code))return 'freshness';
 return DERIVED_REASONS.has(code)?'derived':'structural';
}
const FEED_OF_FRESHNESS_REASON=(code:string):FeedName=>code.startsWith('native')?'native':
 code.startsWith('token0')?'token0':'token1';

export type FeedName='token0'|'token1'|'native';
export interface ReferenceFeedBasis{
 name:FeedName;state:'fresh'|'stale'|'invalid';
 /** USD x18, only for a feed that is individually usable (fresh, or stale within the hold limit). */
 price:string|null;updatedAt:string|null;ageSeconds:number|null;
 /** The basis the strategy itself recorded for this feed (heartbeat_valid, held_equity_reference, unavailable). */
 strategyBasis:string|null;reasons:string[];
}
export interface ReferenceBasis{
 kind:ReferenceBasisKind;
 /** Present only for oracle_fresh and last_oracle_price; USD x18. */
 prices:{price0:bigint;price1:bigint;nativePrice:bigint}|null;
 feeds:ReferenceFeedBasis[];
 /** Oldest oracle answer time among the three feeds, and its age at the mark's source time. */
 asOf:{updatedAt:string;ageSeconds:number}|null;
 freshnessReasons:string[];structuralReasons:string[];
}

const record=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?
 value as Record<string,unknown>:null;
const WAD=10n**18n;

function evaluateFeed(name:FeedName,entry:unknown,sourceTimestamp:number):{feed:ReferenceFeedBasis;value:bigint|null}{
 const invalid=(...reasons:string[]):{feed:ReferenceFeedBasis;value:null}=>({value:null,feed:{name,state:'invalid',price:null,
  updatedAt:null,ageSeconds:null,strategyBasis:null,reasons}});
 const wrapper=record(entry);
 const oracle=name==='native'?wrapper:record(wrapper?.oracle);
 const strategyBasis=name!=='native'&&typeof wrapper?.basis==='string'?wrapper.basis:null;
 const feedMeta=record(oracle?.feed),state=record(oracle?.state);
 if(!oracle||!feedMeta||!state)return invalid(`${name}_oracle_missing`);
 try{
  const decimals=Number(state.decimals);
  if(!Number.isInteger(decimals)||decimals<0||decimals>36)return invalid(`${name}_oracle_decimals_mismatch`);
  const persistedMax=Number(oracle.maxAgeSeconds),heartbeat=Number(feedMeta.heartbeatSeconds);
  const maxAge=Number.isSafeInteger(persistedMax)&&persistedMax>0?persistedMax:heartbeat;
  // Re-evaluate from the raw round data rather than trusting the stored flags.
  const evaluated=evaluateOracleRisk({feed:feedMeta as unknown as OracleFeedMetadata,
   state:state as unknown as OracleRoundState,blockTimestamp:BigInt(sourceTimestamp),maxPriceAgeSeconds:maxAge});
  const structural=evaluated.reasons.filter(reason=>reason!=='oracle_price_stale').map(reason=>`${name}_${reason}`);
  if(structural.length)return invalid(...structural);
  const age=evaluated.priceAgeSeconds;
  if(age===null||age<0)return invalid(`${name}_oracle_timestamp_future`);
  const answer=BigInt(String(state.answer));
  if(answer<=0n)return invalid(`${name}_oracle_answer_nonpositive`);
  const stale=evaluated.reasons.includes('oracle_price_stale');
  if(stale&&age>HELD_ORACLE_MAX_AGE_SECONDS)return invalid(`${name}_oracle_older_than_hold_limit`);
  const value=answer*WAD/10n**BigInt(decimals);
  if(value<=0n)return invalid(`${name}_oracle_answer_nonpositive`);
  return {value,feed:{name,state:stale?'stale':'fresh',price:String(value),
   updatedAt:new Date(Number(state.updatedAt)*1000).toISOString(),ageSeconds:age,strategyBasis,reasons:[]}};
 }catch{return invalid(`${name}_oracle_unreadable`);}
}

/**
 * Classify a stored reference proof.
 *  oracle_fresh      Every feed is within its age limit and no reason code was recorded.
 *  last_oracle_price Every feed is individually valid and at least one is past its age limit, and every recorded
 *                    reason code is freshness-only (or derived from one); valued at the last oracle answers.
 *  unavailable       Any structural reason, an invalid or missing feed, a persisted price that disagrees with the
 *                    proof, or a proof that contradicts its own reason codes.
 * `persistedPrices` are the prices the mark itself recorded (null when withheld); a non-null value must equal the
 * price derived from the proof.
 */
export function classifyReferenceBasis(input:{proof:unknown;reasons?:readonly unknown[];sourceTimestamp:number;
 persistedPrices?:{price0?:unknown;price1?:unknown;nativePrice?:unknown}|null}):ReferenceBasis{
 const reasons=[...new Set((input.reasons??[]).map(reason=>String(reason)))];
 const freshnessReasons=reasons.filter(reason=>classifyReferenceReason(reason)==='freshness');
 const structuralReasons=reasons.filter(reason=>classifyReferenceReason(reason)==='structural');
 const proof=record(input.proof);
 const none=(extra:string[]=[]):ReferenceBasis=>({kind:'unavailable',prices:null,feeds:[],asOf:null,freshnessReasons,
  structuralReasons:[...new Set([...structuralReasons,...extra])]});
 if(!proof||!record(proof.token0)||!record(proof.token1)||!proof.native||!Number.isSafeInteger(input.sourceTimestamp))
  return none(['reference_proof_incomplete']);
 const evaluated=(['token0','token1','native'] as const).map(name=>evaluateFeed(name,proof[name],input.sourceTimestamp));
 const feeds=evaluated.map(item=>item.feed);
 const feedFailures=feeds.flatMap(feed=>feed.reasons);
 const persisted=input.persistedPrices??null;
 const mismatches:string[]=[];
 for(const [index,key] of (['price0','price1','nativePrice'] as const).entries()){
  const stored=persisted?.[key];
  if(stored===null||stored===undefined)continue;
  if(typeof stored!=='string'||!/^[1-9][0-9]*$/.test(stored)||evaluated[index]!.value===null||
   BigInt(stored)!==evaluated[index]!.value)mismatches.push(`${feeds[index]!.name}_reference_price_mismatch`);
 }
 // Each recorded freshness code must name a feed that really is past its age limit.
 const inconsistent=freshnessReasons.filter(code=>feeds.find(feed=>feed.name===FEED_OF_FRESHNESS_REASON(code))?.state==='fresh')
  .map(()=> 'reference_proof_inconsistent');
 // A derived code only ever accompanies a real cause; on its own the proof contradicts itself.
 const derivedOnly=reasons.length>0&&freshnessReasons.length===0&&structuralReasons.length===0?['reference_proof_inconsistent']:[];
 const failed=[...structuralReasons,...feedFailures,...mismatches,...inconsistent,...derivedOnly];
 const base={feeds,freshnessReasons,structuralReasons:[...new Set(failed)]};
 const prices=evaluated.map(item=>item.value);
 const asOfFeed=feeds.filter(feed=>feed.updatedAt!==null).sort((a,b)=>Date.parse(a.updatedAt!)-Date.parse(b.updatedAt!))[0];
 const asOf=asOfFeed?{updatedAt:asOfFeed.updatedAt!,ageSeconds:asOfFeed.ageSeconds!}:null;
 if(failed.length||prices.some(price=>price===null))return {kind:'unavailable',prices:null,asOf,...base};
 const stale=feeds.some(feed=>feed.state==='stale');
 if(!stale&&reasons.length===0)return {kind:'oracle_fresh',prices:{price0:prices[0]!,price1:prices[1]!,nativePrice:prices[2]!},asOf,...base};
 // Only derived codes with every feed fresh would mean the proof contradicts its own reasons.
 if(!stale)return {kind:'unavailable',prices:null,asOf,...base,structuralReasons:[...new Set([...base.structuralReasons,'reference_proof_inconsistent'])]};
 return {kind:'last_oracle_price',prices:{price0:prices[0]!,price1:prices[1]!,nativePrice:prices[2]!},asOf,...base};
}

export interface PoolQuote{decimals0:number;decimals1:number;quoteToken:0|1}
const Q192=1n<<192n;
/** Price of the risk token in quote-token units, x18 and decimals-adjusted, from the pool's sqrt price. */
export function poolQuotePerRiskX18(sqrtPriceX96:bigint,pool:PoolQuote):bigint|null{
 if(sqrtPriceX96<=0n)return null;
 const quoteIsToken0=pool.quoteToken===0;
 const numerator=quoteIsToken0?Q192*10n**BigInt(pool.decimals1)*WAD:sqrtPriceX96*sqrtPriceX96*10n**BigInt(pool.decimals0)*WAD;
 const denominator=quoteIsToken0?sqrtPriceX96*sqrtPriceX96*10n**BigInt(pool.decimals0):Q192*10n**BigInt(pool.decimals1);
 return numerator/denominator;
}

export interface InventoryAmounts{token0Raw:bigint;token1Raw:bigint;nativeWei:bigint}
/** USD x18 value of an inventory at one set of oracle prices. */
export function valueInventory(amounts:InventoryAmounts,prices:{price0:bigint;price1:bigint;nativePrice:bigint},
 pool:Pick<PoolQuote,'decimals0'|'decimals1'>):bigint{
 return amounts.token0Raw*prices.price0/10n**BigInt(pool.decimals0)+
  amounts.token1Raw*prices.price1/10n**BigInt(pool.decimals1)+amounts.nativeWei*prices.nativePrice/WAD;
}

/**
 * Indicative value of an inventory at the pool's own price. The quote token is converted to USD with its own oracle
 * answer (fresh or held) and native gas with the native oracle answer; the risk token never uses an oracle. Returns
 * null when the pool price or either of those two conversions is unavailable. Never used for headline P&L,
 * accounting, the planner or trading.
 */
export function poolImpliedValue(input:{amounts:InventoryAmounts;sqrtPriceX96:bigint|null;pool:PoolQuote;
 quoteUsdX18:bigint|null;nativeUsdX18:bigint|null}):{valueX18:bigint;priceQuoteX18:bigint}|null{
 const {amounts,pool}=input;
 if(input.sqrtPriceX96===null||input.quoteUsdX18===null||input.nativeUsdX18===null||
  input.quoteUsdX18<=0n||input.nativeUsdX18<=0n)return null;
 const price=poolQuotePerRiskX18(input.sqrtPriceX96,pool);
 if(price===null||price<=0n)return null;
 const quoteIs0=pool.quoteToken===0,quoteRaw=quoteIs0?amounts.token0Raw:amounts.token1Raw,riskRaw=quoteIs0?amounts.token1Raw:amounts.token0Raw,
  quoteDecimals=quoteIs0?pool.decimals0:pool.decimals1,riskDecimals=quoteIs0?pool.decimals1:pool.decimals0;
 const quoteUsd=quoteRaw*input.quoteUsdX18/10n**BigInt(quoteDecimals);
 const riskQuoteX18=riskRaw*price/10n**BigInt(riskDecimals);
 const riskUsd=riskQuoteX18*input.quoteUsdX18/WAD;
 const nativeUsd=amounts.nativeWei*input.nativeUsdX18/WAD;
 return {valueX18:quoteUsd+riskUsd+nativeUsd,priceQuoteX18:price};
}
