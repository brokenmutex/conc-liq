import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error Dashboard browser module intentionally stays plain JavaScript.
import {capitalToQuoteRaw,formatSetupCreatedAt,formatSetupTokenAmount,humanSetupLimitsToRaw,rawSetupLimitsToHuman,reviewStaticPaperDraftBinding,setupNativeAllocationToWei,suggestedNativeAllocationWei,suggestedSetupLimits} from '../dashboard/tabs.js';
// @ts-expect-error JavaScript browser module has no declaration file.
import {createOperatorSession} from '../dashboard/operator-session.js';

// Track 1a / U5 — number and unit formatting edge cases not already covered by
// test/dashboard-setup.test.ts and test/dashboard-setup-binding.test.ts.

test('formatSetupTokenAmount treats an absent, null, empty, negative or fractional raw amount as unavailable, never as zero',()=>{
 assert.equal(formatSetupTokenAmount(undefined,6,'AAPL'),'Unavailable AAPL');
 assert.equal(formatSetupTokenAmount(null,6,'AAPL'),'Unavailable AAPL');
 assert.equal(formatSetupTokenAmount('',6,'AAPL'),'Unavailable AAPL');
 // A negative raw amount is silently downgraded to "Unavailable" rather than
 // flagged as an invalid or corrupt value; an operator sees no distinction
 // between "no data" and "the server sent something malformed".
 assert.equal(formatSetupTokenAmount('-100',6,'AAPL'),'Unavailable AAPL');
 assert.equal(formatSetupTokenAmount('123.45',6,'AAPL'),'Unavailable AAPL');
});

test('formatSetupTokenAmount falls back to the raw-units caption for null, empty, negative, non-integer and absurd (>36) decimals',()=>{
 const rawCaption='123456789 raw AAPL (decimals unavailable)';
 assert.equal(formatSetupTokenAmount('123456789',null,'AAPL'),rawCaption);
 assert.equal(formatSetupTokenAmount('123456789','','AAPL'),rawCaption);
 assert.equal(formatSetupTokenAmount('123456789',-1,'AAPL'),rawCaption);
 assert.equal(formatSetupTokenAmount('123456789',6.5,'AAPL'),rawCaption);
 assert.equal(formatSetupTokenAmount('123456789',37,'AAPL'),rawCaption);
 // 36 decimals is accepted at the documented boundary and renders a very
 // small fraction rather than being rejected.
 assert.equal(formatSetupTokenAmount('123456789',36,'AAPL'),'0.000000000000000000000000000123456789 AAPL');
});

test('formatSetupCreatedAt renders EDT immediately before and EST immediately after the 2026-11-01 fall-back instant',()=>{
 // The US eastern fall-back happens at 2:00 AM EDT (06:00 UTC) on 2026-11-01,
 // when clocks return to 1:00 AM EST.
 assert.match(formatSetupCreatedAt('2026-11-01T05:59:00.000Z'),/Nov 1, 2026, 1:59\s?AM EDT/);
 assert.match(formatSetupCreatedAt('2026-11-01T06:00:00.000Z'),/Nov 1, 2026, 1:00\s?AM EST/);
});

test('formatSetupCreatedAt returns Unavailable for an absent, undefined or invalid timestamp',()=>{
 assert.equal(formatSetupCreatedAt(),'Unavailable');
 assert.equal(formatSetupCreatedAt(undefined),'Unavailable');
 assert.equal(formatSetupCreatedAt('not-a-date'),'Unavailable');
});

test('capitalToQuoteRaw accepts the documented 100,000 USDG ceiling and sub-cent fractions down to one raw unit',()=>{
 assert.equal(capitalToQuoteRaw('100000'),'100000000000');
 assert.equal(capitalToQuoteRaw('100000.000001'),null);
 // 0.000001 USDG is a hundredth of a cent; still a single valid raw unit.
 assert.equal(capitalToQuoteRaw('0.000001'),'1');
});

test('humanSetupLimitsToRaw accepts percent-style fields exactly at their documented ceiling and rejects one unit past it',()=>{
 const base={maxDeploymentValue:'250',minDeploymentValue:'0.1',maxExposurePpm:'95',
  maxLossValue:'12.5',maxDrawdownPpm:'10',maxActionCost:'12.5',maxRollingCost:'25',
  maxCampaignCost:'37.5',exitReserveWei:'0.001',maxSlippageBps:'0.5'};
 assert.equal(humanSetupLimitsToRaw({...base,maxExposurePpm:'100'})?.maxExposurePpm,1_000_000);
 assert.equal(humanSetupLimitsToRaw({...base,maxExposurePpm:'100.0001'}),null);
 assert.equal(humanSetupLimitsToRaw({...base,maxDrawdownPpm:'100'})?.maxDrawdownPpm,1_000_000);
 assert.equal(humanSetupLimitsToRaw({...base,maxDrawdownPpm:'100.0001'}),null);
 assert.equal(humanSetupLimitsToRaw({...base,maxSlippageBps:'5'})?.maxSlippageBps,500);
 assert.equal(humanSetupLimitsToRaw({...base,maxSlippageBps:'5.01'}),null);
 assert.equal(humanSetupLimitsToRaw({...base,minDeploymentValue:'300'}),null);
 assert.equal(humanSetupLimitsToRaw({...base,maxActionCost:'30'}),null);
});

test('humanSetupLimitsToRaw/rawSetupLimitsToHuman round-trip a sub-cent value exactly and normalize a trailing-zero fraction',()=>{
 const base={maxDeploymentValue:'250',minDeploymentValue:'0.1',maxExposurePpm:'95',
  maxLossValue:'0.001',maxDrawdownPpm:'10',maxActionCost:'0.001',maxRollingCost:'25',
  maxCampaignCost:'37.5',exitReserveWei:'0.001',maxSlippageBps:'0.5'};
 const raw=humanSetupLimitsToRaw(base);
 assert.equal(raw?.maxLossValue,'1000000000000000');
 assert.equal(rawSetupLimitsToHuman(raw)?.maxLossValue,'0.001');
 // A trailing-zero fraction the operator typed ("0.100") is not preserved on
 // the round trip; the reverse conversion always emits the shortest decimal.
 const trailing=humanSetupLimitsToRaw({...base,minDeploymentValue:'0.100'});
 assert.equal(trailing?.minDeploymentValue,'100000000000000000');
 assert.equal(rawSetupLimitsToHuman(trailing)?.minDeploymentValue,'0.1');
});

test('setupNativeAllocationToWei rejects an exact zero allocation but accepts a single wei',()=>{
 assert.equal(setupNativeAllocationToWei('0'),null);
 assert.equal(setupNativeAllocationToWei('0.000000000000000001'),'1');
});

test('suggestedNativeAllocationWei sums to zero when every bound is zero, to one wei when only the open bound is nonzero, and uses the reserve when it exactly equals the close bound',()=>{
 assert.equal(suggestedNativeAllocationWei({openBoundWei:'0',closeBoundWei:'0',exitReserveWei:'0'}),'0');
 assert.equal(suggestedNativeAllocationWei({openBoundWei:'1',closeBoundWei:'0',exitReserveWei:'0'}),'1');
 // The close/reserve comparison is a strict ">"; when they are exactly equal
 // the reserve branch is taken, which is the same numeric result either way
 // but is worth pinning so a future change to the comparison is caught.
 assert.equal(suggestedNativeAllocationWei({openBoundWei:'100',closeBoundWei:'200',exitReserveWei:'200'}),'300');
});

test('suggestedSetupLimits derives limits that already satisfy every normalizeSetupLimits invariant, from a sub-millionth capital up to the 100,000 USDG ceiling',()=>{
 for(const capital of ['0.000001','0.5','250','100000']){
  const suggested=suggestedSetupLimits(capital);
  assert.ok(suggested,`suggestedSetupLimits(${capital}) should return a value`);
  const normalized=humanSetupLimitsToRaw(suggested!);
  assert.ok(normalized,`suggested limits for capital ${capital} must pass normalizeSetupLimits`);
  assert.ok(BigInt(normalized!.minDeploymentValue as string)<=BigInt(normalized!.maxDeploymentValue as string));
  assert.ok(BigInt(normalized!.maxActionCost as string)<=BigInt(normalized!.maxRollingCost as string));
  assert.ok(BigInt(normalized!.maxActionCost as string)<=BigInt(normalized!.maxCampaignCost as string));
  assert.ok((normalized!.maxExposurePpm as number)<=1_000_000);
  assert.ok((normalized!.maxDrawdownPpm as number)<=1_000_000);
  assert.ok((normalized!.maxSlippageBps as number)<=500);
 }
});

// Track 1a / U6 — staleness reachable from the exported modules.
//
// Almost all staleness rendering (the source-age suffix `condition()` appends,
// and the fact that value/P&L/fee figures keep rendering with full confidence
// beside it) lives in dashboard/app.js, which has zero exports and is
// unreachable from a unit test — see the CRITICAL CONSTRAINT in this track's
// brief. The one staleness rule reachable through an exported symbol is the
// 180-second preflight source freshness window enforced inside
// reviewStaticPaperDraftBinding (dashboard/tabs.js:206-207). It is exercised
// here at its exact boundary and for a future (clock-skew) source timestamp,
// which the existing dashboard-setup-binding.test.ts does not cover — that
// file only exercises a source 181 seconds stale.

test('reviewStaticPaperDraftBinding treats a preflight source exactly 180 seconds old as fresh and one millisecond older as expired',()=>{
 const wallet='0x1111111111111111111111111111111111111111';
 const profileId='67b2b303-e821-4450-bb7b-27171b12079f';
 const limits={maxDeploymentValue:'100000000000000000000',minDeploymentValue:'1000000000000000000',
  maxExposurePpm:'1000000',maxLossValue:'1000000000000000000',maxDrawdownPpm:'900000',
  maxActionCost:'1000000000000000000',maxRollingCost:'2000000000000000000',
  maxCampaignCost:'3000000000000000000',exitReserveWei:'1000000000000000',maxSlippageBps:'50'};
 const base={kind:'paper_setup_preflight',status:'available',mode:'paper',strategyId:'static_manual_v1',
  profileId,profileHash:'c'.repeat(64),input:{capitalQuoteRaw:'250000000',halfWidthTicks:240},
  profile:{pool:'0x2222222222222222222222222222222222222222',fee:3000,tickSpacing:60},
  range:{tickLower:-120,tickUpper:360},
  requirements:{token0Raw:'123456789',token1Raw:'250000000'}};
 const now=1_000_000_000_000;
 const withAge=(ageMs:number)=>({...base,source:{block:'12345',hash:`0x${'a'.repeat(64)}`,
  timestamp:Math.floor((now-ageMs)/1000)}});
 assert.equal(reviewStaticPaperDraftBinding({walletAddress:wallet,preflight:withAge(180_000),nativeWei:'1000000000000000',limits,now}).status,'reviewable');
 const expired=reviewStaticPaperDraftBinding({walletAddress:wallet,preflight:withAge(180_001),nativeWei:'1000000000000000',limits,now});
 assert.equal(expired.status,'incomplete');
 assert(expired.status==='incomplete'&&expired.missing.includes('preflight_source_expired'));
});

test('reviewStaticPaperDraftBinding flags a future (clock-skewed) preflight source timestamp as expired using the same reason as an old one',()=>{
 const wallet='0x1111111111111111111111111111111111111111';
 const profileId='67b2b303-e821-4450-bb7b-27171b12079f';
 const limits={maxDeploymentValue:'100000000000000000000',minDeploymentValue:'1000000000000000000',
  maxExposurePpm:'1000000',maxLossValue:'1000000000000000000',maxDrawdownPpm:'900000',
  maxActionCost:'1000000000000000000',maxRollingCost:'2000000000000000000',
  maxCampaignCost:'3000000000000000000',exitReserveWei:'1000000000000000',maxSlippageBps:'50'};
 const now=1_000_000_000_000;
 const preflight={kind:'paper_setup_preflight',status:'available',mode:'paper',strategyId:'static_manual_v1',
  profileId,profileHash:'c'.repeat(64),input:{capitalQuoteRaw:'250000000',halfWidthTicks:240},
  profile:{pool:'0x2222222222222222222222222222222222222222',fee:3000,tickSpacing:60},
  range:{tickLower:-120,tickUpper:360},
  requirements:{token0Raw:'123456789',token1Raw:'250000000'},
  // Source timestamp five seconds ahead of the caller's clock.
  source:{block:'12345',hash:`0x${'a'.repeat(64)}`,timestamp:Math.floor((now+5000)/1000)}};
 const result=reviewStaticPaperDraftBinding({walletAddress:wallet,preflight,nativeWei:'1000000000000000',limits,now});
 assert.equal(result.status,'incomplete');
 // A future source and a stale source produce the identical opaque reason
 // string; an operator cannot tell "the evidence is old" from "my clock (or
 // the server's) is wrong" from this signal alone.
 assert(result.status==='incomplete'&&result.missing.includes('preflight_source_expired'));
});

// Track 1a / U7 — error legibility through createOperatorSession with a
// stubbed fetchImpl. operator-session.js's rawRequest() rethrows `data.error`
// verbatim as the Error message (dashboard/operator-session.js:27), so every
// assertion below intentionally checks for the raw snake_case server
// identifier rather than an operator-legible sentence, because no such
// sentence exists at this layer. If a future change makes any of these
// messages more legible, the matching assertion here is expected to fail and
// should be updated to the improved text; if a change makes one of these
// worse (for example replacing the code with an unrelated generic string),
// the exact-match assertion is expected to fail loudly for that reason too.
function response(status:number,data:unknown){return {ok:status>=200&&status<300,status,json:async()=>data};}

test('the command service\'s non-401 error codes reach the caller as their exact raw snake_case identifier, in one request with no retry',async()=>{
 // Status codes below are taken from the actual send sites in
 // src/dashboard/server.ts and src/deployments/server.ts, not invented.
 const cases:[string,number][]=[
  ['invalid_position_request',400],
  ['position_not_found',404],
  ['dashboard_read_source_unavailable',503],
  ['origin_mismatch',403],
  ['csrf_mismatch',403],
  ['paper_setup_draft_list_unavailable',503],
  ['request_too_large',413],
  ['json_content_type_required',415],
  ['invalid_json',400],
 ];
 for(const [code,status] of cases){
  let calls=0;
  const session=createOperatorSession({fetchImpl:async(path:string)=>{
   if(path==='/api/session')return response(200,{csrfToken:'csrf',expiresInSeconds:14_400});
   calls++;return response(status,{error:code});
  }});
  await session.bootstrap();
  await assert.rejects(
   session.request('/api/x',{method:'POST',body:{},csrf:true}),
   (error:any)=>{
    // This is the load-bearing assertion for U7: the message a caller
    // receives IS the raw identifier, not a sentence.
    assert.equal(error.message,code);
    assert.equal(error.status,status);
    assert.equal(error.data.error,code);
    return true;
   },
  );
  assert.equal(calls,1,`${code} must not be retried`);
  assert.equal(session.isReady(),true,`a non-401 error must not clear the session for ${code}`);
 }
});

test('a single 401 authentication_required renews the session once and silently retries the identical request',async()=>{
 let sessions=0,calls=0;
 const session=createOperatorSession({fetchImpl:async(path:string)=>{
  if(path==='/api/session'){sessions++;return response(200,{csrfToken:`csrf-${sessions}`,expiresInSeconds:14_400});}
  calls++;
  if(calls===1)return response(401,{error:'authentication_required'});
  return response(200,{status:'accepted'});
 }});
 await session.bootstrap();
 const result=await session.request('/api/x',{method:'POST',body:{},csrf:true});
 assert.deepEqual(result,{status:'accepted'});
 assert.equal(sessions,2);assert.equal(calls,2);assert.equal(session.isReady(),true);
});

test('a retry that also answers 401 authentication_required surfaces the same raw identifier and leaves the session unauthenticated, without a third attempt',async()=>{
 let sessions=0,calls=0;
 const session=createOperatorSession({fetchImpl:async(path:string)=>{
  if(path==='/api/session'){sessions++;return response(200,{csrfToken:`csrf-${sessions}`,expiresInSeconds:14_400});}
  calls++;return response(401,{error:'authentication_required'});
 }});
 await session.bootstrap();
 await assert.rejects(
  session.request('/api/x',{method:'POST',body:{},csrf:true}),
  (error:any)=>{assert.equal(error.message,'authentication_required');assert.equal(error.status,401);return true;},
 );
 // Exactly one bootstrap session plus one renewal, and exactly two protected
 // attempts (the original plus the single retry) — a third attempt would
 // mean the single-retry guarantee regressed.
 assert.equal(sessions,2);assert.equal(calls,2);assert.equal(session.isReady(),false);
});

test('a non-401 error (csrf_mismatch) is never retried even though it is also an auth-adjacent rejection',async()=>{
 let sessions=0,calls=0;
 const session=createOperatorSession({fetchImpl:async(path:string)=>{
  if(path==='/api/session'){sessions++;return response(200,{csrfToken:'csrf',expiresInSeconds:14_400});}
  calls++;return response(403,{error:'csrf_mismatch'});
 }});
 await session.bootstrap();
 await assert.rejects(
  session.request('/api/x',{method:'POST',body:{},csrf:true}),
  (error:any)=>{assert.equal(error.message,'csrf_mismatch');assert.equal(error.status,403);return true;},
 );
 assert.equal(sessions,1,'no renewal session request should be attempted for a non-401');
 assert.equal(calls,1,'a 403 must not be retried the way a 401 is');
 assert.equal(session.isReady(),true,'csrf_mismatch is 403, not 401, so the held token is not discarded');
});
