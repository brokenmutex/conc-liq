import assert from 'node:assert/strict';
import type {RangeKeeperCandidate,RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import type {RangeKeeperTxPlan} from '../strategy/rangekeeper/calldata.js';
import type {RangeKeeperLiveState,RangeKeeperSnapshot} from '../strategy/rangekeeper/live-domain.js';
import {RangeKeeperExitConversionUnavailableError,RangeKeeperMintUnavailableError,RangeKeeperStaleCandidateError} from '../strategy/rangekeeper/live-stage.js';
import {degradeRangeKeeperConvertExitToRetain,isRangeKeeperAwaitingReplan,isRangeKeeperConvertExit,type RangeKeeperLiveCampaign} from './rangekeeper-live-campaign.js';
import type {LiveWalletSource} from './live-wallet-store.js';

/** Seconds a completed swap may wait for a feasible mint before the campaign exits with the inventory it holds. */
export const RANGEKEEPER_MINT_WAIT_SECONDS=300;
/** Seconds a withdrawn convert exit may wait for its sale to become feasible (pool back inside the reference policy,
 * quote within the shortfall limit, gas within the scoped reserve) before it falls back to a retained close. */
export const RANGEKEEPER_CONVERT_WAIT_SECONDS=900;

const sameSource=(a:{block:string|bigint;hash:string;timestamp:number},b:{block:string|bigint;hash:string;timestamp:number})=>
 String(a.block)===String(b.block)&&a.hash.toLowerCase()===b.hash.toLowerCase()&&a.timestamp===b.timestamp;
const sumCost=(events:RangeKeeperLiveState['costEvents'])=>events.reduce<bigint|null>((sum,e)=>
 sum===null||e.gasValue===null||e.swapFeeValue===null||e.swapShortfallValue===null?null:
 sum+e.gasValue+e.swapFeeValue+e.swapShortfallValue,0n);

/** The router's price check can fail an estimate before anything is signed. It is a recoverable mint timing
 * condition, not an authorization or custody failure. */
export function isRangeKeeperMintPriceSlippage(error:unknown):boolean{
 let current:unknown=error;
 for(let depth=0;depth<6&&current&&typeof current==='object';depth++){
  const e=current as {shortMessage?:unknown;details?:unknown;message?:unknown;cause?:unknown};
  if([e.shortMessage,e.details,e.message].some(value=>typeof value==='string'&&value.toLowerCase().includes('price slippage check')))return true;
  current=e.cause;
 }
 return false;
}
/** Map a pre-signing mint price failure to the typed recoverable error; anything else is returned unchanged. */
export function classifyRangeKeeperStageError(plan:RangeKeeperTxPlan|null|undefined,error:unknown):unknown{
 if(plan?.kind==='mint'&&isRangeKeeperMintPriceSlippage(error))return new RangeKeeperMintUnavailableError('Mint price slipped before signing');
 return error;
}
export type RangeKeeperStageSettlement=
 |{kind:'unsettled'}
 |{kind:'wait';reason:string}
 |{kind:'replan'|'exit';reason:string;state:RangeKeeperLiveState};

/** Map a pre-signing failure of a convert exit's risky-leg stage (router approval or sale) to the typed recoverable error:
 * its simulation, gas bound or shortfall bound failed before anything was signed. Other plans are returned unchanged. */
export function classifyRangeKeeperConvertExitStageError(plan:RangeKeeperTxPlan|null|undefined,error:unknown):unknown{
 if(error instanceof RangeKeeperExitConversionUnavailableError)return error;
 if(plan&&(plan.kind==='swap'||plan.kind==='approve'&&plan.spender==='router'&&plan.amount>0n))
  return new RangeKeeperExitConversionUnavailableError(`Exit ${plan.kind} could not be authorized: ${
   error instanceof Error?error.message:'stage_unavailable'}`.slice(0,240));
 return error;
}
/** Settle a recoverable stage-planning error of a withdrawn convert exit: wait a bounded time for the sale to become
 * feasible, then degrade to a retained close so the campaign lands in a safe terminal path (both tokens stay in the
 * wallet) instead of a permanently blocked job. The withdrawal and any completed receipt are never repeated. */
export function settleRangeKeeperLiveConvertExitError(state:RangeKeeperLiveState,snapshot:RangeKeeperSnapshot,
 waitedSeconds:number,error:unknown):RangeKeeperStageSettlement{
 if(!(error instanceof RangeKeeperExitConversionUnavailableError))return {kind:'unsettled'};
 if(!isRangeKeeperConvertExit(state)||state.activeTokenId!==null)return {kind:'unsettled'};
 if(!(waitedSeconds>=RANGEKEEPER_CONVERT_WAIT_SECONDS))return {kind:'wait',reason:`convert_swap_unavailable_wait: ${error.message}`.slice(0,300)};
 return {kind:'exit',reason:'convert_swap_unavailable_retained',state:degradeRangeKeeperConvertExitToRetain(state,error.message,snapshot)};
}

/** Retained exit for a recenter that can no longer complete. The retired NFT and every completed swap stay
 * recorded; nothing is repeated, converted or approved. Exit costs are scoped to the exit itself. */
export function convertRangeKeeperRecenterToRetainExit(state:RangeKeeperLiveState,reason:string,snapshot?:RangeKeeperSnapshot):RangeKeeperLiveState{
 assert(state.phase==='recenter','Only a recenter in progress can be converted to a retained exit');
 const next=structuredClone(state);
 next.phase='exit';next.desired='stopped';next.exitMode='retain';next.candidate=null;next.swapDone=false;next.swapConfirmedAt=null;
 next.actionStartCostIndex=next.costEvents.length;next.reservedActionCost=0n;
 next.policy.confirmation=null;next.policy.exit=null;next.lastReason=`manager_close_retain:${reason}`;
 if(snapshot)next.last=structuredClone(snapshot);
 return next;
}

/** Settle a recoverable stage-planning error for a recenter in progress, mirroring the proven legacy controller:
 * a stale candidate after the confirmed withdrawal is discarded for re-planning; a post-swap mint that stays
 * infeasible waits a bounded time and then exits retained. A completed withdrawal or swap is never repeated. */
export function settleRangeKeeperLiveStageError(state:RangeKeeperLiveState,snapshot:RangeKeeperSnapshot,timestamp:number,
 error:unknown):RangeKeeperStageSettlement{
 if(!(error instanceof RangeKeeperStaleCandidateError||error instanceof RangeKeeperMintUnavailableError))return {kind:'unsettled'};
 if(state.phase!=='recenter'||state.desired!=='running')return {kind:'unsettled'};
 if(state.withdrawDone&&!state.swapDone&&state.activeTokenId===null){
  const next=structuredClone(state);
  next.candidate=null;next.policy.confirmation=null;next.policy.exit=null;next.reservedActionCost=0n;
  next.lastReason='stale_recenter_replan';next.last=structuredClone(snapshot);
  return {kind:'replan',reason:next.lastReason,state:next};
 }
 if(error instanceof RangeKeeperMintUnavailableError&&state.swapDone&&state.swapConfirmedAt!==null&&state.candidate){
  const c=state.candidate,inRange=snapshot.tick>=c.range.tickLower&&snapshot.tick<c.range.tickUpper;
  if(inRange&&timestamp-state.swapConfirmedAt<RANGEKEEPER_MINT_WAIT_SECONDS)return {kind:'wait',reason:'repriced_mint_wait'};
  return {kind:'exit',reason:'repriced_mint_exit',state:convertRangeKeeperRecenterToRetainExit(state,'repriced_mint_exit',snapshot)};
 }
 return {kind:'unsettled'};
}

/** Campaign budget that can still fund a discretionary action: null if any receipt cost is unvalued. */
export function rangeKeeperLiveCostSpent(campaign:RangeKeeperLiveCampaign){
 return campaign.state?sumCost(campaign.state.costEvents):null;
}
/** Valued receipts have reached the rolling or campaign cap: no further discretionary action can be authorized, so
 * management ends with a retained exit. Unvalued history is deliberately not an exit trigger by itself. */
export function rangeKeeperLiveCostBudgetExhausted(campaign:RangeKeeperLiveCampaign):boolean{
 const spent=rangeKeeperLiveCostSpent(campaign),l=campaign.config.limits;
 return spent!==null&&(spent>=l.maxRollingCost||spent>=l.maxCampaignCost);
}
/** What remains of the per-action budget for the recenter already in progress. */
export function rangeKeeperLiveRemainingActionBudget(campaign:RangeKeeperLiveCampaign):bigint{
 const state=campaign.state;assert(state,'Campaign runtime state is not initialized');
 const spent=sumCost(state.costEvents.slice(state.actionStartCostIndex));
 if(spent===null)return 0n;
 return campaign.config.limits.maxActionCost>spent?campaign.config.limits.maxActionCost-spent:0n;
}

export interface RangeKeeperLiveReplanInput {
 source:LiveWalletSource;snapshot:RangeKeeperSnapshot;candidate:RangeKeeperCandidate;policy:RangeKeeperState;costs:unknown;
}
/** Install a freshly confirmed and fork-simulated candidate into a recenter whose first one went stale. The
 * withdrawal, retired NFT and action costs already recorded stay; only the discarded proposal is replaced. */
export function deriveRangeKeeperLiveReplanTransition(campaign:RangeKeeperLiveCampaign,input:RangeKeeperLiveReplanInput):RangeKeeperLiveState{
 const state=campaign.state;assert(state,'Campaign runtime state is not initialized');
 assert(isRangeKeeperAwaitingReplan(state),'Only a withdrawn recenter without a candidate can be re-planned');
 const {source,candidate,policy}=input;
 assert(sameSource(source,input.snapshot.source)&&BigInt(source.block)>=state.last.source.block&&source.timestamp>=state.last.source.timestamp,
  'Replan source is not later than the campaign state');
 assert(candidate.sourceBlock===BigInt(source.block)&&candidate.sourceHash.toLowerCase()===source.hash.toLowerCase()&&
  candidate.expiresAt>source.timestamp,'Replan candidate source/expiry mismatch');
 assert(policy.configHash===campaign.configHash&&policy.buildId===state.buildId&&policy.lastEligible&&
  String(policy.lastEligible.block)===source.block&&policy.lastEligible.hash.toLowerCase()===source.hash.toLowerCase()&&
  policy.lastEligible.timestamp===source.timestamp&&policy.confirmation===null,'Replan policy state is not confirmed at the replan source');
 const costs=input.costs as any;
 assert(costs?.status==='estimated'&&costs.provenance==='owned_fork_allocated_lifecycle_v1'&&sameSource(costs.source,source)&&
  typeof costs.actionCostValue==='string'&&/^[1-9][0-9]*$/.test(costs.actionCostValue),'Replan lacks source-bound owned-fork cost evidence');
 const reserved=BigInt(costs.actionCostValue);
 assert(reserved<=rangeKeeperLiveRemainingActionBudget(campaign),'Replan exceeds the remaining per-action cost budget');
 const next=structuredClone(state);
 next.last=structuredClone(input.snapshot);next.policy=structuredClone(policy);
 next.candidate={...structuredClone(candidate),kind:'recenter'};next.swapDone=false;next.swapConfirmedAt=null;
 next.reservedActionCost=reserved;next.lastReason='manager_recenter_replan:two_confirmations';
 return next;
}
