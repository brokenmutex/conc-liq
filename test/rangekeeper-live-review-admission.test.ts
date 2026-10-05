import assert from 'node:assert/strict';
import test from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {parseRangeKeeperConfig,rangeKeeperConfigHash} from '../src/strategy/rangekeeper/config.js';
import {admitRangeKeeperLiveSetup,rangeKeeperLiveReviewAdmissionInputSchema,
 recordRangeKeeperLiveSetupReview,type RangeKeeperLiveReviewPayload,type RangeKeeperLiveWalletState} from
 '../src/deployments/rangekeeper-live-review-admission.js';

const now=Date.now(),source={block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:Math.floor(now/1000)-10};
const wallet='0x9000000000000000000000000000000000000001',profileId='00000000-0000-4000-8000-000000000001';
const reviewId='00000000-0000-4000-8000-000000000002',requestId='00000000-0000-4000-8000-000000000003';
const buildId='b'.repeat(64),token0='0x1000000000000000000000000000000000000001',token1='0x2000000000000000000000000000000000000002';
const limits={fullWidthSpacings:120,maxDeploymentValue:'1000000000000000000',minDeploymentValue:'1',minDeploymentPpm:1,
 maxSwapInputValue:'1000000000000000000',maxSwapInputPpm:1_000_000,maxSwapShortfallValue:'1000',maxSlippageBps:50,
 maxActionCost:'1000',maxRollingCost:'1000',maxCampaignCost:'1000',maxExposurePpm:1_000_000,maxLossValue:'1000',
 maxDrawdownPpm:1_000_000,maxRecenters:2,maxLiquiditySharePpm:1_000_000,maxObservationGapSeconds:90,exitReserveWei:'1000'};
const {fullWidthSpacings:_width,...submittedLimits}=limits;
const {minDeploymentValue:_minDeploymentValue,...kernelLimits}=submittedLimits;
const kernel=parseRangeKeeperConfig({schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',broadcastEnabled:false,
 operator:wallet,pool:{chainId:4663,factory:'0x3000000000000000000000000000000000000003',pool:'0x4000000000000000000000000000000000000004',
  token0,token1,quoteToken:0,decimals0:6,decimals1:18,fee:500,tickSpacing:10,
  positionManager:'0x5000000000000000000000000000000000000005',router:'0x6000000000000000000000000000000000000006',
  quoter:'0x7000000000000000000000000000000000000007',poolCodeHash:`0x${'a'.repeat(64)}`,
  token0CodeHash:`0x${'b'.repeat(64)}`,token1CodeHash:`0x${'c'.repeat(64)}`,managerCodeHash:`0x${'d'.repeat(64)}`,
  quoterCodeHash:`0x${'e'.repeat(64)}`,reference0:'T0/USD',reference1:'T1/USD',nativeReference:'ETH/USD',numeraire:'USD'},
 limits:{...kernelLimits,fullWidthSpacings:120},signer:null,walletCode:{kind:'eoa'},zeroAllowances:[],legacyRetiredTokenIds:[],
 campaignScope:{maxDurationSeconds:43200,maxEconomicActions:2},referencePolicy:{
  token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  token1:{kind:'stock_token',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000},campaignValue:'1000000000000001000',
 strategyFundingValue:'1000000000000000000',nativeFundingValue:'1000'});
function payload(overrides:Record<string,unknown>={}):RangeKeeperLiveReviewPayload{
 const base:any={schemaVersion:1,kind:'rangekeeper_live_setup_preflight',mode:'live',strategyId:'rangekeeper_v1',
  status:'indicative',profileId,profileHash:'a'.repeat(64),input:{capitalQuoteRaw:'100000000',fullWidthSpacings:120,limits:submittedLimits},
  profile:{pool:kernel.pool.pool,fee:500,tickSpacing:10,token0,token1,quoteToken:0,decimals0:6,decimals1:18},source,
  wallet:{id:'operator-1',address:wallet,source,nonce:'5',nftTokenIds:[],commitmentsHash:'c'.repeat(64),
   token0:{balanceRaw:'1000',allocatedRaw:'100',pendingRaw:'0',freeRaw:'900'},
   token1:{balanceRaw:'2000',allocatedRaw:'0',pendingRaw:'0',freeRaw:'2000'},
   native:{balanceWei:'100000',allocatedWei:'0',pendingWei:'0',exitReserveWei:'1000',freeWei:'99000'}},
  requirements:{token0Raw:'500',token1Raw:'1000',nativeWei:'6000',strategyAllocationValueUsdX18:'1000000000000000000'},
  range:{tickLower:-600,tickUpper:600,centerTick:0,fullWidthSpacings:120},
  candidate:{kind:'open',expiresAt:Math.floor(now/1000)+80,amount0Desired:'500',amount1Desired:'1000'},
  references:{price0:'1000000000000000000',price1:'1000000000000000000',nativePrice:'2000000000000000000000',proofHash:'d'.repeat(64)},
  policy:{config:JSON.parse(JSON.stringify(kernel,(_,v)=>typeof v==='bigint'?String(v):v)),
   configHash:rangeKeeperConfigHash(kernel).slice(2),
   parameters:{fullWidthSpacings:120,limits:submittedLimits},parametersHash:'',broadcastEnabled:false,signer:null},
  costs:{status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',feasibility:'owned_fork_success',
   scope:'entry_action_only_exit_gas_reserve_only',actionCostScope:'entry_action_only',exitEconomics:'unavailable',
   syntheticNativeFunding:true,actionGasWei:'1000',actionCostValue:'1000',completeExitGasWei:'1000',exitReserveWei:'1000',
   managementGasReserveWei:'4000',fundedManagementBundles:'2'},
  binding:{buildId,walletId:'operator-1',walletAddress:wallet,profileHash:'a'.repeat(64),configHash:rangeKeeperConfigHash(kernel).slice(2),
   source,referenceProofHash:'d'.repeat(64),commitmentsHash:'c'.repeat(64),candidateHash:'f'.repeat(64),
   simulationAllocationHash:'1'.repeat(64),finalAllocationHash:'',requirementsHash:'',limitsHash:'2'.repeat(64),
   costsHash:'',sequenceHash:'3'.repeat(64),reviewHash:''},missing:[],reason:'rangekeeper_live_execution_unavailable',
  actionAvailable:false,draftCreationAvailable:false,operationAcceptanceAvailable:false,executionEligible:false};
 base.policy.parametersHash=contentHash(base.policy.parameters);
 base.binding.costsHash=contentHash(base.costs);base.binding.requirementsHash=contentHash(base.requirements);
 base.binding.finalAllocationHash=contentHash({token0Raw:'500',token1Raw:'1000',nativeWei:'6000'});
 const {reviewHash:_discard,...bindingIdentity}=base.binding;base.binding.reviewHash=contentHash(bindingIdentity);
 Object.assign(base,overrides);
 return base;
}
const walletState=():RangeKeeperLiveWalletState=>({wallet,generation:'2',status:'available',source,snapshotHash:'4'.repeat(64),
 commitmentsHash:'c'.repeat(64),nonce:'5',pendingNonce:'5',nativeBalanceWei:'100000',
 tokens:[{address:token0,balanceRaw:'1000'},{address:token1,balanceRaw:'2000'}]});
const reviewRecord=(p:RangeKeeperLiveReviewPayload)=>({reviewId,payload:p,payloadHash:contentHash(p),buildId,source,
 walletGeneration:'2',commitmentsHash:'c'.repeat(64),expiresAt:new Date((Math.floor(now/1000)+80)*1000).toISOString(),
 consumedByJob:null});
const rebind=(p:any)=>{p.binding.costsHash=contentHash(p.costs);p.binding.requirementsHash=contentHash(p.requirements);
 p.binding.finalAllocationHash=contentHash({token0Raw:p.requirements.token0Raw,token1Raw:p.requirements.token1Raw,nativeWei:p.requirements.nativeWei});
 const {reviewHash:_old,...identity}=p.binding;p.binding.reviewHash=contentHash(identity);return p;};

test('acceptance request is strict and contains only frozen review identity plus request id',()=>{
 assert.equal(rangeKeeperLiveReviewAdmissionInputSchema.safeParse({reviewId,reviewHash:'a'.repeat(64),requestId}).success,true);
 assert.equal(rangeKeeperLiveReviewAdmissionInputSchema.safeParse({reviewId,reviewHash:'a'.repeat(64),requestId,wallet}).success,false);
});

test('review persistence freezes exact payload and current wallet generation without creating an action',async()=>{
 const p=payload(),calls:any[]=[];
 const result=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload:p},{readWalletState:async()=>walletState(),
  recordReview:async row=>{calls.push(row);},now:()=>now});
 assert.equal(result.status,'review_recorded',JSON.stringify(result));
 if(result.status!=='review_recorded')return;
 assert.equal(result.reviewHash,contentHash(p));assert.equal(calls.length,1);
 assert.equal(calls[0].walletGeneration,'2');assert.equal(contentHash(calls[0].payload),contentHash(p));
 assert.equal(calls[0].reviewHash,contentHash(p));
});

test('review persistence rejects changed wallet snapshot, malformed commitments, and missing server build identity',async()=>{
 const p=payload(),base={recordReview:async()=>{},now:()=>now};
 const changed=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload:p},{...base,
  readWalletState:async()=>({...walletState(),commitmentsHash:'9'.repeat(64)})});
 assert.equal(changed.status,'unavailable');
 const missingBuild=payload({binding:{...p.binding,buildId:null}});
 const noBuild=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload:missingBuild},{...base,
  readWalletState:async()=>walletState()});
 assert.equal(noBuild.status,'unavailable');
});

test('review persistence rejects tampered management bundles and native inventory below the full reserve',async()=>{
 const base=payload(),persisted:any[]=[];
 const deps={readWalletState:async()=>walletState(),recordReview:async(row:any)=>{persisted.push(row);},now:()=>now};
 const badReserve=structuredClone(base) as any;badReserve.costs.managementGasReserveWei='3999';rebind(badReserve);
 const reserveResult=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload:badReserve},deps);
 assert.equal(reserveResult.status,'unavailable');
 const unbounded=structuredClone(base) as any;unbounded.costs.managementGasReserveWei='6000';
 unbounded.costs.fundedManagementBundles='3';unbounded.requirements.nativeWei='8000';rebind(unbounded);
 const bundleResult=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload:unbounded},deps);
 assert.equal(bundleResult.status,'unavailable');
 const underfunded=structuredClone(base) as any;underfunded.wallet.native.exitReserveWei='94001';underfunded.wallet.native.freeWei='5999';rebind(underfunded);
 const inventoryResult=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload:underfunded},deps);
 assert.equal(inventoryResult.status,'unavailable');assert.equal(persisted.length,0);
});

test('zero recenter limit remains unbounded policy but binds only one funded native management bundle',async()=>{
 const p=structuredClone(payload()) as any;p.input.limits.maxRecenters=0;p.policy.parameters.limits.maxRecenters=0;
 p.policy.config.limits.maxRecenters=0;const config=parseRangeKeeperConfig(p.policy.config);
 p.policy.configHash=rangeKeeperConfigHash(config).slice(2);p.policy.parametersHash=contentHash(p.policy.parameters);
 p.binding.configHash=p.policy.configHash;p.costs.managementGasReserveWei='2000';p.costs.fundedManagementBundles='1';
 p.requirements.nativeWei='4000';rebind(p);let persisted:any=null;
 const result=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload:p},{readWalletState:async()=>walletState(),
  recordReview:async row=>{persisted=row;},now:()=>now});
 assert.equal(result.status,'review_recorded',JSON.stringify(result));assert(persisted);
 assert.equal(persisted.payload.policy.config.limits.maxRecenters,0);
 assert.equal(persisted.payload.costs.fundedManagementBundles,'1');
 assert.equal(persisted.payload.costs.managementGasReserveWei,'2000');
});

test('admission rechecks pinned preflight, binds exact costs/allocation, then atomically queues once',async()=>{
 const p=payload(),record=reviewRecord(p),calls:any[]=[];
 const deps:any={wallet,buildId,readReview:async()=>record,readWalletState:async()=>walletState(),
  findRequest:async()=>null,
  verifyCanonical:async()=>{},revalidatePinned:async()=>p,consumeReviewAndReserve:async (input:unknown)=>{calls.push(input);
   return {status:'queued',campaignId:'campaign-1',jobId:'job-1',allocationId:'allocation-1',replayed:false};},now:()=>now};
 const result=await admitRangeKeeperLiveSetup({reviewId,reviewHash:record.payloadHash,requestId},deps);
 assert.equal(result.status,'queued',JSON.stringify(result));assert.equal(calls.length,1);
 assert.deepEqual(calls[0].allocation.tokens,[{address:token0,amountRaw:'500'},{address:token1,amountRaw:'1000'}]);
 assert.equal(calls[0].allocation.nativeSpendWei,'5000');assert.equal(calls[0].allocation.exitReserveWei,'1000');
 assert.equal(calls[0].campaign.configHash,contentHash(calls[0].campaign.config));
 assert.equal(calls[0].campaign.baseline.source.hash,source.hash);
 assert.equal(calls[0].requestDigest,contentHash({reviewId,reviewHash:record.payloadHash}));
});

test('changed build, wallet generation, references, fork costs, or allocation fail before reserve',async()=>{
 const p=payload(),record=reviewRecord(p);let reserveCalls=0;
 const base:any={wallet,buildId,readReview:async()=>record,readWalletState:async()=>walletState(),
  findRequest:async()=>null,
  verifyCanonical:async()=>{},revalidatePinned:async()=>p,consumeReviewAndReserve:async()=>{reserveCalls++;return {status:'queued',campaignId:'c',jobId:'j',allocationId:'a',replayed:false};},now:()=>now};
 for(const deps of [
  {...base,buildId:'9'.repeat(64)},
  {...base,readWalletState:async()=>({...walletState(),generation:'9'})},
  {...base,revalidatePinned:async()=>{const changed=structuredClone(p) as any;changed.references.proofHash='9'.repeat(64);return changed;}},
  {...base,revalidatePinned:async()=>{const changed=structuredClone(p) as any;
   changed.source.hash=`0x${'9'.repeat(64)}`;return changed;}},
  {...base,revalidatePinned:async()=>{const changed=structuredClone(p) as any;changed.costs.actionGasWei='2000';return changed;}},
  {...base,revalidatePinned:async()=>{const changed=structuredClone(p) as any;changed.requirements.token0Raw='901';return changed;}},
 ]){
  const result=await admitRangeKeeperLiveSetup({reviewId,reviewHash:record.payloadHash,requestId},deps);
  assert.notEqual(result.status,'queued');
 }
 assert.equal(reserveCalls,0);
});

test('same request id with another digest conflicts and exact replay can bypass expired freshness',async()=>{
 const p=payload(),record=reviewRecord(p),base:any={wallet,buildId,
  readReview:async()=>({...record,expiresAt:new Date(now-1000).toISOString()}),readWalletState:async()=>null,
  verifyCanonical:async()=>{},revalidatePinned:async()=>{throw Error('must not replay preflight');},consumeReviewAndReserve:async()=>{throw Error('must not reserve');},
  findRequest:async(_w:string,_id:string,digest:string)=>digest==='other'?{status:'conflict'}:
   {status:'found',campaignId:'c',jobId:'j',allocationId:'a'},now:()=>now};
 const replay=await admitRangeKeeperLiveSetup({reviewId,reviewHash:record.payloadHash,requestId},base);
 assert.equal(replay.status,'queued');if(replay.status==='queued')assert.equal(replay.replayed,true);
 base.findRequest=async()=>({status:'conflict'});
 const conflict=await admitRangeKeeperLiveSetup({reviewId,reviewHash:record.payloadHash,requestId},base);
 assert.equal(conflict.status,'request_conflict');
});

const advanced=(k:number)=>({block:String(100+k*30),hash:`0x${String(k).repeat(64)}`,timestamp:source.timestamp+k*15});
function admissionDeps(state:()=>RangeKeeperLiveWalletState,canonical:(s:{block:string;hash:string;timestamp:number})=>Promise<void>=async()=>{}){
 const p=payload(),record=reviewRecord(p),calls:unknown[]=[],verified:string[]=[];
 const deps:any={wallet,buildId,readReview:async()=>record,readWalletState:async()=>state(),findRequest:async()=>null,
  verifyCanonical:async(s:{block:string;hash:string;timestamp:number})=>{verified.push(s.block);await canonical(s);},revalidatePinned:async()=>p,
  consumeReviewAndReserve:async(input:unknown)=>{calls.push(input);return {status:'queued',campaignId:'c',jobId:'j',allocationId:'a',replayed:false};},now:()=>now};
 return {deps,calls,verified,record};
}

test('a review followed by source-only wallet refreshes still admits once the later source is canonical',async()=>{
 for(const k of [1,2,5]){
  const {deps,calls,verified,record}=admissionDeps(()=>({...walletState(),source:advanced(k)}));
  const result=await admitRangeKeeperLiveSetup({reviewId,reviewHash:record.payloadHash,requestId},deps);
  assert.equal(result.status,'queued',`${k} source-only refreshes: ${JSON.stringify(result)}`);assert.equal(calls.length,1);
  assert(verified.includes(advanced(k).block),'the advanced persisted source itself must be verified canonical');
 }
});

test('review persistence accepts a later persisted source but rejects a backwards or forked one',async()=>{
 const p=payload(),base={recordReview:async()=>{},now:()=>now};
 const later=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload:p},{...base,readWalletState:async()=>({...walletState(),source:advanced(2)})});
 assert.equal(later.status,'review_recorded',JSON.stringify(later));
 for(const bad of [{block:'99',hash:`0x${'9'.repeat(64)}`,timestamp:source.timestamp-1},{...source,hash:`0x${'9'.repeat(64)}`}]){
  const result=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload:p},{...base,readWalletState:async()=>({...walletState(),source:bad})});
  assert.equal(result.status,'unavailable');
 }
});

test('wallet content changes after the review reject admission as live_wallet_changed_since_review',async()=>{
 const changes:Array<[string,Partial<RangeKeeperLiveWalletState>]>=[
  ['generation (sibling receipt-attributed change)',{generation:'3',source:advanced(1),nonce:'6',pendingNonce:'6'}],
  ['generation only',{generation:'3',source:advanced(1)}],
  ['commitments',{commitmentsHash:'9'.repeat(64),source:advanced(1)}],
  ['nonce',{nonce:'6',pendingNonce:'6',source:advanced(1)}],
  ['pending nonce',{pendingNonce:'6',source:advanced(1)}],
 ];
 for(const [name,change] of changes){
  const {deps,calls,record}=admissionDeps(()=>({...walletState(),...change}));
  const result=await admitRangeKeeperLiveSetup({reviewId,reviewHash:record.payloadHash,requestId},deps);
  assert.equal(result.status,'unavailable',name);
  assert.deepEqual((result as any).missing,['live_wallet_changed_since_review'],name);assert.equal(calls.length,0,name);
 }
});

test('a backwards, forked or non-canonical persisted source never admits',async()=>{
 const cases:Array<[string,RangeKeeperLiveWalletState,((s:{block:string})=>Promise<void>)?]>=[
  ['backwards',{...walletState(),source:{block:'99',hash:`0x${'9'.repeat(64)}`,timestamp:source.timestamp-1}}],
  ['same height other hash',{...walletState(),source:{...source,hash:`0x${'9'.repeat(64)}`}}],
  ['later but not canonical',{...walletState(),source:advanced(1)},async s=>{if(s.block===advanced(1).block)throw Error('reorged');}],
 ];
 for(const [name,state,canonical] of cases){
  const {deps,calls,record}=admissionDeps(()=>state,canonical as any);
  const result=await admitRangeKeeperLiveSetup({reviewId,reviewHash:record.payloadHash,requestId},deps);
  assert.equal(result.status,'unavailable',name);assert.deepEqual((result as any).missing,['live_wallet_changed_since_review'],name);
  assert.equal(calls.length,0,name);
 }
});

test('review expiry and the 90 second candidate window are unchanged by source-only refreshes',async()=>{
 const p=payload({candidate:{kind:'open',expiresAt:Math.floor(now/1000)-1,amount0Desired:'500',amount1Desired:'1000'}}),record=reviewRecord(p);
 const result=await admitRangeKeeperLiveSetup({reviewId,reviewHash:record.payloadHash,requestId},{wallet,buildId,
  readReview:async()=>record,readWalletState:async()=>({...walletState(),source:advanced(1)}),findRequest:async()=>null,
  verifyCanonical:async()=>{},revalidatePinned:async()=>p,consumeReviewAndReserve:async()=>{throw Error('must not reserve');},now:()=>now} as any);
 assert.equal(result.status,'unavailable');assert.deepEqual((result as any).missing,['live_setup_review_expired_or_stale']);
});

const withScope=(scope:{maxDurationSeconds:number;maxEconomicActions:number})=>{
 const p=structuredClone(payload()) as any;p.policy.config.campaignScope=scope;p.input.campaignScope=scope;
 p.policy.parameters.campaignScope=scope;const config=parseRangeKeeperConfig(p.policy.config);
 p.policy.configHash=rangeKeeperConfigHash(config).slice(2);p.policy.parametersHash=contentHash(p.policy.parameters);
 p.binding.configHash=p.policy.configHash;return rebind(p);
};
const OPEN_ENDED={maxDurationSeconds:0,maxEconomicActions:0};

test('an operator campaign scope is frozen into the reviewed config and carried into the admitted campaign',async()=>{
 const p=withScope(OPEN_ENDED),record=reviewRecord(p),calls:any[]=[];
 const recorded:any[]=[];
 const review=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload:p},{readWalletState:async()=>walletState(),
  recordReview:async row=>{recorded.push(row);},now:()=>now});
 assert.equal(review.status,'review_recorded',JSON.stringify(review));
 assert.deepEqual(recorded[0].payload.policy.config.campaignScope,OPEN_ENDED);
 const deps:any={wallet,buildId,readReview:async()=>record,readWalletState:async()=>walletState(),findRequest:async()=>null,
  verifyCanonical:async()=>{},revalidatePinned:async()=>p,consumeReviewAndReserve:async(input:unknown)=>{calls.push(input);
   return {status:'queued',campaignId:'campaign-1',jobId:'job-1',allocationId:'allocation-1',replayed:false};},now:()=>now};
 const result=await admitRangeKeeperLiveSetup({reviewId,reviewHash:record.payloadHash,requestId},deps);
 assert.equal(result.status,'queued',JSON.stringify(result));
 assert.deepEqual(calls[0].campaign.config.campaignScope,OPEN_ENDED,'the campaign revision config records the scope');
 assert.equal(calls[0].campaign.configHash,contentHash(calls[0].campaign.config));
 assert.notEqual(calls[0].campaign.configHash,(()=>{const legacy=payload();return contentHash({...legacy.policy.parameters,
  strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1});})(),'a different scope is a different campaign config');
});

test('a campaign scope that disagrees with its frozen hash is not recorded, and a drifted scope never admits',async()=>{
 const tampered=structuredClone(withScope(OPEN_ENDED)) as any;
 tampered.policy.config.campaignScope={maxDurationSeconds:86_400,maxEconomicActions:10};rebind(tampered);
 const recorded:any[]=[];
 const rejected=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload:tampered},{readWalletState:async()=>walletState(),
  recordReview:async row=>{recorded.push(row);},now:()=>now});
 assert.equal(rejected.status,'unavailable');assert.equal(recorded.length,0,'the scope cannot change without the config hash changing');
 const p=withScope(OPEN_ENDED),record=reviewRecord(p);let reserves=0;
 const base:any={wallet,buildId,readReview:async()=>record,readWalletState:async()=>walletState(),findRequest:async()=>null,
  verifyCanonical:async()=>{},consumeReviewAndReserve:async()=>{reserves++;return {status:'queued',campaignId:'c',jobId:'j',allocationId:'a',replayed:false};},now:()=>now};
 const drifted=await admitRangeKeeperLiveSetup({reviewId,reviewHash:record.payloadHash,requestId},
  {...base,revalidatePinned:async()=>withScope({maxDurationSeconds:43_200,maxEconomicActions:2})});
 assert.notEqual(drifted.status,'queued',JSON.stringify(drifted));assert.equal(reserves,0);
});
