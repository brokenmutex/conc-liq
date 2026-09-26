import assert from 'node:assert/strict';
import test from 'node:test';
import type {RobinhoodClient} from '../src/client.js';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {contentHash,staticManualParameters} from '../src/deployments/contracts.js';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import {PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES} from '../src/deployments/paper-cost.js';
import {buildStaticPaperSetupPreflight,paperSetupPreflightInput} from '../src/deployments/paper-setup-preflight.js';
import {buildIndicativePaperOpenPreview,readCanonicalPaperOpenFrame} from '../src/deployments/paper-preview.js';

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
const input=paperSetupPreflightInput.parse({profileId:'00000000-0000-4000-8000-000000000001',
 capitalQuoteRaw:'100000000',halfWidthTicks:60});
const setup=()=>buildStaticPaperSetupPreflight(input,{loadProfile:async id=>({id,profile,profileHash:contentHash(profile)}),
 readFrame:async()=>frame,verifyCanonical:async()=>{},readGasProfiles:async()=>[],readGasPrice:async()=>1n,
 now:()=>now});
const completeGasProfiles=()=>PAPER_STATIC_GAS_STAGES.map((stage,index)=>{
 const source={block:'99',hash:`0x${'2'.repeat(64)}`,estimatedAt:new Date(now-10_000).toISOString(),
  callHash:`0x${String(index+1).repeat(64)}`,method:'owned_fork_nitro_exact_call_v1' as const};
 const model={schemaVersion:1 as const,source,gasUnitsExpected:'100000',gasUnitsBound:'120000',
  sizeMinValue:'1',sizeMaxValue:'10000000000000000000000000000000000000000',
  shareMinPpm:'0',shareMaxPpm:'1000000',tickLower:-60,tickUpper:60};
 return {id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,version:1,
  poolAddress:profile.pool.pool,pathVersion:PAPER_STATIC_GAS_PATH,stage,allowanceState:'zero',
  sizeBand:'setup_test',component:'gas_units',status:'provisional',evidenceClass:'fork_estimated',
  model,sourceHash:contentHash(source),observedUntil:new Date(now-10_000)};
});

test('read-only static paper setup sizes round-up mint inputs within fresh independent quote budget',async()=>{
 const result=await setup();
 assert.equal(result.kind,'paper_setup_preflight');
 assert.equal(result.status,'unavailable'); // sizing is available, but registered cost evidence is absent
 assert.equal(result.actionAvailable,false);
 assert.equal(result.draftCreated,false);
 assert.equal(result.operationCreated,false);
 assert('profileHash' in result);
 assert.equal(result.profileHash,contentHash(profile),
  'cost-unavailable sizing still binds the verified profile needed for source-matched preparation');
 assert.equal(result.range?.tickLower,-60);
 assert.equal(result.range?.tickUpper,60);
 assert(result.requirements);
 const budget=BigInt(input.capitalQuoteRaw),value=BigInt(result.requirements.referenceValueQuoteRaw);
 assert(value>0n&&value<=budget);
 assert.equal(BigInt(result.requirements.budgetResidualQuoteRaw),budget-value);
 assert.equal(result.requirements.sizingConvention,
  'maximize_v3_liquidity_under_independent_reference_quote_budget');
 assert(BigInt(result.requirements.token0Raw)>0n&&BigInt(result.requirements.token1Raw)>0n);
 assert(result.missing.includes('complete_fresh_stage_costs_unavailable'));
});

test('setup is available only when all fresh registered gas stages cover the exact range',async()=>{
 const result=await buildStaticPaperSetupPreflight(input,{loadProfile:async id=>({id,profile,
  profileHash:contentHash(profile)}),readFrame:async()=>frame,verifyCanonical:async()=>{},
  readGasProfiles:async()=>completeGasProfiles(),readGasPrice:async()=>1_000_000_000n,now:()=>now});
 assert.equal(result.status,'available');
 assert.equal(result.costs.status,'provisional');
 assert.equal(result.profile.quoteToken,0,'review binding carries the registered quote-token index, not an address');
 assert.equal(result.actionAvailable,false);
 assert.equal(result.draftCreated,false);
 assert.equal(result.operationCreated,false);
});

test('setup gas scope matches the production planner minted floor value, not budget ceiling',async()=>{
 const scopedFrame={...frame,tick:15,sqrtPriceX96:sqrtRatioAtTick(15),
  price0:10n**18n-17n,price1:10n**18n-23n};
 const limits=staticManualParameters.parse({halfWidthTicks:60,limits:{
  maxDeploymentValue:'1000000000000000000000',minDeploymentValue:'1',maxExposurePpm:1_000_000,
  maxLossValue:'1000000000000000000000',maxDrawdownPpm:1_000_000,
  maxActionCost:'1000000000000000000000',maxRollingCost:'1000000000000000000000',
  maxCampaignCost:'1000000000000000000000',exitReserveWei:'1000000000000000',maxSlippageBps:50}});
 assert(limits.limits);
 const scopedInput=paperSetupPreflightInput.parse({...input,capitalQuoteRaw:'100000001',limits:limits.limits});
 const read=async(gasRows:ReturnType<typeof completeGasProfiles>)=>buildStaticPaperSetupPreflight(scopedInput,{
  loadProfile:async id=>({id,profile,profileHash:contentHash(profile)}),readFrame:async()=>scopedFrame,
  verifyCanonical:async()=>{},readGasProfiles:async()=>gasRows,readGasPrice:async()=>1_000_000_000n,now:()=>now});
 const sizing=await read([]);
 assert(sizing.requirements);
 const parameters={halfWidthTicks:scopedInput.halfWidthTicks,limits:limits.limits};
 const draft={id:'00000000-0000-4000-8000-000000000002',revision:1,profile,
  profileHash:contentHash(profile),configHash:'0'.repeat(64),strategyId:'static_manual_v1' as const,
  strategyVersion:'1.0.0' as const,stateSchemaVersion:1 as const,parameters,
  allocation:{token0Raw:sizing.requirements.token0Raw,token1Raw:sizing.requirements.token1Raw,
   nativeWei:limits.limits.exitReserveWei}};
 const actual=buildIndicativePaperOpenPreview(draft,scopedFrame);
 assert.equal(actual.status,'indicative');assert(actual.candidate);
 const ceil=(amount:bigint,price:bigint,decimals:number)=>
  (amount*price+10n**BigInt(decimals)-1n)/10n**BigInt(decimals);
 const oldCeiling=ceil(BigInt(sizing.requirements.token0Raw),scopedFrame.price0,profile.pool.decimals0)+
  ceil(BigInt(sizing.requirements.token1Raw),scopedFrame.price1,profile.pool.decimals1);
 assert.notEqual(oldCeiling,BigInt(actual.candidate.deployedValue),
  `fixture must distinguish independently rounded setup sizing from the planner candidate: ${JSON.stringify({
   token0:sizing.requirements.token0Raw,token1:sizing.requirements.token1Raw,
   oldCeiling:String(oldCeiling),planner:String(actual.candidate.deployedValue)})}`);
 const rows=completeGasProfiles().map(row=>({...row,model:{...row.model,
  sizeMinValue:actual.candidate!.deployedValue,sizeMaxValue:actual.candidate!.deployedValue,
  shareMinPpm:actual.candidate!.dilutedSharePpm,shareMaxPpm:actual.candidate!.dilutedSharePpm,
  tickLower:actual.candidate!.range.tickLower,tickUpper:actual.candidate!.range.tickUpper}}));
 const prepared=await read(rows);
 assert.equal(prepared.status,'available');
 assert.equal(prepared.costs.status,'provisional');
});

test('setup replays the reviewed source and rejects a different returned frame',async()=>{
 let received:unknown;
 const deps={loadProfile:async(id:string)=>({id,profile,profileHash:contentHash(profile)}),
  readFrame:async(_profile:unknown,pinnedSource:unknown)=>{received=pinnedSource;return frame;},
  verifyCanonical:async()=>{},readGasProfiles:async()=>completeGasProfiles(),
  readGasPrice:async()=>1_000_000_000n,now:()=>now};
 const replay=await buildStaticPaperSetupPreflight(input,deps,frame.source);
 assert.equal(replay.status,'available');
 assert.deepEqual(received,frame.source);
 const mismatched=await buildStaticPaperSetupPreflight(input,{...deps,
  readFrame:async()=>({...frame,source:{...frame.source,block:'101'}})},frame.source);
 assert.equal(mismatched.status,'unavailable');
 assert(mismatched.missing.includes('reviewed_source_replay_mismatch'));
});

test('setup sizing fails closed for stale source, bad independent references, or invalid profile',async()=>{
 const deps={loadProfile:async(id:string)=>({id,profile,profileHash:contentHash(profile)}),
  readFrame:async()=>({...frame,source:{...frame.source,timestamp:Math.floor(now/1000)-181}}),
  verifyCanonical:async()=>{},readGasProfiles:async()=>[],readGasPrice:async()=>1n,now:()=>now};
 assert.equal((await buildStaticPaperSetupPreflight(input,deps)).missing[0],'fresh_source_stale');
 assert.equal((await buildStaticPaperSetupPreflight(input,{...deps,readFrame:async()=>({...frame,
  referenceEligible:false})})).missing[0],'independent_reference_unavailable');
 assert.equal((await buildStaticPaperSetupPreflight(input,{...deps,loadProfile:async id=>({id,profile,
  profileHash:'0'.repeat(64)})})).missing[0],'registered_market_profile_integrity');
});

test('setup input is bounded to positive raw USDG and integer half-width',()=>{
 assert.equal(paperSetupPreflightInput.safeParse({...input,capitalQuoteRaw:'0'}).success,false);
 assert.equal(paperSetupPreflightInput.safeParse({...input,capitalQuoteRaw:'1.5'}).success,false);
 assert.equal(paperSetupPreflightInput.safeParse({...input,capitalQuoteRaw:String(100_001n*10n**6n)}).success,false);
 assert.equal(paperSetupPreflightInput.safeParse({...input,halfWidthTicks:60.5}).success,false);
});

test('pinned setup frame requires a confirmed canonical block and exact hash',async()=>{
 const client={getBlock:async(args?:{blockNumber?:bigint})=>({
  number:args?.blockNumber??200n,
  hash:args?.blockNumber===135n?`0x${'2'.repeat(64)}`:`0x${'1'.repeat(64)}`,
  timestamp:BigInt(Math.floor(Date.now()/1000)-15),
 })} as unknown as RobinhoodClient;
 await assert.rejects(readCanonicalPaperOpenFrame(client,profile,{...frame.source,block:'137'}),
  /paper_pinned_source_not_confirmed/);
 await assert.rejects(readCanonicalPaperOpenFrame(client,profile,{...frame.source,block:'135'}),
  /paper_pinned_source_not_canonical/);
});
