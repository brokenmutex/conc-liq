import assert from 'node:assert/strict';
import { it } from 'node:test';
// @ts-expect-error Dashboard browser module intentionally stays plain JavaScript.
import { capitalToQuoteRaw, formatSetupCreatedAt, formatSetupTokenAmount, humanSetupLimitsToRaw, openAcceptancePathFor, setupDraftPathFor, preflightFacts, rawSetupLimitsToHuman, setupNativeAllocationToWei, setupPreflightPathFor, setupPreflightRequest, suggestedNativeAllocationWei, suggestedSetupLimits, LIVE_SETUP_PREFLIGHT_PATH, LIVE_SETUP_ADMISSION_PATH, LIVE_WALLET_PATH, liveSetupAdmissionRequest, liveSetupAdmissionResult, liveSetupPreflightFacts, liveSetupPreflightRequest, liveWalletFacts, liveRetainPreviewPathFor, liveRetainOperationPathFor, liveRetainPreviewCanBeAccepted, liveRetainAcceptPayload, liveRetainAcceptResult } from '../dashboard/tabs.js';

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

it('converts human setup limits and native amounts to exact integer units', () => {
  const human={maxDeploymentValue:'250',minDeploymentValue:'0.1',maxExposurePpm:'95',
    maxLossValue:'12.5',maxDrawdownPpm:'10',maxActionCost:'12.5',maxRollingCost:'25',
    maxCampaignCost:'37.5',exitReserveWei:'0.001',maxSlippageBps:'0.5'};
  const raw=humanSetupLimitsToRaw(human);
  assert.deepEqual(raw,{maxDeploymentValue:'250000000000000000000',minDeploymentValue:'100000000000000000',
    maxExposurePpm:950000,maxLossValue:'12500000000000000000',maxDrawdownPpm:100000,
    maxActionCost:'12500000000000000000',maxRollingCost:'25000000000000000000',
    maxCampaignCost:'37500000000000000000',exitReserveWei:'1000000000000000',maxSlippageBps:50});
  assert.deepEqual(rawSetupLimitsToHuman(raw),human);
  assert.equal(setupNativeAllocationToWei('0.001'),'1000000000000000');
  assert.equal(setupNativeAllocationToWei('0.0000000000000000001'),null);
  assert.equal(humanSetupLimitsToRaw({...human,maxDeploymentValue:'0.0000000000000000001'}),null);
});

it('formats saved token allocations with registered decimals and creation time in New York time', () => {
  assert.equal(formatSetupTokenAmount('123456789', 6, 'AAPL'), '123.456789 AAPL');
  assert.equal(formatSetupTokenAmount('250000000', 6, 'USDG'), '250 USDG');
  assert.equal(formatSetupTokenAmount('123456789', undefined, 'AAPL'), '123456789 raw AAPL (decimals unavailable)');
  assert.match(formatSetupCreatedAt('2026-07-01T16:00:00.000Z'), /Jul 1, 2026.*12:00 PM EDT/);
  assert.equal(formatSetupCreatedAt('not-a-date'), 'Unavailable');
});

it('scales editable defaults from capital and derives native allocation from exact reviewed bounds', () => {
  assert.deepEqual(suggestedSetupLimits('250'),{maxDeploymentValue:'250',minDeploymentValue:'1',
    maxExposurePpm:'95',maxLossValue:'12.5',maxDrawdownPpm:'10',maxActionCost:'12.5',
    maxRollingCost:'25',maxCampaignCost:'37.5',exitReserveWei:'0.001',maxSlippageBps:'0.5'});
  assert.equal(suggestedSetupLimits('0.5')?.minDeploymentValue,'0.05');
  assert.equal(suggestedNativeAllocationWei({openBoundWei:'100',closeBoundWei:'250',exitReserveWei:'200'}),'420');
  assert.equal(suggestedNativeAllocationWei({openBoundWei:'100',closeBoundWei:'250',exitReserveWei:'400'}),'600');
  assert.equal(suggestedNativeAllocationWei({openBoundWei:'invalid',closeBoundWei:'1',exitReserveWei:'1'}),null);
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
    ['Budget remaining · raw USDG', '56'], ['Cost estimate',
      'Provisional fork estimate. Expected values use the gas-price observation shown; bound values are the reviewed admission cap, not paid gas.'],
    ['Open gas · expected / bound', '100 / 120 units'], ['Open cost · expected / bound · USDG', '3.000000 / 4.000000'],
    ['Admission limits', 'Not evaluated'],
  ]);
});

const rangeKeeperHumanLimits=()=>({
  ...suggestedSetupLimits('250','rangekeeper_v1') as Record<string,string>,
});

it('binds live review to a registered profile, RangeKeeper width, capital and complete limits',()=>{
  const limits=humanSetupLimitsToRaw(rangeKeeperHumanLimits(),'rangekeeper_v1');
  assert(limits);
  assert.equal(LIVE_SETUP_PREFLIGHT_PATH,'/api/deployments/rangekeeper/live-setup-preflight');
  assert.equal(LIVE_WALLET_PATH,'/api/deployments/live-wallet');
  assert.deepEqual(liveSetupPreflightRequest({pool:profile,capital:'250',fullWidthSpacings:'20',limits,liveSetup:true}),
    {available:true,payload:{profileId:profile.marketProfileId,capitalQuoteRaw:'250000000',fullWidthSpacings:20,limits}});
  assert.equal(liveSetupPreflightRequest({pool:profile,capital:'250',fullWidthSpacings:'20',limits,liveSetup:false}).available,false);
  assert.equal(liveSetupPreflightRequest({pool:profile,capital:'250',fullWidthSpacings:'21',limits,liveSetup:true}).available,false);
});

it('renders live wallet reserves and live review blockers without implying action availability',()=>{
  assert.deepEqual(liveWalletFacts({status:'available',walletAddress:'0x1111111111111111111111111111111111111111',source:'canonical',
    tokens:[{symbol:'USDG',balanceRaw:'100',allocatedRaw:'20',pendingRaw:'5',availableRaw:'75'}],
    native:{balanceWei:'1000',allocatedWei:'200',pendingWei:'50',exitReserveWei:'100',availableWei:'650'}}),[
      ['Wallet status','available'],['Server wallet','0x1111111111111111111111111111111111111111 · canonical'],
      ['USDG balance / allocated / pending / available · raw','100 / 20 / 5 / 75'],
      ['Native balance / allocated / pending / exit reserve / available','1000 / 200 / 50 / 100 / 650']]);
  const facts=liveSetupPreflightFacts({kind:'rangekeeper_live_setup_preflight',mode:'live',strategyId:'rangekeeper_v1',status:'indicative',
    actionAvailable:false,draftCreationAvailable:false,executionEligible:false,missing:['reference_unavailable'],
    requirements:{token0Raw:'12'},costs:{status:'unavailable'},profile:{pool:'0x222',fee:3000}}) as [string,string][];
  assert(facts.some(([key,value])=>key==='Review status'&&value==='Indicative estimate · no action available'));
  assert(facts.some(([key,value])=>key==='Missing evidence / blockers'&&value==='reference_unavailable'));
  const funding=liveSetupPreflightFacts({status:'indicative',allocation:{nativeWei:'500000000000000000'},
    costs:{status:'estimated',managementGasReserveWei:'12000000000000000',fundedManagementBundles:0}}) as [string,string][];
  assert(funding.some(([key,value])=>key==='Native gas allocation'&&value==='500000000000000000 wei'));
  assert(funding.some(([key,value])=>key==='Management gas reserve · wei'&&value==='12000000000000000'));
  assert(funding.some(([key,value])=>key==='Funded management bundles'&&value==='Unlimited by count limit'));
});

it('admits only a fresh persisted live review when catalog and preview both expose admission',()=>{
  const now=Date.now(),preflight={kind:'rangekeeper_live_setup_preflight',mode:'live',strategyId:'rangekeeper_v1',
    status:'indicative',actionAvailable:false,draftCreationAvailable:false,operationAcceptanceAvailable:false,
    executionEligible:false,admissionAvailable:true,reviewPersistence:{status:'persisted',
      reviewId:'67b2b303-e821-4450-bb7b-27171b12079f',reviewHash:'a'.repeat(64),
      expiresAt:new Date(now+60_000).toISOString()}},requestId='11111111-1111-4111-8111-111111111111';
  assert.equal(LIVE_SETUP_ADMISSION_PATH,'/api/deployments/rangekeeper/live-setup-admit');
  assert.deepEqual(liveSetupAdmissionRequest({preflight,liveAdmission:true,requestId,now}),{available:true,payload:{
    reviewId:preflight.reviewPersistence.reviewId,reviewHash:preflight.reviewPersistence.reviewHash,requestId}});
  assert.equal(liveSetupAdmissionRequest({preflight,liveAdmission:false,requestId,now}).available,false);
  assert.equal(liveSetupAdmissionRequest({preflight:{...preflight,admissionAvailable:false},liveAdmission:true,requestId,now}).available,false);
  assert.equal(liveSetupAdmissionRequest({preflight:{...preflight,executionEligible:true},liveAdmission:true,requestId,now}).available,false);
  assert.equal(liveSetupAdmissionRequest({preflight:{...preflight,reviewPersistence:{...preflight.reviewPersistence,status:'unavailable'}},liveAdmission:true,requestId,now}).available,false);
  assert.equal(liveSetupAdmissionRequest({preflight:{...preflight,reviewPersistence:{...preflight.reviewPersistence,expiresAt:new Date(now-1).toISOString()}},liveAdmission:true,requestId,now}).available,false);
  assert.equal(liveSetupAdmissionRequest({preflight,liveAdmission:true,requestId:'bad',now}).available,false);
});

it('recognizes a queued admission by its durable ids whatever execution fields an older or newer server sends',()=>{
  const queued={status:'queued',campaignId:'67b2b303-e821-4450-bb7b-27171b12079f',
    jobId:'11111111-1111-4111-8111-111111111111',allocationId:'22222222-2222-4222-8222-222222222222',
    replayed:false,executionEligible:false,reason:'rangekeeper_live_execution_unavailable'};
  assert.equal(liveSetupAdmissionResult(queued),true);
  // A supervised worker may report different execution fields; acceptance rests on the durable ids.
  assert.equal(liveSetupAdmissionResult({...queued,executionEligible:true}),true);
  assert.equal(liveSetupAdmissionResult({...queued,reason:undefined,executionEligible:undefined}),true);
  assert.equal(liveSetupAdmissionResult({...queued,status:'unavailable'}),false);
  assert.equal(liveSetupAdmissionResult({...queued,jobId:'malformed'}),false);
  assert.equal(liveSetupAdmissionResult({...queued,allocationId:undefined}),false);
  assert.equal(liveSetupAdmissionResult({...queued,replayed:'no'}),false);
});

it('builds retain-only routes and accepts only a current persisted preview, never execution eligibility',()=>{
 const id='67b2b303-e821-4450-bb7b-27171b12079f',now=Date.now(),preview={kind:'rangekeeper_live_retain_preview',
  mode:'live',strategyId:'rangekeeper_v1',status:'indicative',trustedPreviewSaved:true,previewId:id,
  contentDigest:'a'.repeat(64),expectedRevision:2,expiresAt:new Date(now+30_000).toISOString(),
  source:{block:'123',hash:`0x${'b'.repeat(64)}`,timestamp:Math.floor(now/1000)},
  actionAvailable:true,operationAcceptanceAvailable:true,executionEligible:false};
 assert.equal(liveRetainPreviewPathFor(id),`/api/deployments/${id}/live/retain-preview`);
 assert.equal(liveRetainOperationPathFor(id),`/api/deployments/${id}/live/retain-operations`);
 assert.equal(liveRetainPreviewCanBeAccepted(preview,now),true);
 assert.deepEqual(liveRetainAcceptPayload(preview,id,now),{previewId:id,contentDigest:'a'.repeat(64),
  expectedRevision:2,idempotencyKey:id});
 assert.equal(liveRetainPreviewCanBeAccepted({...preview,executionEligible:true},now),false);
 assert.equal(liveRetainPreviewCanBeAccepted({...preview,operationAcceptanceAvailable:false},now),false);
 assert.equal(liveRetainPreviewCanBeAccepted({...preview,source:{...preview.source,timestamp:Math.floor(now/1000)-181}},now),false);
 assert.equal(liveRetainPreviewCanBeAccepted({...preview,previewId:'not-a-uuid'},now),false);
 const queued={status:'queued',campaignId:id,jobId:'11111111-1111-4111-8111-111111111111',
  allocationId:'22222222-2222-4222-8222-222222222222',replayed:false,executionEligible:false,
  reason:'rangekeeper_live_execution_unavailable'};
 assert.equal(liveRetainAcceptResult(queued,id),true);
 assert.equal(liveRetainAcceptResult({...queued,campaignId:'33333333-3333-4333-8333-333333333333'},id),false);
 assert.equal(liveRetainAcceptResult({...queued,status:'failed'},id),false);
 assert.equal(liveRetainAcceptResult({...queued,executionEligible:true},id),true,'acceptance rests on durable ids, not legacy execution fields');
 assert.equal(liveRetainAcceptResult({...queued,jobId:'bad'},id),false);
 assert.equal(liveRetainAcceptResult({...queued,replayed:undefined},id),false);
});

it('routes the RangeKeeper setup review to its own endpoint', () => {
  assert.equal(setupPreflightPathFor('rangekeeper_v1'), '/api/deployments/rangekeeper/setup-preflight');
  assert.equal(setupPreflightPathFor('static_manual_v1'), '/api/deployments/setup-preflight');
});

it('binds a RangeKeeper setup review to an even full width in tick spacings', () => {
  const limits=humanSetupLimitsToRaw(rangeKeeperHumanLimits(),'rangekeeper_v1');
  assert(limits,'suggested RangeKeeper limits must normalize');
  const ok=setupPreflightRequest({pool:profile,capital:'250',strategyId:'rangekeeper_v1',
    mode:'paper',limits,fullWidthSpacings:'20'});
  assert.equal(ok.available,true);
  assert.equal(ok.payload.fullWidthSpacings,20);
  assert.equal(ok.payload.capitalQuoteRaw,'250000000');
  // No halfWidthTicks: RangeKeeper centers its own range on the observed tick.
  assert.equal('halfWidthTicks' in ok.payload,false);
  for(const width of ['21','0','2002','','abc']){
    assert.equal(setupPreflightRequest({pool:profile,capital:'250',strategyId:'rangekeeper_v1',
      mode:'paper',limits,fullWidthSpacings:width}).available,false,`width ${width} must be refused`);
  }
  // Limits are required for RangeKeeper, unlike the static contract.
  assert.equal(setupPreflightRequest({pool:profile,capital:'250',strategyId:'rangekeeper_v1',
    mode:'paper',fullWidthSpacings:'20'}).available,false);
});

it('enforces the RangeKeeper limit bounds the kernel would otherwise reject after a fork sample', () => {
  const base=rangeKeeperHumanLimits();
  assert(humanSetupLimitsToRaw(base,'rangekeeper_v1'),'baseline must normalize');
  // RangeKeeper caps slippage at 50bps; static/manual allows 500.
  assert.equal(humanSetupLimitsToRaw({...base,maxSlippageBps:'0.5'},'rangekeeper_v1')!.maxSlippageBps,50);
  assert.equal(humanSetupLimitsToRaw({...base,maxSlippageBps:'0.51'},'rangekeeper_v1'),null);
  assert(humanSetupLimitsToRaw({...base,maxSlippageBps:'0.51'},'static_manual_v1'),
    'the same slippage stays valid for static/manual');
  // The contract allows 30..90, but a gap at or near 30 leaves no window to take
  // a second observation in: the kernel refuses one less than 30s after the first
  // and more than `gap` after it, so the window is (gap - 30) wide. The form
  // refuses below 45 so an operator cannot configure an un-openable campaign.
  for(const gap of ['30','44','91'])
    assert.equal(humanSetupLimitsToRaw({...base,maxObservationGapSeconds:gap},'rangekeeper_v1'),null,
      `gap ${gap} must be refused`);
  for(const gap of ['45','90'])
    assert(humanSetupLimitsToRaw({...base,maxObservationGapSeconds:gap},'rangekeeper_v1'),`gap ${gap} is valid`);
  // Zero recentres is meaningful: it pins a campaign to its entry.
  assert.equal(humanSetupLimitsToRaw({...base,maxRecenters:'0'},'rangekeeper_v1')!.maxRecenters,0);
  // Every other limit still refuses a zero.
  assert.equal(humanSetupLimitsToRaw({...base,maxSwapInputValue:'0'},'rangekeeper_v1'),null);
  // A static payload is missing the seven RangeKeeper fields entirely.
  assert.equal(humanSetupLimitsToRaw(suggestedSetupLimits('250') as Record<string,string>,'rangekeeper_v1'),null);
});

it('round-trips RangeKeeper limits through their displayed units', () => {
  const raw=humanSetupLimitsToRaw(rangeKeeperHumanLimits(),'rangekeeper_v1');
  assert(raw);
  const human=rawSetupLimitsToHuman(raw,'rangekeeper_v1');
  assert(human);
  assert.equal(human.maxObservationGapSeconds,'90');
  assert.equal(human.maxSlippageBps,'0.5');
  assert.equal(Object.keys(human).length,17);
});

it('routes a RangeKeeper open acceptance to its own operation endpoint', () => {
  const id='67b2b303-e821-4450-bb7b-27171b12079f';
  assert.equal(openAcceptancePathFor(id,'rangekeeper_v1'),
    `/api/deployments/${id}/rangekeeper/open-operations`);
  assert.equal(openAcceptancePathFor(id,'static_manual_v1'),
    `/api/deployments/${id}/open-operations`);
});

it('routes a RangeKeeper setup draft to its own admission endpoint', () => {
  assert.equal(setupDraftPathFor('rangekeeper_v1'),'/api/deployments/rangekeeper/setup-drafts');
  assert.equal(setupDraftPathFor('static_manual_v1'),'/api/deployments/setup-drafts');
});
