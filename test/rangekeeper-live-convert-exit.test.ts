import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {parseRangeKeeperConfig} from '../src/strategy/rangekeeper/config.js';
import {nextRangeKeeperStage,rangeKeeperPoolWithinReference,RangeKeeperExitConversionUnavailableError} from '../src/strategy/rangekeeper/live-stage.js';
import type {RangeKeeperLiveState,RangeKeeperSnapshot} from '../src/strategy/rangekeeper/live-domain.js';
import type {RangeKeeperChain} from '../src/strategy/rangekeeper/chain.js';
import {RANGEKEEPER_ALLOWANCE_POLICY} from '../src/strategy/rangekeeper/allowance-policy.js';
import {assertConvertConversionEvidence,degradeRangeKeeperConvertExitToRetain,deriveRangeKeeperLiveClosedState,
 deriveRangeKeeperLiveManagementTransition,isRangeKeeperConvertExit,isRangeKeeperManagedExit,isRangeKeeperRetainedExit,
 type RangeKeeperLiveCampaign,type RangeKeeperLiveManagementReviewPayload} from '../src/deployments/rangekeeper-live-campaign.js';
import {RANGEKEEPER_CONVERT_WAIT_SECONDS,classifyRangeKeeperConvertExitStageError,
 settleRangeKeeperLiveConvertExitError} from '../src/deployments/rangekeeper-live-management-recovery.js';
import {buildRangeKeeperLiveStageEvidence,type RangeKeeperLiveStageProofRequest} from '../src/deployments/rangekeeper-live-stage-proof.js';

const config=parseRangeKeeperConfig(JSON.parse(readFileSync(new URL('../config/rangekeeper-v1-aapl-disabled.json',import.meta.url),'utf8')));
const proofConfig=parseRangeKeeperConfig({...JSON.parse(readFileSync(new URL('../config/rangekeeper-v1-aapl-disabled.json',import.meta.url),'utf8')),signer:null});
const p=config.pool;
// USDG (token0, quote, 6 decimals) / AAPL (token1, risky, 18 decimals).
const price0=999991430000000000n,price1=335529829280000000000n;
const isqrt=(n:bigint)=>{if(n<2n)return n;let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n;}return x;};
const sqrtFor=(price:bigint)=>isqrt((1n<<192n)*10n**BigInt(p.decimals1-p.decimals0)*price0/price);
const sqrtInline=sqrtFor(price1);
const source={block:10n,hash:`0x${'11'.repeat(32)}` as const,timestamp:100};
const zeroAllowances=[{token:p.token0,spender:p.router,amount:0n},{token:p.token0,spender:p.positionManager,amount:0n},
 {token:p.token1,spender:p.router,amount:0n},{token:p.token1,spender:p.positionManager,amount:0n}];
const snapshot=(over:Partial<RangeKeeperSnapshot>={})=>({source,operator:config.operator!,wallet0:2_000_000n,wallet1:3n*10n**18n,nativeWei:10n**16n,
 position:null,tick:0,sqrtPriceX96:sqrtInline,allowances:zeroAllowances,...over}) as RangeKeeperSnapshot;
const exitState=(exitMode:'retain'|'convert'|null,over:Partial<RangeKeeperLiveState>={})=>({phase:'exit',desired:'stopped',exitMode,activeTokenId:null,
 candidate:null,reserve0:0n,reserve1:0n,reserveNativeWei:0n,...over}) as RangeKeeperLiveState;
const quoter=(over:Partial<{amountOut:bigint;shortfallValue:bigint}>={})=>({quote:async(_s:unknown,token:0|1,amountIn:bigint)=>{
 assert.equal(token,1,'the convert sale starts from the risky leg');assert.equal(amountIn,3n*10n**18n);
 return {amountOut:1_000_000_000n,priceAfter:sqrtInline,feeValue:10n**17n,shortfallValue:5n*10n**17n,sourceBlock:source.block,sourceHash:source.hash,...over};}}) as unknown as RangeKeeperChain;
const prices={price0,price1};

test('convert exit approves the router for the whole risky leg, then sells it into the quote token with the slippage haircut',async()=>{
 const state=exitState('convert');
 const approval=await nextRangeKeeperStage(state,snapshot(),config,quoter(),prices);
 assert.deepEqual(approval,{kind:'approve',token:1,spender:'router',amount:3n*10n**18n},'only the risky leg is approved, only for the router');
 const approved=snapshot({allowances:zeroAllowances.map(a=>a.token===p.token1&&a.spender===p.router?{...a,amount:3n*10n**18n}:a)});
 const swap=await nextRangeKeeperStage(state,approved,config,quoter(),prices);
 assert.equal(swap?.kind,'swap');if(swap?.kind!=='swap')return;
 assert.equal(swap.token,1);assert.equal(swap.amountIn,3n*10n**18n);
 assert.equal(swap.minOut,1_000_000_000n*(10_000n-BigInt(config.limits.maxSlippageBps))/10_000n,'minimum output is the quote less the frozen slippage');
 assert.equal(swap.deadline,BigInt(source.timestamp+300));
 // The persistent policy grants through its own capped rule and still touches only the risky leg's router pair.
 const policy={kind:RANGEKEEPER_ALLOWANCE_POLICY,retain:new Set<string>(),exposure:[2_000_000n,3n*10n**18n]} as any;
 const capped=await nextRangeKeeperStage(state,snapshot(),config,quoter(),prices,policy);
 assert.equal(capped?.kind,'approve');if(capped?.kind==='approve'){assert.equal(capped.token,1);assert.equal(capped.spender,'router');}
});

test('after the sale the convert exit cleans allowances like a retained close and then completes',async()=>{
 const sold=snapshot({wallet0:3_000_000n,wallet1:0n,allowances:zeroAllowances.map(a=>a.token===p.token1&&a.spender===p.router?{...a,amount:3n*10n**18n}:a)});
 const cleanup=await nextRangeKeeperStage(exitState('convert'),sold,config,{} as RangeKeeperChain,prices);
 assert.deepEqual(cleanup,{kind:'approve',token:1,spender:'router',amount:0n});
 assert.equal(await nextRangeKeeperStage(exitState('convert'),snapshot({wallet0:3_000_000n,wallet1:0n}),config,{} as RangeKeeperChain,prices),null);
 // A withdrawn-only position (nothing to sell) needs no router approval at all.
 assert.equal(await nextRangeKeeperStage(exitState('convert'),snapshot({wallet1:0n}),config,{} as RangeKeeperChain,prices),null);
 // A retained close, and a convert that degraded to retain, never sell the risky leg.
 assert.equal(await nextRangeKeeperStage(exitState('retain'),snapshot(),config,{} as RangeKeeperChain,prices),null);
 const degraded=degradeRangeKeeperConvertExitToRetain(exitState('convert'),'x');
 assert.equal(await nextRangeKeeperStage(degraded,snapshot(),config,{} as RangeKeeperChain,prices),null);
});

test('convert exit refuses to sell into a detached pool or a bad quote and reports a typed, recoverable condition',async()=>{
 const state=exitState('convert');
 const detached=snapshot({sqrtPriceX96:sqrtFor(price1*110n/100n)});
 assert.equal(rangeKeeperPoolWithinReference(p,sqrtInline,prices,config.referencePolicy.maxPoolDeviationPpm),true);
 assert.equal(rangeKeeperPoolWithinReference(p,detached.sqrtPriceX96,prices,config.referencePolicy.maxPoolDeviationPpm),false);
 await assert.rejects(nextRangeKeeperStage(state,detached,config,quoter(),prices),(error:unknown)=>
  error instanceof RangeKeeperExitConversionUnavailableError&&/Exit pool\/reference deviation/.test(error.message));
 const approved=snapshot({allowances:zeroAllowances.map(a=>a.token===p.token1&&a.spender===p.router?{...a,amount:3n*10n**18n}:a)});
 await assert.rejects(nextRangeKeeperStage(state,approved,config,quoter({amountOut:0n}),prices),RangeKeeperExitConversionUnavailableError);
 await assert.rejects(nextRangeKeeperStage(state,approved,config,quoter({shortfallValue:config.limits.maxSwapShortfallValue+1n}),prices),
  (error:unknown)=>error instanceof RangeKeeperExitConversionUnavailableError&&/excessive shortfall/.test(error.message));
});

// ----------------------------------------------------------------------------------------- campaign state transitions
const wallet='0x3333333333333333333333333333333333333333';
const hashSource={block:'10',hash:`0x${'a'.repeat(64)}`,timestamp:1000};
function campaignFixture(){
 const snap={operator:wallet,source:{block:10n,hash:hashSource.hash,timestamp:hashSource.timestamp},nonce:4n,nftCount:1n,
  wallet0:20n,wallet1:30n,nativeWei:40n,tick:0,sqrtPriceX96:1n,unlocked:true,poolLiquidity:100n,allowances:[],
  position:{tokenId:77n,token0:p.token0,token1:p.token1,fee:p.fee,tickLower:-60,tickUpper:60,liquidity:10n,tokensOwed0:0n,tokensOwed1:0n}} as any;
 const state={version:1,id:'campaign-1',operator:wallet,configHash:`0x${'b'.repeat(64)}`,buildId:'d'.repeat(64),phase:'holding',
  desired:'running',exitMode:null,haltReason:null,createdAt:1,expiresAt:3000,economicActions:1,recenters:0,policy:{configHash:`0x${'b'.repeat(64)}`,
   buildId:'d'.repeat(64)},last:snap,activeTokenId:77n,retiredTokenIds:[],legacyNftCount:0n,reserve0:0n,reserve1:0n,reserveNativeWei:0n,
  initial0:1n,initial1:1n,initialNativeWei:1n,initialStrategyValue:1n,candidate:null,swapDone:false,swapConfirmedAt:null,withdrawDone:false,
  actionStartCostIndex:0,reservedActionCost:0n,mintRecoveryAttempts:0,collectedFee0:0n,collectedFee1:0n,gasSpentWei:0n,costEvents:[],
  highWaterValue:1n,activeSeconds:0,outsideSeconds:0,lastMarkTimestamp:0,lastReason:'opened',closedAt:null} as any;
 const campaign={id:'campaign-1',chainId:4663,wallet,revision:1,profileId:'profile-1',profileHash:'c'.repeat(64),profile:{},
  config,configHash:state.configHash,revisionConfig:{},revisionConfigHash:'f'.repeat(64),
  allocation:{allocationId:'allocation-1',campaignId:'campaign-1',revision:1,wallet,liquidByTokenAddress:{},nativeSpendWei:40n,
   pendingNativeSpendWei:0n,exitReserveWei:10n,nftTokenIds:['77'],allocationHash:'e'.repeat(64),sourceGeneration:3,sourceHash:hashSource.hash},
  baseline:{},reviewPayload:{binding:{buildId:state.buildId}},state,stateHash:'1'.repeat(64),stateRevision:7,status:'active'} as unknown as RangeKeeperLiveCampaign;
 const conversion={mode:'convert',swapRequired:true,withdrawn0:'30',withdrawn1:'40',maxSlippageBps:config.limits.maxSlippageBps,
  maxSwapShortfallValue:String(config.limits.maxSwapShortfallValue),token:1,amountIn:'140',minOut:'139',expectedOut:'139',feeValue:'100',shortfallValue:'400'};
 const payload=(over:Record<string,unknown>={},costs:Record<string,unknown>={})=>({schemaVersion:1,kind:'rangekeeper_live_management_review',mode:'live',
  strategyId:'rangekeeper_v1',operationKind:'close_convert',campaignId:campaign.id,revision:1,allocationId:'allocation-1',profileId:'profile-1',
  profileHash:campaign.profileHash,configHash:state.configHash.slice(2),buildId:state.buildId,runtimeStateHash:campaign.stateHash,stateRevision:7,
  wallet:{address:wallet,generation:8,commitmentsHash:'9'.repeat(64),nonce:'4'},source:hashSource,snapshot:snap,
  reference:{proofHash:'8'.repeat(64),price0:'100',price1:'200',nativePrice:'300',evidence:{}},position:{tokenId:'77'},
  decision:{reason:'convert_exit_preview',observationHash:'7'.repeat(64)},candidate:null,policy:null,
  costs:{status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source:hashSource,gasWei:'3',gasValueUsdX18:'4',actionCostValue:'504',conversion,...costs},
  expiresAt:2000,...over}) as unknown as RangeKeeperLiveManagementReviewPayload;
 return {campaign,state,payload,conversion};
}

test('convert management transition freezes the convert exit mode, reserves the sale cost and rejects stale or malformed reviews',()=>{
 const {campaign,state,payload,conversion}=campaignFixture();
 const next=deriveRangeKeeperLiveManagementTransition(campaign,payload());
 assert.deepEqual([next.phase,next.desired,next.exitMode,next.candidate,next.withdrawDone,next.swapDone],['exit','stopped','convert',null,false,false]);
 assert.equal(next.activeTokenId,77n);assert.equal(next.reservedActionCost,504n,'the reserved action cost is the frozen total (gas plus sale cost)');
 assert.equal(next.lastReason,'manager_close_convert:convert_exit_preview');assert.equal(state.phase,'holding','the source state is immutable');
 assert.equal(isRangeKeeperConvertExit(next),true);assert.equal(isRangeKeeperManagedExit(next),true);assert.equal(isRangeKeeperRetainedExit(next),false);
 // A retain review keeps its own mode.
 const retained=deriveRangeKeeperLiveManagementTransition(campaign,payload({operationKind:'close_retain',decision:{reason:'operator_exit',observationHash:'7'.repeat(64)}},{conversion:undefined}));
 assert.equal(retained.exitMode,'retain');assert.equal(retained.lastReason,'manager_close_retain:operator_exit');
 // A replay (state already moved by this exact review) returns the persisted state instead of failing.
 const replayCampaign={...campaign,state:next,stateHash:'2'.repeat(64),stateRevision:8};
 assert.deepEqual(deriveRangeKeeperLiveManagementTransition(replayCampaign,payload()),next);
 const replayAsRetain={...replayCampaign};
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition(replayAsRetain,payload({operationKind:'close_retain',decision:{reason:'convert_exit_preview',observationHash:'7'.repeat(64)}})),
  /stale or another state transition won/,'a convert exit is not a replay of a retain review');
 // Staleness, lifecycle and evidence.
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition({...campaign,stateHash:'3'.repeat(64)},payload()),/stale|another state transition/);
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition({...campaign,state:{...state,phase:'recenter'}},payload()),/stale|requires a held/);
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition({...campaign,state:{...state,activeTokenId:null}},payload()),/requires a held campaign position/);
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition(campaign,payload({},{conversion:undefined})),/lacks its conversion evidence/);
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition(campaign,payload({},{conversion:{...conversion,token:0}})),/non-quote leg directly/);
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition(campaign,payload({},{conversion:{...conversion,shortfallValue:String(config.limits.maxSwapShortfallValue+1n)}})),/slippage or swap-shortfall/);
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition(campaign,payload({},{conversion:{...conversion,maxSlippageBps:config.limits.maxSlippageBps+1}})),/slippage or swap-shortfall/);
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition(campaign,payload({},{actionCostValue:undefined,costValue:undefined,gasValueUsdX18:'0'})),/cost authorization is missing|cost evidence/);
});

test('conversion evidence accepts a withdraw-only convert and rejects every malformed sale',()=>{
 const {conversion}=campaignFixture();
 const ok=(c:unknown)=>assertConvertConversionEvidence({conversion:c},p,config.limits);
 assert.doesNotThrow(()=>ok(conversion));
 assert.doesNotThrow(()=>ok({mode:'convert',swapRequired:false,withdrawn0:'1',withdrawn1:'0',feeValue:'0',shortfallValue:'0'}),'nothing to sell is valid');
 for(const bad of [undefined,null,{...conversion,mode:'retain'},{...conversion,swapRequired:undefined},{...conversion,withdrawn0:'-1'},{...conversion,amountIn:'0'},
  {...conversion,minOut:'0'},{...conversion,minOut:'140',expectedOut:'139'},{...conversion,token:undefined},{...conversion,expectedOut:'abc'}])
  assert.throws(()=>ok(bad),`rejects ${JSON.stringify(bad)}`);
});

test('the terminal close records a convert as convert, a degraded or retained close as retain, and never an unfinished exit',()=>{
 const {state}=campaignFixture();
 const closeSource={block:'11',hash:`0x${'b'.repeat(64)}`,timestamp:1010};
 const finished=(mode:'retain'|'convert')=>({...state,phase:'exit',desired:'stopped',exitMode:mode,activeTokenId:null,candidate:null}) as RangeKeeperLiveState;
 const converted=deriveRangeKeeperLiveClosedState(finished('convert'),closeSource);
 assert.deepEqual([converted.phase,converted.lastReason,converted.closedAt],['closed','convert_close_complete',1010]);
 assert.equal(deriveRangeKeeperLiveClosedState(finished('retain'),closeSource).lastReason,'retain_close_complete');
 for(const bad of [{...finished('convert'),activeTokenId:77n},{...finished('convert'),exitMode:null},{...finished('convert'),phase:'holding'},
  {...finished('convert'),desired:'running'},{...finished('convert'),phase:'halted'},{...finished('convert'),candidate:{} as any}])
  assert.throws(()=>deriveRangeKeeperLiveClosedState(bad as RangeKeeperLiveState,closeSource),/can close only after/);
 assert.throws(()=>deriveRangeKeeperLiveClosedState(finished('convert'),{...closeSource,block:'9'}),/moved backwards/);
});

test('a convert exit degrades to a retained close only after its withdrawal, keeping every recorded effect',()=>{
 const {state}=campaignFixture();
 const withdrawn={...state,phase:'exit',desired:'stopped',exitMode:'convert',activeTokenId:null,withdrawDone:true,retiredTokenIds:['77'],
  costEvents:[{hash:`0x${'1'.repeat(64)}`,block:9n,timestamp:900,gasWei:5n,gasValue:5n,swapFeeValue:0n,swapShortfallValue:0n}],gasSpentWei:5n,
  actionStartCostIndex:0,reservedActionCost:504n,haltReason:'x'} as RangeKeeperLiveState;
 const next=degradeRangeKeeperConvertExitToRetain(withdrawn,'swap_reverted:swap:1');
 assert.deepEqual([next.phase,next.desired,next.exitMode,next.haltReason,next.activeTokenId],['exit','stopped','retain',null,null]);
 assert.equal(next.lastReason,'convert_degraded_to_retain:swap_reverted:swap:1');
 assert.deepEqual(next.retiredTokenIds,['77']);assert.equal(next.costEvents.length,1);assert.equal(next.gasSpentWei,5n);
 assert.equal(next.withdrawDone,true,'a completed withdrawal is never repeated');assert.equal(isRangeKeeperRetainedExit(next),true);
 assert.equal(withdrawn.exitMode,'convert','the source state is immutable');
 assert.throws(()=>degradeRangeKeeperConvertExitToRetain({...withdrawn,activeTokenId:77n},'x'),/Only a convert exit that has withdrawn/);
 assert.throws(()=>degradeRangeKeeperConvertExitToRetain({...withdrawn,exitMode:'retain'},'x'),/Only a convert exit/);
 assert.throws(()=>degradeRangeKeeperConvertExitToRetain({...withdrawn,phase:'holding'},'x'),/Only a convert exit/);
});

test('an unavailable convert sale waits a bounded time, then falls back to a retained exit; other errors never settle',()=>{
 const {state}=campaignFixture();
 const withdrawn={...state,phase:'exit',desired:'stopped',exitMode:'convert',activeTokenId:null,withdrawDone:true} as RangeKeeperLiveState;
 const snap=snapshot();const err=new RangeKeeperExitConversionUnavailableError('Exit pool/reference deviation');
 const early=settleRangeKeeperLiveConvertExitError(withdrawn,snap,RANGEKEEPER_CONVERT_WAIT_SECONDS-1,err);
 assert.equal(early.kind,'wait');if(early.kind==='wait')assert.match(early.reason,/convert_swap_unavailable_wait: Exit pool\/reference deviation/);
 const late=settleRangeKeeperLiveConvertExitError(withdrawn,snap,RANGEKEEPER_CONVERT_WAIT_SECONDS,err);
 assert.equal(late.kind,'exit');if(late.kind==='exit'){assert.equal(late.state.exitMode,'retain');assert.equal(late.reason,'convert_swap_unavailable_retained');
  assert.match(late.state.lastReason,/^convert_degraded_to_retain:Exit pool\/reference deviation/);assert.equal(late.state.last,snap===late.state.last?snap:late.state.last);}
 assert.equal(settleRangeKeeperLiveConvertExitError(withdrawn,snap,99999,new Error('HTTP 503')).kind,'unsettled','infrastructure errors keep blocking with their own reason');
 assert.equal(settleRangeKeeperLiveConvertExitError({...withdrawn,activeTokenId:77n},snap,99999,err).kind,'unsettled','nothing settles before the withdrawal');
 assert.equal(settleRangeKeeperLiveConvertExitError({...withdrawn,exitMode:'retain'},snap,99999,err).kind,'unsettled');
 assert.equal(settleRangeKeeperLiveConvertExitError({...withdrawn,phase:'recenter'},snap,99999,err).kind,'unsettled');
 // Only the risky-leg stages of a convert exit are classified as recoverable; the withdrawal and cleanup keep their errors.
 const boundError=new Error('Stage would invade reserved exit gas');
 const swap={kind:'swap',token:1,amountIn:1n,minOut:1n,deadline:1n} as const,approveRouter={kind:'approve',token:1,spender:'router',amount:5n} as const;
 for(const plan of [swap,approveRouter]){
  const classified=classifyRangeKeeperConvertExitStageError(plan,boundError);
  assert(classified instanceof RangeKeeperExitConversionUnavailableError);assert.match((classified as Error).message,/could not be authorized: Stage would invade reserved exit gas/);
 }
 assert.equal(classifyRangeKeeperConvertExitStageError({kind:'approve',token:1,spender:'router',amount:0n},boundError),boundError,'a zero-approval cleanup is not a sale');
 assert.equal(classifyRangeKeeperConvertExitStageError({kind:'withdraw'} as any,boundError),boundError);
 assert.equal(classifyRangeKeeperConvertExitStageError(null,boundError),boundError);
 assert.equal(classifyRangeKeeperConvertExitStageError(swap,err),err,'an already typed error passes through');
});

// ----------------------------------------------------------------------------------------- stage proof permission
function proofRequest(plan:RangeKeeperLiveStageProofRequest['plan'],over:Partial<RangeKeeperLiveStageProofRequest>={}):RangeKeeperLiveStageProofRequest{
 const before={source:{block:100n,hash:`0x${'a'.repeat(64)}` as const,timestamp:1000},operator:config.operator!,wallet0:1_000_000n,wallet1:2n*10n**18n,
  nativeWei:2n*10n**18n,nonce:3,nftCount:0n,tick:0,sqrtPriceX96:sqrtInline,poolLiquidity:1000n,unlocked:true,position:null,allowances:[]} as unknown as RangeKeeperSnapshot;
 return {campaignId:'campaign-a',allocationId:'allocation-a',revision:1,stage:'exit-1',buildId:'b'.repeat(64),profileHash:'c'.repeat(64),allocationHash:'d'.repeat(64),
  referenceProofHash:'e'.repeat(64),config:proofConfig,source:before.source,beforePool:before,plan,
  allocation:{campaignId:'campaign-a',liquidByTokenAddress:{[p.token0.toLowerCase()]:1_000_000n,[p.token1.toLowerCase()]:2n*10n**18n},
   nativeSpendWei:10n**18n,exitReserveWei:10n**17n,nftTokenIds:[]},prices:{price0,price1,nativePrice:10n**18n},...over};
}
const measurement={gasUsed:30_000n,estimatedGas:25_000n,baseFeePerGasWei:2n,marketGasPriceWei:3n,forkReceiptHash:`0x${'f'.repeat(64)}`,now:1_001_000};

test('the exit-reserve stage permission covers the risky-leg sale only for a convert exit',()=>{
 const sale={kind:'swap',token:1,amountIn:10n**18n,minOut:334_000_000n,deadline:BigInt(1000+300)} as const;
 const approveSale={kind:'approve',token:1,spender:'router',amount:10n**18n} as const;
 const exit=(plan:any,over:Partial<RangeKeeperLiveStageProofRequest>={})=>buildRangeKeeperLiveStageEvidence(proofRequest(plan,{exitSpendAllowed:true,...over}),measurement);
 // Convert: the sale and its router approval are allowed and recorded in the capability.
 const convertEvidence=exit(sale,{exitConvert:true});
 assert.equal(convertEvidence.exitSpendAllowed,true);assert.equal(convertEvidence.exitConvert,true);
 assert.equal(exit(approveSale,{exitConvert:true}).exitConvert,true);
 // Retain (no convert permission): withdrawals and zero approvals only.
 for(const plan of [sale,approveSale])assert.throws(()=>exit(plan),/Exit reserve is available only to withdraw\/allowance-cleanup stages and the convert exit risky-leg sale/);
 assert.equal(exit({kind:'approve',token:1,spender:'router',amount:0n}).exitConvert,false);
 // Convert permission is not a general exit: only the risky leg, only the router, never the quote leg, never a mint.
 assert.throws(()=>exit({...sale,token:0},{exitConvert:true}),/Exit reserve is available only/);
 assert.throws(()=>exit({...approveSale,token:0},{exitConvert:true}),/Exit reserve is available only/);
 assert.throws(()=>exit({...approveSale,spender:'positionManager'},{exitConvert:true}),/Exit reserve is available only/);
 assert.throws(()=>exit({kind:'mint'} as any,{exitConvert:true}),/Exit reserve is available only/);
 assert.throws(()=>buildRangeKeeperLiveStageEvidence(proofRequest(sale,{exitConvert:true}),measurement),/Convert permission requires an exit stage/);
 // The semantic calldata gate still bounds the sale to the campaign's own inventory, and gas to the scoped reserve.
 assert.throws(()=>exit({...sale,amountIn:3n*10n**18n},{exitConvert:true}),/Transaction deadline invalid|amountIn|assert/i);
 assert.throws(()=>exit(sale,{exitConvert:true,allocation:{...proofRequest(sale).allocation,nativeSpendWei:0n,exitReserveWei:1n}}),/scoped native allocation/);
 // Discretionary stages keep their action-cost bound; a convert exit's sale is exempt from it but not from the shortfall bound.
 assert.throws(()=>buildRangeKeeperLiveStageEvidence(proofRequest(sale,{config:{...proofConfig,limits:{...proofConfig.limits,maxActionCost:1n}}}),measurement),/Stage cost exceeds reviewed action budget/);
 assert.doesNotThrow(()=>exit(sale,{exitConvert:true,config:{...proofConfig,limits:{...proofConfig.limits,maxActionCost:1n}}}));
 assert.throws(()=>exit(sale,{exitConvert:true,config:{...proofConfig,limits:{...proofConfig.limits,maxSwapShortfallValue:0n}}}),/swap shortfall exceeds policy/);
 // The capability is bound to the convert permission it was proven under.
 assert.notEqual(convertEvidence.requestHash,exit(sale,{exitConvert:true,stage:'exit-2'}).requestHash);
});
