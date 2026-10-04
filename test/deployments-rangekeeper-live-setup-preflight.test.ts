import assert from 'node:assert/strict';
import test from 'node:test';
import type {Address} from 'viem';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {contentHash} from '../src/deployments/contracts.js';
import {allocateLiveWalletBalances} from '../src/deployments/live-wallet-allocation.js';
import {marketProfileSchema,referenceProofHash,type MarketProfile} from '../src/deployments/market-profile.js';
import {buildRangeKeeperLiveSetupPreflight,rangeKeeperLiveSetupPreflightInput,
 type RangeKeeperLiveSetupSnapshot} from '../src/deployments/rangekeeper-live-setup-preflight.js';
import {createRangeKeeperLiveSetupRuntime,verifyRangeKeeperLiveSetupPinnedReferences} from '../src/deployments/rangekeeper-live-setup-runtime.js';
import {liveSetupEvidenceHash} from '../src/deployments/rangekeeper-live-setup-simulation.js';

const H=`0x${'a'.repeat(64)}`;
const limits={maxDeploymentValue:'1000000000000000000000',minDeploymentValue:'1',minDeploymentPpm:1,
 maxSwapInputValue:'50000000000000000000',maxSwapInputPpm:1_000_000,maxSwapShortfallValue:'10000000000000000000',
 maxSlippageBps:50,maxActionCost:'100000000000000000000',maxRollingCost:'100000000000000000000',
 maxCampaignCost:'100000000000000000000',maxExposurePpm:1_000_000,maxLossValue:'100000000000000000000',
 maxDrawdownPpm:1_000_000,maxRecenters:5,maxLiquiditySharePpm:1_000_000,
 maxObservationGapSeconds:90,exitReserveWei:'1000000000000000'};
const now=Date.now(),source={block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:Math.floor(now/1000)-15};
const proof={independent:true,registry:{fetchedAt:new Date(now-5_000).toISOString(),
 sha256:`sha256:${'a'.repeat(64)}`,url:'https://references.example/registry.json'}};
const proofHash=referenceProofHash(proof);

function fixture(quoteToken:0|1,fee=3000,spacing=60,decimals0=6,decimals1=6){
 const token0=quoteToken===0?USDG:'0x1000000000000000000000000000000000000001';
 const token1=quoteToken===1?USDG:'0x7000000000000000000000000000000000000001';
 const tick=decimals0===decimals1?0:Math.round(Math.log(10**(decimals1-decimals0))/Math.log(1.0001));
 const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,
  pool:'0x8000000000000000000000000000000000000001',token0,token1,quoteToken,decimals0,decimals1,
  fee,tickSpacing:spacing,positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
  poolCodeHash:H,token0CodeHash:H,token1CodeHash:H,managerCodeHash:H,quoterCodeHash:H,
  reference0:'TOKEN0/USD',reference1:'TOKEN1/USD',nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{
   token0:{kind:quoteToken===0?'stablecoin':'stock_token',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
   token1:{kind:quoteToken===1?'stablecoin':'stock_token',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
   nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}});
 const frame={source,tick,sqrtPriceX96:sqrtRatioAtTick(tick),poolLiquidity:10n**24n,
  price0:10n**18n,price1:10n**18n,nativePrice:2_000n*10n**18n,referenceEligible:true,
  referenceReasons:[],referenceProofHash:proofHash,referenceProof:proof};
 const raw0=100n*10n**BigInt(decimals0),raw1=100n*10n**BigInt(decimals1);
 const allocation=allocateLiveWalletBalances({tokens:[{address:token0,decimals:decimals0,symbol:'T0',balanceRaw:String(raw0)},
  {address:token1,decimals:decimals1,symbol:'T1',balanceRaw:String(raw1)}],nativeBalanceWei:'1000000000000000000',
  commitments:[],commitmentsStatus:'available'});
 const snapshot:RangeKeeperLiveSetupSnapshot={...allocation,source,status:'available',canonical:true,nonce:'4',
  nftCustody:{status:'available',enumerationComplete:true,tokenIds:[]}};
 return {profile,frame,snapshot};
}
const preflightInput=(profileId:string,capitalQuoteRaw='100000000',fullWidthSpacings=120)=>
 rangeKeeperLiveSetupPreflightInput.parse({profileId,capitalQuoteRaw,fullWidthSpacings,limits});

function deps(f:ReturnType<typeof fixture>,overrides:Partial<Parameters<typeof buildRangeKeeperLiveSetupPreflight>[1]>={}){
 const profileId='00000000-0000-4000-8000-000000000001';
 return {buildId:'b'.repeat(64),serverWallet:async()=>({id:'server-wallet-1',address:'0x9000000000000000000000000000000000000001' as Address}),
  loadProfile:async(id:string)=>({id,profile:f.profile,profileHash:contentHash(f.profile)}),
  readFrame:async()=>f.frame,readWalletSnapshot:async()=>f.snapshot,
  readGasPrice:async()=>({baseFeePerGasWei:1_000_000_000n,marketGasPriceWei:1_000_000_000n}),
  verifyCanonical:async()=>{},now:()=>now,
  quote:async(token:0|1,amount:bigint)=>({amountOut:amount,priceAfter:f.frame.sqrtPriceX96,
   feeValue:0n,shortfallValue:0n,sourceBlock:BigInt(source.block),sourceHash:source.hash}),
  simulateCandidate:async(request:Parameters<Parameters<typeof buildRangeKeeperLiveSetupPreflight>[1]['simulateCandidate']>[0])=>{
   const gasByStage=[{phase:'entry' as const,kind:'mint',gasUsed:'100000',gasUnitsBound:'130000'},
    {phase:'exit' as const,kind:'withdraw',gasUsed:'100000',gasUnitsBound:'130000'}];
   const actionGasWei='162500000000000',completeExitGasWei='162500000000000',exitReserveWei='1000000000000000';
   const estimatedCostValue='325000000000000000',maxFeePerGasWei='1250000000';
   return {status:'success' as const,source:request.source,candidateHash:liveSetupEvidenceHash(request.candidate),
    profileHash:contentHash(request.profile),allocationHash:contentHash(request.allocation),
    limitsHash:liveSetupEvidenceHash(request.limits),sequenceHash:contentHash({gasByStage}),gasByStage,maxFeePerGasWei,
    actionGasWei,completeExitGasWei,estimatedCostValue,exitReserveWei,
    provenance:'owned_fork_allocated_lifecycle_v1' as const,syntheticNativeFunding:true as const};
  },...overrides};
}

test('live setup preflight supports quote token0, USDG token1, and exact decimal conversion',async()=>{
 const f=fixture(0,500,10),input=preflightInput('00000000-0000-4000-8000-000000000001',
  '100000000',120);
 const result=await buildRangeKeeperLiveSetupPreflight(input,deps(f));
 assert.equal(result.status,'indicative',JSON.stringify(result.missing));assert.equal(result.profile?.quoteToken,0);
 assert.deepEqual(result.range,{tickLower:-600,tickUpper:600,centerTick:0,fullWidthSpacings:120});
 assert(BigInt(result.requirements!.token0Raw)>0n&&BigInt(result.requirements!.token1Raw)>0n);
 assert.equal(result.requirements!.quoteValueRaw,'100000000');
 assert.equal(result.costs.provenance,'owned_fork_allocated_lifecycle_v1');
 assert.equal(result.costs.fundedManagementBundles,'5');
 assert.equal(result.costs.managementGasReserveWei,'1625000000000000');
 assert.equal(result.requirements!.nativeWei,'2787500000000000');
 assert.equal(result.executionEligible,false);assert.equal(result.reason,'rangekeeper_live_execution_unavailable');
});

test('zero recenter cap funds exactly one finite management bundle without changing the unbounded policy limit',async()=>{
 const f=fixture(0),input=rangeKeeperLiveSetupPreflightInput.parse({profileId:'00000000-0000-4000-8000-000000000001',
  capitalQuoteRaw:'100000000',fullWidthSpacings:120,limits:{...limits,maxRecenters:0}});
 const result=await buildRangeKeeperLiveSetupPreflight(input,deps(f));
 assert.equal(result.status,'indicative',JSON.stringify(result.missing));
 assert.equal((result.policy as any).config.limits.maxRecenters,0);
 assert.equal(result.costs.fundedManagementBundles,'1');
 assert.equal(result.costs.managementGasReserveWei,'325000000000000');
 assert.equal(result.requirements!.nativeWei,'1487500000000000');
});

test('pinned reference revalidation rejects a profile identity change before trusting caller-supplied prices',async()=>{
 const f=fixture(0);let rpcReads=0;
 const client={getChainId:async()=>{rpcReads++;return 4663;}} as any;
 const valid=await verifyRangeKeeperLiveSetupPinnedReferences({client,profile:f.profile,source,
  profileHash:'f'.repeat(64),references:{price0:String(f.frame.price0),price1:String(f.frame.price1),
   nativePrice:String(f.frame.nativePrice),semanticProofHash:'a'.repeat(64)}});
 assert.equal(valid,false);assert.equal(rpcReads,0,'changed profile identity is rejected before RPC proof reads');
});

test('live setup runtime preserves read-only response by default and exposes inert persistence only by opt-in',async()=>{
 const timestamp=Math.floor(Date.now()/1000)-15,hash=`0x${'7'.repeat(64)}`;
 const client={getBlock:async({blockNumber}:{blockNumber?:bigint}={})=>({number:blockNumber??200n,hash,
   timestamp:BigInt(timestamp)}),getBytecode:async()=>undefined};
 const common={store:{paperSetupProfile:async()=>null} as any,indexer:{query:async()=>{throw Error('unused');}} as any,
  client:client as any,walletAddress:'0x9000000000000000000000000000000000000001',buildId:'b'.repeat(64),rpcUrl:'',
  anvilBinary:'',transferStore:{} as any};
 const parsed=preflightInput('00000000-0000-4000-8000-000000000001');
 const readonly=await createRangeKeeperLiveSetupRuntime(common).setupPreflight(parsed);
 assert.equal(readonly.status,'unavailable');assert.equal('reviewPersistence' in readonly,false);
 const optedIn=await createRangeKeeperLiveSetupRuntime({...common,persistReviews:true}).setupPreflight(parsed);
 assert.equal(optedIn.status,'unavailable');assert('reviewPersistence' in optedIn);
 if('reviewPersistence' in optedIn){assert.equal(optedIn.reviewPersistence.status,'unavailable');
  assert(optedIn.reviewPersistence.missing.includes('live_setup_snapshot_persistence_unavailable'));}
});

test('live setup preflight handles quote token1 and differing token decimals within free inventory',async()=>{
 const f=fixture(1,500,10,18,6),input=preflightInput('00000000-0000-4000-8000-000000000001');
 const result=await buildRangeKeeperLiveSetupPreflight(input,deps(f));
 assert.equal(result.status,'indicative',JSON.stringify(result.missing));assert.equal(result.profile?.quoteToken,1);
 assert.equal(result.profile?.decimals0,18);assert.equal(result.profile?.decimals1,6);
 assert(BigInt(result.requirements!.token0Raw)<=BigInt(f.snapshot.tokens.find(t=>t.address.toLowerCase()===f.profile.pool.token0.toLowerCase())!.availableRaw!));
 assert(BigInt(result.requirements!.token1Raw)<=BigInt(f.snapshot.tokens.find(t=>t.address.toLowerCase()===f.profile.pool.token1.toLowerCase())!.availableRaw!));
 assert.equal(Math.abs(result.range!.tickLower%10),0);assert.equal(Math.abs(result.range!.tickUpper%10),0);
});

test('live setup preflight fails closed when commitments or complete NFT custody are unknown',async()=>{
 const f=fixture(0),input=preflightInput('00000000-0000-4000-8000-000000000001');
 const unknown={...f.snapshot,status:'unavailable' as const,blockers:['active_live_custody_commitment_unknown']};
 const result=await buildRangeKeeperLiveSetupPreflight(input,deps(f,{readWalletSnapshot:async()=>unknown}));
 assert.equal(result.status,'unavailable');assert(result.missing.some(reason=>reason==='active_live_custody_commitment_unknown'));
 const noNft={...f.snapshot,nftCustody:{status:'unavailable' as const,enumerationComplete:false,tokenIds:null}};
 const custody=await buildRangeKeeperLiveSetupPreflight(input,deps(f,{readWalletSnapshot:async()=>noNft}));
 assert(custody.missing.some(reason=>reason==='complete_nft_custody_unavailable'));
});

test('live setup preflight reports the in-policy persistent allowances the wallet review accepted',async()=>{
 const f=fixture(0),input=preflightInput('00000000-0000-4000-8000-000000000001');
 const accepted=[{token:f.profile.pool.token0,spender:f.profile.pool.router,label:'router',amountRaw:'1000'}];
 const reported={...f.snapshot,allowancePolicy:{kind:'persistent_capped_v1' as const,accepted}};
 const result=await buildRangeKeeperLiveSetupPreflight(input,deps(f,{readWalletSnapshot:async()=>reported}));
 assert.equal(result.status,'indicative',JSON.stringify(result.missing));
 assert.deepEqual((result.wallet as {allowancePolicy?:unknown}).allowancePolicy,{kind:'persistent_capped_v1',accepted});
 const zero=await buildRangeKeeperLiveSetupPreflight(input,deps(f));
 assert.equal('allowancePolicy' in (zero.wallet as object),false,'a snapshot without a report adds nothing to the frozen review');
});

test('live setup allocation never exceeds free inventory and reports an inventory shortfall',async()=>{
 const f=fixture(0),input=preflightInput('00000000-0000-4000-8000-000000000001');
 const small=allocateLiveWalletBalances({tokens:[
  {address:f.profile.pool.token0,decimals:6,symbol:'T0',balanceRaw:'10000000'},
  {address:f.profile.pool.token1,decimals:6,symbol:'T1',balanceRaw:'10000000'}],nativeBalanceWei:'1000000000000000000',
  commitments:[],commitmentsStatus:'available'});
 const snapshot={...small,source, status:'available' as const,canonical:true,nonce:'4',
  nftCustody:{status:'available' as const,enumerationComplete:true,tokenIds:[]}};
 const result=await buildRangeKeeperLiveSetupPreflight(input,deps(f,{readWalletSnapshot:async()=>snapshot}));
 assert.equal(result.status,'indicative',JSON.stringify(result.missing));
 assert(BigInt(result.requirements!.token0Raw)<=10_000_000n);
 assert(BigInt(result.requirements!.token1Raw)<=10_000_000n);
 assert.equal(result.requirements!.shortfallQuoteRaw,'80000000');
});

test('live setup blocks when available native inventory cannot cover measured entry and exit gas',async()=>{
 const f=fixture(0),input=preflightInput('00000000-0000-4000-8000-000000000001');
 const barelyFunded='1100000000000000';
 const snapshot={...f.snapshot,native:{...f.snapshot.native,balanceWei:barelyFunded,allocatedWei:'0',pendingWei:'0',
  exitReserveWei:'0',availableWei:barelyFunded}};
 const result=await buildRangeKeeperLiveSetupPreflight(input,deps(f,{readWalletSnapshot:async()=>snapshot}));
 assert.equal(result.status,'unavailable');assert(result.missing.some(reason=>reason==='native_gas_allocation_shortfall'),JSON.stringify(result.missing));
});

test('live setup uses the greater owned-fork gas estimate when it exceeds receipt gas',async()=>{
 const f=fixture(0),input=preflightInput('00000000-0000-4000-8000-000000000001'),base=deps(f);
 const result=await buildRangeKeeperLiveSetupPreflight(input,{...base,simulateCandidate:async request=>{
  const original=await base.simulateCandidate(request),gasByStage=[
   {phase:'entry' as const,kind:'mint',gasUsed:'100000',estimatedGas:'200000',gasUnitsBound:'260000'},
   {phase:'exit' as const,kind:'withdraw',gasUsed:'100000',estimatedGas:'300000',gasUnitsBound:'390000'}];
  const maxFee=1_250_000_000n,actionGasWei=260_000n*maxFee,completeExitGasWei=390_000n*maxFee;
  const exitReserveWei=BigInt(input.limits.exitReserveWei)>completeExitGasWei?BigInt(input.limits.exitReserveWei):completeExitGasWei;
  const estimatedCostValue=(actionGasWei*request.prices.nativePrice+10n**18n-1n)/10n**18n+
   (request.candidate.swap?request.candidate.swap.feeValue+request.candidate.swap.shortfallValue:0n);
  return {...original,gasByStage,maxFeePerGasWei:String(maxFee),actionGasWei:String(actionGasWei),
   completeExitGasWei:String(completeExitGasWei),exitReserveWei:String(exitReserveWei),estimatedCostValue:String(estimatedCostValue)};
 }});
 assert.equal(result.status,'indicative',JSON.stringify(result.missing));
 assert.equal(result.costs.stages[0]!.estimatedGas,'200000');assert.equal(result.costs.stages[0]!.gasUnitsBound,'260000');
 assert.equal(result.costs.stages[1]!.estimatedGas,'300000');assert.equal(result.costs.stages[1]!.gasUnitsBound,'390000');
 assert.equal(result.costs.actionGasWei,String(325_000_000_000_000n));
 assert.equal(result.costs.completeExitGasWei,String(487_500_000_000_000n));
});

test('live setup blocks native inventory that covers entry and close but not the funded management reserve',async()=>{
 const f=fixture(0),input=preflightInput('00000000-0000-4000-8000-000000000001');
 const nativeFree='2000000000000000';
 assert(BigInt(nativeFree)>162500000000000n+162500000000000n+1000000000000000n);
 const snapshot={...f.snapshot,native:{...f.snapshot.native,balanceWei:nativeFree,allocatedWei:'0',pendingWei:'0',
  exitReserveWei:'0',availableWei:nativeFree}};
 const result=await buildRangeKeeperLiveSetupPreflight(input,deps(f,{readWalletSnapshot:async()=>snapshot}));
 assert.equal(result.status,'unavailable');assert(result.missing.includes('native_gas_allocation_shortfall'));
});

test('live setup keeps acquired swap inventory outside the initial allocation and stays under the quote budget',async()=>{
 const f=fixture(0,10_000,200),input=preflightInput('00000000-0000-4000-8000-000000000001');
 const oneLeg=allocateLiveWalletBalances({tokens:[
  {address:f.profile.pool.token0,decimals:6,symbol:'T0',balanceRaw:'100000000'},
  {address:f.profile.pool.token1,decimals:6,symbol:'T1',balanceRaw:'0'}],nativeBalanceWei:'1000000000000000000',
  commitments:[],commitmentsStatus:'available'});
 const snapshot={...oneLeg,source,status:'available' as const,canonical:true,nonce:'4',
  nftCustody:{status:'available' as const,enumerationComplete:true,tokenIds:[]}};
 const base=deps(f),captured:Parameters<Parameters<typeof buildRangeKeeperLiveSetupPreflight>[1]['simulateCandidate']>[0][]=[];
 const result=await buildRangeKeeperLiveSetupPreflight(input,{...base,readWalletSnapshot:async()=>snapshot,
  quote:async(token,amount)=>({amountOut:amount,priceAfter:f.frame.sqrtPriceX96,feeValue:0n,shortfallValue:0n,
   sourceBlock:BigInt(source.block),sourceHash:source.hash}),
  simulateCandidate:async request=>{captured.push(request);return base.simulateCandidate(request);}});
 assert.equal(result.status,'indicative',JSON.stringify(result.missing));
 assert.equal(result.requirements!.token0Raw,'100000000');assert.equal(result.requirements!.token1Raw,'0');
 assert.equal(result.requirements!.quoteValueRaw,'100000000');
 assert.equal(result.candidate!.swap!.token,0);assert(BigInt(result.candidate!.swap!.amountIn)>0n);
 assert.equal(captured[0]!.allocation.token0Raw,'100000000');assert.equal(captured[0]!.allocation.token1Raw,'0');
});

test('live setup rejects malformed owned-fork cost and allocation bindings',async()=>{
 const f=fixture(0),input=preflightInput('00000000-0000-4000-8000-000000000001'),base=deps(f);
 const wrongBinding=await buildRangeKeeperLiveSetupPreflight(input,deps(f,{simulateCandidate:async request=>
  ({...await base.simulateCandidate(request),allocationHash:'0'.repeat(64)})}));
 assert.equal(wrongBinding.status,'unavailable');
 assert(wrongBinding.missing.some(reason=>reason==='owned_fork_evidence_binding_mismatch'));
 const malformedCost=await buildRangeKeeperLiveSetupPreflight(input,deps(f,{simulateCandidate:async request=>
  ({...await base.simulateCandidate(request),completeExitGasWei:'0'})}));
 assert.equal(malformedCost.status,'unavailable');
 assert(malformedCost.missing.some(reason=>reason==='owned_fork_cost_evidence_malformed'));
});

test('live setup preflight rechecks the canonical anchor and blocks a changed review source',async()=>{
 const f=fixture(0),input=preflightInput('00000000-0000-4000-8000-000000000001');
 const result=await buildRangeKeeperLiveSetupPreflight(input,deps(f,{verifyCanonical:async()=>{throw Error('reorg');}}));
 assert.equal(result.status,'unavailable');assert(result.missing.some(reason=>reason==='fresh_source_not_canonical'));
 const changed={...f.frame,source:{...source,hash:`0x${'2'.repeat(64)}`}};
 const mismatched=await buildRangeKeeperLiveSetupPreflight(input,deps(f,{readFrame:async()=>changed}));
 assert.equal(mismatched.status,'unavailable');assert(mismatched.missing.some(reason=>reason==='wallet_snapshot_source_mismatch'));
});
