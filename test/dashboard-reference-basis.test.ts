import assert from 'node:assert/strict';
import {test} from 'node:test';
import {evaluateOracleRisk} from '../src/risk/evaluate.js';
import {HELD_ORACLE_MAX_AGE_SECONDS,classifyReferenceBasis,classifyReferenceReason,poolImpliedValue,
 poolQuotePerRiskX18,valueInventory} from '../src/dashboard/reference-basis.js';

const TS=1_791_000_000,HOUR=3600;
const hash=`0x${'a'.repeat(64)}`,address=`0x${'1'.repeat(40)}`;
type OracleOptions={decimals?:number;description?:string;roundId?:string;answeredInRound?:string;maxAge?:number;
 heartbeat?:number;answer?:string;updatedAt?:number};
/** A real evaluateOracleRisk result, as the strategy stores it inside the reference proof. */
function oracle(base:string,answer:string,ageSeconds:number,options:OracleOptions={}){
 const updatedAt=options.updatedAt??TS-ageSeconds;
 return evaluateOracleRisk({blockTimestamp:BigInt(TS),maxPriceAgeSeconds:options.maxAge??180,
  feed:{address:address as `0x${string}`,baseAsset:base,decimals:8,heartbeatSeconds:options.heartbeat??86_400,marketHours:null,
   name:`${base}/USD`,productTypeCode:'x',quoteAsset:'USD'},
  state:{answer:options.answer??answer,answeredInRound:options.answeredInRound??'7',codeHash:hash as `0x${string}`,
   decimals:options.decimals??8,description:options.description??`${base}/USD`,roundId:options.roundId??'7',
   startedAt:String(updatedAt),updatedAt:String(updatedAt)}});
}
const USDG='100000000',AAPL='20000000000',ETH='300000000000';
const PRICES={price0:10n**18n,price1:200n*10n**18n,nativePrice:3000n*10n**18n};
function proof(parts:{stable?:unknown;stock?:unknown;native?:unknown;stockBasis?:string}={}){
 return {token0:{asset:null,oracle:parts.stable??oracle('USDG',USDG,30),basis:'heartbeat_valid'},
  token1:{asset:{registry:{symbol:'AAPL'}},oracle:parts.stock??oracle('AAPL',AAPL,30),basis:parts.stockBasis??'heartbeat_valid'},
  native:parts.native??oracle('ETH',ETH,30),registry:{},feedDirectory:{}};
}
const classify=(p:unknown,reasons:string[]=[],persisted:Record<string,unknown>|null=null)=>
 classifyReferenceBasis({proof:p,reasons,sourceTimestamp:TS,persistedPrices:persisted});

test('classifies every reference reason code explicitly: freshness-only, derived, or structural',()=>{
 const freshness=['token0_reference_age_unacceptable','token1_reference_age_unacceptable','native_oracle_price_stale'];
 for(const code of freshness)assert.equal(classifyReferenceReason(code),'freshness',code);
 assert.equal(classifyReferenceReason('reference_value_unavailable'),'derived');
 const structural=['risk_source_identity','market_session_unverified','token0_unsupported_stablecoin','token1_unsupported_stablecoin',
  'token0_asset_identity','token1_asset_identity','token0_asset_health','token1_asset_health','token0_oracle_missing',
  'token1_oracle_missing','token0_oracle_identity','token1_oracle_identity',
  ...['token0','token1','native'].flatMap(name=>['answer_nonpositive','decimals_mismatch','description_mismatch','round_incomplete',
   'timestamp_future','read_failed'].map(reason=>`${name}_oracle_${reason}`)),
  'native_oracle_missing','independent_reference_unavailable','some_future_reason'];
 for(const code of structural)assert.equal(classifyReferenceReason(code),'structural',code);
 assert.equal(classifyReferenceReason(undefined),'structural');
 assert.equal(classifyReferenceReason(42),'structural');
 // Near misses fail closed: the exact code names are the only freshness codes.
 for(const code of ['token2_reference_age_unacceptable','token1_oracle_price_stale','oracle_price_stale','native_reference_age_unacceptable',
  'token1_reference_age_unacceptable_extra'])assert.equal(classifyReferenceReason(code),'structural',code);
});

test('every feed within its age limit is an oracle-fresh basis with the prices derived from the proof',()=>{
 const basis=classify(proof(),[]);
 assert.equal(basis.kind,'oracle_fresh');assert.deepEqual(basis.prices,PRICES);
 assert.deepEqual(basis.feeds.map(feed=>[feed.name,feed.state,feed.price]),
  [['token0','fresh',String(PRICES.price0)],['token1','fresh',String(PRICES.price1)],['native','fresh',String(PRICES.nativePrice)]]);
 assert.equal(basis.asOf?.ageSeconds,30);assert.deepEqual(basis.structuralReasons,[]);
 assert.equal(classify(proof(),[],{price0:String(PRICES.price0),price1:String(PRICES.price1),nativePrice:String(PRICES.nativePrice)}).kind,'oracle_fresh');
});

test('a closed or slow off-hours market is valued at the last oracle answer, labeled with its time and age',()=>{
 const weekend=classify(proof({stock:oracle('AAPL',AAPL,38*HOUR)}),['token1_reference_age_unacceptable','reference_value_unavailable'],
  {price0:null,price1:null,nativePrice:String(PRICES.nativePrice)});
 assert.equal(weekend.kind,'last_oracle_price');assert.deepEqual(weekend.prices,PRICES);
 assert.deepEqual(weekend.freshnessReasons,['token1_reference_age_unacceptable']);assert.deepEqual(weekend.structuralReasons,[]);
 assert.equal(weekend.asOf?.ageSeconds,38*HOUR);assert.equal(weekend.asOf?.updatedAt,new Date((TS-38*HOUR)*1000).toISOString());
 const stock=weekend.feeds.find(feed=>feed.name==='token1')!;
 assert.equal(stock.state,'stale');assert.equal(stock.price,String(PRICES.price1),'the held price is the last answer, not zero');
 assert.equal(weekend.feeds.find(feed=>feed.name==='token0')!.state,'fresh');
 // The strategy itself accepted a held equity reference (no reason recorded) but the oracle reports priceFresh=false.
 const held=classify(proof({stock:oracle('AAPL',AAPL,20*HOUR),stockBasis:'held_equity_reference'}),[]);
 assert.equal(held.kind,'last_oracle_price');assert.equal(held.feeds.find(feed=>feed.name==='token1')!.strategyBasis,'held_equity_reference');
 // A slow native feed alone is also freshness-only.
 const slowNative=classify(proof({native:oracle('ETH',ETH,2*HOUR,{maxAge:180})}),['native_oracle_price_stale','reference_value_unavailable']);
 assert.equal(slowNative.kind,'last_oracle_price');assert.equal(slowNative.feeds.find(feed=>feed.name==='native')!.state,'stale');
 // A stale stablecoin feed is freshness-only too.
 assert.equal(classify(proof({stable:oracle('USDG',USDG,5*HOUR)}),['token0_reference_age_unacceptable','reference_value_unavailable']).kind,'last_oracle_price');
 // The label reports the oldest answer among all feeds.
 const mixed=classify(proof({stock:oracle('AAPL',AAPL,38*HOUR),native:oracle('ETH',ETH,2*HOUR)}),
  ['token1_reference_age_unacceptable','native_oracle_price_stale','reference_value_unavailable']);
 assert.equal(mixed.kind,'last_oracle_price');assert.equal(mixed.asOf?.ageSeconds,38*HOUR);
 // Exactly at the hold limit is still held; one second past it is a dead feed.
 assert.equal(classify(proof({stock:oracle('AAPL',AAPL,HELD_ORACLE_MAX_AGE_SECONDS)}),['token1_reference_age_unacceptable']).kind,'last_oracle_price');
 const dead=classify(proof({stock:oracle('AAPL',AAPL,HELD_ORACLE_MAX_AGE_SECONDS+1)}),['token1_reference_age_unacceptable']);
 assert.equal(dead.kind,'unavailable');assert.deepEqual(dead.structuralReasons,['token1_oracle_older_than_hold_limit']);assert.equal(dead.prices,null);
});

test('structural reference failures stay unavailable even when the feed is also stale',()=>{
 const stale=['token1_reference_age_unacceptable','reference_value_unavailable'];
 const cases:[string,unknown,string[],string][]=[
  ['asset health (corporate action, paused oracle, inactive registry)',proof({stock:oracle('AAPL',AAPL,38*HOUR)}),[...stale,'token1_asset_health'],'token1_asset_health'],
  ['asset identity',proof({stock:oracle('AAPL',AAPL,38*HOUR)}),[...stale,'token1_asset_identity'],'token1_asset_identity'],
  ['unverified market session',proof({stock:oracle('AAPL',AAPL,38*HOUR)}),[...stale,'market_session_unverified'],'market_session_unverified'],
  ['unsupported stablecoin',proof({stock:oracle('AAPL',AAPL,38*HOUR)}),[...stale,'token0_unsupported_stablecoin'],'token0_unsupported_stablecoin'],
  ['unrecognized future reason code',proof({stock:oracle('AAPL',AAPL,38*HOUR)}),[...stale,'brand_new_reason'],'brand_new_reason'],
  ['feed description mismatch',proof({stock:oracle('AAPL',AAPL,38*HOUR,{description:'SPY/USD'})}),stale,'token1_oracle_description_mismatch'],
  ['feed decimals mismatch',proof({stock:oracle('AAPL',AAPL,38*HOUR,{decimals:6})}),stale,'token1_oracle_decimals_mismatch'],
  ['incomplete round',proof({stock:oracle('AAPL',AAPL,38*HOUR,{roundId:'9',answeredInRound:'8'})}),stale,'token1_oracle_round_incomplete'],
  ['future timestamp',proof({stock:oracle('AAPL',AAPL,0,{updatedAt:TS+60})}),['token1_reference_age_unacceptable'],'token1_oracle_timestamp_future'],
  ['non-positive answer',proof({stock:oracle('AAPL','0',38*HOUR)}),stale,'token1_oracle_answer_nonpositive'],
  ['native structural failure',proof({native:oracle('ETH',ETH,2*HOUR,{description:'BTC/USD'})}),['native_oracle_price_stale'],'native_oracle_description_mismatch'],
  ['stablecoin round incomplete',proof({stable:oracle('USDG',USDG,5*HOUR,{roundId:'9',answeredInRound:'1'})}),['token0_reference_age_unacceptable'],'token0_oracle_round_incomplete'],
 ];
 for(const [name,p,reasons,expected] of cases){
  const basis=classify(p,reasons);
  assert.equal(basis.kind,'unavailable',name);assert.equal(basis.prices,null,name);
  assert(basis.structuralReasons.includes(expected),`${name}: ${JSON.stringify(basis.structuralReasons)}`);
 }
 assert.equal(classify(proof({stock:{...oracle('AAPL',AAPL,38*HOUR),state:null}}),stale).kind,'unavailable','missing oracle round');
 assert.equal(classify(proof({stock:{feed:{},state:{answer:'x'}}}),stale).kind,'unavailable','malformed oracle evidence');
 assert.equal(classify({token0:proof().token0,token1:proof().token1},stale).kind,'unavailable','missing native feed');
 assert.equal(classify(null,stale).kind,'unavailable');assert.equal(classify('proof',stale).kind,'unavailable');
 assert.equal(classify(proof({stock:oracle('AAPL',AAPL,38*HOUR)}),['reference_value_unavailable']).kind,'unavailable',
  'a derived code never stands on its own');
});

test('a proof that contradicts its reasons or the prices the mark recorded is unavailable',()=>{
 const everyFeedFresh=classify(proof(),['token1_reference_age_unacceptable','reference_value_unavailable']);
 assert.equal(everyFeedFresh.kind,'unavailable');assert(everyFeedFresh.structuralReasons.includes('reference_proof_inconsistent'));
 const wrongFeed=classify(proof({stock:oracle('AAPL',AAPL,38*HOUR)}),['native_oracle_price_stale','reference_value_unavailable']);
 assert.equal(wrongFeed.kind,'unavailable','a freshness reason must name a feed that is actually stale');
 const onlyDerived=classify(proof(),['reference_value_unavailable']);assert.equal(onlyDerived.kind,'unavailable');
 const persistedDiffers=classify(proof({stock:oracle('AAPL',AAPL,38*HOUR)}),['token1_reference_age_unacceptable'],
  {price1:String(PRICES.price1+1n)});
 assert.equal(persistedDiffers.kind,'unavailable');assert(persistedDiffers.structuralReasons.includes('token1_reference_price_mismatch'));
 assert.equal(classify(proof({stock:oracle('AAPL',AAPL,38*HOUR)}),['token1_reference_age_unacceptable'],{price1:'0'}).kind,'unavailable');
 assert.equal(classify(proof({stock:oracle('AAPL',AAPL,38*HOUR)}),['token1_reference_age_unacceptable'],{price1:String(PRICES.price1)}).kind,
  'last_oracle_price','a recorded price that matches the proof is accepted');
 // Stored flags are not trusted: stale data with a flag claiming freshness is still re-evaluated from the round.
 const forged=oracle('AAPL',AAPL,38*HOUR) as any;forged.flags={...forged.flags,priceFresh:true};
 assert.equal(classify(proof({stock:forged}),[]).kind,'last_oracle_price');
});

test('values an inventory at held oracle prices with the accounting formula',()=>{
 const pool={decimals0:6,decimals1:18};
 const amounts={token0Raw:50_000_000n,token1Raw:5n*10n**17n,nativeWei:10n**16n};
 assert.equal(valueInventory(amounts,PRICES,pool),180n*10n**18n,'50 USDG + 0.5 AAPL at 200 + 0.01 ETH at 3000');
 assert.equal(valueInventory({token0Raw:0n,token1Raw:0n,nativeWei:0n},PRICES,pool),0n);
 const held=classify(proof({stock:oracle('AAPL',AAPL,38*HOUR)}),['token1_reference_age_unacceptable']);
 assert.equal(valueInventory(amounts,held.prices!,pool),180n*10n**18n,'a held price values inventory exactly like a fresh one');
});

test('pool-implied value uses the pool price for the risk token and oracle answers only for quote and native conversion',()=>{
 const pool={decimals0:6,decimals1:18,quoteToken:0 as const},amounts={token0Raw:50_000_000n,token1Raw:5n*10n**17n,nativeWei:10n**16n};
 const sqrtTick0=1n<<96n;
 assert.equal(poolQuotePerRiskX18(sqrtTick0,pool),10n**12n*10n**18n,'tick 0 with 6/18 decimals is 1e12 quote per risk token');
 assert.equal(poolQuotePerRiskX18(0n,pool),null);
 const exact=poolImpliedValue({amounts,sqrtPriceX96:sqrtTick0,pool,quoteUsdX18:10n**18n,nativeUsdX18:3000n*10n**18n})!;
 assert.equal(exact.valueX18,50n*10n**18n+5n*10n**29n+30n*10n**18n);
 // A realistic pool near 220 quote per risk token values the 0.5 token at about 110.
 const near=poolImpliedValue({amounts,sqrtPriceX96:sqrtRatio(222390),pool,quoteUsdX18:10n**18n,nativeUsdX18:3000n*10n**18n})!;
 const asNumber=Number(near.valueX18/10n**12n)/1e6;
 assert(asNumber>180&&asNumber<200,`pool-implied NAV ${asNumber} sits near, but not at, the oracle value`);
 assert.notEqual(near.valueX18,180n*10n**18n);
 // Quote on token1: the risk token is token0 and the quote leg is token1.
 const flipped=poolImpliedValue({amounts:{token0Raw:5n*10n**17n,token1Raw:50_000_000n,nativeWei:0n},sqrtPriceX96:sqrtTick0,
  pool:{decimals0:18,decimals1:6,quoteToken:1},quoteUsdX18:10n**18n,nativeUsdX18:3000n*10n**18n})!;
 assert(flipped.valueX18>0n);
 for(const missing of [{quoteUsdX18:null},{nativeUsdX18:null},{sqrtPriceX96:null},{quoteUsdX18:0n},{nativeUsdX18:0n}])
  assert.equal(poolImpliedValue({amounts,sqrtPriceX96:sqrtTick0,pool,quoteUsdX18:10n**18n,nativeUsdX18:3n,...missing} as any),null,
   JSON.stringify(missing,(_,v)=>typeof v==='bigint'?String(v):v));
});

function sqrtRatio(tick:number):bigint{
 // Independent reconstruction with floating point is too coarse; reuse the repository helper.
 return sqrtRatioAtTickRef(tick);
}
import {sqrtRatioAtTick as sqrtRatioAtTickRef} from '../src/backtest/principal.js';
