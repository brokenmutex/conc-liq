import assert from 'node:assert/strict';
import {test} from 'node:test';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {contentHash,type DraftInput} from '../src/deployments/contracts.js';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import {pinnedExternalReferenceProofIdentityHash} from '../src/deployments/pinned-external-reference-proof.js';
import {createRangeKeeperPaperDraftFromSetup,rangeKeeperPaperSetupReviewBinding} from
 '../src/deployments/rangekeeper-paper-draft-admission.js';

const now=Date.now(),profileId='00000000-0000-4000-8000-000000000001';
const token1='0x7000000000000000000000000000000000000001',hash=`0x${'a'.repeat(64)}`;
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,
 pool:'0x8000000000000000000000000000000000000001',token0:USDG,token1,quoteToken:0,
 decimals0:6,decimals1:6,fee:3000,tickSpacing:60,positionManager:NONFUNGIBLE_POSITION_MANAGER,
 router:PAPER_ROUTER,quoter:PAPER_QUOTER,poolCodeHash:hash,token0CodeHash:hash,token1CodeHash:hash,
 managerCodeHash:hash,quoterCodeHash:hash,reference0:'USDG/USD',reference1:'TOKEN/USD',
 nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{
 token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
 nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}});
const profileHash=contentHash(profile);
const referenceProof={token0:{oracle:{answer:'100',updatedAt:123,feed:{address:'0x0000000000000000000000000000000000000001'}}},
 token1:{oracle:{answer:'200',updatedAt:123,feed:{address:'0x0000000000000000000000000000000000000002'}}},
 native:{answer:'300',updatedAt:123},
 registry:{fetchedAt:new Date(now-2_000).toISOString(),sha256:`sha256:${'a'.repeat(64)}`,
  url:'https://references.example/registry.json'},
 feedDirectory:{fetchedAt:new Date(now-2_000).toISOString(),sha256:`sha256:${'b'.repeat(64)}`,
  url:'https://references.example/feeds.json'}};
const limits={maxDeploymentValue:String(100n*10n**18n),minDeploymentValue:String(1n*10n**18n),
 minDeploymentPpm:10_000,maxSwapInputValue:String(10n*10n**18n),maxSwapInputPpm:1_000_000,
 maxSwapShortfallValue:String(1n*10n**18n),maxSlippageBps:50,
 maxActionCost:String(5n*10n**18n),maxRollingCost:String(8n*10n**18n),maxCampaignCost:String(16n*10n**18n),
 maxExposurePpm:1_000_000,maxLossValue:String(10n*10n**18n),maxDrawdownPpm:1_000_000,maxRecenters:5,
 maxLiquiditySharePpm:1_000_000,maxObservationGapSeconds:90,exitReserveWei:'1000000000000000'};
const openStages=['open_approve_manager_token0','open_approve_manager_token1','open_mint'],
 exitStages=['exit_withdraw_collect','exit_cleanup_router_token0','exit_cleanup_router_token1',
  'exit_cleanup_manager_token0','exit_cleanup_manager_token1'];
const costs={status:'provisional' as const,scope:'range_keeper_open_and_retain_exit_gas_only' as const,
 evidenceClass:'fork_estimated' as const,pathVersion:'paper_rangekeeper_v1_no_swap_v1',
 sizeBand:`rk_${'0'.repeat(32)}`,
 profileIds:[...openStages,...exitStages].map((stage,index)=>
  ({stage,id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,version:1})),
 marketGasPriceWei:'1000000000',boundGasPriceWei:'1250000000',gasPriceObservedAt:new Date(now).toISOString(),
 nativeReferencePrice:String(2000n*10n**18n),swapFeeAndShortfallValue:'0',
 open:{expectedGasUnits:'300000',boundGasUnits:'360000',expectedWei:'300000000000000',
  boundWei:'450000000000000',expectedValue:'600000000000000000',boundValue:'900000000000000000'},
 retainExit:{expectedGasUnits:'300000',boundGasUnits:'360000',expectedWei:'300000000000000',
  boundWei:'450000000000000',expectedValue:'600000000000000000',boundValue:'900000000000000000',
  requiredReserveWei:'1000000000000000'},unavailable:[] as string[]};
const preflight={schemaVersion:1,kind:'rangekeeper_paper_setup_preflight',status:'available',mode:'paper',
 strategyId:'rangekeeper_v1',profileId,profileHash,
 input:{capitalQuoteRaw:'100000000',fullWidthSpacings:120,limits},
 source:{block:'100',hash:`0x${'b'.repeat(64)}`,timestamp:Math.floor(now/1000)},
 profile:{pool:profile.pool.pool,fee:profile.pool.fee,tickSpacing:profile.pool.tickSpacing,
  token0:profile.pool.token0,token1:profile.pool.token1,quoteToken:profile.pool.quoteToken},
 range:{tickLower:-3600,tickUpper:3600,centerTick:0,fullWidthSpacings:120},
 requirements:{liquidity:'1000000',token0Raw:'50000000',token1Raw:'49000000',
  referenceValueQuoteRaw:'99000000',budgetResidualQuoteRaw:'1000000',deployedValueUsdX18:'99000000000000000000',
  sharePpm:'100',
  sizingConvention:'maximize_v3_liquidity_under_independent_reference_quote_budget_then_kernel_sized' as const},
 references:{price0:String(10n**18n),price1:String(10n**18n),nativePrice:String(2000n*10n**18n),
  proofHash:referenceProofHash(referenceProof),
  proofIdentityHash:pinnedExternalReferenceProofIdentityHash(referenceProof)},costs,
 admissionLimits:{status:'not_evaluated'},missing:[] as string[],
 actionAvailable:false,draftCreated:false,operationCreated:false};
const input=()=>({profileId,capitalQuoteRaw:'100000000',fullWidthSpacings:120,
 reviewId:'00000000-0000-4000-8000-000000000077',
 requestId:'00000000-0000-4000-8000-000000000088',
 wallet:'0x1111111111111111111111111111111111111111',
 allocation:{token0Raw:'50000000',token1Raw:'49000000',nativeWei:'2000000000000000'},limits,
 reviewed:rangeKeeperPaperSetupReviewBinding(preflight)});
const deps=(overrides:Record<string,unknown>={})=>({
 runPreflight:async()=>preflight,
 lookupCapturedReview:()=>({costs:structuredClone(costs)}),
 loadProfile:async(id:string)=>({id,profile,profileHash}),
 findDraftRequest:async()=>null,
 createDraftWithRequestId:async(_requestId:string,draft:DraftInput)=>({status:'created' as const,
  id:'00000000-0000-4000-8000-000000000099',revision:1,configHash:contentHash(draft.config)}),
 now:()=>now,...overrides,
});

test('rangekeeper setup draft admission rechecks canonical binding and limits, creating only a guarded paper draft',async()=>{
 let created:DraftInput|undefined,preflightCalls=0,pinnedSource:unknown;
 const result=await createRangeKeeperPaperDraftFromSetup(input(),deps({
  runPreflight:async(_request:unknown,source:unknown)=>{preflightCalls++;pinnedSource=source;return preflight;},
  createDraftWithRequestId:async(_requestId:string,draft:DraftInput)=>{created=draft;return {status:'created' as const,
   id:'00000000-0000-4000-8000-000000000099',revision:1,configHash:contentHash(draft.config)};},
 }));
 assert.equal(result.status,'draft_created');
 if(result.status==='draft_created')assert.equal(result.replayed,false);
 assert.equal(preflightCalls,1);
 assert.deepEqual(pinnedSource,preflight.source);
 assert(created);
 assert.equal(created.mode,'paper');
 assert.equal(created.strategyId,'rangekeeper_v1');
 assert.deepEqual(created.allocation,input().allocation);
 assert.deepEqual(created.config,{fullWidthSpacings:120,limits});
 if(result.status==='draft_created'){
  assert.equal(result.profileId,profileId);
  assert.deepEqual(result.range,{tickLower:-3600,tickUpper:3600});
 }
});

test('rangekeeper setup admission is idempotent on request id and never re-sizes a matching saved draft',async()=>{
 let preflightCalls=0;
 const result=await createRangeKeeperPaperDraftFromSetup(input(),deps({
  runPreflight:async()=>{preflightCalls++;return preflight;},
  findDraftRequest:async()=>({status:'found' as const,id:'00000000-0000-4000-8000-000000000099',
   revision:1,configHash:'f'.repeat(64)}),
 }));
 assert.equal(result.status,'draft_created');
 if(result.status==='draft_created')assert.equal(result.replayed,true);
 assert.equal(preflightCalls,0,'a replayed request must not re-run the canonical preflight');
});

test('rangekeeper setup admission fails a conflicting request id without creating or sizing anything',async()=>{
 const result=await createRangeKeeperPaperDraftFromSetup(input(),deps({
  findDraftRequest:async()=>({status:'conflict' as const}),
  runPreflight:async()=>{throw new Error('must not run preflight on conflict');},
 }));
 assert.equal(result.status,'request_conflict');
});

test('rangekeeper setup admission rejects a changed reviewed source, allocation, or profile before creating a draft',async()=>{
 const sourceChanged=await createRangeKeeperPaperDraftFromSetup(input(),
  deps({runPreflight:async()=>({...preflight,source:{...preflight.source,block:'101'}})}));
 assert.equal(sourceChanged.status,'unavailable');
 const allocationChanged=await createRangeKeeperPaperDraftFromSetup(
  {...input(),allocation:{...input().allocation,token0Raw:'1'}},deps());
 assert.equal(allocationChanged.status,'unavailable');
 if(allocationChanged.status==='unavailable')
  assert(allocationChanged.missing.includes('setup_allocation_does_not_match_fresh_preflight'));
 const profileChanged=await createRangeKeeperPaperDraftFromSetup(input(),
  deps({loadProfile:async(id:string)=>({id,profile,profileHash:'0'.repeat(64)})}));
 assert.equal(profileChanged.status,'unavailable');
});

test('rangekeeper setup admission fails closed when submitted limits cannot be resolved by the kernel',async()=>{
 const badLimits={...limits,minDeploymentValue:limits.maxDeploymentValue},
  badPreflight={...preflight,input:{...preflight.input,limits:badLimits}},
  request={...input(),limits:badLimits,reviewed:rangeKeeperPaperSetupReviewBinding(badPreflight)};
 const result=await createRangeKeeperPaperDraftFromSetup(request,deps({runPreflight:async()=>badPreflight}));
 assert.equal(result.status,'unavailable');
 if(result.status==='unavailable')
  assert(result.missing[0]!.includes('rangekeeper_min_deployment_value_not_enforced_by_kernel'));
});

test('rangekeeper setup refresh permits only transport-derived band drift after exact reference and cost checks',async()=>{
 const refreshedProof=structuredClone(referenceProof);
 refreshedProof.registry.fetchedAt=new Date(now).toISOString();
 const refreshed={...preflight,references:{...preflight.references,
  proofHash:referenceProofHash(refreshedProof),
  proofIdentityHash:pinnedExternalReferenceProofIdentityHash(refreshedProof)},
  costs:{...costs,sizeBand:`rk_${'1'.repeat(32)}`}};
 const accepted=await createRangeKeeperPaperDraftFromSetup(input(),deps({runPreflight:async()=>refreshed}));
 assert.equal(accepted.status,'draft_created');
 const changedReference=await createRangeKeeperPaperDraftFromSetup(input(),deps({runPreflight:async()=>({
  ...refreshed,references:{...refreshed.references,proofIdentityHash:'c'.repeat(64)}})}));
 assert.equal(changedReference.status,'unavailable');
 const changedGas=await createRangeKeeperPaperDraftFromSetup(input(),deps({runPreflight:async()=>({
  ...refreshed,costs:{...refreshed.costs,open:{...costs.open,boundGasUnits:'360001'}}})}));
 assert.equal(changedGas.status,'unavailable');
});

test('rangekeeper setup admission preserves bounded refresh failures without exposing arbitrary errors',async()=>{
 for(const [missing,expected] of [
  [['fresh_source_stale'],['fresh_canonical_setup_preflight_unavailable','fresh_source_stale']],
  [['https://private.invalid/token?secret=1'],['fresh_canonical_setup_preflight_unavailable']],
 ] as const){
  const result=await createRangeKeeperPaperDraftFromSetup(input(),deps({
   runPreflight:async()=>({status:'unavailable',missing})}));
  assert.equal(result.status,'unavailable');
  if(result.status==='unavailable')assert.deepEqual(result.missing,expected);
 }
});

test('rangekeeper setup admission rejects a native allocation below the bound open cost plus exit reserve',async()=>{
 const shortNative={...input(),allocation:{...input().allocation,nativeWei:'1'}};
 const result=await createRangeKeeperPaperDraftFromSetup(shortNative,deps());
 assert.equal(result.status,'unavailable');
 if(result.status==='unavailable')assert(result.missing.includes('native_allocation_below_cost_and_exit_reserve'));
});

test('rangekeeper setup admission rejects provisional cost that exceeds the reviewed action or campaign limits',async()=>{
 const tightLimits={...limits,maxActionCost:'1',maxRollingCost:'1',maxCampaignCost:'1'},
  tightPreflight={...preflight,input:{...preflight.input,limits:tightLimits}},
  request={...input(),limits:tightLimits,reviewed:rangeKeeperPaperSetupReviewBinding(tightPreflight)};
 const result=await createRangeKeeperPaperDraftFromSetup(request,deps({runPreflight:async()=>tightPreflight}));
 assert.equal(result.status,'unavailable');
 if(result.status==='unavailable')assert(result.missing.includes('provisional_cost_exceeds_rangekeeper_limits'));
});
