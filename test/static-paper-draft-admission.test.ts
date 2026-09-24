import assert from 'node:assert/strict';
import {test} from 'node:test';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {contentHash,type DraftInput} from '../src/deployments/contracts.js';
import {marketProfileSchema} from '../src/deployments/market-profile.js';
import {PAPER_STATIC_GAS_PATH} from '../src/deployments/paper-cost.js';
import {createStaticPaperDraftFromSetup,staticPaperSetupReviewBinding} from '../src/deployments/static-paper-draft-admission.js';

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
const costs={status:'provisional' as const,scope:'open_and_close_retain_gas_only' as const,
 pathVersion:PAPER_STATIC_GAS_PATH,sizeBand:'admission-test',gasPriceWei:'1000000000',
 boundGasPriceWei:'1250000000',gasPriceObservedAt:new Date(now).toISOString(),
 nativeReferencePrice:String(2000n*10n**18n),stages:Array.from({length:6},(_,index)=>({
  stage:['approve_token0','approve_token1','mint','withdraw_collect','cleanup_token0','cleanup_token1'][index]!,
  profileId:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,version:1,
  evidenceClass:'fork_estimated',expectedGasUnits:'100000',boundGasUnits:'120000',
  source:{block:'99',hash,estimatedAt:new Date(now-10_000).toISOString(),callHash:hash,
   method:'owned_fork_nitro_exact_call_v1'}})),
 open:{expectedGasUnits:'300000',boundGasUnits:'360000',expectedWei:'300000000000000',
  boundWei:'450000000000000',expectedValue:'3000000000000000000',boundValue:'4000000000000000000'},
 closeRetain:{expectedGasUnits:'300000',boundGasUnits:'360000',expectedWei:'300000000000000',
  boundWei:'450000000000000',expectedValue:'2000000000000000000',boundValue:'3000000000000000000'},
 missing:['fee_capture','execution_delay','failure_expense','close_convert_swap']};
const preflight={schemaVersion:1,kind:'paper_setup_preflight',status:'available',mode:'paper',
 strategyId:'static_manual_v1',profileId,profileHash,
 input:{capitalQuoteRaw:'100000000',halfWidthTicks:60},
 source:{block:'100',hash:`0x${'b'.repeat(64)}`,timestamp:Math.floor(now/1000)},
 profile:{pool:profile.pool.pool,fee:profile.pool.fee,tickSpacing:profile.pool.tickSpacing,
  token0:profile.pool.token0,token1:profile.pool.token1,quoteToken:profile.pool.quoteToken},
 range:{centerTick:0,centerAnchorTick:0,halfWidthTicks:60,tickLower:-60,tickUpper:60,
  fullWidthTicks:120,lowerPriceQuotePerBaseX18:'990000000000000000',
  upperPriceQuotePerBaseX18:'1010000000000000000'},
 requirements:{liquidity:'1000000',token0Raw:'50000000',token1Raw:'0',
  referenceValueQuoteRaw:'50000000',budgetResidualQuoteRaw:'50000000',
  sizingConvention:'maximize_v3_liquidity_under_independent_reference_quote_budget'},
 references:{price0:String(10n**18n),price1:String(10n**18n),nativePrice:String(2000n*10n**18n),
  proofHash:'c'.repeat(64)},costs,admissionLimits:{status:'not_evaluated'},missing:[],
 actionAvailable:false,draftCreated:false,operationCreated:false};
const limits={maxDeploymentValue:String(100n*10n**18n),minDeploymentValue:String(1n*10n**18n),
 maxExposurePpm:1_000_000,maxLossValue:String(10n*10n**18n),maxDrawdownPpm:1_000_000,
 maxActionCost:String(5n*10n**18n),maxRollingCost:String(8n*10n**18n),
 maxCampaignCost:String(8n*10n**18n),exitReserveWei:'1000000000000000',maxSlippageBps:50};
const input=()=>({profileId,capitalQuoteRaw:'100000000',halfWidthTicks:60,
 requestId:'00000000-0000-4000-8000-000000000088',
 wallet:'0x1111111111111111111111111111111111111111',
 allocation:{token0Raw:'50000000',token1Raw:'0',nativeWei:'2000000000000000'},limits,
 reviewed:staticPaperSetupReviewBinding(preflight)});
const deps=(overrides:Record<string,unknown>={})=>({
 runPreflight:async()=>preflight,
 loadProfile:async(id:string)=>({id,profile,profileHash}),
 findDraftRequest:async()=>null,
 createDraftWithRequestId:async(_requestId:string,draft:DraftInput)=>({status:'created' as const,
  id:'00000000-0000-4000-8000-000000000099',revision:1,configHash:contentHash(draft.config)}),
 now:()=>now,...overrides,
});

test('setup draft admission rechecks exact canonical binding, limits, and creates only a guarded paper draft',async()=>{
 let created:DraftInput|undefined,preflightCalls=0,pinnedSource:unknown;
 const result=await createStaticPaperDraftFromSetup(input(),deps({
  runPreflight:async(_request:unknown,source:unknown)=>{preflightCalls++;pinnedSource=source;return preflight;},
  createDraftWithRequestId:async(_requestId:string,draft:DraftInput)=>{created=draft;return{status:'created' as const,id:'00000000-0000-4000-8000-000000000099',
   revision:1,configHash:contentHash(draft.config)};},
 }));
 assert.equal(result.status,'draft_created');
 if(result.status==='draft_created')assert.equal(result.replayed,false);
 assert.equal(preflightCalls,1);
 assert.deepEqual(pinnedSource,preflight.source);
 assert(created);
 assert.equal(created.mode,'paper');
 assert.equal(created.strategyId,'static_manual_v1');
 assert.deepEqual(created.allocation,input().allocation);
 assert.deepEqual(created.config,{halfWidthTicks:60,limits});
 if(result.status==='draft_created'){
  assert.equal(result.profileId,profileId);
  assert.deepEqual(result.range,{tickLower:-60,tickUpper:60});
 }
});

test('same request ID replays before stale preflight and a conflicting ID fails without re-sizing',async()=>{
 let preflightCalls=0;
 const saved={status:'found' as const,id:'00000000-0000-4000-8000-000000000099',revision:1,
  configHash:'d'.repeat(64)};
 const replay=await createStaticPaperDraftFromSetup(input(),deps({
  findDraftRequest:async()=>saved,
  runPreflight:async()=>{preflightCalls++;throw Error('expired source should not be read on replay');},
 }));
 assert.equal(replay.status,'draft_created');
 if(replay.status==='draft_created'){
  assert.equal(replay.replayed,true);
  assert.equal(replay.draftId,saved.id);
  assert.equal(replay.revision,1);
  assert.equal(replay.source,null);
  assert.equal(replay.range,null);
 }
 assert.equal(preflightCalls,0);
 const conflict=await createStaticPaperDraftFromSetup(input(),deps({
  findDraftRequest:async()=>({status:'conflict' as const}),
  runPreflight:async()=>{preflightCalls++;throw Error('conflicting request should stop early');},
 }));
 assert.equal(conflict.status,'request_conflict');
 assert.equal(preflightCalls,0);
 const race=await createStaticPaperDraftFromSetup(input(),deps({
  createDraftWithRequestId:async()=>({...saved,status:'replayed' as const}),
 }));
 assert.equal(race.status,'draft_created');
 if(race.status==='draft_created')assert.equal(race.replayed,true);
});

test('changed source, profile, allocation, or provisional cost evidence rejects before draft creation',async()=>{
 for(const [name,change,expected] of [
  ['source',{source:{...preflight.source,hash:`0x${'d'.repeat(64)}`}},'setup_review_binding_stale'],
  ['profile',{profileHash:'d'.repeat(64)},'setup_review_binding_stale'],
  ['reference',{references:{...preflight.references,proofHash:'d'.repeat(64)}},'setup_review_binding_stale'],
  ['cost profile',{costs:{...costs,stages:costs.stages.map((stage,index)=>index===0?{...stage,version:2}:stage)}},'setup_cost_evidence_changed_since_review'],
 ] as const){
  let creates=0;
  const result=await createStaticPaperDraftFromSetup(input(),deps({
   runPreflight:async()=>({...preflight,...change}),createDraftWithRequestId:async()=>{creates++;throw Error('unexpected');},
  }));
  assert.equal(result.status,'unavailable',name);
  if(result.status==='unavailable')assert(result.missing.includes(expected),`${name}: ${result.missing.join(',')}`);
  assert.equal(creates,0,name);
 }
 let creates=0;
 const mismatch=await createStaticPaperDraftFromSetup({...input(),allocation:{...input().allocation,token0Raw:'49999999'}},deps({
  createDraftWithRequestId:async()=>{creates++;throw Error('unexpected');},
 }));
 assert.equal(mismatch.status,'unavailable');
 if(mismatch.status==='unavailable')assert(mismatch.missing.includes('setup_allocation_does_not_match_fresh_preflight'));
 assert.equal(creates,0);
});

test('cost caps, deployment bounds, gas reserve, stale evidence and store errors fail closed',async()=>{
 const cases:[string,Record<string,unknown>,string][]=[
  ['cost cap',{limits:{...limits,maxCampaignCost:String(6n*10n**18n)}},'provisional_cost_exceeds_static_limits'],
  ['deployment cap',{limits:{...limits,maxDeploymentValue:String(49n*10n**18n)}},'allocation_outside_deployment_value_limits'],
  ['native reserve',{allocation:{...input().allocation,nativeWei:'1000000000000000'}},'native_allocation_below_cost_and_exit_reserve'],
 ];
 for(const [name,change,expected] of cases){
  let creates=0;
  const result=await createStaticPaperDraftFromSetup({...input(),...change},deps({
   createDraftWithRequestId:async()=>{creates++;throw Error('unexpected');},
  }));
  assert.equal(result.status,'unavailable',name);
  if(result.status==='unavailable')assert(result.missing.includes(expected),name);
  assert.equal(creates,0,name);
 }
 const stale=await createStaticPaperDraftFromSetup(input(),deps({
  now:()=>now+181_000,
 }));
 assert.equal(stale.status,'unavailable');
 if(stale.status==='unavailable')assert(stale.missing.includes('setup_review_evidence_expired'));
 const rejected=await createStaticPaperDraftFromSetup(input(),deps({createDraftWithRequestId:async()=>{throw Error('db');}}));
 assert.equal(rejected.status,'reconciliation_required');
 if(rejected.status==='reconciliation_required')assert.equal(rejected.retrySafe,true);
 const malformed=await createStaticPaperDraftFromSetup(input(),deps({
  createDraftWithRequestId:async()=>({status:'created',id:'not-a-uuid',revision:1,configHash:'bad'}),
 }));
 assert.equal(malformed.status,'reconciliation_required');
 if(malformed.status==='reconciliation_required')assert.equal(malformed.reason,'deployment_draft_creation_result_invalid');
 for(const invalid of [undefined,{status:'unexpected',id:'00000000-0000-4000-8000-000000000099',
  revision:1,configHash:'d'.repeat(64)}]){
  const result=await createStaticPaperDraftFromSetup(input(),deps({
   createDraftWithRequestId:async()=>invalid,
  }));
  assert.equal(result.status,'reconciliation_required');
 }
});
