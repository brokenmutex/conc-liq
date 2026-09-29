import {z} from 'zod';
import {sqrtRatioAtTick} from '../backtest/principal.js';
import {USDG} from '../constants.js';
import type {RobinhoodClient} from '../client.js';
import {decideStaticManual} from '../strategy/static-manual/planner.js';
import {positionAmounts,replayPaperMint} from '../v3/position-math.js';
import {contentHash,staticPaperLimitsSchema} from './contracts.js';
import {resolveCenteredManualRange} from './centered-manual-range.js';
import {costIndicativePaperOpenPreview,PAPER_STATIC_GAS_PATH,
 type PaperGasProfileRow} from './paper-cost.js';
import {marketProfileSchema,referenceProofHash,type MarketProfile} from './market-profile.js';
import {pinnedExternalReferenceProofIdentityHash} from './pinned-external-reference-proof.js';
import type {PaperOpenFrame} from './paper-preview.js';

const MAX_CAPITAL_QUOTE=100_000n*10n**6n;
const UINT128_MAX=(1n<<128n)-1n;
const raw=z.string().regex(/^(0|[1-9][0-9]*)$/).max(12)
 .refine(value=>/^(0|[1-9][0-9]*)$/.test(value)&&BigInt(value)>0n&&BigInt(value)<=MAX_CAPITAL_QUOTE);
export const paperSetupPreflightInput=z.object({profileId:z.uuid(),capitalQuoteRaw:raw,
 halfWidthTicks:z.number().int().min(1).max(887272),limits:staticPaperLimitsSchema.optional()}).strict();
export type PaperSetupPreflightInput=z.infer<typeof paperSetupPreflightInput>;
export interface PaperSetupProfile {id:string;profile:MarketProfile;profileHash:string}

const ceilDiv=(n:bigint,d:bigint)=>n===0n?0n:(n+d-1n)/d;
const ceilRefValueQuoteRaw=(amount:bigint,priceX18:bigint,decimals:number,
 quotePriceX18:bigint,quoteDecimals:number)=>
 ceilDiv(amount*priceX18*10n**BigInt(quoteDecimals),
  10n**BigInt(decimals)*quotePriceX18);

function tickPriceQuoteX18(tick:number,profile:MarketProfile){
 const p=profile.pool,sqrt=sqrtRatioAtTick(tick),q192=1n<<192n;
 if(p.quoteToken===1)
  return sqrt*sqrt*10n**BigInt(p.decimals0)*10n**18n/
   (q192*10n**BigInt(p.decimals1));
 return q192*10n**BigInt(p.decimals1)*10n**18n/
  (sqrt*sqrt*10n**BigInt(p.decimals0));
}

function unavailable(input:PaperSetupPreflightInput,reason:string,profileId=input.profileId){
 return {schemaVersion:1 as const,kind:'paper_setup_preflight' as const,status:'unavailable' as const,
  mode:'paper' as const,strategyId:'static_manual_v1' as const,profileId,
  input:{capitalQuoteRaw:input.capitalQuoteRaw,halfWidthTicks:input.halfWidthTicks,
   ...(input.limits?{limits:input.limits}:{})},
  source:null,profile:null,range:null,requirements:null,references:null,costs:{status:'unavailable' as const},
  admissionLimits:{status:'not_evaluated' as const,reason:'static_manual_limits_not_submitted'},
  missing:[reason],actionAvailable:false,draftCreated:false,operationCreated:false,
  limitations:['read_only_no_draft_or_operation','hypothetical_inventory_requirements_only',
   'does_not_claim_wallet_balances_or_funding_availability','costs_are_provisional_fork_estimates',
   'not_an_executable_preview']};
}

/** Read-only sizing for the setup form. The capital budget is enforced against
 * fresh independent USD references with per-token upward rounding. The pool
 * sqrt price determines only the V3 inventory proportions and mint amounts. */
export async function buildStaticPaperSetupPreflight(input:PaperSetupPreflightInput,deps:{
 loadProfile:(id:string)=>Promise<PaperSetupProfile|null>;
 readFrame:(profile:MarketProfile,pinnedSource?:PaperOpenFrame['source'])=>Promise<PaperOpenFrame>;
 verifyCanonical:(chainId:number,source:PaperOpenFrame['source'])=>Promise<void>;
 readGasProfiles:(poolAddress:string)=>Promise<PaperGasProfileRow[]>;
 readGasPrice:()=>Promise<bigint>;
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
 try{range=resolveCenteredManualRange(frame.tick,input.halfWidthTicks,p!.tickSpacing);}
 catch{return unavailable(input,'centered_range_unavailable_on_pool_grid');}
 const budget=BigInt(input.capitalQuoteRaw),quoteValue=(amount0:bigint,amount1:bigint)=>
  ceilRefValueQuoteRaw(amount0,frame.price0!,p!.decimals0,quotePriceX18,quoteDecimals)+
  ceilRefValueQuoteRaw(amount1,frame.price1!,p!.decimals1,quotePriceX18,quoteDecimals);
 // The quote budget and the operator's maxDeploymentValue are different
 // numeraires, and USDG is not exactly one dollar. Size under both, rounding
 // each up, so the funded allocation is admissible on its USD value and the
 // open planner has no reason to rescale it. Sizing under the quote budget
 // alone hands the planner an allocation worth more USD than its own cap; it
 // then mints less than this preflight sized, and the gas evidence sampled
 // for that candidate no longer matches what this preflight looks up.
 const deploymentCap=input.limits?BigInt(input.limits.maxDeploymentValue):null;
 const requirements=(liquidity:bigint)=>{
  const amounts=positionAmounts(frame.sqrtPriceX96,range,liquidity,true);
  return {...amounts,valueQuoteRaw:quoteValue(amounts.amount0,amounts.amount1),
   valueUsdX18:ceilDiv(amounts.amount0*frame.price0!,10n**BigInt(p!.decimals0))+
    ceilDiv(amounts.amount1*frame.price1!,10n**BigInt(p!.decimals1))};
 };
 const affordable=(liquidity:bigint)=>{
  const candidate=requirements(liquidity);
  return candidate.valueQuoteRaw<=budget&&
   (deploymentCap===null||candidate.valueUsdX18<=deploymentCap);
 };
 let lower=0n,upper=UINT128_MAX-1n;
 while(lower<upper){
  const middle=lower+(upper-lower+1n)/2n;
  if(affordable(middle))lower=middle;
  else upper=middle-1n;
 }
 if(lower===0n)return unavailable(input,
  deploymentCap===null?'capital_below_one_liquidity_unit':'capital_or_deployment_limit_below_one_liquidity_unit');
 const needed=requirements(lower);
 let minted;
 try{minted=replayPaperMint(frame.sqrtPriceX96,range,needed.amount0,needed.amount1,0n);}
 catch{return unavailable(input,'exact_mint_requirements_unavailable');}
 if(minted.liquidity<lower||needed.valueQuoteRaw>budget||
  (deploymentCap!==null&&needed.valueUsdX18>deploymentCap))
  return unavailable(input,'exact_mint_requirement_budget_mismatch');
 // Cost calibration is scoped by the production static planner's exact minted
 // inventory and floor-valued reference total. Keep the setup budget above
 // independently rounded up in quote units; only this gas-profile identity
 // must match the actual paper open candidate. Resolve it through the planner
 // itself: it rescales the funded allocation whenever the floor-valued USD
 // total exceeds maxDeploymentValue, which a quote-budget sizing above can
 // exceed whenever the USDG reference is not exactly one dollar. Recomputing
 // the candidate here instead would key gas evidence to inventory the open
 // path never mints, and no sampled band could ever match.
 let deployedUsdX18:bigint,sharePpm:bigint;
 if(input.limits){
  let decision;
  try{decision=decideStaticManual({continuity:'canonical',tick:frame.tick,
   sqrtPriceX96:frame.sqrtPriceX96,amount0:needed.amount0,amount1:needed.amount1,
   price0:frame.price0,price1:frame.price1,decimals0:p!.decimals0,decimals1:p!.decimals1,
   quoteToken:p!.quoteToken,position:null,pending:false,entryAllowed:true,safetyExitRequired:false,
   expiryReached:input.limits.expiryAt?Date.parse(input.limits.expiryAt)<=now():false},
   {tickLower:range.tickLower,tickUpper:range.tickUpper},
   {maxDeploymentValue:BigInt(input.limits.maxDeploymentValue),
    minDeploymentValue:BigInt(input.limits.minDeploymentValue),
    maxExposurePpm:input.limits.maxExposurePpm});}
  catch{return unavailable(input,'static_manual_planner_candidate_invalid');}
  if(decision.action!=='entry')return unavailable(input,`static_manual_entry_unavailable:${decision.reason}`);
  deployedUsdX18=decision.candidate.deployedValue;
  sharePpm=decision.candidate.liquidity*1_000_000n/(frame.poolLiquidity+decision.candidate.liquidity);
 }else{
  deployedUsdX18=minted.amount0*frame.price0/10n**BigInt(p!.decimals0)+
   minted.amount1*frame.price1/10n**BigInt(p!.decimals1);
  sharePpm=minted.liquidity*1_000_000n/(frame.poolLiquidity+minted.liquidity);
 }
 let gasRows:PaperGasProfileRow[],gasPriceWei:bigint;
 try{[gasRows,gasPriceWei]=await Promise.all([
  deps.readGasProfiles(p!.pool),deps.readGasPrice()]);}
 catch{return unavailable(input,'registered_cost_evidence_unavailable');}
 const costCandidate={range:{tickLower:range.tickLower,tickUpper:range.tickUpper},
  deployedValue:String(deployedUsdX18),dilutedSharePpm:String(sharePpm)};
 const costed=costIndicativePaperOpenPreview({status:'indicative',candidate:costCandidate},
  gasRows,p!.pool,frame.nativePrice,gasPriceWei,now());
 try{await deps.verifyCanonical(p!.chainId,frame.source);}
 catch{return unavailable(input,'fresh_source_not_canonical');}
 const checkedAt=now();
 if(checkedAt-frame.source.timestamp*1000<0||checkedAt-frame.source.timestamp*1000>180_000)
  return unavailable(input,'fresh_source_stale');
 const costs=costed.costs;
 if(costs.status!=='provisional')return {...unavailable(input,costs.reason),
  source:frame.source,profileHash:registered.profileHash,
  profile:{pool:p!.pool,fee:p!.fee,tickSpacing:p!.tickSpacing,
   token0:p!.token0,token1:p!.token1,quoteToken:p!.quoteToken},
  range:{centerTick:frame.tick,centerAnchorTick:range.centerAnchorTick,
   halfWidthTicks:range.halfWidthTicks,tickLower:range.tickLower,tickUpper:range.tickUpper,
   fullWidthTicks:range.fullWidthTicks,
   lowerPriceQuotePerBaseX18:String(p!.quoteToken===1?
    tickPriceQuoteX18(range.tickLower,profile.data):tickPriceQuoteX18(range.tickUpper,profile.data)),
   upperPriceQuotePerBaseX18:String(p!.quoteToken===1?
    tickPriceQuoteX18(range.tickUpper,profile.data):tickPriceQuoteX18(range.tickLower,profile.data))},
  requirements:{liquidity:String(minted.liquidity),token0Raw:String(needed.amount0),
   token1Raw:String(needed.amount1),referenceValueQuoteRaw:String(needed.valueQuoteRaw),
   budgetResidualQuoteRaw:String(budget-needed.valueQuoteRaw),
   sizingConvention:'maximize_v3_liquidity_under_independent_reference_quote_budget'},
  references:{price0:String(frame.price0),price1:String(frame.price1),nativePrice:String(frame.nativePrice),
   proofHash:frame.referenceProofHash,proofIdentityHash},costs};
 return {schemaVersion:1 as const,kind:'paper_setup_preflight' as const,status:'available' as const,
  mode:'paper' as const,strategyId:'static_manual_v1' as const,profileId:registered.id,
  profileHash:registered.profileHash,
  input:{capitalQuoteRaw:input.capitalQuoteRaw,halfWidthTicks:input.halfWidthTicks,
   ...(input.limits?{limits:input.limits}:{})},source:frame.source,
  profile:{pool:p!.pool,fee:p!.fee,tickSpacing:p!.tickSpacing,token0:p!.token0,token1:p!.token1,
   quoteToken:p!.quoteToken},
  range:{centerTick:frame.tick,centerAnchorTick:range.centerAnchorTick,
   halfWidthTicks:range.halfWidthTicks,tickLower:range.tickLower,tickUpper:range.tickUpper,
   fullWidthTicks:range.fullWidthTicks,
   lowerPriceQuotePerBaseX18:String(p!.quoteToken===1?
    tickPriceQuoteX18(range.tickLower,profile.data):tickPriceQuoteX18(range.tickUpper,profile.data)),
   upperPriceQuotePerBaseX18:String(p!.quoteToken===1?
    tickPriceQuoteX18(range.tickUpper,profile.data):tickPriceQuoteX18(range.tickLower,profile.data))},
  requirements:{liquidity:String(minted.liquidity),token0Raw:String(needed.amount0),
   token1Raw:String(needed.amount1),referenceValueQuoteRaw:String(needed.valueQuoteRaw),
   budgetResidualQuoteRaw:String(budget-needed.valueQuoteRaw),
   sizingConvention:'maximize_v3_liquidity_under_independent_reference_quote_budget'},
  references:{price0:String(frame.price0),price1:String(frame.price1),nativePrice:String(frame.nativePrice),
   proofHash:frame.referenceProofHash,proofIdentityHash},costs,
  admissionLimits:{status:'not_evaluated' as const,reason:'static_manual_limits_not_submitted'},
  missing:[],actionAvailable:false,draftCreated:false,operationCreated:false,
  limitations:['read_only_no_draft_or_operation','hypothetical_inventory_requirements_only',
   'does_not_claim_wallet_balances_or_funding_availability','costs_are_provisional_fork_estimates',
   'not_an_executable_preview']};
}
