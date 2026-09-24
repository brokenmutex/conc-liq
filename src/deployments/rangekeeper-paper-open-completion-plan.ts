import {contentHash} from './contracts.js';
import type {RangeKeeperPaperConfirmedContext} from './rangekeeper-paper-confirmation-context.js';

type Source={block:string;hash:string;timestamp:number};
export interface RangeKeeperPaperOpenCompletionProjection {
 schemaVersion:1;kind:'rangekeeper_paper_open_completion_projection_v1';
 campaignId:string;revision:number;operationId:string;idempotencyKey:string;
 source:Source;envelopeHash:string;candidateHash:string;referenceProofHash:string;
 mark:{classification:'rangekeeper_paper_open_confirmation_v1';inventory:{
  token0Raw:string;token1Raw:string;nativeWei:string;
  position:{tickLower:number;tickUpper:number;liquidity:string};
  idle:{token0:string;token1:string}};economics:null;calibrationProfileIds:string[];
  provenance:{classification:'rangekeeper_paper_open_confirmation_v1';operationId:string;
   envelopeHash:string;candidateHash:string;referenceProofHash:string;source:Source;
   modeledCostsHash:string;paidCostsAvailable:false;actionAvailable:false}};
 ledger:{entryKey:string;kind:'capital_in';tokenAddress:string|null;amountRaw:string;
  valueRaw:string;source:{classification:'rangekeeper_paper_open_confirmation_v1';
   operationId:string;asset:'token0'|'token1'|'native';source:Source;envelopeHash:string;
   referenceProofHash:string;paidCostsAvailable:false}}[];
 campaign:{lifecycle:'active';rangeState:'inside'|'outside'};
 openingBooked:false;bookingAvailable:false;actionAvailable:false;projectionHash:string;
}

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash64=/^[0-9a-f]{64}$/;
const positiveRaw=/^[1-9][0-9]*$/;
const raw=/^(0|[1-9][0-9]*)$/;

/**
 * Creates a deterministic, non-booking projection for a future RangeKeeper
 * open worker. The caller must first obtain this context from the restart-safe
 * loader, which rechecks canonical sources and replays costs and inventory.
 * This function has no persistence or operation-admission authority.
 */
export function planRangeKeeperPaperOpenCompletion(input:{context:RangeKeeperPaperConfirmedContext;
 operationId:string}):RangeKeeperPaperOpenCompletionProjection{
 const {context,operationId}=input;
 if(!uuid.test(operationId)||context.status!=='available'||
  context.evidence.openingBooked!==false||context.evidence.actionAvailable!==false||
  context.envelope.openingBooked!==false||context.envelope.actionAvailable!==false||
  context.envelope.campaignId!==context.campaignId||context.envelope.revision!==context.revision||
  !hash64.test(context.envelope.envelopeHash)||!hash64.test(context.envelope.profileHash)||
  !hash64.test(context.envelope.draftConfigHash)||!hash64.test(context.snapshotHash)||
  context.envelope.executionEvidence!=='source_bound_caller_simulation_evidence_unverified')
  throw new Error('rangekeeper_paper_open_completion_context_unavailable');
 const envelope=context.envelope,source=envelope.confirmationObservation.source,
  candidate=context.candidate,
  proofHash=envelope.confirmationObservation.reference.proofHash;
 if(!hash64.test(proofHash)||String(candidate.sourceBlock)!==source.block||
  candidate.sourceHash.toLowerCase()!==source.hash.toLowerCase()||
  envelope.decision.simulation.sourceBlock!==source.block||
  envelope.decision.simulation.sourceHash.toLowerCase()!==source.hash.toLowerCase()||
  envelope.decision.simulation.candidateHash!==envelope.confirmationObservation.candidateHash||
  !hash64.test(envelope.confirmationObservation.candidateHash)||
  !raw.test(context.draft.allocation.token0Raw)||
  !raw.test(context.draft.allocation.token1Raw)||
  !raw.test(context.draft.allocation.nativeWei)||
  !raw.test(envelope.inventory.idle.token0)||!raw.test(envelope.inventory.idle.token1)||
  !positiveRaw.test(envelope.inventory.position.liquidity))
  throw new Error('rangekeeper_paper_open_completion_identity_invalid');
 if(BigInt(context.draft.allocation.token0Raw)+BigInt(context.draft.allocation.token1Raw)<=0n)
  throw new Error('rangekeeper_paper_open_completion_allocation_empty');
 let available0=BigInt(context.draft.allocation.token0Raw),available1=BigInt(context.draft.allocation.token1Raw);
 if(candidate.swap){
  if(candidate.swap.token===0){available0-=candidate.swap.amountIn;available1+=candidate.swap.quotedOut;}
  else{available1-=candidate.swap.amountIn;available0+=candidate.swap.quotedOut;}
 }
 if(available0-candidate.amount0Desired!==BigInt(context.inventory.idle.token0)||
  available1-candidate.amount1Desired!==BigInt(context.inventory.idle.token1)||
  candidate.range.tickLower!==context.inventory.position.tickLower||
  candidate.range.tickUpper!==context.inventory.position.tickUpper||
  candidate.liquidity!==BigInt(context.inventory.position.liquidity))
  throw new Error('rangekeeper_paper_open_completion_inventory_replay_mismatch');
 const prices=[envelope.confirmationObservation.reference.price0,
  envelope.confirmationObservation.reference.price1,
  envelope.confirmationObservation.reference.nativePrice];
 if(prices.some(price=>!positiveRaw.test(price)))
  throw new Error('rangekeeper_paper_open_completion_reference_invalid');
 const p=context.draft.profile.pool,allocation=context.draft.allocation,
  modeledCostsHash=contentHash(envelope.costs),base={classification:'rangekeeper_paper_open_confirmation_v1' as const,
   operationId,source,envelopeHash:envelope.envelopeHash,referenceProofHash:proofHash,
   paidCostsAvailable:false as const},
  value=(amount:string,price:string,decimals:number)=>
   String(BigInt(amount)*BigInt(price)/10n**BigInt(decimals));
 const assets=[
  {asset:'token0' as const,tokenAddress:p.token0,amount:allocation.token0Raw,
   price:prices[0]!,decimals:p.decimals0},
  {asset:'token1' as const,tokenAddress:p.token1,amount:allocation.token1Raw,
   price:prices[1]!,decimals:p.decimals1},
  {asset:'native' as const,tokenAddress:null,amount:allocation.nativeWei,
   price:prices[2]!,decimals:18},
 ];
 const body={schemaVersion:1 as const,kind:'rangekeeper_paper_open_completion_projection_v1' as const,
  campaignId:context.campaignId,revision:context.revision,operationId,
  idempotencyKey:`rangekeeper_paper_open:${operationId}`,source,
  envelopeHash:envelope.envelopeHash,candidateHash:envelope.confirmationObservation.candidateHash,
  referenceProofHash:proofHash,
  mark:{classification:'rangekeeper_paper_open_confirmation_v1' as const,
   inventory:{token0Raw:allocation.token0Raw,token1Raw:allocation.token1Raw,nativeWei:allocation.nativeWei,
    position:{tickLower:context.inventory.position.tickLower,tickUpper:context.inventory.position.tickUpper,
     liquidity:context.inventory.position.liquidity},
    idle:{token0:context.inventory.idle.token0,token1:context.inventory.idle.token1}},
   economics:null,calibrationProfileIds:[...envelope.selectedGasProfileIds],
   provenance:{...base,candidateHash:envelope.confirmationObservation.candidateHash,
    modeledCostsHash,actionAvailable:false as const}},
  ledger:assets.map(item=>({entryKey:`rangekeeper_paper_open:${operationId}:capital_in:${item.asset}`,
   kind:'capital_in' as const,tokenAddress:item.tokenAddress,amountRaw:item.amount,
   valueRaw:value(item.amount,item.price,item.decimals),source:{...base,asset:item.asset}})),
  campaign:{lifecycle:'active' as const,
   rangeState:candidate.range.tickLower<=envelope.confirmationObservation.poolState.tick&&
    envelope.confirmationObservation.poolState.tick<candidate.range.tickUpper?
    'inside' as const:'outside' as const},
  openingBooked:false as const,bookingAvailable:false as const,actionAvailable:false as const};
 return {...body,projectionHash:contentHash(body)};
}

/** Worker retry contract: same operation must reproduce the exact projection. */
export function assertRangeKeeperPaperOpenCompletionReplay(
 prior:RangeKeeperPaperOpenCompletionProjection,
 replay:RangeKeeperPaperOpenCompletionProjection):void{
 if(prior.operationId!==replay.operationId||prior.idempotencyKey!==replay.idempotencyKey||
  prior.projectionHash!==replay.projectionHash||contentHash(prior)!==contentHash(replay))
  throw new Error('rangekeeper_paper_open_completion_replay_conflict');
}
