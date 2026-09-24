import {contentHash} from './contracts.js';
import {rawValue} from '../strategy/rangekeeper/planner.js';
import type {RangeKeeperPaperConfirmedContext} from './rangekeeper-paper-confirmation-context.js';
import type {RangeKeeperPaperOpenModel} from './rangekeeper-paper-open-model.js';

const WAD=10n**18n;

function serializeCandidate(candidate:RangeKeeperPaperConfirmedContext['candidate']){
 return {kind:candidate.kind,range:candidate.range,swap:candidate.swap?{
  token:candidate.swap.token,amountIn:String(candidate.swap.amountIn),
  quotedOut:String(candidate.swap.quotedOut),minOut:String(candidate.swap.minOut),
  priceAfter:String(candidate.swap.priceAfter),feeValue:String(candidate.swap.feeValue),
  shortfallValue:String(candidate.swap.shortfallValue)}:null,
  amount0Desired:String(candidate.amount0Desired),amount1Desired:String(candidate.amount1Desired),
  amount0Min:String(candidate.amount0Min),amount1Min:String(candidate.amount1Min),
  liquidity:String(candidate.liquidity),deployedValue:String(candidate.deployedValue),
  sourceBlock:String(candidate.sourceBlock),sourceHash:candidate.sourceHash,expiresAt:candidate.expiresAt};
}

export interface RangeKeeperPaperConfirmedOpenAdapterResult {
 model:RangeKeeperPaperOpenModel;
 lineage:{kind:'rangekeeper_paper_confirmed_open_lineage_v1';campaignId:string;revision:number;
  firstModelHash:string;firstCandidateHash:string;confirmationEnvelopeHash:string;
  confirmationSource:{block:string;hash:string;timestamp:number};
  confirmationCandidateHash:string;simulationProvenance:'source_bound_caller_evidence_unverified';
  booked:false;actionAvailable:false};
 modelHash:string;bookingAvailable:false;actionAvailable:false;
}

/**
 * Adapts a restart-validated second-observation context to the existing
 * RangeKeeper open-model shape consumed by mark and exit replay. The source,
 * candidate, reference, and costs all come from the confirmation envelope.
 * First-observation preview identity remains in separate lineage metadata.
 * This adapter is read-only and cannot create a booked mark or enable action.
 */
export function adaptRangeKeeperConfirmedOpenContext(
 context:RangeKeeperPaperConfirmedContext):RangeKeeperPaperConfirmedOpenAdapterResult{
 if(context.status!=='available'||context.evidence.openingBooked!==false||
  context.evidence.actionAvailable!==false||context.envelope.openingBooked!==false||
  context.envelope.actionAvailable!==false||context.envelope.campaignId!==context.campaignId||
  context.envelope.revision!==context.revision||context.envelope.executionEvidence!==
   'source_bound_caller_simulation_evidence_unverified')
  throw new Error('rangekeeper_paper_confirmed_open_context_unavailable');
 const envelope=context.envelope,observation=envelope.confirmationObservation,
  reference=observation.reference,candidate=context.candidate,pool=context.draft.profile.pool;
 if(candidate.sourceBlock!==BigInt(observation.source.block)||
  candidate.sourceHash.toLowerCase()!==observation.source.hash.toLowerCase()||
  observation.candidateHash!==envelope.decision.simulation.candidateHash||
  reference.proofHash!==observation.reference.proofHash||
  context.inventory.position.liquidity!==String(candidate.liquidity)||
  context.inventory.position.tickLower!==candidate.range.tickLower||
  context.inventory.position.tickUpper!==candidate.range.tickUpper)
  throw new Error('rangekeeper_paper_confirmed_open_identity_invalid');
 const price0=BigInt(reference.price0),price1=BigInt(reference.price1),nativePrice=BigInt(reference.nativePrice),
  amount0=BigInt(context.draft.allocation.token0Raw),amount1=BigInt(context.draft.allocation.token1Raw),
  native=BigInt(context.draft.allocation.nativeWei),
  token0Value=rawValue(amount0,price0,pool.decimals0),token1Value=rawValue(amount1,price1,pool.decimals1),
  nativeValue=native*nativePrice/WAD,strategyInventoryValue=token0Value+token1Value,
  totalAllocatedValue=strategyInventoryValue+nativeValue,costs=context.costs,
  original=context.openModel;
 const model:RangeKeeperPaperOpenModel={...original,status:'indicative',
  blockingReason:'rangekeeper_two_observation_confirmed_for_paper_open',
  source:observation.source,
  poolState:{tick:observation.poolState.tick,sqrtPriceX96:observation.poolState.sqrtPriceX96,
   poolLiquidity:observation.poolState.poolLiquidity},
  reference:{price0:reference.price0,price1:reference.price1,nativePrice:reference.nativePrice,
   eligible:true,proofHash:reference.proofHash,proof:reference.proof,reasons:[]},
  allocation:{token0Raw:String(amount0),token1Raw:String(amount1),nativeWei:String(native),
   token0Value:String(token0Value),token1Value:String(token1Value),nativeValue:String(nativeValue),
   strategyInventoryValue:String(strategyInventoryValue),totalAllocatedValue:String(totalAllocatedValue)},
  candidate:serializeCandidate(candidate),candidateHash:observation.candidateHash,
  decision:{status:'indicative',reason:'two_confirmations',kernelAction:'execute',
   kernelReason:'two_confirmations',requiresSecondObservation:false,remaining:null},
  costs,actionAvailable:false,
  execution:{...original.execution,classification:'read_only_hypothetical',fillRecorded:false,
   paidCosts:null,modeledOpenCost:costs.open.expectedValue,
   modeledOpenCostBound:costs.open.boundValue,modeledRetainExitCost:costs.retainExit.expectedValue,
   modeledExitReserve:costs.retainExit.requiredReserveWei,feeAccrual:null,netNav:null,
   absolutePnl:null,passiveAlpha:null},
  unavailable:[]};
 const lineage={kind:'rangekeeper_paper_confirmed_open_lineage_v1' as const,
  campaignId:context.campaignId,revision:context.revision,
  firstModelHash:envelope.firstObservation.modelHash,
  firstCandidateHash:envelope.firstObservation.candidateHash,
  confirmationEnvelopeHash:envelope.envelopeHash,confirmationSource:observation.source,
  confirmationCandidateHash:observation.candidateHash,
  simulationProvenance:'source_bound_caller_evidence_unverified' as const,
  booked:false as const,actionAvailable:false as const};
 return {model,lineage,modelHash:contentHash(model),bookingAvailable:false,actionAvailable:false};
}
