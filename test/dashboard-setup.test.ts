import assert from 'node:assert/strict';
import { it } from 'node:test';
// @ts-expect-error Dashboard browser module intentionally stays plain JavaScript.
import { capitalToQuoteRaw, preflightFacts, setupPreflightRequest } from '../dashboard/tabs.js';

const profile = { poolAddress: '0x1111111111111111111111111111111111111111',
  marketProfileId: '67b2b303-e821-4450-bb7b-27171b12079f', tickSpacing: 60 };

it('binds setup preflight to exact USDG raw units and a registered centered width', () => {
  assert.equal(capitalToQuoteRaw('250'), '250000000');
  assert.equal(capitalToQuoteRaw('1.000001'), '1000001');
  assert.equal(capitalToQuoteRaw('0'), null);
  assert.equal(capitalToQuoteRaw('100001'), null);
  assert.equal(capitalToQuoteRaw('1.0000001'), null);
  assert.deepEqual(setupPreflightRequest({ pool: profile, capital: '250', halfWidthTicks: '240',
    strategyId: 'static_manual_v1', mode: 'paper' }), { available: true, payload: {
    profileId: profile.marketProfileId, capitalQuoteRaw: '250000000', halfWidthTicks: 240,
  } });
});

it('keeps unsupported setup choices and unbound profiles unavailable without sending a request', () => {
  assert.equal(setupPreflightRequest({ pool: profile, capital: '250', halfWidthTicks: '240',
    strategyId: 'rangekeeper_v1', mode: 'paper' }).available, false);
  assert.equal(setupPreflightRequest({ pool: profile, capital: '250', halfWidthTicks: '240',
    strategyId: 'static_manual_v1', mode: 'live' }).available, false);
  assert.match(setupPreflightRequest({ pool: { ...profile, marketProfileId: undefined }, capital: '250',
    halfWidthTicks: '240', strategyId: 'static_manual_v1', mode: 'paper' }).reason!, /profile ID is missing/);
  assert.match(setupPreflightRequest({ pool: profile, capital: '250', halfWidthTicks: '241',
    strategyId: 'static_manual_v1', mode: 'paper' }).reason!, /tick spacing/);
});

it('sends explicit limits with raw, PPM and bps units intact for preparation', () => {
  const limits={maxDeploymentValue:'100000000000000000000',minDeploymentValue:'1',maxExposurePpm:'950000',
    maxLossValue:'1000000000000000000',maxDrawdownPpm:'100000',maxActionCost:'1000000000000000000',
    maxRollingCost:'2000000000000000000',maxCampaignCost:'3000000000000000000',
    exitReserveWei:'1000000000000000',maxSlippageBps:'50'};
  const request=setupPreflightRequest({pool:profile,capital:'250',halfWidthTicks:'240',
    strategyId:'static_manual_v1',mode:'paper',limits});
  assert.equal(request.available,true);
  assert.deepEqual(request.payload.limits,{...limits,maxExposurePpm:950000,maxDrawdownPpm:100000,maxSlippageBps:50});
  assert.equal(setupPreflightRequest({pool:profile,capital:'250',halfWidthTicks:'240',
    strategyId:'static_manual_v1',mode:'paper',limits:{...limits,exitReserveWei:'0'}}).available,false);
});

it('shows fresh bounds and exact inventory facts without implying acceptance', () => {
  assert.deepEqual(preflightFacts({ source: { block: 123 }, range: {
    centerTick: 10, centerAnchorTick: 0, tickLower: -240, tickUpper: 240,
    lowerPriceQuotePerBaseX18: '1000000000000000000',
    upperPriceQuotePerBaseX18: '2000000000000000000',
  }, profile: { pool: '0x3333333333333333333333333333333333333333', fee: 500,
    token0: '0x1111111111111111111111111111111111111111', token1: '0x2222222222222222222222222222222222222222' },
  requirements: { token0Raw: '12', token1Raw: '34', budgetResidualQuoteRaw: '56' },
    costs: { status: 'provisional', open: { expectedGasUnits: '100', boundGasUnits: '120', expectedValue: '3000000000000000000', boundValue: '4000000000000000000' } },
    admissionLimits: { status: 'not_evaluated' } }), [
    ['Registered pool / fee tier', '0x3333333333333333333333333333333333333333 · 500'],
    ['Confirmed source block', '123'], ['Observed center tick', '10'], ['Aligned center tick', '0'],
    ['Tick bounds', '-240 to 240'], ['Price bounds · USDG per token', '1.000000 to 2.000000'],
    ['Token 0 required · raw · 0x111111…11111', '12'], ['Token 1 required · raw · 0x222222…22222', '34'],
    ['Budget remaining · raw USDG', '56'], ['Cost estimate', 'Provisional fork estimate'],
    ['Open gas · expected / bound', '100 / 120 units'], ['Open cost · expected / bound · USDG', '3.000000 / 4.000000'],
    ['Admission limits', 'Not evaluated'],
  ]);
});
