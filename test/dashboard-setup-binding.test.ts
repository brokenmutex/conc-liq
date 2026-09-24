import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error Dashboard browser module intentionally stays plain JavaScript.
import {reviewStaticPaperDraftBinding} from '../dashboard/tabs.js';

const wallet='0x1111111111111111111111111111111111111111';
const profileId='67b2b303-e821-4450-bb7b-27171b12079f';
const limits={maxDeploymentValue:'100000000000000000000',minDeploymentValue:'1000000000000000000',
 maxExposurePpm:'1000000',maxLossValue:'1000000000000000000',maxDrawdownPpm:'900000',
 maxActionCost:'1000000000000000000',maxRollingCost:'2000000000000000000',
 maxCampaignCost:'3000000000000000000',exitReserveWei:'1000000000000000',maxSlippageBps:'50'};
const preflight={kind:'paper_setup_preflight',status:'available',mode:'paper',strategyId:'static_manual_v1',
 profileId,profileHash:'c'.repeat(64),input:{capitalQuoteRaw:'250000000',halfWidthTicks:240},
 profile:{pool:'0x2222222222222222222222222222222222222222',fee:3000,tickSpacing:60},
 source:{block:'12345',hash:`0x${'a'.repeat(64)}`,timestamp:Math.floor(Date.now()/1000)},
 range:{tickLower:-120,tickUpper:360},
 requirements:{token0Raw:'123456789',token1Raw:'250000000'}};

test('setup binding preserves exact preview allocation, profile and source without claiming a campaign revision',()=>{
 const result=reviewStaticPaperDraftBinding({walletAddress:wallet,preflight,nativeWei:'1000000000000000',limits});
 assert.equal(result.status,'reviewable');
 if(result.status!=='reviewable')return;
 assert.equal(result.binding.profileId,profileId);
 assert.equal(result.binding.profileHash,preflight.profileHash);
 assert.equal(result.binding.source.hash,preflight.source.hash);
 assert.equal(result.binding.campaignRevision,null);
 assert.deepEqual(result.binding.proposedDraft.allocation,{token0Raw:'123456789',token1Raw:'250000000',
  nativeWei:'1000000000000000'});
 assert.equal(result.binding.proposedDraft.config.halfWidthTicks,240);
 assert.equal(result.binding.proposedDraft.config.limits.maxActionCost,'1000000000000000000');
});

test('setup binding stays incomplete for missing wallet, reserve, limits or stale source',()=>{
 const missing=reviewStaticPaperDraftBinding({walletAddress:'',preflight,nativeWei:'',limits:{}});
 assert.equal(missing.status,'incomplete');
 assert(missing.missing.includes('wallet_address_invalid_or_missing'));
 assert(missing.missing.includes('proposed_native_allocation_wei_missing'));
 assert(missing.missing.some((reason:string)=>reason.startsWith('static_limit_')));
 const stale=reviewStaticPaperDraftBinding({walletAddress:wallet,preflight:{...preflight,
  source:{...preflight.source,timestamp:Math.floor(Date.now()/1000)-181}},nativeWei:'1',limits});
 assert.equal(stale.status,'incomplete');
 assert(stale.missing.includes('preflight_source_expired'));
});

test('setup binding rejects nonsensical unit ranges and cost or deployment ordering',()=>{
 const invalid=reviewStaticPaperDraftBinding({walletAddress:wallet,preflight,nativeWei:'1',limits:{...limits,
  maxExposurePpm:'1000001',maxSlippageBps:'501',minDeploymentValue:'200000000000000000000',
  maxActionCost:'3000000000000000000',maxCampaignCost:'2000000000000000000'}});
 assert.equal(invalid.status,'incomplete');
 assert(invalid.missing.includes('static_limit_maxExposurePpm_out_of_range'));
 assert(invalid.missing.includes('static_limit_maxSlippageBps_out_of_range'));
 assert(invalid.missing.includes('static_minimum_deployment_exceeds_maximum'));
 assert(invalid.missing.includes('static_action_cost_exceeds_rolling_limit'));
 assert(invalid.missing.includes('static_action_cost_exceeds_campaign_limit'));
});
