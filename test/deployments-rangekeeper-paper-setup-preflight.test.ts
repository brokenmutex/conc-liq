import assert from 'node:assert/strict';
import test from 'node:test';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {contentHash} from '../src/deployments/contracts.js';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import {rangeKeeperPaperCandidateHash,
 RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP,RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES,
 type RangeKeeperPaperCandidateScope} from '../src/deployments/rangekeeper-paper-cost.js';
import {buildRangeKeeperPaperSetupPreflight,rangeKeeperPaperSetupCandidateIdentity,
 rangeKeeperSetupPreflightInput} from '../src/deployments/rangekeeper-paper-setup-preflight.js';
import {replayPaperMint} from '../src/v3/position-math.js';
import type {RangeKeeperCandidate} from '../src/strategy/rangekeeper/domain.js';

const token1='0x7000000000000000000000000000000000000001';
const hash=`0x${'a'.repeat(64)}`;
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,
 pool:'0x8000000000000000000000000000000000000001',token0:USDG,token1,quoteToken:0,
 decimals0:6,decimals1:6,fee:3000,tickSpacing:60,positionManager:NONFUNGIBLE_POSITION_MANAGER,
 router:PAPER_ROUTER,quoter:PAPER_QUOTER,poolCodeHash:hash,token0CodeHash:hash,token1CodeHash:hash,
 managerCodeHash:hash,quoterCodeHash:hash,reference0:'USDG/USD',reference1:'TOKEN/USD',
 nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{
 token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
 nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}});
const now=Date.now(),proof={independent:true,
 registry:{fetchedAt:new Date(now-5_000).toISOString(),sha256:`sha256:${'a'.repeat(64)}`,
  url:'https://references.example/registry.json'},
 feedDirectory:{fetchedAt:new Date(now-5_000).toISOString(),sha256:`sha256:${'b'.repeat(64)}`,
  url:'https://references.example/feeds.json'}},proofHash=referenceProofHash(proof);
const frame={source:{block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:Math.floor(now/1000)-15},
 tick:0,sqrtPriceX96:sqrtRatioAtTick(0),poolLiquidity:10n**20n,
 price0:10n**18n,price1:10n**18n,nativePrice:2_000n*10n**18n,
 referenceEligible:true,referenceReasons:[],referenceProofHash:proofHash,referenceProof:proof};
const limits={maxDeploymentValue:'1000000000000000000000',minDeploymentValue:'1',minDeploymentPpm:1,
 maxSwapInputValue:'10000000000000000000',maxSwapInputPpm:1_000_000,
 maxSwapShortfallValue:'1000000000000000000',maxSlippageBps:50,
 maxActionCost:'1000000000000000000000',maxRollingCost:'1000000000000000000000',
 maxCampaignCost:'1000000000000000000000',maxExposurePpm:1_000_000,
 maxLossValue:'1000000000000000000000',maxDrawdownPpm:1_000_000,maxRecenters:5,
 maxLiquiditySharePpm:1_000_000,maxObservationGapSeconds:90,exitReserveWei:'1000000000000000'};
const input=rangeKeeperSetupPreflightInput.parse({profileId:'00000000-0000-4000-8000-000000000001',
 capitalQuoteRaw:'100000000',fullWidthSpacings:120,limits});
const deps=(overrides:Partial<Parameters<typeof buildRangeKeeperPaperSetupPreflight>[1]>={})=>({
 loadProfile:async(id:string)=>({id,profile,profileHash:contentHash(profile)}),
 readFrame:async()=>frame,verifyCanonical:async()=>{},
 readGasPrice:async()=>1_000_000_000n,
 sampleOwnedFork:async()=>{throw Error('owned fork unavailable in this test');},
 now:()=>now,...overrides});

/** Stage samples shaped exactly as the owned fork returns them, so the preflight
 * exercises its real produce/verify/speculative-row path rather than fabricated
 * calibration rows. Gas is constant across stages; this fixture is about the
 * identity and binding, not about gas realism. */
const forkSamples=(stages:readonly string[])=>stages.map((action,index)=>({
 action,to:profile.pool.pool,calldata:`0x${'ab'.repeat(index+1)}`,returnData:'0x',
 localHash:`0x${String(index+1).repeat(64)}`.slice(0,66),localGasUsed:'100000',
 localEffectiveGasPriceWei:'1000000000',sourceBlock:frame.source.block,sourceHash:frame.source.hash,
 estimate:{gas:'100000',parentGas:'0',baseFeeWei:'1000000000',parentBaseFeeWei:'1000000000',
  totalFeeWei:'100000000000000',parentFeeWei:'0',executionFeeWei:'100000000000000',
  basis:'node_estimateGas_with_paper_prestate_and_parent_component' as const},
 stateOverrideHash:contentHash({}),stateOverrides:{}}));

test('read-only rangekeeper setup sizes a candidate via the planner; cost evidence is absent by default',async()=>{
 const result=await buildRangeKeeperPaperSetupPreflight(input,deps());
 assert.equal(result.kind,'rangekeeper_paper_setup_preflight');
 assert.equal(result.status,'unavailable');
 assert.equal(result.actionAvailable,false);
 assert.equal(result.draftCreated,false);
 assert.equal(result.operationCreated,false);
 assert('profileHash' in result);
 assert.equal(result.profileHash,contentHash(profile));
 assert(result.range);
 assert.equal(result.range.tickLower,-3600);
 assert.equal(result.range.tickUpper,3600);
 assert(result.requirements);
 assert(BigInt(result.requirements.token0Raw)>0n&&BigInt(result.requirements.token1Raw)>0n);
 assert(BigInt(result.requirements.liquidity)>0n);
 assert.equal(result.requirements.sizingConvention,
  'maximize_v3_liquidity_under_independent_reference_quote_budget_then_kernel_sized');
 assert.equal(result.missing[0],'rangekeeper_setup_gas_sample_unavailable');
});

test('rangekeeper setup is available once the exact kernel candidate has complete fresh gas evidence',async()=>{
 const sizing=await buildRangeKeeperPaperSetupPreflight(input,deps());
 assert(sizing.requirements&&sizing.range);
 const range={tickLower:sizing.range.tickLower,tickUpper:sizing.range.tickUpper},
  mint=replayPaperMint(frame.sqrtPriceX96,range,BigInt(sizing.requirements.token0Raw),
   BigInt(sizing.requirements.token1Raw),0n),haircut=10_000n-BigInt(limits.maxSlippageBps);
 assert.equal(mint.liquidity,BigInt(sizing.requirements.liquidity),
  'test fixture must replay to the same liquidity the preflight reported');
 const candidate:RangeKeeperCandidate={kind:'entry',range,swap:null,
  amount0Desired:BigInt(sizing.requirements.token0Raw),amount1Desired:BigInt(sizing.requirements.token1Raw),
  amount0Min:mint.amount0*haircut/10_000n,amount1Min:mint.amount1*haircut/10_000n,
  liquidity:mint.liquidity,deployedValue:BigInt(sizing.requirements.deployedValueUsdX18),
  sourceBlock:BigInt(frame.source.block),sourceHash:frame.source.hash as `0x${string}`,
  expiresAt:frame.source.timestamp+90};
 // The preflight's pre-draft identity must be the production candidate hash
 // with sentinel campaign values, not a separate hash space: that is what lets
 // produceRangeKeeperPaperGasEvidence accept the scope it samples against.
 const configHash=contentHash({fullWidthSpacings:input.fullWidthSpacings,limits:input.limits,
  strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1});
 const candidateHash=rangeKeeperPaperSetupCandidateIdentity({profileHash:contentHash(profile),
  configHash,source:frame.source,referenceProofHash:frame.referenceProofHash,candidate});
 assert.equal(candidateHash,rangeKeeperPaperCandidateHash({campaignId:'00000000-0000-4000-8000-000000000000',
  revision:1,profileHash:contentHash(profile),configHash,source:frame.source,
  referenceProofHash:frame.referenceProofHash,candidate}),
  'setup identity must stay in the production candidate hash space');
 const stages=[...RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP,...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES];
 let sampledScope:RangeKeeperPaperCandidateScope|null=null;
 const result=await buildRangeKeeperPaperSetupPreflight(input,deps({
  sampleOwnedFork:async(request:{stages:readonly string[];scope:RangeKeeperPaperCandidateScope})=>{
   sampledScope=request.scope;return forkSamples(request.stages);
  }}));
 assert.deepEqual(sampledScope&&(sampledScope as RangeKeeperPaperCandidateScope).candidateHash,candidateHash,
  'the preflight must sample against the identity it reports');
 assert.deepEqual(stages.length,8);
 assert.equal(result.status,'available');
 assert.equal(result.costs.status,'provisional');
 assert.equal(result.actionAvailable,false);
 assert.equal(result.draftCreated,false);
 assert.equal(result.operationCreated,false);
});

test('rangekeeper setup replays the reviewed source and rejects a different returned frame',async()=>{
 let received:unknown;
 const readFrame=async(_profile:unknown,pinnedSource:unknown)=>{received=pinnedSource;return frame;};
 const replay=await buildRangeKeeperPaperSetupPreflight(input,deps({readFrame}),frame.source);
 assert.deepEqual(received,frame.source);
 assert.equal(replay.missing[0]!.startsWith('rangekeeper_')||
  replay.missing[0]==='reviewed_source_replay_mismatch',true);
 const mismatched=await buildRangeKeeperPaperSetupPreflight(input,
  deps({readFrame:async()=>({...frame,source:{...frame.source,block:'101'}})}),frame.source);
 assert.equal(mismatched.status,'unavailable');
 assert(mismatched.missing.includes('reviewed_source_replay_mismatch'));
});

test('rangekeeper setup fails closed for stale source, ineligible reference, or profile integrity',async()=>{
 const stale=await buildRangeKeeperPaperSetupPreflight(input,
  deps({readFrame:async()=>({...frame,source:{...frame.source,timestamp:Math.floor(now/1000)-181}})}));
 assert.equal(stale.missing[0],'fresh_source_stale');
 const ineligible=await buildRangeKeeperPaperSetupPreflight(input,
  deps({readFrame:async()=>({...frame,referenceEligible:false})}));
 assert.equal(ineligible.missing[0],'independent_reference_unavailable');
 const badProfile=await buildRangeKeeperPaperSetupPreflight(input,
  deps({loadProfile:async id=>({id,profile,profileHash:'0'.repeat(64)})}));
 assert.equal(badProfile.missing[0],'registered_market_profile_integrity');
});

test('rangekeeper setup input requires even full-width spacings and required limits',()=>{
 assert.equal(rangeKeeperSetupPreflightInput.safeParse({...input,fullWidthSpacings:121}).success,false);
 assert.equal(rangeKeeperSetupPreflightInput.safeParse({...input,fullWidthSpacings:0}).success,false);
 const {limits:_omitted,...withoutLimits}=input;
 assert.equal(rangeKeeperSetupPreflightInput.safeParse(withoutLimits).success,false);
 assert.equal(rangeKeeperSetupPreflightInput.safeParse({...input,capitalQuoteRaw:'0'}).success,false);
});

test('rangekeeper setup fails closed when submitted limits cannot be enforced by the kernel',async()=>{
 const badLimits={...limits,minDeploymentValue:limits.maxDeploymentValue}; // floor unreachable by ppm
 const badInput=rangeKeeperSetupPreflightInput.parse({...input,limits:badLimits});
 const result=await buildRangeKeeperPaperSetupPreflight(badInput,deps());
 assert.equal(result.status,'unavailable');
 assert(result.missing[0]!.includes('rangekeeper_min_deployment_value_not_enforced_by_kernel'));
});
