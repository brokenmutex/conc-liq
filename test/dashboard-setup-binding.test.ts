import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error Dashboard browser module intentionally stays plain JavaScript.
import {preflightFacts,reviewStaticPaperDraftBinding,setupNativeAllocationSuggestionFor,suggestedSetupLimits,humanSetupLimitsToRaw} from '../dashboard/tabs.js';

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

test('RangeKeeper setup review creates its exact admission body and binds the reviewed limits',()=>{
 const limits=humanSetupLimitsToRaw(suggestedSetupLimits('250','rangekeeper_v1') as Record<string,string>,
  'rangekeeper_v1');
 assert(limits);
 const rk={...preflight,kind:'rangekeeper_paper_setup_preflight',strategyId:'rangekeeper_v1',
  setupReviewId:'77b2b303-e821-4450-bb7b-27171b120799',
  input:{capitalQuoteRaw:'250000000',fullWidthSpacings:20,limits},
  profile:{...preflight.profile,token0:'0x3333333333333333333333333333333333333333',
   token1:'0x4444444444444444444444444444444444444444',quoteToken:1},
  range:{tickLower:-600,tickUpper:600,centerTick:0,fullWidthSpacings:20},
  requirements:{...preflight.requirements,liquidity:'987654',referenceValueQuoteRaw:'245000000',
   budgetResidualQuoteRaw:'5000000',deployedValueUsdX18:'245000000000000000000',sharePpm:'100',
   sizingConvention:'maximize_v3_liquidity_under_independent_reference_quote_budget_then_kernel_sized'},
  references:{price0:'1000000000000000000',price1:'1000000000000000000',nativePrice:'2000000000000000000',
   proofHash:'d'.repeat(64)},
  costs:{status:'provisional',scope:'range_keeper_open_and_retain_exit_gas_only',
   retainExit:{boundWei:'800',requiredReserveWei:'500'}}};
 const result=reviewStaticPaperDraftBinding({walletAddress:wallet,preflight:rk,nativeWei:'2000',limits});
 assert.equal(result.status,'reviewable');
 if(result.status!=='reviewable')return;
 const body=result.binding.admissionRequest;
 assert.equal(body.reviewId,rk.setupReviewId);
 assert.equal(body.profileId,profileId);
 assert.equal(body.fullWidthSpacings,20);
 assert.equal('halfWidthTicks' in body,false);
 assert.equal(body.wallet,wallet);
 assert.deepEqual(body.allocation,{token0Raw:preflight.requirements.token0Raw,
  token1Raw:preflight.requirements.token1Raw,nativeWei:'2000'});
 assert.deepEqual(body.limits,limits);
 assert.deepEqual(body.reviewed,{profileId:rk.profileId,profileHash:rk.profileHash,input:rk.input,
  source:rk.source,profile:rk.profile,range:rk.range,requirements:rk.requirements,
  references:rk.references,costs:rk.costs});
 assert.equal(result.binding.proposedDraft.strategyId,'rangekeeper_v1');
 assert.equal(result.binding.proposedDraft.config.fullWidthSpacings,20);
 assert.equal('halfWidthTicks' in result.binding.proposedDraft.config,false);
 const changed={...limits,maxRecenters:4};
 const stale=reviewStaticPaperDraftBinding({walletAddress:wallet,preflight:rk,nativeWei:'2000',limits:changed});
 assert.equal(stale.status,'incomplete');
 if(stale.status==='incomplete')assert(stale.missing.includes('rangekeeper_limits_changed_since_cost_preparation'));
});

test('RangeKeeper setup facts and native suggestion use retainExit costs',()=>{
 const preflight={strategyId:'rangekeeper_v1',costs:{open:{boundWei:'100'},
  retainExit:{expectedGasUnits:'20',boundGasUnits:'30',expectedValue:'40',boundValue:'50',boundWei:'800',requiredReserveWei:'1100'},
  closeRetain:{boundWei:'9000'}}};
 assert.deepEqual(preflightFacts(preflight).filter(([label]:[string,string])=>label.startsWith('Retain close')),
  [['Retain close gas · expected / bound','20 / 30 units'],
   ['Retain close cost · expected / bound · USDG','0.000000 / 0.000000']]);
 // 100 open + max(800 retain, max(500 configured, 1100 modeled reserve)),
 // then the helper's 20% headroom.
 assert.equal(setupNativeAllocationSuggestionFor(preflight,{exitReserveWei:'500'}),'1440');
});
