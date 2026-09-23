import {z} from 'zod';
import {MAX_TICK,MIN_TICK} from '../backtest/principal.js';
import {ROBINHOOD_CHAIN_ID,USDG} from '../constants.js';
import {principalAmounts} from '../backtest/principal.js';
import {sizeLiquidityForQuoteBudget,tickSpacingForFee,validateTickAndSqrtPrice} from '../simulator/math.js';
import {contentHash} from '../deployments/contracts.js';
import {referenceProofHash} from '../deployments/market-profile.js';

/** A bounded Research scenario is read-only preparation evidence. This module
 * only checks caller-supplied evidence shape and arithmetic; it cannot prove
 * RPC canonicality or database registration. Its result remains
 * `unverified_scenario` until a trusted internal reader supplies the evidence.
 * It cannot create or pin a draft, operation, preview, or execution intent. */
export const RESEARCH_CANDIDATE_WINDOWS_SECONDS=[900,3600,21600,86400,604800] as const;
export const RESEARCH_CANDIDATE_STRATEGIES=['static_manual_v1','rangekeeper_v1'] as const;
export const RESEARCH_STATIC_NO_SWAP_COST_PATH='paper_static_manual_no_swap_v1';
export const RESEARCH_STATIC_NO_SWAP_COST_STAGES=[
 'approve_token0','approve_token1','mint','withdraw_collect','cleanup_token0','cleanup_token1',
] as const;

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const contentHashSchema=z.string().regex(/^[0-9a-f]{64}$/);
const address=z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const anchor=z.object({block:raw,hash,timestamp:z.number().int().nonnegative()}).strict();
const sourceClaim=z.object({kind:z.literal('caller_claimed_rpc_anchor_bracket_v1'),
 block:raw,expectedHash:hash,observedHash:hash,timestamp:z.number().int().nonnegative(),
 checkedBefore:z.boolean(),checkedAfter:z.boolean()}).strict();
const references=z.object({source:anchor,price0:raw,price1:raw,nativePrice:raw,
 proofHash:contentHashSchema,proof:z.record(z.string(),z.unknown())}).strict();
const frame=z.object({source:anchor,sourceClaim,profileHash:contentHashSchema,
 poolState:z.object({tick:z.number().int().min(MIN_TICK).max(MAX_TICK),
  sqrtPriceX96:raw,poolLiquidity:raw}).strict(),references}).strict();
const profile=z.object({chainId:z.literal(ROBINHOOD_CHAIN_ID),profileHash:contentHashSchema,
 id:z.uuid(),claimedVerificationClass:z.literal('canonical_chain_and_independent_reference_v1'),
 poolAddress:address,token0:address,token1:address,decimals0:z.number().int().min(0).max(36),
 decimals1:z.number().int().min(0).max(36),quoteToken:z.union([z.literal(0),z.literal(1)]),
 fee:z.number().int().min(1).max(999_999),tickSpacing:z.number().int().positive(),
 reference0:z.string().min(1).max(64),reference1:z.string().min(1).max(64),
 nativeReference:z.literal('ETH/USD'),
 streamKey:z.string().min(1).max(128),targetSetHash:z.string().min(1).max(256),
 maxPoolDeviationPpm:z.number().int().min(1).max(1_000_000)}).strict();
const feeToken=z.object({lowerRawQ128:raw,upperRawQ128:raw,lowerAmountRaw:raw,upperAmountRaw:raw}).strict();
const feeInterval=z.object({kind:z.literal('paper_observed_flow_fee_interval_v1'),
 pool:address,token0Address:address,token1Address:address,fee:z.number().int(),tickSpacing:z.number().int(),
 from:z.object({block:raw,hash}).strict(),to:z.object({block:raw,hash}).strict(),
 range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),liquidity:raw,
 token0:feeToken,token1:feeToken,events:z.number().int().nonnegative(),segments:z.number().int().nonnegative(),
 partialSegments:z.number().int().nonnegative(),accounting:z.literal('modeled_hypothetical_fee_share'),
 coverage:z.object({stream:z.string().min(1),targetSetHash:z.string().min(1),
  completeThroughBlock:raw,completeThroughHash:hash,chainAnchorRecheckRequired:z.literal(false)}).strict()}).strict();
const gasSource=z.object({block:raw,hash,estimatedAt:z.iso.datetime({offset:true}),callHash:hash,
 method:z.literal('owned_fork_nitro_exact_call_v1')}).strict();
const gasModel=z.object({schemaVersion:z.literal(1),source:gasSource,gasUnitsExpected:raw,gasUnitsBound:raw,
 sizeMinValue:raw,sizeMaxValue:raw,shareMinPpm:raw,shareMaxPpm:raw,
 tickLower:z.number().int(),tickUpper:z.number().int()}).strict();
const gasRow=z.object({id:z.uuid(),version:z.number().int().positive(),poolAddress:address,
 pathVersion:z.string(),stage:z.string(),allowanceState:z.string(),sizeBand:z.string().min(1).max(256),
 component:z.string(),status:z.string(),evidenceClass:z.string(),model:z.unknown(),sourceHash:contentHashSchema,
 observedUntil:z.union([z.date(),z.iso.datetime({offset:true})])}).strict();
const gasPricing=z.object({source:anchor,expectedWei:raw,boundWei:raw,
 method:z.literal('canonical_gas_price_scenario_v1')}).strict();
const request=z.object({schemaVersion:z.literal(1),strategyId:z.enum(RESEARCH_CANDIDATE_STRATEGIES),
 windowSeconds:z.number().int().refine(value=>(RESEARCH_CANDIDATE_WINDOWS_SECONDS as readonly number[]).includes(value)),
 capitalQuoteRaw:raw,range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict()}).strict();
const inputSchema=z.object({request,profile,from:frame,through:frame,feeInterval,
 gasProfiles:z.array(gasRow).max(200),gasPricing:z.object({open:gasPricing,close:gasPricing}).strict()}).strict();

export type ResearchCandidateReplayRequest=z.infer<typeof request>;
export type ResearchCandidateReplayInput=z.input<typeof inputSchema>;
export type ResearchCandidateReplayResult={
 schemaVersion:1;status:'unverified_scenario'|'unavailable';strategyId:'static_manual_v1'|'rangekeeper_v1';
 actionAvailable:false;draftCreationAvailable:false;request:ResearchCandidateReplayRequest;
 candidate:Record<string,string|number|boolean>|null;
 economics:Record<string,unknown>|null;missing:readonly string[];limitations:readonly string[];
 evidenceHash:string|null;
};

type ParsedInput=z.infer<typeof inputSchema>;
type SelectedGasStage={stage:typeof RESEARCH_STATIC_NO_SWAP_COST_STAGES[number];id:string;version:number;
 sizeBand:string;expected:string;bound:string;source:z.infer<typeof gasSource>};
const Q192=1n<<192n,USD_SCALE=1_000_000n,PRICE_SCALE=10n**18n;
const MAX_CAPITAL_QUOTE=100_000n*USD_SCALE,MAX_GAS_PROFILES=200,MAX_PROFILE_AGE_MS=86_400_000;
const ceilDiv=(a:bigint,b:bigint)=>(a+b-1n)/b;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();

const digest=contentHash;

function unavailable(strategyId:'static_manual_v1'|'rangekeeper_v1',reason:string,
 requestValue?:ResearchCandidateReplayRequest):ResearchCandidateReplayResult{
 return {schemaVersion:1,status:'unavailable',strategyId,actionAvailable:false,draftCreationAvailable:false,
  request:requestValue??{schemaVersion:1,strategyId,windowSeconds:900,capitalQuoteRaw:'0',range:{tickLower:0,tickUpper:1}},
  candidate:null,economics:null,missing:[reason],limitations:[
   'read_only_research_scenario_no_saved_draft','paper_model_is_not_a_fill_or_paid_cost_record',
   'independent_references_and_source_anchors_are_required',
  ],evidenceHash:null};
}

function matchesAnchor(source:z.infer<typeof anchor>,proof:z.infer<typeof sourceClaim>):boolean{
 return source.block===proof.block&&source.timestamp===proof.timestamp&&
  same(source.hash,proof.expectedHash)&&same(source.hash,proof.observedHash)&&
  proof.checkedBefore&&proof.checkedAfter;
}

function validateFrame(value:z.infer<typeof frame>,p:z.infer<typeof profile>):string|null{
 if(value.profileHash!==p.profileHash)return 'market_profile_binding_mismatch';
 if(!matchesAnchor(value.source,value.sourceClaim))return 'source_anchor_claim_mismatch';
 if(value.references.source.block!==value.source.block||!same(value.references.source.hash,value.source.hash)||
  value.references.source.timestamp!==value.source.timestamp)return 'reference_source_anchor_mismatch';
 if(referenceProofHash(value.references.proof)!==value.references.proofHash)return 'reference_proof_hash_mismatch';
 const price0=BigInt(value.references.price0),price1=BigInt(value.references.price1),native=BigInt(value.references.nativePrice);
 if(price0<=0n||price1<=0n||native<=0n)return 'independent_reference_unavailable';
 const proof=value.references.proof as {token0?:{oracle?:unknown};token1?:{oracle?:unknown};native?:unknown};
 const oraclePrice=(input:unknown,identity:string):bigint|null=>{
  if(!input||typeof input!=='object')return null;
  const wrapper=input as {oracle?:unknown;basis?:unknown};
  const row=(wrapper.oracle&&typeof wrapper.oracle==='object'?wrapper.oracle:input) as
   {executionEligible?:unknown;feed?:{baseAsset?:unknown;quoteAsset?:unknown};
   state?:{answer?:unknown;decimals?:unknown}};
  const referenceEligible=row.executionEligible===true||wrapper.basis==='held_equity_reference';
  if(!referenceEligible||row.feed?.quoteAsset!=='USD'||
   typeof row.feed.baseAsset!=='string'||row.feed.baseAsset.toUpperCase()!==identity.split('/')[0]?.toUpperCase()||
   typeof row.state?.answer!=='string'||!/^\d+$/.test(row.state.answer)||
   typeof row.state.decimals!=='number'||!Number.isSafeInteger(row.state.decimals)||
   row.state.decimals<0||row.state.decimals>36)return null;
  const answer=BigInt(row.state.answer);
  return answer>0n?answer*PRICE_SCALE/10n**BigInt(row.state.decimals):null;
 };
 const ref0=proof.token0;
 const ref1=proof.token1;
 const nativeRef=proof.native;
 if(oraclePrice(ref0,p.reference0)!==price0||oraclePrice(ref1,p.reference1)!==price1||
  oraclePrice(nativeRef,p.nativeReference)!==native)return 'independent_reference_value_mismatch';
 try{validateTickAndSqrtPrice({tick:value.poolState.tick,sqrtPriceX96:BigInt(value.poolState.sqrtPriceX96)});}
 catch{return 'pool_frame_invalid';}
 if(BigInt(value.poolState.poolLiquidity)<0n)return 'pool_frame_invalid';
 const impliedPrice1=Q192*10n**BigInt(p.decimals1)*price0/
  (BigInt(value.poolState.sqrtPriceX96)**2n*10n**BigInt(p.decimals0));
 const deviation=impliedPrice1>price1?impliedPrice1-price1:price1-impliedPrice1;
 if(deviation*1_000_000n>price1*BigInt(p.maxPoolDeviationPpm))return 'pool_outside_independent_reference_band';
 return null;
}

function chooseGasStages(input:ParsedInput,sizeUsdX18:bigint,sharePpm:bigint,now:number):
 {stages:SelectedGasStage[];reason:string|null}{
 if(input.gasProfiles.length>MAX_GAS_PROFILES)return {stages:[],reason:'cost_profile_query_bound'};
 const grouped=new Map<string,Map<string,z.infer<typeof gasRow>>>();
 for(const rawRow of input.gasProfiles){
  const parsed=gasRow.safeParse(rawRow);if(!parsed.success)continue;
  const row=parsed.data;
  if(!same(row.poolAddress,input.profile.poolAddress)||row.pathVersion!==RESEARCH_STATIC_NO_SWAP_COST_PATH||
   row.allowanceState!=='zero'||row.component!=='gas_units'||
   !(RESEARCH_STATIC_NO_SWAP_COST_STAGES as readonly string[]).includes(row.stage))continue;
  const group=grouped.get(row.sizeBand)??new Map<string,z.infer<typeof gasRow>>(),prior=group.get(row.stage);
  if(!prior||row.version>prior.version)group.set(row.stage,row);
  grouped.set(row.sizeBand,group);
 }
 const valid=(row:z.infer<typeof gasRow>):SelectedGasStage|null=>{
  if(!['provisional','validated'].includes(row.status)||row.evidenceClass!=='fork_estimated')return null;
  const modelResult=gasModel.safeParse(row.model);if(!modelResult.success)return null;
  const model=modelResult.data;
  if(digest(model.source)!==row.sourceHash)return null;
  const min=BigInt(model.sizeMinValue),max=BigInt(model.sizeMaxValue),smin=BigInt(model.shareMinPpm),smax=BigInt(model.shareMaxPpm);
  if(min>max||sizeUsdX18<min||sizeUsdX18>max||smin>smax||smax>1_000_000n||
   sharePpm<smin||sharePpm>smax||model.tickLower!==input.request.range.tickLower||
   model.tickUpper!==input.request.range.tickUpper||BigInt(model.gasUnitsExpected)<=0n||
   BigInt(model.gasUnitsBound)<BigInt(model.gasUnitsExpected))return null;
  const sampledAt=Date.parse(model.source.estimatedAt),observedUntil=row.observedUntil instanceof Date?
   row.observedUntil.getTime():Date.parse(row.observedUntil);
  if(!Number.isFinite(sampledAt)||!Number.isFinite(observedUntil)||Math.abs(observedUntil-sampledAt)>1000||
   now<sampledAt||now-sampledAt>MAX_PROFILE_AGE_MS)return null;
  const stage=row.stage as typeof RESEARCH_STATIC_NO_SWAP_COST_STAGES[number];
  return {stage,id:row.id,version:row.version,sizeBand:row.sizeBand,expected:model.gasUnitsExpected,
   bound:model.gasUnitsBound,source:model.source};
 };
 const complete:[string,Map<string,z.infer<typeof gasRow>>][]=[];
 for(const entry of grouped){
  if(RESEARCH_STATIC_NO_SWAP_COST_STAGES.every(stage=>entry[1].has(stage))&&
   RESEARCH_STATIC_NO_SWAP_COST_STAGES.every(stage=>valid(entry[1].get(stage)!)!==null))complete.push(entry);
 }
 if(complete.length!==1)return {stages:[],reason:complete.length?'ambiguous_cost_size_band':'candidate_scoped_cost_evidence_unavailable'};
 const [sizeBand,group]=complete[0]!,stages=RESEARCH_STATIC_NO_SWAP_COST_STAGES.map(stage=>valid(group.get(stage)!)!);
 const first=stages[0]!.source;
 if(stages.some(s=>s.source.block!==first.block||!same(s.source.hash,first.hash)||
  s.source.estimatedAt!==first.estimatedAt))return {stages:[],reason:'cost_profile_source_sequence_mismatch'};
 if(stages.some(s=>s.sizeBand!==sizeBand))return {stages:[],reason:'cost_profile_size_scope_mismatch'};
 return {stages,reason:null};
}

const valueUsd6=(amount:bigint,priceX18:bigint,decimals:number)=>
 amount*priceX18*USD_SCALE/(10n**BigInt(decimals)*PRICE_SCALE);
const valueUsdX18=(amount:bigint,priceX18:bigint,decimals:number)=>
 amount*priceX18/10n**BigInt(decimals);
const gasUsd6=(units:bigint,gasPriceWei:bigint,nativePriceX18:bigint)=>
 ceilDiv(units*gasPriceWei*nativePriceX18,10n**30n);

/** Build a reproducible, read-only candidate scenario from canonical source
 * frames, independently proved endpoint prices, a canonically replayed fee
 * interval, and registered exact-scope gas rows. RangeKeeper recenter paths
 * stay unavailable until their timer, quote, withdrawal and remint history can
 * be replayed as the actual frozen policy. */
export function buildResearchCandidateReplay(raw:unknown,now=Date.now()):ResearchCandidateReplayResult{
 const parsed=inputSchema.safeParse(raw);
 const rawStrategy=(raw as {request?:{strategyId?:unknown}}|null)?.request?.strategyId;
 const strategyId=RESEARCH_CANDIDATE_STRATEGIES.includes(rawStrategy as typeof RESEARCH_CANDIDATE_STRATEGIES[number])?
  rawStrategy as typeof RESEARCH_CANDIDATE_STRATEGIES[number]:'static_manual_v1';
 if(!parsed.success)return unavailable(strategyId,'candidate_replay_input_invalid');
 const input=parsed.data,req=input.request,p=input.profile;
 if(req.strategyId==='rangekeeper_v1')return unavailable(req.strategyId,'rangekeeper_recenter_replay_unavailable',req);
 if(p.chainId!==ROBINHOOD_CHAIN_ID||p.profileHash!==input.from.profileHash||
  p.profileHash!==input.through.profileHash||same(p.token0,p.token1)||
  p.token0.toLowerCase()>=p.token1.toLowerCase())return unavailable(req.strategyId,'market_profile_binding_mismatch',req);
 if(p.tickSpacing!==tickSpacingForFee(p.fee))return unavailable(req.strategyId,'market_profile_fee_spacing_mismatch',req);
 const quoteAddress=p.quoteToken===0?p.token0:p.token1;
 if(!same(quoteAddress,USDG)|| (p.quoteToken===0?p.decimals0:p.decimals1)!==6)
  return unavailable(req.strategyId,'unsupported_research_quote_unit',req);
 if(BigInt(req.capitalQuoteRaw)<=0n||BigInt(req.capitalQuoteRaw)>MAX_CAPITAL_QUOTE)
  return unavailable(req.strategyId,'candidate_capital_out_of_bounds',req);
 if(req.range.tickLower<MIN_TICK||req.range.tickUpper>MAX_TICK||req.range.tickLower>=req.range.tickUpper||
  req.range.tickLower%p.tickSpacing!==0||req.range.tickUpper%p.tickSpacing!==0)
  return unavailable(req.strategyId,'candidate_range_not_tick_aligned',req);
 if(BigInt(input.from.source.block)>=BigInt(input.through.source.block)||
  input.through.source.timestamp-input.from.source.timestamp!==req.windowSeconds)
  return unavailable(req.strategyId,'candidate_window_source_mismatch',req);
 const fromReason=validateFrame(input.from,p),throughReason=validateFrame(input.through,p);
 if(fromReason)return unavailable(req.strategyId,fromReason,req);
 if(throughReason)return unavailable(req.strategyId,throughReason,req);
 const proof=input.feeInterval,from=input.from.source,through=input.through.source;
 if(!same(proof.pool,p.poolAddress)||!same(proof.token0Address,p.token0)||!same(proof.token1Address,p.token1)||
  proof.fee!==p.fee||proof.tickSpacing!==p.tickSpacing||proof.coverage.stream!==p.streamKey||
  proof.coverage.targetSetHash!==p.targetSetHash||proof.from.block!==from.block||
  !same(proof.from.hash,from.hash)||proof.to.block!==through.block||!same(proof.to.hash,through.hash)||
  BigInt(proof.coverage.completeThroughBlock)<BigInt(through.block)||
  BigInt(proof.coverage.completeThroughBlock)===BigInt(through.block)&&
   !same(proof.coverage.completeThroughHash,through.hash))
  return unavailable(req.strategyId,'canonical_fee_interval_scope_mismatch',req);
 if(proof.range.tickLower!==req.range.tickLower||proof.range.tickUpper!==req.range.tickUpper)
  return unavailable(req.strategyId,'canonical_fee_interval_range_mismatch',req);
 if(proof.events>20_000||proof.partialSegments>proof.segments)
  return unavailable(req.strategyId,'canonical_fee_interval_budget_invalid',req);
 const sized=sizeLiquidityForQuoteBudget({budgetQuote:BigInt(req.capitalQuoteRaw),quoteToken:quoteAddress,
  sqrtPriceX96:BigInt(input.from.poolState.sqrtPriceX96),tickLower:req.range.tickLower,
  tickUpper:req.range.tickUpper,token0:p.token0,token1:p.token1});
 if(sized.liquidity<=0n)return unavailable(req.strategyId,'candidate_has_no_liquidity',req);
 if(proof.liquidity!==String(sized.liquidity))return unavailable(req.strategyId,'canonical_fee_candidate_liquidity_mismatch',req);
 const price0Start=BigInt(input.from.references.price0),price1Start=BigInt(input.from.references.price1),
  price0End=BigInt(input.through.references.price0),price1End=BigInt(input.through.references.price1),
  nativeStart=BigInt(input.from.references.nativePrice),nativeEnd=BigInt(input.through.references.nativePrice);
 const deployedUsdX18=valueUsdX18(sized.amount0,price0Start,p.decimals0)+
  valueUsdX18(sized.amount1,price1Start,p.decimals1);
 const poolLiquidity=BigInt(input.from.poolState.poolLiquidity),sharePpm=sized.liquidity*1_000_000n/
  (poolLiquidity+sized.liquidity);
 const selected=chooseGasStages(input,deployedUsdX18,sharePpm,now);
 if(selected.reason)return unavailable(req.strategyId,selected.reason,req);
 const openPricing=input.gasPricing.open,closePricing=input.gasPricing.close;
 if(openPricing.source.block!==from.block||!same(openPricing.source.hash,from.hash)||
  openPricing.source.timestamp!==from.timestamp||closePricing.source.block!==through.block||
  !same(closePricing.source.hash,through.hash)||closePricing.source.timestamp!==through.timestamp||
  BigInt(openPricing.expectedWei)<=0n||BigInt(openPricing.boundWei)<BigInt(openPricing.expectedWei)||
  BigInt(closePricing.expectedWei)<=0n||BigInt(closePricing.boundWei)<BigInt(closePricing.expectedWei))
  return unavailable(req.strategyId,'canonical_gas_price_scenario_unavailable',req);
 const startPosition=principalAmounts({liquidity:sized.liquidity,
  sqrtPriceX96:BigInt(input.from.poolState.sqrtPriceX96),tickLower:req.range.tickLower,tickUpper:req.range.tickUpper});
 if(startPosition.amount0!==sized.amount0||startPosition.amount1!==sized.amount1)
  return unavailable(req.strategyId,'candidate_principal_sizing_mismatch',req);
 const endPosition=principalAmounts({liquidity:sized.liquidity,
  sqrtPriceX96:BigInt(input.through.poolState.sqrtPriceX96),tickLower:req.range.tickLower,tickUpper:req.range.tickUpper});
 const lower0=BigInt(proof.token0.lowerAmountRaw),upper0=BigInt(proof.token0.upperAmountRaw),
  lower1=BigInt(proof.token1.lowerAmountRaw),upper1=BigInt(proof.token1.upperAmountRaw);
 if(lower0>upper0||lower1>upper1)return unavailable(req.strategyId,'canonical_fee_amount_bounds_invalid',req);
 const quoteIndex=p.quoteToken,quotePriceEnd=quoteIndex===0?price0End:price1End,
  quotePriceStart=quoteIndex===0?price0Start:price1Start,
  idle0=quoteIndex===0?sized.idleQuote:0n,idle1=quoteIndex===1?sized.idleQuote:0n;
 const end0=endPosition.amount0+idle0+lower0,end1=endPosition.amount1+idle1+lower1;
 const upperEnd0=endPosition.amount0+idle0+upper0,upperEnd1=endPosition.amount1+idle1+upper1;
 const candidateStartUsd6=valueUsd6(sized.amount0+idle0,price0Start,p.decimals0)+
  valueUsd6(sized.amount1+idle1,price1Start,p.decimals1);
 const candidateEndLowerUsd6=valueUsd6(end0,price0End,p.decimals0)+valueUsd6(end1,price1End,p.decimals1);
 const candidateEndUpperUsd6=valueUsd6(upperEnd0,price0End,p.decimals0)+valueUsd6(upperEnd1,price1End,p.decimals1);
 const passiveStartUsd6=valueUsd6(BigInt(req.capitalQuoteRaw),quotePriceStart,
  quoteIndex===0?p.decimals0:p.decimals1);
 const passiveEndUsd6=valueUsd6(BigInt(req.capitalQuoteRaw),quotePriceEnd,
  quoteIndex===0?p.decimals0:p.decimals1);
 const sumGas=(stages:readonly SelectedGasStage[],field:'expected'|'bound')=>
  stages.reduce((sum,stage)=>sum+BigInt(stage[field]),0n);
 const openStages=selected.stages.slice(0,3),closeStages=selected.stages.slice(3);
 const openExpectedUsd6=gasUsd6(sumGas(openStages,'expected'),BigInt(openPricing.expectedWei),nativeStart);
 const openBoundUsd6=gasUsd6(sumGas(openStages,'bound'),BigInt(openPricing.boundWei),nativeStart);
 const closeExpectedUsd6=gasUsd6(sumGas(closeStages,'expected'),BigInt(closePricing.expectedWei),nativeEnd);
 const closeBoundUsd6=gasUsd6(sumGas(closeStages,'bound'),BigInt(closePricing.boundWei),nativeEnd);
 const expectedCostUsd6=openExpectedUsd6+closeExpectedUsd6,boundCostUsd6=openBoundUsd6+closeBoundUsd6;
 const afterExpected=candidateEndLowerUsd6-expectedCostUsd6,afterBound=candidateEndLowerUsd6-boundCostUsd6;
 const candidate={tickLower:req.range.tickLower,tickUpper:req.range.tickUpper,
  liquidity:String(sized.liquidity),amount0AtEntryRaw:String(startPosition.amount0),
  amount1AtEntryRaw:String(startPosition.amount1),idleQuoteRaw:String(sized.idleQuote),
  deployedValueUsdX18:String(deployedUsdX18),dilutedSharePpm:String(sharePpm),
  feeEarningAtEntry:input.from.poolState.tick>=req.range.tickLower&&input.from.poolState.tick<req.range.tickUpper};
 const evidence={request:req,profile:{id:p.id,chainId:p.chainId,claimedVerificationClass:p.claimedVerificationClass,
  profileHash:p.profileHash,poolAddress:p.poolAddress.toLowerCase(),
  token0:p.token0.toLowerCase(),token1:p.token1.toLowerCase(),decimals0:p.decimals0,decimals1:p.decimals1,
  quoteToken:p.quoteToken,fee:p.fee,tickSpacing:p.tickSpacing,reference0:p.reference0,reference1:p.reference1,
  nativeReference:p.nativeReference,streamKey:p.streamKey,targetSetHash:p.targetSetHash},
  sources:{from,through},references:{from:input.from.references,through:input.through.references},
  feeInterval:proof,costProfiles:selected.stages,gasPricing:input.gasPricing,candidate,
  economics:{reportingUnit:'USD_MICRO',candidateStartUsd6:String(candidateStartUsd6),
   candidateEndLowerUsd6:String(candidateEndLowerUsd6),candidateEndUpperUsd6:String(candidateEndUpperUsd6),
   passiveStartUsd6:String(passiveStartUsd6),passiveEndUsd6:String(passiveEndUsd6),
   openExpectedCostUsd6:String(openExpectedUsd6),openBoundCostUsd6:String(openBoundUsd6),
   closeExpectedCostUsd6:String(closeExpectedUsd6),closeBoundCostUsd6:String(closeBoundUsd6),
   totalExpectedCostUsd6:String(expectedCostUsd6),totalBoundCostUsd6:String(boundCostUsd6),
   candidatePnlExpectedUsd6:String(afterExpected-candidateStartUsd6),
   candidatePnlBoundUsd6:String(afterBound-candidateStartUsd6),
   passivePnlUsd6:String(passiveEndUsd6-passiveStartUsd6),
   alphaExpectedUsd6:String(afterExpected-passiveEndUsd6),
   alphaBoundUsd6:String(afterBound-passiveEndUsd6)}};
 return {schemaVersion:1,status:'unverified_scenario',strategyId:req.strategyId,actionAvailable:false,
  draftCreationAvailable:false,request:req,candidate,economics:evidence.economics,
  missing:['canonical_market_profile_and_source_reader_required',
   'deployment_wallet_and_strategy_limits_not_pinned','trusted_draft_store_pinning_unavailable'],
  limitations:['fixed_static_manual_range_over_observed_pool_path','fees_are_lower_bound_hypothetical_flow_allocation',
   'no_counterfactual_market_impact_or_execution_delay','fork_gas_units_are_modeled_not_paid',
   'gas_price_is_a_source_pinned_scenario_for_both_stage_bundles','independent_endpoint_references_value_all_inventory',
   'caller_supplied_evidence_is_not_trusted','not_a_saved_draft_or_preview'],evidenceHash:digest(evidence)};
}

/** Recomputes the pure scenario from its full evidence bundle. This verifies
 * arithmetic and byte identity only; callers must source profile, fee, anchor,
 * reference, and registered gas evidence from their trusted readers. */
export function verifyResearchCandidateReplay(input:unknown,result:unknown,now=Date.now()):
 {valid:boolean;reason:string|null}{
 const expected=buildResearchCandidateReplay(input,now);
 if(expected.status!=='unverified_scenario')return {valid:false,reason:'candidate_replay_not_available'};
 if(!result||typeof result!=='object')return {valid:false,reason:'candidate_replay_result_invalid'};
 try{
  if(digest(result)!==digest(expected))return {valid:false,reason:'candidate_replay_result_mismatch'};
 }catch{return {valid:false,reason:'candidate_replay_result_invalid'};}
 return {valid:true,reason:null};
}
