import assert from 'node:assert/strict';
import test from 'node:test';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {contentHash} from '../src/deployments/contracts.js';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import {previewDigest} from '../src/deployments/contracts.js';
import {persistTrustedRangeKeeperPaperOpenPreview}
 from '../src/deployments/rangekeeper-paper-open-preflight.js';

const token1='0x7000000000000000000000000000000000000001';
const codeHash=`0x${'a'.repeat(64)}`;
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,
 pool:'0x8000000000000000000000000000000000000001',token0:USDG,token1,quoteToken:0,
 decimals0:6,decimals1:6,fee:3000,tickSpacing:60,positionManager:NONFUNGIBLE_POSITION_MANAGER,
 router:PAPER_ROUTER,quoter:PAPER_QUOTER,poolCodeHash:codeHash,token0CodeHash:codeHash,
 token1CodeHash:codeHash,managerCodeHash:codeHash,quoterCodeHash:codeHash,
 reference0:'USDG/USD',reference1:'TOKEN/USD',nativeReference:'ETH/USD',numeraire:'USD'},
 referencePolicy:{
  token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
  nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}});
const profileHash=contentHash(profile);
const now=Date.now();
const proof={independent:true,
 registry:{fetchedAt:new Date(now-5_000).toISOString(),sha256:`sha256:${'a'.repeat(64)}`,
  url:'https://references.example/registry.json'},
 feedDirectory:{fetchedAt:new Date(now-5_000).toISOString(),sha256:`sha256:${'b'.repeat(64)}`,
  url:'https://references.example/feeds.json'}};
const proofHash=referenceProofHash(proof);
const campaignId='00000000-0000-4000-8000-00000000abcd';
const configHash='c'.repeat(64);
const allocation={token0Raw:'1000000',token1Raw:'1000000',nativeWei:'1000000000000000'};
const draft:any={id:campaignId,revision:1,allocation,profile,profileHash,configHash,
 strategyId:'rangekeeper_v1',parameters:{fullWidthSpacings:20}};
const source={block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:Math.floor(now/1000)-15};

const model=(overrides:Record<string,unknown>={}):any=>({
 schemaVersion:1,kind:'rangekeeper_paper_open_model',status:'indicative',
 blockingReason:'rangekeeper_two_observation_confirmation_pending',campaignId,revision:1,
 strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',draftConfigHash:configHash,
 kernelPolicyHash:'d'.repeat(64),kernelBuildId:'e'.repeat(64),
 policyMapping:{minimumDeployment:'covered_by_kernel_ppm_floor',expiry:'not_configured'},
 profileHash,source,poolState:{tick:0,sqrtPriceX96:String(sqrtRatioAtTick(0)),poolLiquidity:'100'},
 reference:{price0:'1',price1:'1',nativePrice:'1',eligible:true,proofHash,proof,reasons:[]},
 allocation:{...allocation,token0Value:'1',token1Value:'1',nativeValue:'1',
  strategyInventoryValue:'2',totalAllocatedValue:'3'},
 candidate:{kind:'entry',range:{tickLower:-600,tickUpper:600},swap:null,amount0Desired:'1',
  amount1Desired:'1',amount0Min:'0',amount1Min:'0',liquidity:'1',deployedValue:'1',
  sourceBlock:'100',sourceHash:source.hash,expiresAt:source.timestamp+90},
 candidateHash:'f'.repeat(64),
 decision:{status:'indicative',reason:'pending',kernelAction:'confirm',
  kernelReason:'first_confirmation',requiresSecondObservation:true,
  remaining:{action:'1',rolling:'1',campaign:'1',nativeWei:'1'}},
 costs:{status:'provisional',profileIds:['11111111-1111-4111-8111-111111111111']},
 actionAvailable:false,
 execution:{classification:'read_only_hypothetical',fillRecorded:false,paidCosts:null,
  modeledOpenCost:null,modeledOpenCostBound:null,modeledRetainExitCost:null,
  modeledExitReserve:null,configuredExitReserveWei:null,feeAccrual:null,netNav:null,
  absolutePnl:null,passiveAlpha:null},
 unavailable:[],...overrides});

const stubStore=()=>{
 const calls:any[]=[];
 return {calls,store:{recordPreview:async(input:any)=>{calls.push(input);
  return {id:'22222222-2222-4222-8222-222222222222',
   contentDigest:previewDigest({...input}),expiresAt:input.expiresAt};}} as any};
};
const ok=async()=>{};

test('persists a trusted RangeKeeper open preview the confirmation path can read',async()=>{
 const {calls,store}=stubStore();
 const saved=await persistTrustedRangeKeeperPaperOpenPreview({store,draft,model:model(),
  verifyAnchors:ok,now});
 assert.equal(calls.length,1);
 const written=calls[0]!;
 assert.equal(written.campaignId,campaignId);
 assert.equal(written.expectedRevision,1);
 assert.equal(written.kind,'open');
 // The key the envelope reader selects (store.ts:886), plus the optional hash it
 // cross-checks when present.
 assert.equal(written.proposal.rangekeeperPaperOpenModel.candidateHash,'f'.repeat(64));
 assert.equal(written.proposal.rangekeeperPaperOpenModelHash,
  contentHash(written.proposal.rangekeeperPaperOpenModel));
 assert.equal(written.request.strategyId,'rangekeeper_v1');
 assert.equal(written.request.allocationHash,contentHash(allocation));
 assert.equal(written.evidence.verificationClass,'canonical_rangekeeper_paper_open_model_v1');
 assert.equal(written.evidence.paidCostsAvailable,false);
 assert.deepEqual(written.evidence.costProfileIds,['11111111-1111-4111-8111-111111111111']);
 // Never outlives its own canonical source: the source is 15s old, so the
 // 180s source bound (165s remaining) is tighter than the 120s preview bound.
 assert.equal(written.expiresAt.getTime(),now+120_000);
 assert.equal(saved.expectedRevision,1);
 assert.equal(saved.modelHash,contentHash(model()));
});

test('an older source shortens the preview rather than outliving it',async()=>{
 const {calls,store}=stubStore();
 const old={...source,timestamp:Math.floor(now/1000)-120};
 await persistTrustedRangeKeeperPaperOpenPreview({store,draft,
  model:model({source:old}),verifyAnchors:ok,now});
 // 180s source window minus 120s elapsed leaves 60s, below the 120s preview bound.
 assert.equal(calls[0]!.expiresAt.getTime(),old.timestamp*1000+180_000);
});

test('refuses anything the confirmation path would later reject',async()=>{
 const cases:[string,any][]=[
  ['rangekeeper_open_preview_strategy_unavailable',{draft:{...draft,strategyId:'static_manual_v1'}}],
  ['rangekeeper_open_preview_draft_binding_invalid',{model:model({revision:2})}],
  ['rangekeeper_open_preview_draft_binding_invalid',{model:model({draftConfigHash:'0'.repeat(64)})}],
  ['rangekeeper_open_costed_model_unavailable',{model:model({status:'blocked'})}],
  ['rangekeeper_open_costed_model_unavailable',{model:model({candidate:null})}],
  ['rangekeeper_open_costed_model_unavailable',{model:model({costs:null})}],
  ['rangekeeper_open_costed_model_unavailable',
   {model:model({costs:{status:'unavailable',reason:'x'}})}],
  ['rangekeeper_open_preview_policy_unavailable',{model:model({kernelPolicyHash:null})}],
  // The two-observation protocol: only a first confirmation may be bound.
  ['rangekeeper_open_preview_first_confirmation_unavailable',
   {model:model({decision:{status:'indicative',reason:'r',kernelAction:'wait',kernelReason:'w',
    requiresSecondObservation:false,remaining:null}})}],
  ['rangekeeper_open_preview_first_confirmation_unavailable',
   {model:model({decision:{status:'indicative',reason:'r',kernelAction:'confirm',kernelReason:'w',
    requiresSecondObservation:false,remaining:null}})}],
  ['rangekeeper_open_preview_reference_unavailable',
   {model:model({reference:{price0:'1',price1:'1',nativePrice:'1',eligible:false,
    proofHash,proof,reasons:['stale']}})}],
  ['rangekeeper_open_preview_source_stale',
   {model:model({source:{...source,timestamp:Math.floor(now/1000)-181}})}],
  ['rangekeeper_open_preview_source_stale',
   {model:model({source:{...source,timestamp:Math.floor(now/1000)+5}})}],
 ];
 for(const [reason,override] of cases){
  const {calls,store}=stubStore();
  await assert.rejects(()=>persistTrustedRangeKeeperPaperOpenPreview({store,draft,model:model(),
   verifyAnchors:ok,now,...override}),(error:any)=>{
   assert.equal(error.code,reason,`expected ${reason}, got ${error.code}`);return true;});
  assert.equal(calls.length,0,`${reason} must not write a preview`);
 }
});

test('a non-canonical source is refused before anything is written',async()=>{
 const {calls,store}=stubStore();
 await assert.rejects(()=>persistTrustedRangeKeeperPaperOpenPreview({store,draft,model:model(),
  verifyAnchors:async()=>{throw new Error('reorg');},now}),
  (error:any)=>{assert.equal(error.code,'rangekeeper_open_preview_source_not_canonical');return true;});
 assert.equal(calls.length,0);
});
