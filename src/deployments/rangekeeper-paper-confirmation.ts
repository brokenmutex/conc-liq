import {z} from 'zod';
import type {RobinhoodClient} from '../client.js';
import type {RangeKeeperCandidate,RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {planRangeKeeper,rawValue} from '../strategy/rangekeeper/planner.js';
import {replayPaperMint} from '../v3/position-math.js';
import {contentHash} from './contracts.js';
import {referenceProofHash} from './market-profile.js';
import type {PaperOpenFrame} from './paper-preview.js';
import type {PaperGasProfileRow} from './paper-cost.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft,
 type RangeKeeperPaperOpenModel} from './rangekeeper-paper-open-model.js';
import {modelRangeKeeperPaperCosts,rangeKeeperPaperCandidateHash,rangeKeeperPaperPathVersion,
 rangeKeeperPaperSizeBand,selectRangeKeeperPaperCostProfiles,type RangeKeeperPaperCandidateScope,
 type RangeKeeperPaperGasProfileReader,type RangeKeeperPaperModeledCosts} from './rangekeeper-paper-cost.js';

const PPM=1_000_000n;
const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const sourceSchema=z.object({block:raw,hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 timestamp:z.number().int().nonnegative()}).strict();
const candidateSchema=z.object({kind:z.enum(['entry','recenter']),
 range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),
 swap:z.object({token:z.union([z.literal(0),z.literal(1)]),amountIn:raw,quotedOut:raw,minOut:raw,
  priceAfter:raw,feeValue:raw,shortfallValue:raw}).strict().nullable(),
 amount0Desired:raw,amount1Desired:raw,amount0Min:raw,amount1Min:raw,liquidity:raw,
 deployedValue:raw,sourceBlock:raw,sourceHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 expiresAt:z.number().int().nonnegative()}).strict();

export interface RangeKeeperPaperConfirmationProbe {
 status:'candidate';campaignId:string;revision:number;firstModelHash:string;firstCandidateHash:string;
 source:PaperOpenFrame['source'];candidate:RangeKeeperCandidate;candidateHash:string;
 scope:RangeKeeperPaperCandidateScope;pathVersion:string;sizeBand:string;actionAvailable:false;
}
export interface RangeKeeperPaperConfirmationUnavailable {
 status:'unavailable';reason:string;campaignId:string;revision:number;actionAvailable:false;
}
export interface RangeKeeperPaperConfirmationEnvelope {
 schemaVersion:1;kind:'rangekeeper_paper_open_confirmation_v1';status:'confirmed';
 campaignId:string;revision:number;draftConfigHash:string;profileHash:string;
 firstObservation:{source:PaperOpenFrame['source'];modelHash:string;candidateHash:string};
 confirmationObservation:{source:PaperOpenFrame['source'];candidateHash:string;
  candidate:unknown;poolState:{tick:number;sqrtPriceX96:string;poolLiquidity:string};
  reference:{price0:string;price1:string;nativePrice:string;proofHash:string;proof:Record<string,unknown>}};
 decision:{action:'execute';reason:'two_confirmations';gasSequenceHash:string;
  simulation:{status:'success';sourceBlock:string;sourceHash:string;candidateHash:string;simulationHash:string}};
 costs:RangeKeeperPaperModeledCosts;strategyState:unknown;
 inventory:{position:{tickLower:number;tickUpper:number;liquidity:string};idle:{token0:string;token1:string}};
 selectedGasProfileIds:string[];executionEvidence:'caller_supplied_simulation_attestation_unverified';
 openingBooked:false;actionAvailable:false;envelopeHash:string;
}
export type RangeKeeperPaperConfirmationResult=RangeKeeperPaperConfirmationProbe|
 RangeKeeperPaperConfirmationUnavailable|RangeKeeperPaperConfirmationEnvelope;
export interface RangeKeeperPaperConfirmationSimulation {
 status:'success';sourceBlock:string;sourceHash:string;candidateHash:string;simulationHash:string;
}

function deserializeCandidate(value:unknown):RangeKeeperCandidate{
 const c=candidateSchema.parse(value);
 return {kind:c.kind,range:c.range,swap:c.swap?{token:c.swap.token,amountIn:BigInt(c.swap.amountIn),
  quotedOut:BigInt(c.swap.quotedOut),minOut:BigInt(c.swap.minOut),priceAfter:BigInt(c.swap.priceAfter),
  feeValue:BigInt(c.swap.feeValue),shortfallValue:BigInt(c.swap.shortfallValue)}:null,
  amount0Desired:BigInt(c.amount0Desired),amount1Desired:BigInt(c.amount1Desired),
  amount0Min:BigInt(c.amount0Min),amount1Min:BigInt(c.amount1Min),liquidity:BigInt(c.liquidity),
  deployedValue:BigInt(c.deployedValue),sourceBlock:BigInt(c.sourceBlock),
  sourceHash:c.sourceHash as `0x${string}`,expiresAt:c.expiresAt};
}
function serializeCandidate(c:RangeKeeperCandidate){
 return {kind:c.kind,range:c.range,swap:c.swap?{token:c.swap.token,amountIn:String(c.swap.amountIn),
  quotedOut:String(c.swap.quotedOut),minOut:String(c.swap.minOut),priceAfter:String(c.swap.priceAfter),
  feeValue:String(c.swap.feeValue),shortfallValue:String(c.swap.shortfallValue)}:null,
  amount0Desired:String(c.amount0Desired),amount1Desired:String(c.amount1Desired),
  amount0Min:String(c.amount0Min),amount1Min:String(c.amount1Min),liquidity:String(c.liquidity),
  deployedValue:String(c.deployedValue),sourceBlock:String(c.sourceBlock),sourceHash:c.sourceHash,
  expiresAt:c.expiresAt};
}
const unavailable=(draft:RangeKeeperPaperDraft,reason:string):RangeKeeperPaperConfirmationUnavailable=>
 ({status:'unavailable',reason,campaignId:draft.id,revision:draft.revision,actionAvailable:false});

function usableFrame(frame:PaperOpenFrame,now:number){
 return sourceSchema.safeParse(frame.source).success&&frame.referenceEligible&&frame.sqrtPriceX96>0n&&
  frame.poolLiquidity>=0n&&frame.price0!==null&&frame.price0>0n&&frame.price1!==null&&frame.price1>0n&&
  frame.nativePrice!==null&&frame.nativePrice>0n&&!!frame.referenceProof&&
  referenceProofHash(frame.referenceProof)===frame.referenceProofHash&&
  now>=frame.source.timestamp*1000&&now-frame.source.timestamp*1000<=180_000;
}

function initialState(open:RangeKeeperPaperOpenModel,first:RangeKeeperCandidate):RangeKeeperState{
 return {schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',
  configHash:`0x${open.kernelPolicyHash}` as `0x${string}`,buildId:open.kernelBuildId!,
  lastEligible:{block:BigInt(open.source.block),hash:open.source.hash as `0x${string}`,
   timestamp:open.source.timestamp},exit:null,
  confirmation:{candidate:first,firstBlock:BigInt(open.source.block),
   firstHash:open.source.hash as `0x${string}`,firstAt:open.source.timestamp}};
}

function serializedState(state:RangeKeeperState){
 return JSON.parse(JSON.stringify(state,(_key,value)=>typeof value==='bigint'?String(value):value));
}

/** Replays the first saved candidate at the second canonical observation. The
 * probe phase exposes only an un-actionable candidate so exact-source gas
 * evidence can be sampled and registered before envelope creation. */
export async function buildRangeKeeperPaperConfirmation(input:{draft:RangeKeeperPaperDraft;
 firstModel:RangeKeeperPaperOpenModel;frame:PaperOpenFrame;buildId:string;client:RobinhoodClient;
 readGasProfiles:RangeKeeperPaperGasProfileReader;marketGasPriceWei:bigint|null;
 marketGasPriceObservedAt:number|null;
 simulate:(candidate:RangeKeeperCandidate)=>Promise<RangeKeeperPaperConfirmationSimulation>;
 probeOnly?:boolean;now?:number}):Promise<RangeKeeperPaperConfirmationResult>{
 const {draft,firstModel:open,frame}=input,now=input.now??Date.now();
 const firstModelHash=contentHash(open),firstCandidateHash=open.candidateHash??'';
 let first:RangeKeeperCandidate;
 try{first=deserializeCandidate(open.candidate);}catch{return unavailable(draft,'rangekeeper_first_candidate_invalid');}
 if(open.status!=='indicative'||open.actionAvailable!==false||open.campaignId!==draft.id||
  open.revision!==draft.revision||open.strategyId!=='rangekeeper_v1'||open.strategyVersion!=='1.0.0'||
  open.draftConfigHash!==draft.configHash||open.profileHash!==draft.profileHash||
  open.decision?.kernelAction!=='confirm'||open.decision.requiresSecondObservation!==true||
  !open.kernelPolicyHash||!open.kernelBuildId||!firstCandidateHash||
  contentHash(draft.profile)!==draft.profileHash||
  first.sourceBlock!==BigInt(open.source.block)||first.sourceHash.toLowerCase()!==open.source.hash.toLowerCase()||
  first.expiresAt!==open.source.timestamp+90)
  return unavailable(draft,'rangekeeper_first_confirmation_identity_invalid');
 if(!usableFrame(frame,now)||BigInt(frame.source.block)<=BigInt(open.source.block)||
  frame.source.timestamp<=open.source.timestamp||frame.source.timestamp-open.source.timestamp>
   Number((draft.parameters as {limits?:{maxObservationGapSeconds?:number}}).limits?.maxObservationGapSeconds??0)||
  frame.source.timestamp>first.expiresAt)
  return unavailable(draft,'rangekeeper_confirmation_source_or_gap_invalid');
 const policy=resolveRangeKeeperPaperPolicy(draft,input.buildId);
 if(!policy.policy||policy.unavailable.length||policy.policy.policyHash!==open.kernelPolicyHash||
  policy.policy.buildId!==open.kernelBuildId)
  return unavailable(draft,policy.unavailable.join(',')||'rangekeeper_confirmation_policy_mismatch');
 const p=draft.profile.pool,limits=policy.policy.limits,chain=new RangeKeeperChain(input.client,p),
  quote=(token:0|1,amount:bigint)=>chain.quote({block:BigInt(frame.source.block),
   hash:frame.source.hash as `0x${string}`,timestamp:frame.source.timestamp},token,amount,
   frame.price0!,frame.price1!),
  strategyValue=BigInt(open.allocation.strategyInventoryValue??'0'),
  wallet0=BigInt(draft.allocation.token0Raw),wallet1=BigInt(draft.allocation.token1Raw),
  nativeWei=BigInt(draft.allocation.nativeWei);
 if(!open.costs||open.costs.status!=='provisional'||
  input.marketGasPriceWei===null||input.marketGasPriceWei<=0n||
  input.marketGasPriceObservedAt===null||now<input.marketGasPriceObservedAt||
  now-input.marketGasPriceObservedAt>30_000)
  return unavailable(draft,'rangekeeper_confirmation_cost_evidence_unavailable');
 const firstDenominator=BigInt(open.poolState.poolLiquidity)+first.liquidity;
 if(firstDenominator<=0n)return unavailable(draft,'rangekeeper_first_liquidity_share_unavailable');
 const firstScope:RangeKeeperPaperCandidateScope={poolAddress:p.pool,profileHash:draft.profileHash,
  candidateHash:firstCandidateHash,deployedValue:first.deployedValue,
  sharePpm:first.liquidity*PPM/firstDenominator,range:first.range,
  swapKind:first.swap?'direct_pool_exact_input':'none'},firstPath=rangeKeeperPaperPathVersion(first),
  firstBand=rangeKeeperPaperSizeBand(firstPath,firstScope),firstGasAt=Date.parse(open.costs.gasPriceObservedAt);
 if(open.costs.sizeBand!==firstBand||!Number.isFinite(firstGasAt)||
  BigInt(open.costs.marketGasPriceWei)<=0n||BigInt(open.reference.nativePrice??'0')<=0n)
  return unavailable(draft,'rangekeeper_first_cost_scope_invalid');
 let firstRows:readonly PaperGasProfileRow[];
 try{firstRows=await input.readGasProfiles({poolAddress:p.pool,pathVersion:firstPath,sizeBand:firstBand});}
 catch{return unavailable(draft,'rangekeeper_first_gas_profile_lookup_unavailable');}
 const firstSelected=selectRangeKeeperPaperCostProfiles({candidate:first,scope:firstScope,
  source:open.source,rows:firstRows,now});
 if(firstSelected.status!=='available')return unavailable(draft,
  `rangekeeper_first_${firstSelected.reason}:${firstSelected.missingStages.join(',')}`);
 let firstCosts:RangeKeeperPaperModeledCosts;
 try{firstCosts=modelRangeKeeperPaperCosts({profiles:firstSelected,limits,
  nativePrice:BigInt(open.reference.nativePrice!),marketGasPriceWei:BigInt(open.costs.marketGasPriceWei),
  swapFeeAndShortfallValue:first.swap?first.swap.feeValue+first.swap.shortfallValue:0n,now:firstGasAt});}
 catch{return unavailable(draft,'rangekeeper_first_cost_replay_invalid');}
 if(contentHash(firstCosts)!==contentHash(open.costs))
  return unavailable(draft,'rangekeeper_first_cost_evidence_changed');
 const observation={block:BigInt(frame.source.block),hash:frame.source.hash as `0x${string}`,
  timestamp:frame.source.timestamp,tick:frame.tick,sqrtPriceX96:frame.sqrtPriceX96,
  continuity:'canonical' as const,wallet0,wallet1,released0:0n,released1:0n,nativeWei,
  requiredExitReserveWei:limits.exitReserveWei,price0:frame.price0,price1:frame.price1,
  nativePrice:frame.nativePrice,position:null,pending:false,entryAllowed:true,safeExitRequired:false,executionReady:true,
  liquiditySharePpm:0,actionCost:limits.maxActionCost,actionGasWei:0n,reservedCost:0n,
  rollingSpentCost:0n,campaignSpentCost:0n,campaignStartValue:strategyValue,
  highWaterValue:strategyValue,recenters:0};
 const probe=await planRangeKeeper({state:initialState(open,first),observation,limits,
  spacing:p.tickSpacing,decimals0:p.decimals0,decimals1:p.decimals1,quoteToken:p.quoteToken,
  maxPoolDeviationPpm:draft.profile.referencePolicy.maxPoolDeviationPpm,quote,simulate:async()=>true});
 if(probe.action!=='execute'||!probe.candidate||probe.reason!=='two_confirmations')
  return unavailable(draft,`rangekeeper_second_observation_${probe.reason}`);
 const candidate=probe.candidate,candidateHash=rangeKeeperPaperCandidateHash({campaignId:draft.id,
  revision:draft.revision,profileHash:draft.profileHash,configHash:draft.configHash,source:frame.source,
  referenceProofHash:frame.referenceProofHash,candidate}),denominator=frame.poolLiquidity+candidate.liquidity;
 if(denominator<=0n)return unavailable(draft,'rangekeeper_confirmation_liquidity_share_unavailable');
 const share=candidate.liquidity*PPM/denominator;
 const scope:RangeKeeperPaperCandidateScope={poolAddress:p.pool,profileHash:draft.profileHash,
  candidateHash,deployedValue:candidate.deployedValue,sharePpm:share,range:candidate.range,
  swapKind:candidate.swap?'direct_pool_exact_input':'none'};
 const pathVersion=rangeKeeperPaperPathVersion(candidate),sizeBand=rangeKeeperPaperSizeBand(pathVersion,scope);
 if(input.probeOnly)return {status:'candidate',campaignId:draft.id,revision:draft.revision,
  firstModelHash,firstCandidateHash,source:frame.source,candidate,candidateHash,scope,pathVersion,
  sizeBand,actionAvailable:false};
 if(input.marketGasPriceWei===null||input.marketGasPriceWei<=0n||
  input.marketGasPriceObservedAt===null||now<input.marketGasPriceObservedAt||
  now-input.marketGasPriceObservedAt>30_000)
  return unavailable(draft,'rangekeeper_confirmation_gas_price_unavailable');
 let rows:readonly PaperGasProfileRow[];
 try{rows=await input.readGasProfiles({poolAddress:p.pool,pathVersion,sizeBand});}
 catch{return unavailable(draft,'rangekeeper_confirmation_gas_profile_lookup_unavailable');}
 const selected=selectRangeKeeperPaperCostProfiles({candidate,scope,source:frame.source,rows,now});
 if(selected.status!=='available')return unavailable(draft,
  `${selected.reason}:${selected.missingStages.join(',')}`);
 let costs:RangeKeeperPaperModeledCosts;
 try{costs=modelRangeKeeperPaperCosts({profiles:selected,limits,nativePrice:frame.nativePrice!,
  marketGasPriceWei:input.marketGasPriceWei,swapFeeAndShortfallValue:candidate.swap?
   candidate.swap.feeValue+candidate.swap.shortfallValue:0n,now:input.marketGasPriceObservedAt});}
 catch(error){return unavailable(draft,error instanceof Error?error.message:'rangekeeper_confirmation_cost_model_invalid');}
 const finalObservation={...observation,actionCost:BigInt(costs.open.boundValue),
  actionGasWei:BigInt(costs.open.boundWei),requiredExitReserveWei:BigInt(costs.retainExit.requiredReserveWei),
  liquiditySharePpm:Number(share)};
 let simulation:RangeKeeperPaperConfirmationSimulation|null=null;
 const final=await planRangeKeeper({state:initialState(open,first),observation:finalObservation,limits,
  spacing:p.tickSpacing,decimals0:p.decimals0,decimals1:p.decimals1,quoteToken:p.quoteToken,
  maxPoolDeviationPpm:draft.profile.referencePolicy.maxPoolDeviationPpm,quote,
  simulate:async frozen=>{
   if(rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:draft.revision,
    profileHash:draft.profileHash,configHash:draft.configHash,source:frame.source,
    referenceProofHash:frame.referenceProofHash,candidate:frozen})!==candidateHash)return false;
   try{simulation=await input.simulate(frozen);}catch{return false;}
   return simulation.status==='success'&&simulation.sourceBlock===frame.source.block&&
    simulation.sourceHash.toLowerCase()===frame.source.hash.toLowerCase()&&
    simulation.candidateHash===candidateHash&&/^0x[0-9a-fA-F]{64}$/.test(simulation.simulationHash);
  }});
 if(final.action!=='execute'||final.reason!=='two_confirmations'||!final.candidate||
  rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:draft.revision,
   profileHash:draft.profileHash,configHash:draft.configHash,source:frame.source,
   referenceProofHash:frame.referenceProofHash,candidate:final.candidate})!==candidateHash||!simulation)
  return unavailable(draft,`rangekeeper_confirmation_cost_or_simulation_gate:${final.reason}`);
 const replay=replayPaperMint(frame.sqrtPriceX96,candidate.range,candidate.amount0Desired,
  candidate.amount1Desired,0n);
 let afterSwap0=wallet0,afterSwap1=wallet1;
 if(candidate.swap){if(candidate.swap.token===0){afterSwap0-=candidate.swap.amountIn;afterSwap1+=candidate.swap.quotedOut;}
  else{afterSwap1-=candidate.swap.amountIn;afterSwap0+=candidate.swap.quotedOut;}}
 const idle0=afterSwap0-replay.amount0,idle1=afterSwap1-replay.amount1;
 if(idle0<0n||idle1<0n)return unavailable(draft,'rangekeeper_confirmation_idle_inventory_invalid');
 const body={schemaVersion:1 as const,kind:'rangekeeper_paper_open_confirmation_v1' as const,
  status:'confirmed' as const,campaignId:draft.id,revision:draft.revision,
  draftConfigHash:draft.configHash,profileHash:draft.profileHash,
  firstObservation:{source:open.source,modelHash:firstModelHash,candidateHash:firstCandidateHash},
  confirmationObservation:{source:frame.source,candidateHash,candidate:serializeCandidate(candidate),
   poolState:{tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),poolLiquidity:String(frame.poolLiquidity)},
   reference:{price0:String(frame.price0),price1:String(frame.price1),nativePrice:String(frame.nativePrice),
    proofHash:frame.referenceProofHash,proof:frame.referenceProof!}},
  decision:{action:'execute' as const,reason:'two_confirmations' as const,
   gasSequenceHash:selected.simulationHash,simulation},
  costs,strategyState:serializedState(final.state),
  inventory:{position:{tickLower:candidate.range.tickLower,tickUpper:candidate.range.tickUpper,
   liquidity:String(candidate.liquidity)},idle:{token0:String(idle0),token1:String(idle1)}},
  selectedGasProfileIds:costs.profileIds.map(row=>row.id),
  executionEvidence:'caller_supplied_simulation_attestation_unverified' as const,
  openingBooked:false as const,actionAvailable:false as const};
 return {...body,envelopeHash:contentHash(body)};
}
