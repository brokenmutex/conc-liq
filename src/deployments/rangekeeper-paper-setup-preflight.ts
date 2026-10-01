import {z} from 'zod';
import {sqrtRatioAtTick} from '../backtest/principal.js';
import {USDG} from '../constants.js';
import {planRangeKeeper,rangeKeeperRange,rawValue} from '../strategy/rangekeeper/planner.js';
import type {RangeKeeperCandidate,RangeKeeperLimits} from '../strategy/rangekeeper/domain.js';
import {positionAmounts,replayPaperMint} from '../v3/position-math.js';
import {contentHash,rangeKeeperLimitsSchema,rangeKeeperPaperSetupConfigHash} from './contracts.js';
import {modelRangeKeeperPaperCosts,rangeKeeperPaperCandidateHash,rangeKeeperPaperPathVersion,
 selectRangeKeeperPaperCostProfiles,type RangeKeeperPaperCandidateScope,
 type RangeKeeperPaperModeledCosts} from './rangekeeper-paper-cost.js';
import {produceRangeKeeperPaperGasEvidence,rangeKeeperPaperSpeculativeGasRows,
 verifyRangeKeeperPaperGasReport,type RangeKeeperPaperGasProbeRequest,
 type RangeKeeperPaperGasStageSample} from './rangekeeper-paper-gas-evidence.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft} from './rangekeeper-paper-open-model.js';
import {marketProfileSchema,referenceProofHash,type MarketProfile} from './market-profile.js';
import {pinnedExternalReferenceProofIdentityHash} from './pinned-external-reference-proof.js';
import type {PaperOpenFrame} from './paper-preview.js';
import type {PaperGasProfileRow} from './paper-cost.js';
import type {PaperSetupProfile} from './paper-setup-preflight.js';

const PPM=1_000_000n;
const MAX_CAPITAL_QUOTE=100_000n*10n**6n;
const UINT128_MAX=(1n<<128n)-1n;
const raw=z.string().regex(/^(0|[1-9][0-9]*)$/).max(12)
 .refine(value=>/^(0|[1-9][0-9]*)$/.test(value)&&BigInt(value)>0n&&BigInt(value)<=MAX_CAPITAL_QUOTE);
// Limits are required, unlike the static contract's optional limits: the
// RangeKeeper kernel has no limit-free sizing mode at all (construct() reads
// maxDeploymentValue, minDeploymentPpm and maxSlippageBps to size anything),
// so a limits-less preflight could never call the planner meaningfully.
export const rangeKeeperSetupPreflightInput=z.object({profileId:z.uuid(),capitalQuoteRaw:raw,
 fullWidthSpacings:z.number().int().min(2).max(2000).refine(value=>value%2===0),
 limits:rangeKeeperLimitsSchema}).strict();
export type RangeKeeperSetupPreflightInput=z.infer<typeof rangeKeeperSetupPreflightInput>;

// A placeholder build identity: resolveRangeKeeperPaperPolicy requires the
// 64-hex shape but never checks its value against anything else, and the
// preflight itself never replays against a persisted runtime build (that
// binding belongs to the open/confirmation path once a draft exists).
const SETUP_BUILD_ID='0'.repeat(64);

/** A RangeKeeper candidate identity folds in campaignId and revision, which do
 * not exist before a draft does, so the preflight supplies fixed sentinels. It
 * can do this safely only because the evidence it samples is never persisted:
 * `rangeKeeperPaperSpeculativeGasRows` rows are costed in the same request and
 * discarded, so a sentinel identity never enters the store's hash space and
 * cannot be mistaken for a real campaign's evidence. The alternative — keeping
 * a separate pre-draft hash space — was what made this preflight inert, since
 * `produceRangeKeeperPaperGasEvidence` asserts the scope's candidateHash is the
 * production one and no sampler could ever target anything else. */
export type RangeKeeperSetupForkSampler=(request:RangeKeeperPaperGasProbeRequest,
 options:{limits:RangeKeeperLimits;initialBalances:readonly [bigint,bigint]})=>
 Promise<readonly RangeKeeperPaperGasStageSample[]>;

const SETUP_CAMPAIGN_ID='00000000-0000-4000-8000-000000000000';
const SETUP_REVISION=1;

/** A missing-stage list is only meaningful when the selector actually looked at
 * rows; a sampling failure has none, and must not report a bare trailing colon. */
const costUnavailableReason=(selected:{reason:string;missingStages:readonly string[]})=>
 selected.missingStages.length?`${selected.reason}:${selected.missingStages.join(',')}`:selected.reason;

const ceilDiv=(n:bigint,d:bigint)=>n===0n?0n:(n+d-1n)/d;
const ceilRefValueQuoteRaw=(amount:bigint,priceX18:bigint,decimals:number,
 quotePriceX18:bigint,quoteDecimals:number)=>
 ceilDiv(amount*priceX18*10n**BigInt(quoteDecimals),10n**BigInt(decimals)*quotePriceX18);
const ceilUsdX18=(amount:bigint,priceX18:bigint,decimals:number)=>ceilDiv(amount*priceX18,10n**BigInt(decimals));

function serializeCandidate(c:RangeKeeperCandidate){
 return {kind:c.kind,range:c.range,swap:c.swap?{token:c.swap.token,amountIn:String(c.swap.amountIn),
  quotedOut:String(c.swap.quotedOut),minOut:String(c.swap.minOut),priceAfter:String(c.swap.priceAfter),
  feeValue:String(c.swap.feeValue),shortfallValue:String(c.swap.shortfallValue)}:null,
  amount0Desired:String(c.amount0Desired),amount1Desired:String(c.amount1Desired),
  amount0Min:String(c.amount0Min),amount1Min:String(c.amount1Min),liquidity:String(c.liquidity),
  deployedValue:String(c.deployedValue),sourceBlock:String(c.sourceBlock),sourceHash:c.sourceHash,
  expiresAt:c.expiresAt};
}

/** Pre-draft candidate identity: the production `rangeKeeperPaperCandidateHash`
 * over the real profile, configHash, source, reference proof and candidate, with
 * the campaignId and revision that cannot exist yet replaced by sentinels. It is
 * therefore the same hash space as the post-draft identity, which is what lets
 * the preflight sample its own gas evidence at review time instead of looking up
 * a band nothing writes. See SETUP_CAMPAIGN_ID for why that is safe here. */
export function rangeKeeperPaperSetupCandidateIdentity(input:{profileHash:string;configHash:string;
 source:PaperOpenFrame['source'];referenceProofHash:string;candidate:RangeKeeperCandidate}){
 return rangeKeeperPaperCandidateHash({campaignId:SETUP_CAMPAIGN_ID,revision:SETUP_REVISION,
  profileHash:input.profileHash,configHash:input.configHash,source:input.source,
  referenceProofHash:input.referenceProofHash,candidate:input.candidate});
}

function unavailable(input:RangeKeeperSetupPreflightInput,reason:string,profileId=input.profileId){
 return {schemaVersion:1 as const,kind:'rangekeeper_paper_setup_preflight' as const,status:'unavailable' as const,
  mode:'paper' as const,strategyId:'rangekeeper_v1' as const,profileId,
  input:{capitalQuoteRaw:input.capitalQuoteRaw,fullWidthSpacings:input.fullWidthSpacings,limits:input.limits},
  source:null,profile:null,range:null,requirements:null,references:null,costs:{status:'unavailable' as const},
  admissionLimits:{status:'not_evaluated' as const,reason:'rangekeeper_admission_limits_not_yet_checked'},
  missing:[reason],actionAvailable:false,draftCreated:false,operationCreated:false,
  limitations:['read_only_no_draft_or_operation','hypothetical_inventory_requirements_only',
   'does_not_claim_wallet_balances_or_funding_availability','costs_are_provisional_fork_estimates',
   'not_an_executable_preview']};
}

/** Read-only sizing for the RangeKeeper setup form. Candidate discovery is
 * delegated to `planRangeKeeper` exactly as the static preflight now delegates
 * to `decideStaticManual`: this module only proposes a wallet allocation (the
 * same generic V3 mint math the static path uses) and reads off the kernel's
 * own candidate for everything that keys gas evidence or gets admitted. */
export async function buildRangeKeeperPaperSetupPreflight(input:RangeKeeperSetupPreflightInput,deps:{
 loadProfile:(id:string)=>Promise<PaperSetupProfile|null>;
 readFrame:(profile:MarketProfile,pinnedSource?:PaperOpenFrame['source'])=>Promise<PaperOpenFrame>;
 verifyCanonical:(chainId:number,source:PaperOpenFrame['source'])=>Promise<void>;
 readGasPrice:()=>Promise<bigint>;
 /** Samples this exact candidate on an owned fork at the pinned source. The
  * preflight costs that sample directly and persists nothing, mirroring how the
  * open path samples at open time rather than reusing a stored band.
  *
  * The policy limits and the funding the sample must start from are passed in
  * rather than left to the caller: both are derived here from the kernel's own
  * resolved policy and its candidate, and a caller re-deriving them could fund
  * a fixture that does not match the candidate being priced. */
 sampleOwnedFork:RangeKeeperSetupForkSampler;
 now?:()=>number;
},pinnedSource?:PaperOpenFrame['source']){
 const now=deps.now??Date.now;
 let registered:PaperSetupProfile|null;
 try{registered=await deps.loadProfile(input.profileId);}catch{return unavailable(input,'registered_market_profile_unavailable');}
 if(!registered||registered.id!==input.profileId)return unavailable(input,'registered_market_profile_unavailable');
 const profile=marketProfileSchema.safeParse(registered.profile),p=profile.success?profile.data.pool:null;
 if(!profile.success||contentHash(profile.data)!==registered.profileHash)
  return unavailable(input,'registered_market_profile_integrity');
 const quoteToken=p!.quoteToken===0?p!.token0:p!.token1,
  quoteDecimals=p!.quoteToken===0?p!.decimals0:p!.decimals1;
 if(quoteToken.toLowerCase()!==USDG.toLowerCase()||quoteDecimals!==6)
  return unavailable(input,'unsupported_usdg_quote_profile');
 let frame:PaperOpenFrame;
 try{frame=await deps.readFrame(profile.data,pinnedSource);}
 catch{return unavailable(input,'fresh_canonical_pool_frame_unavailable');}
 if(pinnedSource&&(frame.source.block!==pinnedSource.block||
  frame.source.hash.toLowerCase()!==pinnedSource.hash.toLowerCase()||
  frame.source.timestamp!==pinnedSource.timestamp))
  return unavailable(input,'reviewed_source_replay_mismatch');
 const observedAt=now(),age=observedAt-frame.source.timestamp*1000;
 if(age<0||age>180_000)return unavailable(input,'fresh_source_stale');
 if(!frame.referenceEligible||!frame.referenceProof||frame.price0===null||frame.price1===null||
  frame.nativePrice===null||frame.price0<=0n||frame.price1<=0n||frame.nativePrice<=0n||
  referenceProofHash(frame.referenceProof)!==frame.referenceProofHash)
  return unavailable(input,'independent_reference_unavailable');
 let proofIdentityHash:string;
 try{proofIdentityHash=pinnedExternalReferenceProofIdentityHash(frame.referenceProof);}
 catch{return unavailable(input,'independent_reference_proof_invalid');}
 const quotePriceX18=p!.quoteToken===0?frame.price0:frame.price1;
 if(quotePriceX18<=0n)return unavailable(input,'independent_usdg_reference_unavailable');
 const poolPrice1=((1n<<192n)*10n**BigInt(p!.decimals1)*frame.price0)/
  (frame.sqrtPriceX96*frame.sqrtPriceX96*10n**BigInt(p!.decimals0));
 const deviation=poolPrice1>frame.price1?poolPrice1-frame.price1:frame.price1-poolPrice1;
 if(deviation*1_000_000n>frame.price1*BigInt(profile.data.referencePolicy.maxPoolDeviationPpm))
  return unavailable(input,'pool_independent_reference_deviation');
 let range;
 try{range=rangeKeeperRange(frame.tick,p!.tickSpacing,input.fullWidthSpacings);}
 catch{return unavailable(input,'rangekeeper_range_unavailable_on_pool_grid');}
 // Validate the submitted limits the same way the open kernel will, by
 // reusing its own resolver against a synthetic draft carrying the exact
 // parameters and profile the real draft will carry. This is the same
 // reason we call the planner for the candidate: do not re-derive the
 // kernel's own acceptance rules for a limits object.
 const configHash=rangeKeeperPaperSetupConfigHash(input);
 const syntheticDraft:RangeKeeperPaperDraft={id:input.profileId,revision:1,profile:profile.data,
  profileHash:registered.profileHash,configHash,strategyId:'rangekeeper_v1',
  parameters:{fullWidthSpacings:input.fullWidthSpacings,limits:input.limits},
  allocation:{token0Raw:'0',token1Raw:'0',nativeWei:'0'}};
 const resolved=resolveRangeKeeperPaperPolicy(syntheticDraft,SETUP_BUILD_ID);
 if(!resolved.policy||resolved.unavailable.length)
  return unavailable(input,resolved.unavailable.join(',')||'rangekeeper_policy_unavailable');
 const limits=resolved.policy.limits;
 const budget=BigInt(input.capitalQuoteRaw),deploymentCap=limits.maxDeploymentValue,
  quoteValue=(amount0:bigint,amount1:bigint)=>
   ceilRefValueQuoteRaw(amount0,frame.price0!,p!.decimals0,quotePriceX18,quoteDecimals)+
   ceilRefValueQuoteRaw(amount1,frame.price1!,p!.decimals1,quotePriceX18,quoteDecimals);
 const requirements=(liquidity:bigint)=>{
  const amounts=positionAmounts(frame.sqrtPriceX96,range,liquidity,true);
  return {...amounts,valueQuoteRaw:quoteValue(amounts.amount0,amounts.amount1),
   valueUsdX18:ceilUsdX18(amounts.amount0,frame.price0!,p!.decimals0)+
    ceilUsdX18(amounts.amount1,frame.price1!,p!.decimals1)};
 };
 const affordable=(liquidity:bigint)=>{
  const candidate=requirements(liquidity);
  return candidate.valueQuoteRaw<=budget&&candidate.valueUsdX18<=deploymentCap;
 };
 let lower=0n,upper=UINT128_MAX-1n;
 while(lower<upper){
  const middle=lower+(upper-lower+1n)/2n;
  if(affordable(middle))lower=middle;else upper=middle-1n;
 }
 if(lower===0n)return unavailable(input,'capital_or_deployment_limit_below_one_liquidity_unit');
 const needed=requirements(lower);
 let minted;
 try{minted=replayPaperMint(frame.sqrtPriceX96,range,needed.amount0,needed.amount1,0n);}
 catch{return unavailable(input,'exact_mint_requirements_unavailable');}
 if(minted.liquidity<lower||needed.valueQuoteRaw>budget||needed.valueUsdX18>deploymentCap)
  return unavailable(input,'exact_mint_requirement_budget_mismatch');
 // Hand the exact sized allocation to the kernel as if it were already-funded
 // wallet inventory. It is sized in the position's own ratio, so the no-swap
 // branch should always be chosen; `quote` throws if that assumption is ever
 // violated, which the planner catches as a clean 'construction_unproven'
 // wait rather than an unhandled rejection.
 const strategyValue=rawValue(needed.amount0,frame.price0!,p!.decimals0)+
  rawValue(needed.amount1,frame.price1!,p!.decimals1);
 const state={schemaVersion:1 as const,policyId:'rangekeeper_v1' as const,strategyVersion:'1.0.0' as const,
  configHash:`0x${resolved.policy.policyHash}` as `0x${string}`,buildId:resolved.policy.buildId,
  lastEligible:null,exit:null,confirmation:null};
 const observation={block:BigInt(frame.source.block),hash:frame.source.hash as `0x${string}`,
  timestamp:frame.source.timestamp,tick:frame.tick,sqrtPriceX96:frame.sqrtPriceX96,
  continuity:'canonical' as const,wallet0:needed.amount0,wallet1:needed.amount1,released0:0n,released1:0n,
  nativeWei:limits.exitReserveWei,requiredExitReserveWei:limits.exitReserveWei,
  price0:frame.price0,price1:frame.price1,nativePrice:frame.nativePrice,position:null,pending:false,
  entryAllowed:true,safeExitRequired:false,executionReady:true,liquiditySharePpm:0,
  actionCost:limits.maxActionCost,actionGasWei:0n,reservedCost:0n,rollingSpentCost:0n,
  campaignSpentCost:0n,campaignStartValue:strategyValue,highWaterValue:strategyValue,recenters:0};
 let decision;
 try{decision=await planRangeKeeper({state,observation,limits,spacing:p!.tickSpacing,
  decimals0:p!.decimals0,decimals1:p!.decimals1,quoteToken:p!.quoteToken,
  maxPoolDeviationPpm:profile.data.referencePolicy.maxPoolDeviationPpm,
  quote:async()=>{throw new Error('rangekeeper_setup_preflight_swap_quote_unexpected');},
  simulate:async()=>true});}
 catch{return unavailable(input,'rangekeeper_kernel_candidate_construction_failed');}
 if(!decision.candidate)return unavailable(input,`rangekeeper_entry_unavailable:${decision.reason}`);
 const candidate=decision.candidate;
 if(candidate.kind!=='entry'||candidate.swap!==null)
  return unavailable(input,'rangekeeper_setup_unexpected_candidate_shape');
 const denominator=frame.poolLiquidity+candidate.liquidity;
 if(denominator<=0n)return unavailable(input,'rangekeeper_pool_liquidity_share_unavailable');
 const sharePpm=candidate.liquidity*PPM/denominator;
 if(sharePpm>BigInt(limits.maxLiquiditySharePpm))return unavailable(input,'rangekeeper_liquidity_share_limit');
 const candidateHash=rangeKeeperPaperSetupCandidateIdentity({profileHash:registered.profileHash,
  configHash,source:frame.source,referenceProofHash:frame.referenceProofHash,candidate});
 const pathVersion=rangeKeeperPaperPathVersion(candidate);
 const scope:RangeKeeperPaperCandidateScope={poolAddress:p!.pool,profileHash:registered.profileHash,
  candidateHash,deployedValue:candidate.deployedValue,sharePpm,range:candidate.range,swapKind:'none'};
 const rangeOut={tickLower:range.tickLower,tickUpper:range.tickUpper,centerTick:frame.tick,
  fullWidthSpacings:input.fullWidthSpacings};
 const requirementsOut={liquidity:String(candidate.liquidity),token0Raw:candidate.amount0Desired.toString(),
  token1Raw:candidate.amount1Desired.toString(),referenceValueQuoteRaw:String(quoteValue(candidate.amount0Desired,
   candidate.amount1Desired)),budgetResidualQuoteRaw:String(budget-quoteValue(candidate.amount0Desired,
   candidate.amount1Desired)),deployedValueUsdX18:String(candidate.deployedValue),sharePpm:String(sharePpm),
  sizingConvention:'maximize_v3_liquidity_under_independent_reference_quote_budget_then_kernel_sized' as const};
 const referencesOut={price0:String(frame.price0),price1:String(frame.price1),
  nativePrice:String(frame.nativePrice),proofHash:frame.referenceProofHash,proofIdentityHash};
 const profileOut={pool:p!.pool,fee:p!.fee,tickSpacing:p!.tickSpacing,token0:p!.token0,token1:p!.token1,
  quoteToken:p!.quoteToken};
 // The gas price is read before sampling because the evidence producer binds it
 // into the report it signs, so it cannot be fetched afterwards.
 let gasPriceWei:bigint;
 try{gasPriceWei=await deps.readGasPrice();}catch{return unavailable(input,'registered_cost_evidence_unavailable');}
 // Sample this exact candidate now rather than looking up a stored band. A
 // RangeKeeper calibration row is a feasibility proof of one candidate at one
 // block as well as a gas measurement, so no stored row can exist for a
 // candidate that has not been sampled -- see the plan's section 2d. Nothing is
 // persisted: the rows are costed in this request and discarded.
 let selected:ReturnType<typeof selectRangeKeeperPaperCostProfiles>;
 try{
  const report=await produceRangeKeeperPaperGasEvidence({kind:'open',campaignId:SETUP_CAMPAIGN_ID,
   revision:SETUP_REVISION,configHash,buildId:resolved.policy.buildId,profile:profile.data,frame,
   candidateSource:frame.source,candidateReferenceProofHash:frame.referenceProofHash,candidate,
   openMarkId:null,openModelHash:null,marketGasPriceWei:gasPriceWei,scope,
   sampleOwnedFork:request=>deps.sampleOwnedFork(request,
    {limits,initialBalances:[candidate.amount0Desired,candidate.amount1Desired]}),now:now()});
  const rows=rangeKeeperPaperSpeculativeGasRows(verifyRangeKeeperPaperGasReport(report,now()));
  selected=selectRangeKeeperPaperCostProfiles({candidate,scope,source:frame.source,rows,now:now()});
 }catch{selected={status:'unavailable',reason:'rangekeeper_setup_gas_sample_unavailable',missingStages:[]};}
 if(selected.status!=='available')
  return {schemaVersion:1 as const,kind:'rangekeeper_paper_setup_preflight' as const,status:'unavailable' as const,
   mode:'paper' as const,strategyId:'rangekeeper_v1' as const,profileId:registered.id,profileHash:registered.profileHash,
   input:{capitalQuoteRaw:input.capitalQuoteRaw,fullWidthSpacings:input.fullWidthSpacings,limits:input.limits},
   source:frame.source,profile:profileOut,range:rangeOut,requirements:requirementsOut,references:referencesOut,
   costs:{status:'unavailable' as const,reason:costUnavailableReason(selected)},
   admissionLimits:{status:'not_evaluated' as const,reason:'rangekeeper_admission_limits_not_yet_checked'},
   missing:[costUnavailableReason(selected)],actionAvailable:false,draftCreated:false,
   operationCreated:false,
   limitations:['read_only_no_draft_or_operation','hypothetical_inventory_requirements_only',
    'does_not_claim_wallet_balances_or_funding_availability','costs_are_provisional_fork_estimates',
    'not_an_executable_preview']};
 let costs:RangeKeeperPaperModeledCosts;
 try{costs=modelRangeKeeperPaperCosts({profiles:selected,limits,nativePrice:frame.nativePrice,
  marketGasPriceWei:gasPriceWei,swapFeeAndShortfallValue:0n,now:now()});}
 catch{return unavailable(input,'rangekeeper_cost_model_unavailable');}
 try{await deps.verifyCanonical(p!.chainId,frame.source);}
 catch{return unavailable(input,'fresh_source_not_canonical');}
 const checkedAt=now();
 if(checkedAt-frame.source.timestamp*1000<0||checkedAt-frame.source.timestamp*1000>180_000)
  return unavailable(input,'fresh_source_stale');
 return {schemaVersion:1 as const,kind:'rangekeeper_paper_setup_preflight' as const,status:'available' as const,
  mode:'paper' as const,strategyId:'rangekeeper_v1' as const,profileId:registered.id,
  profileHash:registered.profileHash,
  input:{capitalQuoteRaw:input.capitalQuoteRaw,fullWidthSpacings:input.fullWidthSpacings,limits:input.limits},
  source:frame.source,profile:profileOut,range:rangeOut,requirements:requirementsOut,references:referencesOut,costs,
  admissionLimits:{status:'not_evaluated' as const,reason:'rangekeeper_admission_limits_not_yet_checked'},
  missing:[],actionAvailable:false,draftCreated:false,operationCreated:false,
  limitations:['read_only_no_draft_or_operation','hypothetical_inventory_requirements_only',
   'does_not_claim_wallet_balances_or_funding_availability','costs_are_provisional_fork_estimates',
   'not_an_executable_preview']};
}
