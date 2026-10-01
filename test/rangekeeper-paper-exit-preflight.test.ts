import assert from 'node:assert/strict';
import test from 'node:test';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {contentHash,previewDigest} from '../src/deployments/contracts.js';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import {rangeKeeperPaperConvertQuoteContent,rangeKeeperPaperConvertQuoteHash,
 rangeKeeperPaperConvertQuoteSchema} from '../src/deployments/rangekeeper-paper-exit-model.js';
import {persistTrustedRangeKeeperPaperExitPreview}
 from '../src/deployments/rangekeeper-paper-exit-preflight.js';

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
const limits={maxDeploymentValue:String(100n*10n**18n),minDeploymentValue:String(1n*10n**18n),
 minDeploymentPpm:10_000,maxSwapInputValue:String(10n*10n**18n),maxSwapInputPpm:1_000_000,
 maxSwapShortfallValue:String(1n*10n**18n),maxSlippageBps:50,
 maxActionCost:String(5n*10n**18n),maxRollingCost:String(8n*10n**18n),maxCampaignCost:String(16n*10n**18n),
 maxExposurePpm:1_000_000,maxLossValue:String(10n*10n**18n),maxDrawdownPpm:1_000_000,maxRecenters:5,
 maxLiquiditySharePpm:1_000_000,maxObservationGapSeconds:90,exitReserveWei:'1000000000000000'};
const parameters={fullWidthSpacings:120,limits};
const configHash=contentHash({...parameters,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',
 stateSchemaVersion:1});
const allocation={token0Raw:'1000000',token1Raw:'1000000',nativeWei:'1000000000000000'};
const draft:any={id:campaignId,revision:1,allocation,profile,profileHash,configHash,
 strategyId:'rangekeeper_v1',parameters};
const source={block:'200',hash:`0x${'2'.repeat(64)}`,timestamp:Math.floor(now/1000)-15};
const previousSource={block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:Math.floor(now/1000)-200};
const openMarkId='1',candidateHash='f'.repeat(64),openModelHash='e'.repeat(64);

const costs=(kind:'retain'|'convert'):any=>({status:'provisional',kind,
 scope:'range_keeper_terminal_exit_gas_only',evidenceClass:'fork_estimated',
 pathVersion:kind==='retain'?'paper_rangekeeper_v1_no_swap_v1':'paper_rangekeeper_v1_direct_convert_exit_v1',
 sizeBand:`rk_${'0'.repeat(32)}`,
 profileIds:[{stage:'exit_withdraw_collect',id:'00000000-0000-4000-8000-000000000001',version:1}],
 marketGasPriceWei:'1000000000',boundGasPriceWei:'1250000000',gasPriceObservedAt:new Date(now).toISOString(),
 nativeReferencePrice:String(2000n*10n**18n),swapFeeAndShortfallValue:'0',
 expectedGasUnits:'100000',boundGasUnits:'120000',expectedWei:'100000000000000',boundWei:'150000000000000',
 expectedGasValue:'200000000000000000',boundGasValue:'300000000000000000',
 expectedValue:'200000000000000000',boundValue:'300000000000000000',requiredReserveWei:'1000000000000000',
 unavailable:[]});

// The exact maxSlippageBps `limits.maxSlippageBps` above (50) that the quote
// must be recomputed against — the preflight pulls it from `draft.parameters`,
// never from the quote itself.
const convertQuote=(overrides:Record<string,unknown>={}):any=>{
 const base={pathVersion:'paper_rangekeeper_v1_direct_convert_exit_v1',inputToken:1 as const,
  outputToken:0 as const,inputAmount:'1000',expectedOutput:'900',minimumOutput:'855',
  expectedProceedsValue:'900',minimumProceedsValue:'855',feeValue:'10',shortfallValue:'5'};
 const content=rangeKeeperPaperConvertQuoteContent({candidateHash,source,
  pool:{pool:profile.pool.pool,router:profile.pool.router,quoter:profile.pool.quoter,fee:profile.pool.fee},
  inputToken:base.inputToken,outputToken:base.outputToken,inputAmount:BigInt(base.inputAmount),
  expectedOutput:BigInt(base.expectedOutput),minimumOutput:BigInt(base.minimumOutput),
  feeValue:BigInt(base.feeValue),shortfallValue:BigInt(base.shortfallValue),maxSlippageBps:50});
 // `overrides` is applied after the hash is computed from the unmodified base,
 // so a case that overrides a priced field (without recomputing) deliberately
 // produces a quote whose self-reported hash no longer matches its content.
 return rangeKeeperPaperConvertQuoteSchema.parse({...base,
  quoteHash:rangeKeeperPaperConvertQuoteHash(content),...overrides});
};

const model=(exitKind:'retain'|'convert',overrides:Record<string,unknown>={}):any=>({
 schemaVersion:1,kind:'rangekeeper_paper_exit_model',status:'indicative',exitKind,
 blockingReason:'rangekeeper_operator_terminal_request_read_only',actionAvailable:false,
 campaignId,revision:1,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',draftConfigHash:configHash,
 kernelPolicyHash:'d'.repeat(64),kernelBuildId:'c'.repeat(64),profileHash,
 openMarkId,openModelHash,candidateHash,
 previousMark:{id:'0',source:previousSource,candidateHash},
 source,poolState:{tick:0,sqrtPriceX96:'79228162514264337593543950336',poolLiquidity:'100'},
 reference:{price0:'1',price1:'1',nativePrice:'1',proofHash,proof},
 inventoryProofHash:'9'.repeat(64),
 position:{paperPositionKey:`paper:${candidateHash}`,tickLower:-600,tickUpper:600,liquidity:'1',
  sharePpm:'1',idle0:'0',idle1:'0',principal0:'1',principal1:'1',
  retainedLowerBound0:'1',retainedLowerBound1:'1'},
 conversion:exitKind==='convert'?convertQuote():null,
 costs:costs(exitKind),
 kernelEvaluation:{action:'wait',reason:'operator_terminal_request',candidateHash:null,
  simulationAvailable:true,remaining:{action:'1',rolling:'1',campaign:'1',nativeWei:'1'}},
 unmodeled:['uncollected_fees'],unavailable:[],...overrides});

const stubStore=()=>{
 const calls:any[]=[];
 return {calls,store:{recordPreview:async(input:any)=>{calls.push(input);
  return {id:'22222222-2222-4222-8222-222222222222',
   contentDigest:previewDigest({...input}),expiresAt:input.expiresAt};}} as any};
};
const ok=async()=>{};

test('persists a trusted RangeKeeper retain-exit preview',async()=>{
 const {calls,store}=stubStore();
 const saved=await persistTrustedRangeKeeperPaperExitPreview({store,draft,
  model:model('retain'),kind:'close_retain',verifyAnchors:ok,now});
 assert.equal(calls.length,1);
 const written=calls[0]!;
 assert.equal(written.campaignId,campaignId);
 assert.equal(written.expectedRevision,1);
 assert.equal(written.kind,'close_retain');
 assert.equal(written.proposal.rangekeeperPaperExitModel.candidateHash,candidateHash);
 assert.equal(written.proposal.rangekeeperPaperExitModelHash,
  contentHash(written.proposal.rangekeeperPaperExitModel));
 assert.equal(written.proposal.rangekeeperPaperConvertQuote,undefined);
 assert.deepEqual(written.request,{kind:'close_retain',strategyId:'rangekeeper_v1',profileHash,
  configHash,openMarkId,candidateHash,exitKind:'retain'});
 assert.equal(written.evidence.verificationClass,'canonical_rangekeeper_paper_exit_model_v1');
 assert.equal(written.evidence.inventoryHash,'9'.repeat(64));
 assert.equal(written.evidence.paidCostsAvailable,false);
 assert.equal(written.evidence.feeAccrualAvailable,false);
 // Source is 15s old: the 180s source bound (165s remaining) is looser than
 // the 120s preview bound, so the preview bound governs.
 assert.equal(written.expiresAt.getTime(),now+120_000);
 assert.equal(saved.expectedRevision,1);
 assert.equal(saved.modelHash,contentHash(model('retain')));
});

test('persists a trusted RangeKeeper convert-exit preview with its quote',async()=>{
 const {calls,store}=stubStore();
 await persistTrustedRangeKeeperPaperExitPreview({store,draft,
  model:model('convert'),kind:'close_convert',verifyAnchors:ok,now});
 assert.equal(calls.length,1);
 const written=calls[0]!;
 assert.equal(written.kind,'close_convert');
 assert.equal(written.request.exitKind,'convert');
 assert.ok(written.proposal.rangekeeperPaperConvertQuote);
 assert.equal(written.proposal.rangekeeperPaperConvertQuote.quoteHash,
  written.proposal.rangekeeperPaperExitModel.conversion.quoteHash);
});

test('an older source shortens the preview rather than outliving it',async()=>{
 const {calls,store}=stubStore();
 const old={...source,timestamp:Math.floor(now/1000)-120};
 await persistTrustedRangeKeeperPaperExitPreview({store,draft,
  model:model('retain',{source:old}),kind:'close_retain',verifyAnchors:ok,now});
 // 180s source window minus 120s elapsed leaves 60s, below the 120s preview bound.
 assert.equal(calls[0]!.expiresAt.getTime(),old.timestamp*1000+180_000);
});

test('refuses anything an acceptance or worker would later reject',async()=>{
 const cases:[string,'close_retain'|'close_convert','retain'|'convert',Record<string,unknown>][]=[
  ['rangekeeper_exit_preview_strategy_unavailable','close_retain','retain',{}],
  ['rangekeeper_exit_preview_kind_mismatch','close_convert','retain',{}],
  ['rangekeeper_exit_costed_model_unavailable','close_retain','retain',{status:'blocked'}],
  ['rangekeeper_exit_costed_model_unavailable','close_retain','retain',{costs:null}],
  ['rangekeeper_exit_costed_model_unavailable','close_retain','retain',
   {costs:{...costs('retain'),status:'unavailable'}}],
  ['rangekeeper_exit_preview_draft_binding_invalid','close_retain','retain',{revision:2}],
  ['rangekeeper_exit_preview_draft_binding_invalid','close_retain','retain',{draftConfigHash:'0'.repeat(64)}],
  ['rangekeeper_exit_preview_draft_binding_invalid','close_retain','retain',
   {profileHash:'0'.repeat(64)}],
  ['rangekeeper_exit_preview_mark_identity_unavailable','close_retain','retain',{openMarkId:''}],
  ['rangekeeper_exit_preview_mark_identity_unavailable','close_retain','retain',
   {openModelHash:'not-hex'}],
  ['rangekeeper_exit_preview_mark_identity_unavailable','close_retain','retain',{candidateHash:''}],
  ['rangekeeper_exit_preview_reference_unavailable','close_retain','retain',
   {reference:{price0:'1',price1:'1',nativePrice:'1',proofHash,proof:{}}}],
  ['rangekeeper_exit_preview_reference_unavailable','close_retain','retain',
   {reference:{price0:'1',price1:'1',nativePrice:'1',proofHash:'0'.repeat(64),proof}}],
  ['rangekeeper_exit_preview_source_stale','close_retain','retain',
   {source:{...source,timestamp:Math.floor(now/1000)-181}}],
  ['rangekeeper_exit_preview_source_stale','close_retain','retain',
   {source:{...source,timestamp:Math.floor(now/1000)+5}}],
  ['rangekeeper_exit_preview_convert_quote_unavailable','close_convert','convert',{conversion:null}],
  ['rangekeeper_exit_preview_convert_quote_hash_mismatch','close_convert','convert',
   {conversion:convertQuote({feeValue:'999'})}],
 ];
 for(const [reason,kind,exitKind,override] of cases){
  const {calls,store}=stubStore();
  await assert.rejects(()=>persistTrustedRangeKeeperPaperExitPreview({store,
   draft:reason==='rangekeeper_exit_preview_strategy_unavailable'?
    {...draft,strategyId:'static_manual_v1'}:draft,
   model:model(exitKind,override),kind,verifyAnchors:ok,now}),
   (error:any)=>{assert.equal(error.code,reason,`expected ${reason}, got ${error.code}`);return true;});
  assert.equal(calls.length,0,`${reason} must not write a preview`);
 }
});

test('a non-canonical source is refused before anything is written',async()=>{
 const {calls,store}=stubStore();
 await assert.rejects(()=>persistTrustedRangeKeeperPaperExitPreview({store,draft,
  model:model('retain'),kind:'close_retain',
  verifyAnchors:async()=>{throw new Error('reorg');},now}),
  (error:any)=>{assert.equal(error.code,'rangekeeper_exit_preview_source_not_canonical');return true;});
 assert.equal(calls.length,0);
});

test('a draft whose persisted profile no longer hashes to its own profileHash is refused',async()=>{
 const {calls,store}=stubStore();
 const taperedDraft={...draft,profileHash:'0'.repeat(64)};
 await assert.rejects(()=>persistTrustedRangeKeeperPaperExitPreview({store,draft:taperedDraft,
  model:model('retain',{profileHash:'0'.repeat(64)}),kind:'close_retain',verifyAnchors:ok,now}),
  (error:any)=>{assert.equal(error.code,'rangekeeper_exit_preview_profile_hash_mismatch');return true;});
 assert.equal(calls.length,0);
});

test('a convert quote missing from a draft with no limits is refused',async()=>{
 const {calls,store}=stubStore();
 const noLimitsDraft={...draft,parameters:{fullWidthSpacings:120}};
 await assert.rejects(()=>persistTrustedRangeKeeperPaperExitPreview({store,draft:noLimitsDraft,
  model:model('convert'),kind:'close_convert',verifyAnchors:ok,now}),
  (error:any)=>{assert.equal(error.code,'rangekeeper_exit_preview_convert_quote_unavailable');return true;});
 assert.equal(calls.length,0);
});
