import assert from 'node:assert/strict';
import test from 'node:test';
import {draftInput,staticManualParameters} from '../src/deployments/contracts.js';
import {resolveCenteredManualRange,resolveStaticManualRange} from '../src/deployments/centered-manual-range.js';

const limits={maxDeploymentValue:'1000000000',minDeploymentValue:'1',maxExposurePpm:1_000_000,
 maxLossValue:'1000000000',maxDrawdownPpm:1_000_000,maxActionCost:'1000000000',
 maxRollingCost:'1000000000',maxCampaignCost:'1000000000',exitReserveWei:'0',maxSlippageBps:50};

test('static setup accepts a half-width request and resolves it from the preview tick',()=>{
 const config=staticManualParameters.parse({halfWidthTicks:300,limits});
 const range=resolveStaticManualRange(config,-276324,60);
 assert.deepEqual(range,{requestedLower:-276600,requestedUpper:-276000,
  tickLower:-276600,tickUpper:-276000,fullWidthTicks:600,rounded:false,
  centerTick:-276324,centerAnchorTick:-276300,halfWidthTicks:300});
});

test('draft validation accepts centered setup parameters while the resolver rejects unsupported width or bounds',()=>{
 const parsed=draftInput.safeParse({mode:'paper',chainId:4663,
  wallet:'0x1111111111111111111111111111111111111111',
  marketProfileId:'aef5f51e-18ef-4e9c-952d-8d772970f708',strategyId:'static_manual_v1',
  strategyVersion:'1.0.0',stateSchemaVersion:1,
  allocation:{token0Raw:'0',token1Raw:'250000000',nativeWei:'0'},
  config:{halfWidthTicks:300,limits}});
 assert.equal(parsed.success,true);
 assert.throws(()=>resolveCenteredManualRange(0,301,60),/manual_half_width_not_spacing_aligned/);
 assert.throws(()=>resolveCenteredManualRange(887270,300,60),/manual_centered_range_tick_bounds/);
});
