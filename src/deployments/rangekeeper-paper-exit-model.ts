import {z} from 'zod';
import {principalAmounts} from '../backtest/principal.js';
import type {RobinhoodClient} from '../client.js';
import type {RangeKeeperCandidate,RangeKeeperLimits,RangeKeeperObservation,RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {planRangeKeeper,rawValue} from '../strategy/rangekeeper/planner.js';
import {replayPaperMint} from '../v3/position-math.js';
import {contentHash} from './contracts.js';
import {referenceProofHash} from './market-profile.js';
import {readCanonicalPaperNextFrame,type PaperOpenFrame} from './paper-preview.js';
import type {PaperGasProfileRow} from './paper-cost.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft,
 type RangeKeeperPaperOpenModel} from './rangekeeper-paper-open-model.js';
import {RANGEKEEPER_PAPER_DIRECT_CONVERT_EXIT_PATH,modelRangeKeeperPaperExitCost,
 rangeKeeperPaperCandidateHash,rangeKeeperPaperPathVersion,rangeKeeperPaperSizeBand,
 selectRangeKeeperPaperExitCostProfiles,type RangeKeeperPaperCandidateScope,
 type RangeKeeperPaperGasProfileReader,type RangeKeeperPaperModeledExitCost} from './rangekeeper-paper-cost.js';

const PPM=1_000_000n;
const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const candidateSchema=z.object({kind:z.enum(['entry','recenter']),
 range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),
 swap:z.object({token:z.union([z.literal(0),z.literal(1)]),amountIn:raw,quotedOut:raw,minOut:raw,
  priceAfter:raw,feeValue:raw,shortfallValue:raw}).strict().nullable(),
 amount0Desired:raw,amount1Desired:raw,amount0Min:raw,amount1Min:raw,
 liquidity:raw,deployedValue:raw,sourceBlock:raw,sourceHash:hash,expiresAt:z.number().int().nonnegative(),
}).strict();

export interface RangeKeeperPaperExitKernelContext {
 /** Trusted saved strategy state and current source-pinned inventory, never HTTP fields. */
 state:RangeKeeperState;source:PaperOpenFrame['source'];
 inventoryProofHash:string;
 wallet0:bigint;wallet1:bigint;released0:bigint;released1:bigint;nativeWei:bigint;
 campaignStartValue:bigint;highWaterValue:bigint;rollingSpentCost:bigint;
 campaignSpentCost:bigint;reservedCost:bigint;recenters:number;
 pending:boolean;entryAllowed:boolean;safeExitRequired:boolean;executionReady:boolean;
}

export interface RangeKeeperPaperExitModel {
 schemaVersion:1;kind:'rangekeeper_paper_exit_model';status:'blocked'|'indicative';
 exitKind:'retain'|'convert';blockingReason:string;actionAvailable:false;
 campaignId:string;revision:number;strategyId:'rangekeeper_v1';strategyVersion:'1.0.0';
 draftConfigHash:string;kernelPolicyHash:string;kernelBuildId:string;profileHash:string;
 openMarkId:string;openModelHash:string;candidateHash:string;
 previousMark:{id:string;source:PaperOpenFrame['source'];candidateHash:string};
 source:PaperOpenFrame['source'];poolState:{tick:number;sqrtPriceX96:string;poolLiquidity:string};
 reference:{price0:string;price1:string;nativePrice:string;proofHash:string;proof:Record<string,unknown>};
 inventoryProofHash:string;
 position:{paperPositionKey:string;tickLower:number;tickUpper:number;liquidity:string;
  sharePpm:string;idle0:string;idle1:string;principal0:string;principal1:string;
  retainedLowerBound0:string;retainedLowerBound1:string};
 conversion:null|{pathVersion:string;inputToken:0|1;outputToken:0|1;inputAmount:string;
  expectedOutput:string;minimumOutput:string;expectedProceedsValue:string;minimumProceedsValue:string;
  feeValue:string;shortfallValue:string;quoteHash:string};
 costs:RangeKeeperPaperModeledExitCost|null;
 kernelEvaluation:null|{action:'wait'|'safety_exit'|'confirm'|'execute';reason:string;
  candidateHash:string|null;simulationAvailable:boolean;remaining:{action:string;rolling:string;
   campaign:string;nativeWei:string}};
 unmodeled:string[];unavailable:string[];
}

export interface RangeKeeperPaperExitUnavailable {
 schemaVersion:1;kind:'rangekeeper_paper_exit_unavailable';status:'unavailable';
 exitKind:'retain'|'convert';reason:string;campaignId:string;revision:number;
 openModelHash:string|null;candidateHash:string|null;actionAvailable:false;
}
export type RangeKeeperPaperExitResult=RangeKeeperPaperExitModel|RangeKeeperPaperExitUnavailable;

export interface BuildRangeKeeperPaperExitInput {
 client:RobinhoodClient;draft:RangeKeeperPaperDraft;openModel:RangeKeeperPaperOpenModel;
 openMarkId:string;previous:{id:string;source:PaperOpenFrame['source'];candidateHash:string;
  position:{tickLower:number;tickUpper:number;liquidity:string};idle:{token0:string;token1:string}};
 frame:PaperOpenFrame;buildId:string;exitKind:'retain'|'convert';
 kernel:RangeKeeperPaperExitKernelContext;readGasProfiles:RangeKeeperPaperGasProfileReader;
 marketGasPriceWei:bigint|null;marketGasPriceObservedAt:number|null;
 simulate:(candidate:RangeKeeperCandidate)=>Promise<boolean>;now?:number;
}

type ExitProofContext=Omit<RangeKeeperPaperExitKernelContext,'inventoryProofHash'>;
export function rangeKeeperPaperExitInventoryProofHash(input:{campaignId:string;revision:number;
 openMarkId:string;openModelHash:string;candidateHash:string;kernel:ExitProofContext;
 previous:BuildRangeKeeperPaperExitInput['previous']}):string{
 const k=input.kernel;
 const confirmation=k.state.confirmation;
 const confirmedCandidate=confirmation?{
  kind:confirmation.candidate.kind,range:confirmation.candidate.range,
  swap:confirmation.candidate.swap?{token:confirmation.candidate.swap.token,
   amountIn:String(confirmation.candidate.swap.amountIn),quotedOut:String(confirmation.candidate.swap.quotedOut),
   minOut:String(confirmation.candidate.swap.minOut),priceAfter:String(confirmation.candidate.swap.priceAfter),
   feeValue:String(confirmation.candidate.swap.feeValue),
   shortfallValue:String(confirmation.candidate.swap.shortfallValue)}:null,
  amount0Desired:String(confirmation.candidate.amount0Desired),
  amount1Desired:String(confirmation.candidate.amount1Desired),
  amount0Min:String(confirmation.candidate.amount0Min),amount1Min:String(confirmation.candidate.amount1Min),
  liquidity:String(confirmation.candidate.liquidity),deployedValue:String(confirmation.candidate.deployedValue),
  sourceBlock:String(confirmation.candidate.sourceBlock),sourceHash:confirmation.candidate.sourceHash,
  expiresAt:confirmation.candidate.expiresAt,
 }:null;
 return contentHash({kind:'range_keeper_paper_exit_inventory_snapshot_v1',
  campaignId:input.campaignId,revision:input.revision,openMarkId:input.openMarkId,
  openModelHash:input.openModelHash,candidateHash:input.candidateHash,source:k.source,
  previous:{id:input.previous.id,source:input.previous.source,candidateHash:input.previous.candidateHash,
   position:input.previous.position,idle:input.previous.idle},
  inventory:{wallet0:String(k.wallet0),wallet1:String(k.wallet1),released0:String(k.released0),
   released1:String(k.released1),nativeWei:String(k.nativeWei)},
  history:{campaignStartValue:String(k.campaignStartValue),highWaterValue:String(k.highWaterValue),
   rollingSpentCost:String(k.rollingSpentCost),campaignSpentCost:String(k.campaignSpentCost),
   reservedCost:String(k.reservedCost),recenters:k.recenters,pending:k.pending,
   entryAllowed:k.entryAllowed,safeExitRequired:k.safeExitRequired,executionReady:k.executionReady},
  state:{schemaVersion:k.state.schemaVersion,policyId:k.state.policyId,
   strategyVersion:k.state.strategyVersion,configHash:k.state.configHash,buildId:k.state.buildId,
   lastEligible:k.state.lastEligible?{block:String(k.state.lastEligible.block),
    hash:k.state.lastEligible.hash,timestamp:k.state.lastEligible.timestamp}:null,
   confirmation:confirmation?{candidate:confirmedCandidate,firstBlock:String(confirmation.firstBlock),
    firstHash:confirmation.firstHash,firstAt:confirmation.firstAt}:null,
   exit:k.state.exit?{tokenId:k.state.exit.tokenId,tickLower:k.state.exit.tickLower,
    tickUpper:k.state.exit.tickUpper,block:String(k.state.exit.block),hash:k.state.exit.hash,
    since:k.state.exit.since,lastOutsideAt:k.state.exit.lastOutsideAt}:null}});
}

const unavailable=(input:Pick<BuildRangeKeeperPaperExitInput,'draft'|'openModel'|'exitKind'>,
 reason:string):RangeKeeperPaperExitUnavailable=>({schemaVersion:1,kind:'rangekeeper_paper_exit_unavailable',
 status:'unavailable',exitKind:input.exitKind,reason,campaignId:input.draft.id,
 revision:input.draft.revision,openModelHash:input.openModel?contentHash(input.openModel):null,
 candidateHash:input.openModel?.candidateHash??null,actionAvailable:false});

function parseCandidate(open:RangeKeeperPaperOpenModel):RangeKeeperCandidate{
 const c=candidateSchema.parse(open.candidate);
 return {kind:c.kind,range:c.range,
  swap:c.swap?{token:c.swap.token,amountIn:BigInt(c.swap.amountIn),quotedOut:BigInt(c.swap.quotedOut),
   minOut:BigInt(c.swap.minOut),priceAfter:BigInt(c.swap.priceAfter),feeValue:BigInt(c.swap.feeValue),
   shortfallValue:BigInt(c.swap.shortfallValue)}:null,
  amount0Desired:BigInt(c.amount0Desired),amount1Desired:BigInt(c.amount1Desired),
  amount0Min:BigInt(c.amount0Min),amount1Min:BigInt(c.amount1Min),liquidity:BigInt(c.liquidity),
  deployedValue:BigInt(c.deployedValue),sourceBlock:BigInt(c.sourceBlock),
  sourceHash:c.sourceHash as `0x${string}`,expiresAt:c.expiresAt};
}

function frameReasons(frame:PaperOpenFrame,now:number):string[]{
 const reasons:string[]=[];
 if(!frame.referenceProof||referenceProofHash(frame.referenceProof)!==frame.referenceProofHash)
  reasons.push('canonical_reference_proof_unavailable');
 if(!/^0x[0-9a-fA-F]{64}$/.test(frame.source.hash)||!raw.safeParse(frame.source.block).success||
  !Number.isSafeInteger(frame.source.timestamp)||frame.source.timestamp<0)
  reasons.push('canonical_source_identity_unavailable');
 const age=now-Math.floor(frame.source.timestamp*1000);
 if(age<0||age>180_000)reasons.push('canonical_source_stale');
 if(!Number.isSafeInteger(frame.tick)||frame.sqrtPriceX96<=0n||frame.poolLiquidity<0n)
  reasons.push('canonical_pool_state_unavailable');
 if(!frame.referenceEligible||frame.price0===null||frame.price0<=0n||frame.price1===null||
  frame.price1<=0n||frame.nativePrice===null||frame.nativePrice<=0n)
  reasons.push('independent_reference_unavailable');
 return reasons;
}

function idleInventory(draft:RangeKeeperPaperDraft,candidate:RangeKeeperCandidate,
 open:RangeKeeperPaperOpenModel):{amount0:bigint;amount1:bigint}{
 const p=draft.profile.pool,openPrice=BigInt(open.poolState.sqrtPriceX96);
 const replay=replayPaperMint(openPrice,candidate.range,candidate.amount0Desired,candidate.amount1Desired,0n);
 if(replay.liquidity!==candidate.liquidity||candidate.expiresAt!==open.source.timestamp+90)
  throw Error('rangekeeper_open_mint_replay_mismatch');
 let available0=BigInt(draft.allocation.token0Raw),available1=BigInt(draft.allocation.token1Raw);
 if(candidate.swap){
  if(candidate.swap.token===0){available0-=candidate.swap.amountIn;available1+=candidate.swap.quotedOut;}
  else{available1-=candidate.swap.amountIn;available0+=candidate.swap.quotedOut;}
 }
 const amount0=available0-replay.amount0,amount1=available1-replay.amount1;
 if(amount0<0n||amount1<0n||p.decimals0<0||p.decimals1<0)
  throw Error('rangekeeper_open_idle_inventory_invalid');
 return {amount0,amount1};
}

async function terminalQuote(input:{candidateHash:string;kind:'retain'|'convert';frame:PaperOpenFrame;
 draft:RangeKeeperPaperDraft;amount0:bigint;amount1:bigint;chain:RangeKeeperChain;
 limits:RangeKeeperLimits}):Promise<RangeKeeperPaperExitModel['conversion']>{
 if(input.kind==='retain')return null;
 const p=input.draft.profile.pool,risky:0|1=p.quoteToken===0?1:0;
 const amountIn=risky===0?input.amount0:input.amount1;
 if(amountIn<=0n)throw Error('rangekeeper_convert_input_unavailable');
 const quote=await input.chain.quote({block:BigInt(input.frame.source.block),
  hash:input.frame.source.hash as `0x${string}`,timestamp:input.frame.source.timestamp},risky,amountIn,
  input.frame.price0!,input.frame.price1!);
 if(quote.amountOut<=0n||quote.sourceBlock!==BigInt(input.frame.source.block)||
  quote.sourceHash.toLowerCase()!==input.frame.source.hash.toLowerCase()||
  quote.shortfallValue>input.limits.maxSwapShortfallValue)
  throw Error('rangekeeper_convert_quote_or_shortfall_unavailable');
 const minOut=quote.amountOut*(10_000n-BigInt(input.limits.maxSlippageBps))/10_000n;
 if(minOut<=0n)throw Error('rangekeeper_convert_minimum_output_unavailable');
 const outputPrice=risky===0?input.frame.price1!:input.frame.price0!,outputDecimals=risky===0?p.decimals1:p.decimals0;
 const expectedProceedsValue=rawValue(quote.amountOut,outputPrice,outputDecimals);
 const minimumProceedsValue=rawValue(minOut,outputPrice,outputDecimals);
 const content={kind:'range_keeper_paper_direct_convert_quote_v1',candidateHash:input.candidateHash,
  source:input.frame.source,pool:p.pool,router:p.router,quoter:p.quoter,fee:p.fee,
  inputToken:risky,outputToken:p.quoteToken,inputAmount:String(amountIn),
  expectedOutput:String(quote.amountOut),minimumOutput:String(minOut),
  feeValue:String(quote.feeValue),shortfallValue:String(quote.shortfallValue),
  maxSlippageBps:input.limits.maxSlippageBps};
 return {pathVersion:'paper_rangekeeper_v1_direct_convert_exit_v1',inputToken:risky,
  outputToken:p.quoteToken,inputAmount:String(amountIn),expectedOutput:String(quote.amountOut),
  minimumOutput:String(minOut),expectedProceedsValue:String(expectedProceedsValue),
  minimumProceedsValue:String(minimumProceedsValue),feeValue:String(quote.feeValue),
  shortfallValue:String(quote.shortfallValue),quoteHash:contentHash(content)};
}

function validateIdentity(input:BuildRangeKeeperPaperExitInput,candidate:RangeKeeperCandidate,
 limits:RangeKeeperLimits,policyHash:string,now:number):string[]{
 const {draft,openModel:open,previous,frame,kernel}=input,reasons:string[]=[];
 if(open.status!=='indicative'||open.actionAvailable||!open.candidate||!open.candidateHash||
  open.decision?.requiresSecondObservation!==true)
  reasons.push('rangekeeper_open_candidate_unconfirmed_or_unavailable');
 if(open.campaignId!==draft.id||open.revision!==draft.revision||open.profileHash!==draft.profileHash||
  open.draftConfigHash!==draft.configHash||open.strategyId!=='rangekeeper_v1'||
  open.strategyVersion!=='1.0.0'||open.kernelPolicyHash!==policyHash||open.kernelBuildId!==input.buildId)
  reasons.push('rangekeeper_open_config_identity_mismatch');
 if(!open.reference.proof||referenceProofHash(open.reference.proof)!==open.reference.proofHash)
  reasons.push('rangekeeper_open_reference_proof_invalid');
 if(candidate.sourceBlock!==BigInt(open.source.block)||candidate.sourceHash.toLowerCase()!==open.source.hash.toLowerCase()||
  candidate.range.tickUpper-candidate.range.tickLower!==
   limits.fullWidthSpacings*draft.profile.pool.tickSpacing)
  reasons.push('rangekeeper_open_candidate_source_or_width_mismatch');
 const expectedCandidateHash=rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:draft.revision,
  profileHash:draft.profileHash,configHash:draft.configHash,source:open.source,
  referenceProofHash:open.reference.proofHash,candidate});
 if(open.candidateHash!==expectedCandidateHash||previous.candidateHash!==expectedCandidateHash)
  reasons.push('rangekeeper_candidate_identity_mismatch');
 if(!raw.safeParse(input.openMarkId).success||!raw.safeParse(previous.id).success||
  !raw.safeParse(previous.source.block).success||!hash.safeParse(previous.source.hash).success||
  !Number.isSafeInteger(previous.source.timestamp)||previous.source.timestamp<0||
  BigInt(input.openMarkId)<=0n||BigInt(previous.id)<=BigInt(input.openMarkId)||
  BigInt(previous.source.block)<=BigInt(open.source.block)||
  BigInt(frame.source.block)<=BigInt(previous.source.block)||frame.source.timestamp<previous.source.timestamp)
  reasons.push('rangekeeper_exit_source_order_invalid');
 if(kernel.source.block!==frame.source.block||kernel.source.hash.toLowerCase()!==frame.source.hash.toLowerCase()||
  kernel.state.buildId!==input.buildId||kernel.state.configHash.toLowerCase()!==`0x${policyHash}`.toLowerCase()||
  kernel.source.timestamp!==frame.source.timestamp||
  kernel.inventoryProofHash!==rangeKeeperPaperExitInventoryProofHash({campaignId:draft.id,
   revision:draft.revision,openMarkId:input.openMarkId,openModelHash:contentHash(open),
   candidateHash:open.candidateHash??'',kernel,previous}))
  reasons.push('rangekeeper_kernel_state_identity_mismatch');
 if(kernel.wallet0<0n||kernel.wallet1<0n||kernel.released0<0n||kernel.released1<0n||
  kernel.nativeWei<0n||kernel.campaignStartValue<=0n||kernel.highWaterValue<=0n||
  kernel.rollingSpentCost<0n||kernel.campaignSpentCost<0n||kernel.reservedCost<0n||
  !Number.isSafeInteger(kernel.recenters)||kernel.recenters<0)
  reasons.push('rangekeeper_kernel_history_invalid');
 reasons.push(...frameReasons(frame,now));
 return [...new Set(reasons)];
}

function unavailableModel(input:BuildRangeKeeperPaperExitInput,reason:string,
 policyHash:string|null=null):RangeKeeperPaperExitModel{
 const open=input.openModel,frame=input.frame;
 return {schemaVersion:1,kind:'rangekeeper_paper_exit_model',status:'blocked',exitKind:input.exitKind,
  blockingReason:reason,actionAvailable:false,campaignId:input.draft.id,revision:input.draft.revision,
  strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',draftConfigHash:input.draft.configHash,
  kernelPolicyHash:policyHash??open.kernelPolicyHash??'',kernelBuildId:input.buildId,
  profileHash:input.draft.profileHash,openMarkId:input.openMarkId,openModelHash:contentHash(open),
  candidateHash:open.candidateHash??'',previousMark:{id:input.previous.id,source:input.previous.source,
   candidateHash:input.previous.candidateHash},source:frame.source,
  poolState:{tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),poolLiquidity:String(frame.poolLiquidity)},
  reference:{price0:frame.price0===null?'':String(frame.price0),price1:frame.price1===null?'':String(frame.price1),
   nativePrice:frame.nativePrice===null?'':String(frame.nativePrice),proofHash:frame.referenceProofHash,
   proof:frame.referenceProof??{}},
  inventoryProofHash:input.kernel.inventoryProofHash,
  position:{paperPositionKey:open.candidateHash??'',tickLower:0,tickUpper:0,liquidity:'0',sharePpm:'0',
   idle0:'0',idle1:'0',principal0:'0',principal1:'0',retainedLowerBound0:'0',retainedLowerBound1:'0'},
  conversion:null,costs:null,kernelEvaluation:null,
  unmodeled:['fee_capture','paid_gas','final_custody','lifecycle_accounting'],unavailable:[reason]};
}

/** Builds a read-only terminal valuation for an explicitly requested close.
 * The requested retain/convert path is not represented as a kernel safety exit.
 * It requires a trusted current kernel state and exact source-scoped gas rows. */
export async function buildRangeKeeperPaperExitModel(input:BuildRangeKeeperPaperExitInput):Promise<RangeKeeperPaperExitModel>{
 const now=input.now??Date.now(),policyResolution=resolveRangeKeeperPaperPolicy(input.draft,input.buildId);
 if(!policyResolution.policy||policyResolution.unavailable.length)
  return unavailableModel(input,policyResolution.unavailable.join(',')||'rangekeeper_policy_unavailable');
 const policy=policyResolution.policy,limits=policy.limits;
 let candidate:RangeKeeperCandidate;
 try{candidate=parseCandidate(input.openModel);}
 catch{return unavailableModel(input,'rangekeeper_open_candidate_invalid',policy.policyHash);}
 const identityReasons=validateIdentity(input,candidate,limits,policy.policyHash,now);
 if(identityReasons.length)return unavailableModel(input,identityReasons.join(','),policy.policyHash);
 const draft=input.draft,open=input.openModel,frame=input.frame,p=draft.profile.pool;
 let idle:{amount0:bigint;amount1:bigint};
 try{idle=idleInventory(draft,candidate,open);}
 catch(error){return unavailableModel(input,error instanceof Error?error.message:'rangekeeper_idle_inventory_unavailable',policy.policyHash);}
 if(input.previous.position.tickLower!==candidate.range.tickLower||
  input.previous.position.tickUpper!==candidate.range.tickUpper||
  input.previous.position.liquidity!==String(candidate.liquidity)||
  input.previous.idle.token0!==String(idle.amount0)||input.previous.idle.token1!==String(idle.amount1))
  return unavailableModel(input,'rangekeeper_previous_position_or_idle_changed',policy.policyHash);
 const poolPrice1=((1n<<192n)*10n**BigInt(p.decimals1)*frame.price0!) /
  (frame.sqrtPriceX96*frame.sqrtPriceX96*10n**BigInt(p.decimals0));
 const deviation=poolPrice1>frame.price1!?poolPrice1-frame.price1!:frame.price1!-poolPrice1;
 if(deviation*PPM>frame.price1!*BigInt(draft.profile.referencePolicy.maxPoolDeviationPpm))
  return unavailableModel(input,'rangekeeper_exit_independent_price_band',policy.policyHash);
 const principal=principalAmounts({liquidity:candidate.liquidity,tickLower:candidate.range.tickLower,
  tickUpper:candidate.range.tickUpper,sqrtPriceX96:frame.sqrtPriceX96});
 // The saved source-pinned wallet must still reconcile to the entry idle
 // inventory. Released balances may contain principal, but any excess would
 // be uncollected fees and cannot be valued without canonical fee evidence.
 if(input.kernel.wallet0!==idle.amount0||input.kernel.wallet1!==idle.amount1)
  return unavailableModel(input,'rangekeeper_terminal_wallet_idle_unproven',policy.policyHash);
 if(input.kernel.released0!==principal.amount0||input.kernel.released1!==principal.amount1)
  return unavailableModel(input,input.kernel.released0>principal.amount0||input.kernel.released1>principal.amount1?
   'rangekeeper_terminal_released_fee_evidence_unavailable':
   'rangekeeper_terminal_released_principal_mismatch',policy.policyHash);
 const retained0=input.kernel.wallet0+principal.amount0,retained1=input.kernel.wallet1+principal.amount1;
 const denominator=frame.poolLiquidity+candidate.liquidity;
 if(denominator<=0n)return unavailableModel(input,'rangekeeper_exit_liquidity_share_unavailable',policy.policyHash);
 const share=candidate.liquidity*PPM/denominator;
 if(share>BigInt(limits.maxLiquiditySharePpm))
  return unavailableModel(input,'rangekeeper_exit_liquidity_share_limit',policy.policyHash);
 const candidateHash=open.candidateHash!,deployedValue=rawValue(principal.amount0,frame.price0!,p.decimals0)+
  rawValue(principal.amount1,frame.price1!,p.decimals1);
 const inventoryHash=contentHash({kind:'range_keeper_paper_terminal_inventory_v1',candidateHash,
  source:frame.source,inventoryProofHash:input.kernel.inventoryProofHash,
  wallet0:String(input.kernel.wallet0),wallet1:String(input.kernel.wallet1),
  released0:String(input.kernel.released0),released1:String(input.kernel.released1),
  nativeWei:String(input.kernel.nativeWei),position:{tickLower:candidate.range.tickLower,
   tickUpper:candidate.range.tickUpper,liquidity:String(candidate.liquidity)},
  principal0:String(principal.amount0),principal1:String(principal.amount1),
  idle0:String(idle.amount0),idle1:String(idle.amount1),
  terminal0:String(input.kernel.wallet0+input.kernel.released0),
  terminal1:String(input.kernel.wallet1+input.kernel.released1)});
 const scope:RangeKeeperPaperCandidateScope={poolAddress:p.pool,profileHash:draft.profileHash,
  candidateHash,deployedValue,sharePpm:share,range:candidate.range,
  swapKind:candidate.swap?'direct_pool_exact_input':'none',inventoryHash};
 const chain=new RangeKeeperChain(input.client,p);
 let conversion:RangeKeeperPaperExitModel['conversion']=null;
 if(input.exitKind==='convert'){
  try{conversion=await terminalQuote({candidateHash,kind:'convert',frame,draft,
   amount0:input.kernel.wallet0+input.kernel.released0,
   amount1:input.kernel.wallet1+input.kernel.released1,chain,limits});}
  catch(error){return unavailableModel(input,error instanceof Error?error.message:'rangekeeper_convert_quote_unavailable',policy.policyHash);}
 }
 const path=input.exitKind==='retain'?rangeKeeperPaperPathVersion(candidate):RANGEKEEPER_PAPER_DIRECT_CONVERT_EXIT_PATH;
 const sizeBand=rangeKeeperPaperSizeBand(path,scope);
 let rows:readonly PaperGasProfileRow[]=[];
 let costs:RangeKeeperPaperModeledExitCost|null=null;
 let costReason:string|null=null;
 if(input.marketGasPriceWei===null||input.marketGasPriceWei<=0n||input.marketGasPriceObservedAt===null||
  now<input.marketGasPriceObservedAt||now-input.marketGasPriceObservedAt>30_000)
  costReason='rangekeeper_exit_gas_price_unavailable';
 else{
  try{rows=await input.readGasProfiles({poolAddress:p.pool,pathVersion:path,sizeBand});}
  catch{costReason='rangekeeper_exit_scoped_cost_lookup_unavailable';}
  if(!costReason){
   const costSelection=selectRangeKeeperPaperExitCostProfiles({kind:input.exitKind,candidate,scope,
    source:frame.source,rows,now});
   if(costSelection.status!=='available')costReason=`${costSelection.reason}:${costSelection.missingStages.join(',')}`;
   else{
    try{costs=modelRangeKeeperPaperExitCost({profiles:costSelection,limits,nativePrice:frame.nativePrice!,
     marketGasPriceWei:input.marketGasPriceWei,swapFeeAndShortfallValue:conversion?
      BigInt(conversion.feeValue)+BigInt(conversion.shortfallValue):0n,now});}
    catch(error){costReason=error instanceof Error?error.message:'rangekeeper_exit_cost_model_unavailable';}
   }
  }
 }
 const costBound=costs?BigInt(costs.boundValue):null;
 if(costs&&((costBound!>limits.maxActionCost)||costBound!>limits.maxRollingCost-
   (input.kernel.rollingSpentCost+input.kernel.reservedCost)||costBound!>limits.maxCampaignCost-
   (input.kernel.campaignSpentCost+input.kernel.reservedCost)||input.kernel.nativeWei<BigInt(costs.boundWei)))
  costReason='rangekeeper_exit_cost_or_native_budget_limit';
 const observation:RangeKeeperObservation={block:BigInt(frame.source.block),hash:frame.source.hash as `0x${string}`,
  timestamp:frame.source.timestamp,tick:frame.tick,sqrtPriceX96:frame.sqrtPriceX96,continuity:'canonical',
  wallet0:input.kernel.wallet0,wallet1:input.kernel.wallet1,released0:input.kernel.released0,
  released1:input.kernel.released1,nativeWei:input.kernel.nativeWei,
  requiredExitReserveWei:limits.exitReserveWei,price0:frame.price0,price1:frame.price1,
  nativePrice:frame.nativePrice,position:{tokenId:`paper:${candidateHash}`,tickLower:candidate.range.tickLower,
   tickUpper:candidate.range.tickUpper,liquidity:candidate.liquidity},pending:input.kernel.pending,
  entryAllowed:input.kernel.entryAllowed,safeExitRequired:input.kernel.safeExitRequired,
  executionReady:input.kernel.executionReady,liquiditySharePpm:Number(share),
  actionCost:costs&&!costReason?costBound:null,actionGasWei:costs&&!costReason?BigInt(costs.boundWei):null,
  reservedCost:input.kernel.reservedCost,rollingSpentCost:input.kernel.rollingSpentCost,
  campaignSpentCost:input.kernel.campaignSpentCost,campaignStartValue:input.kernel.campaignStartValue,
  highWaterValue:input.kernel.highWaterValue,recenters:input.kernel.recenters};
 let decision;
 try{decision=await planRangeKeeper({state:input.kernel.state,observation,limits,
  spacing:p.tickSpacing,decimals0:p.decimals0,decimals1:p.decimals1,quoteToken:p.quoteToken,
  maxPoolDeviationPpm:draft.profile.referencePolicy.maxPoolDeviationPpm,
  quote:(token,amount)=>chain.quote({block:BigInt(frame.source.block),hash:frame.source.hash as `0x${string}`,
   timestamp:frame.source.timestamp},token,amount,frame.price0!,frame.price1!),simulate:input.simulate});}
 catch(error){return unavailableModel(input,error instanceof Error?error.message:'rangekeeper_kernel_evaluation_unavailable',policy.policyHash);}
 const model:RangeKeeperPaperExitModel={schemaVersion:1,kind:'rangekeeper_paper_exit_model',
  status:costReason?'blocked':'indicative',exitKind:input.exitKind,
  blockingReason:costReason??'rangekeeper_operator_terminal_request_read_only',actionAvailable:false,
  campaignId:draft.id,revision:draft.revision,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',
  draftConfigHash:draft.configHash,kernelPolicyHash:policy.policyHash,kernelBuildId:policy.buildId,
  profileHash:draft.profileHash,openMarkId:input.openMarkId,openModelHash:contentHash(open),candidateHash,
  previousMark:{id:input.previous.id,source:input.previous.source,candidateHash:input.previous.candidateHash},
  source:frame.source,poolState:{tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),
   poolLiquidity:String(frame.poolLiquidity)},reference:{price0:String(frame.price0),price1:String(frame.price1),
   nativePrice:String(frame.nativePrice),proofHash:frame.referenceProofHash,proof:frame.referenceProof!},
  inventoryProofHash:input.kernel.inventoryProofHash,
  position:{paperPositionKey:`paper:${candidateHash}`,tickLower:candidate.range.tickLower,
   tickUpper:candidate.range.tickUpper,liquidity:String(candidate.liquidity),sharePpm:String(share),
   idle0:String(idle.amount0),idle1:String(idle.amount1),principal0:String(principal.amount0),
   principal1:String(principal.amount1),retainedLowerBound0:String(retained0),
   retainedLowerBound1:String(retained1)},conversion,costs,
  kernelEvaluation:{action:decision.action,reason:decision.reason,
   candidateHash:decision.candidate?contentHash(decision.candidate):null,
   simulationAvailable:decision.reason!=='calldata_simulation_unavailable'&&
    decision.reason!=='calldata_simulation_failed',remaining:{action:String(decision.remaining.action),
     rolling:String(decision.remaining.rolling),campaign:String(decision.remaining.campaign),
     nativeWei:String(decision.remaining.nativeWei)}},
  unmodeled:['uncollected_fees','paid_gas','execution_delay','execution_failure','final_custody',
   'ledger_reconciliation','lifecycle_accounting'],
  unavailable:costReason?[costReason,...(costs?.unavailable??[])]:costs?.unavailable??[],
 };
 return model;
}

/** Canonical read-only wrapper. The draft and kernel context must come from
 * trusted persisted state; the gas reader must be the exact-scope store query. */
export async function readCanonicalRangeKeeperPaperExitModel(input:Omit<BuildRangeKeeperPaperExitInput,
 'frame'|'buildId'|'marketGasPriceWei'|'marketGasPriceObservedAt'|'now'>&{buildId:string|null;now?:number}){
 const emptyInput={draft:input.draft,openModel:input.openModel,exitKind:input.exitKind};
 if(!input.buildId)return unavailable(emptyInput,'rangekeeper_runtime_build_identity_unavailable');
 if(!raw.safeParse(input.openMarkId).success||!raw.safeParse(input.previous.id).success||
  BigInt(input.openMarkId)<=0n||BigInt(input.previous.id)<=BigInt(input.openMarkId)||
  !raw.safeParse(input.previous.source.block).success||
  !hash.safeParse(input.previous.source.hash).success||!Number.isSafeInteger(input.previous.source.timestamp)||
  input.previous.source.timestamp<0)
  return unavailable(emptyInput,'rangekeeper_previous_mark_anchor_invalid');
 let frame:PaperOpenFrame;
 try{frame=await readCanonicalPaperNextFrame(input.client,input.draft.profile,
  {sourceBlock:input.previous.source.block,sourceHash:input.previous.source.hash});}
 catch{return unavailable(emptyInput,'rangekeeper_previous_mark_anchor_or_canonical_exit_source_unavailable');}
 let marketGasPriceWei:bigint|null=null,marketGasPriceObservedAt:number|null=null;
 try{marketGasPriceWei=await input.client.getGasPrice();marketGasPriceObservedAt=Date.now();}
 catch{/* The builder returns a blocked model with explicit gas evidence unavailable. */}
 const now=input.now??Date.now();
 return buildRangeKeeperPaperExitModel({...input,buildId:input.buildId,frame,
  marketGasPriceWei,marketGasPriceObservedAt,now});
}
