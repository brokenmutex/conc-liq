import {contentHash} from './contracts.js';
import {rawValue} from '../strategy/rangekeeper/planner.js';
import {replayPaperMint} from '../v3/position-math.js';
import type {RangeKeeperPaperConfirmedContext} from './rangekeeper-paper-confirmation-context.js';
import type {RangeKeeperPaperConfirmationEnvelope} from './rangekeeper-paper-confirmation.js';
import type {RangeKeeperPaperOpenModel} from './rangekeeper-paper-open-model.js';
import type {RangeKeeperPaperConfirmationReplayResult} from './rangekeeper-paper-confirmation-replay-verifier.js';
import {rangeKeeperPaperCandidateHash} from './rangekeeper-paper-cost.js';
import {parseRangeKeeperPaperCandidate} from './rangekeeper-paper-persistence.js';

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

export interface RangeKeeperPaperConfirmedOpenRecord {
 schemaVersion:1;kind:'rangekeeper_paper_confirmed_open_v1';status:'booked';
 campaignId:string;revision:number;previewId:string;operationId:string;
 firstModelHash:string;firstCandidateHash:string;confirmationEnvelopeHash:string;
 modelHash:string;model:RangeKeeperPaperOpenModel;
 simulationProvenance:'source_bound_owned_fork_replay_matched';
 replay:{kind:'rangekeeper_paper_operation_fork_replay_v1';operationId:string;
  openPreviewId:string;operationSnapshotHash:string;envelopeHash:string;candidateHash:string;
  simulationHash:string;replayHash:string};
 bookingClass:'provisional_mark_and_capital_ledger';openingBooked:true;actionAvailable:false;
}

/** Prepares the JSON provenance value written atomically with the first
 * RangeKeeper open mark. Only the completion transaction should call this. */
export function createRangeKeeperPaperConfirmedOpenRecord(input:{
 adapter:RangeKeeperPaperConfirmedOpenAdapterResult;previewId:string;operationId:string;
 replay:RangeKeeperPaperConfirmationReplayResult;
}):RangeKeeperPaperConfirmedOpenRecord{
 const {adapter,previewId,operationId,replay}=input,lineage=adapter.lineage;
 if(adapter.bookingAvailable!==false||adapter.actionAvailable!==false||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previewId)||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)||
  replay.status!=='matched'||replay.bookingAvailable!==false||replay.actionAvailable!==false||
  replay.operationId!==operationId||replay.openPreviewId!==previewId||
  replay.campaignId!==lineage.campaignId||replay.revision!==lineage.revision||
  replay.envelopeHash!==lineage.confirmationEnvelopeHash||
  replay.candidateHash!==lineage.confirmationCandidateHash||
  !/^[0-9a-f]{64}$/.test(replay.operationSnapshotHash)||
  !/^0x[0-9a-fA-F]{64}$/.test(replay.simulationHash)||
  !/^[0-9a-f]{64}$/.test(replay.replayHash))
  throw new Error('rangekeeper_paper_confirmed_open_record_invalid');
 return {schemaVersion:1,kind:'rangekeeper_paper_confirmed_open_v1',status:'booked',
  campaignId:lineage.campaignId,revision:lineage.revision,previewId,operationId,
  firstModelHash:lineage.firstModelHash,firstCandidateHash:lineage.firstCandidateHash,
  confirmationEnvelopeHash:lineage.confirmationEnvelopeHash,modelHash:adapter.modelHash,
  model:adapter.model,simulationProvenance:'source_bound_owned_fork_replay_matched',
  replay:{kind:'rangekeeper_paper_operation_fork_replay_v1',operationId,openPreviewId:previewId,
   operationSnapshotHash:replay.operationSnapshotHash,envelopeHash:replay.envelopeHash,
   candidateHash:replay.candidateHash,simulationHash:replay.simulationHash,replayHash:replay.replayHash},
  bookingClass:'provisional_mark_and_capital_ledger',openingBooked:true,actionAvailable:false};
}

/** Validates the append-only open provenance against the immutable first
 * preview and persisted confirmation row. A present but malformed record is
 * an integrity failure; consumers must not fall back to the first model. */
export function validateRangeKeeperPaperConfirmedOpenRecord(value:unknown,expected:{
 campaignId:string;revision:number;previewId:string;operationId:string;
 firstModel:unknown;confirmationEnvelopeHash:string;confirmationEnvelope:unknown;
}):RangeKeeperPaperConfirmedOpenRecord{
 if(!value||typeof value!=='object'||Array.isArray(value))
  throw new Error('rangekeeper_paper_confirmed_open_record_invalid');
 const record=value as Partial<RangeKeeperPaperConfirmedOpenRecord>,first=expected.firstModel as
  {candidateHash?:unknown;source?:unknown;profileHash?:unknown;draftConfigHash?:unknown;
   kernelPolicyHash?:unknown;kernelBuildId?:unknown},envelope=expected.confirmationEnvelope as
   RangeKeeperPaperConfirmationEnvelope|undefined;
 if(record.schemaVersion!==1||record.kind!=='rangekeeper_paper_confirmed_open_v1'||
  record.status!=='booked'||record.campaignId!==expected.campaignId||
  record.revision!==expected.revision||record.previewId!==expected.previewId||
  record.operationId!==expected.operationId||record.firstModelHash!==contentHash(expected.firstModel)||
  record.firstCandidateHash!==first.candidateHash||
  record.confirmationEnvelopeHash!==expected.confirmationEnvelopeHash||
  !/^[0-9a-f]{64}$/.test(record.confirmationEnvelopeHash??'')||
  !envelope||envelope.envelopeHash!==expected.confirmationEnvelopeHash||
  envelope.campaignId!==expected.campaignId||envelope.revision!==expected.revision||
  !record.model||typeof record.model!=='object'||Array.isArray(record.model)||
  record.modelHash!==contentHash(record.model)||!/^[0-9a-f]{64}$/.test(record.modelHash??'')||
  record.simulationProvenance!=='source_bound_owned_fork_replay_matched'||
  !record.replay||record.replay.kind!=='rangekeeper_paper_operation_fork_replay_v1'||
  record.replay.operationId!==expected.operationId||record.replay.openPreviewId!==expected.previewId||
  record.replay.envelopeHash!==expected.confirmationEnvelopeHash||
  record.bookingClass!=='provisional_mark_and_capital_ledger'||record.openingBooked!==true||
  record.actionAvailable!==false)
  throw new Error('rangekeeper_paper_confirmed_open_record_invalid');
 const model=record.model;
 if(!/^[0-9a-f]{64}$/.test(record.replay.operationSnapshotHash)||
  !/^[0-9a-f]{64}$/.test(record.replay.candidateHash)||
  !/^0x[0-9a-fA-F]{64}$/.test(record.replay.simulationHash)||
  !/^[0-9a-f]{64}$/.test(record.replay.replayHash))
  throw new Error('rangekeeper_paper_confirmed_open_record_invalid');
 if(model.kind!=='rangekeeper_paper_open_model'||model.status!=='indicative'||
  model.actionAvailable!==false||model.campaignId!==expected.campaignId||
  model.revision!==expected.revision||model.candidateHash===null||!model.source||!model.candidate||
  model.profileHash!==first.profileHash||model.draftConfigHash!==first.draftConfigHash||
  model.kernelPolicyHash!==first.kernelPolicyHash||model.kernelBuildId!==first.kernelBuildId||
  model.candidate.sourceBlock!==model.source.block||
  model.candidate.sourceHash.toLowerCase()!==model.source.hash.toLowerCase()||
  model.candidateHash!==envelope.confirmationObservation.candidateHash||
  record.replay.candidateHash!==envelope.confirmationObservation.candidateHash||
  record.replay.simulationHash!==envelope.decision.simulation.simulationHash||
  contentHash(model.candidate)!==contentHash(envelope.confirmationObservation.candidate)||
  contentHash(model.source)!==contentHash(envelope.confirmationObservation.source)||
  contentHash(model.poolState)!==contentHash(envelope.confirmationObservation.poolState)||
  contentHash(model.reference)!==contentHash({price0:envelope.confirmationObservation.reference.price0,
   price1:envelope.confirmationObservation.reference.price1,
   nativePrice:envelope.confirmationObservation.reference.nativePrice,eligible:true,
   proofHash:envelope.confirmationObservation.reference.proofHash,
   proof:envelope.confirmationObservation.reference.proof,reasons:[]})||
  contentHash(model.costs)!==contentHash(envelope.costs))
  throw new Error('rangekeeper_paper_confirmed_open_model_invalid');
 let candidate:ReturnType<typeof parseRangeKeeperPaperCandidate>;
 try{candidate=parseRangeKeeperPaperCandidate(model.candidate);}catch{
  throw new Error('rangekeeper_paper_confirmed_open_model_invalid');
 }
 if(model.reference.proofHash!==envelope.confirmationObservation.reference.proofHash||
  rangeKeeperPaperCandidateHash({campaignId:expected.campaignId,revision:expected.revision,
   profileHash:model.profileHash,configHash:model.draftConfigHash,source:model.source,
   referenceProofHash:model.reference.proofHash,candidate})!==model.candidateHash)
  throw new Error('rangekeeper_paper_confirmed_open_model_invalid');
 return record as RangeKeeperPaperConfirmedOpenRecord;
}

export interface RangeKeeperPaperConfirmedOpenInventory {
 classification:'rangekeeper_paper_open_v1';token0Raw:string;token1Raw:string;nativeWei:string;
 position:{tickLower:number;tickUpper:number;liquidity:string;amount0Minted:string;amount1Minted:string};
 idle:{token0:string;token1:string};
}

/** Reconstructs the open-mark inventory from the second-observation model. */
export function buildRangeKeeperPaperConfirmedOpenInventory(input:{model:RangeKeeperPaperOpenModel;
 allocation:{token0Raw:string;token1Raw:string;nativeWei:string};decimals0:number;decimals1:number;
}):RangeKeeperPaperConfirmedOpenInventory{
 const {model,allocation}=input,candidate=model.candidate;
 if(model.kind!=='rangekeeper_paper_open_model'||model.status!=='indicative'||
  model.actionAvailable!==false||!candidate||!model.candidateHash||
  !/^(0|[1-9][0-9]*)$/.test(allocation.token0Raw)||
  !/^(0|[1-9][0-9]*)$/.test(allocation.token1Raw)||
  !/^(0|[1-9][0-9]*)$/.test(allocation.nativeWei))
  throw new Error('rangekeeper_paper_confirmed_open_inventory_invalid');
 if(model.allocation.token0Raw!==allocation.token0Raw||model.allocation.token1Raw!==allocation.token1Raw||
  model.allocation.nativeWei!==allocation.nativeWei)
  throw new Error('rangekeeper_paper_confirmed_open_inventory_identity');
 const minted=replayPaperMint(BigInt(model.poolState.sqrtPriceX96),candidate.range,
  BigInt(candidate.amount0Desired),BigInt(candidate.amount1Desired),0n);
 if(minted.liquidity!==BigInt(candidate.liquidity))
  throw new Error('rangekeeper_paper_confirmed_open_mint_replay_mismatch');
 let available0=BigInt(allocation.token0Raw),available1=BigInt(allocation.token1Raw);
 if(candidate.swap){
  const amount=BigInt(candidate.swap.amountIn),output=BigInt(candidate.swap.quotedOut);
  if(candidate.swap.token===0){available0-=amount;available1+=output;}
  else{available1-=amount;available0+=output;}
 }
 const idle0=available0-minted.amount0,idle1=available1-minted.amount1;
 if(idle0<0n||idle1<0n||BigInt(candidate.liquidity)<=0n)
  throw new Error('rangekeeper_paper_confirmed_open_inventory_negative');
 return {classification:'rangekeeper_paper_open_v1',token0Raw:allocation.token0Raw,
  token1Raw:allocation.token1Raw,nativeWei:allocation.nativeWei,
  position:{tickLower:candidate.range.tickLower,tickUpper:candidate.range.tickUpper,
   liquidity:String(minted.liquidity),amount0Minted:String(minted.amount0),amount1Minted:String(minted.amount1)},
  idle:{token0:String(idle0),token1:String(idle1)}};
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
