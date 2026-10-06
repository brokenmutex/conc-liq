import assert from 'node:assert/strict';
import type {Address,Hex} from 'viem';
import type {PilotIntent} from '../../live-pilot/journal.js';
import type {RangeKeeperChain} from './chain.js';
import type {RangeKeeperCandidate,RangeKeeperState} from './domain.js';
import type {RangeKeeperTxPlan} from './calldata.js';

export type RangeKeeperSnapshot=Awaited<ReturnType<RangeKeeperChain['snapshot']>>;
export type RangeKeeperPhase='entry'|'holding'|'recenter'|'exit'|'closed'|'halted';
export interface RangeKeeperCostEvent {hash:Hex;block:bigint;timestamp:number;gasWei:bigint;
 gasValue:bigint|null;swapFeeValue:bigint|null;swapShortfallValue:bigint|null}
export interface RangeKeeperLiveState {
 version:1;id:string;operator:Address;configHash:Hex;buildId:string;
 phase:RangeKeeperPhase;desired:'running'|'stopped';haltReason:string|null;
 /** Explicit close mode; absent/null preserves the legacy exit-and-convert policy. */
 exitMode?:'retain'|'convert'|null;
 createdAt:number;expiresAt:number;economicActions:number;recenters:number;
 policy:RangeKeeperState;last:RangeKeeperSnapshot;activeTokenId:bigint|null;
 retiredTokenIds:string[];legacyNftCount:bigint;
 reserve0:bigint;reserve1:bigint;reserveNativeWei:bigint;
 initial0:bigint;initial1:bigint;initialNativeWei:bigint;initialStrategyValue:bigint;
 candidate:RangeKeeperCandidate|null;swapDone:boolean;swapConfirmedAt:number|null;withdrawDone:boolean;
 actionStartCostIndex:number;reservedActionCost:bigint;
 mintRecoveryAttempts:number;
 collectedFee0:bigint;collectedFee1:bigint;gasSpentWei:bigint;
 costEvents:RangeKeeperCostEvent[];highWaterValue:bigint;
 activeSeconds:number;outsideSeconds:number;lastMarkTimestamp:number;
 lastReason:string;closedAt:number|null;
}
/** Live time-in-range accrual, applied by the valuation-mark writer before the state is hashed.
 * Left-Riemann: the elapsed gap since the previous observed snapshot (state.last) is attributed to
 * the state observed AT that previous snapshot, matching src/experiment/portfolio.ts. activeSeconds
 * is in-range time and outsideSeconds is out-of-range time (disjoint). Time with no active
 * liquid position (entry/exit/cash) is not counted. A gap longer than maxGapSeconds (the policy's
 * maxObservationGapSeconds, i.e. worker downtime) is unobserved and not attributed to either bucket.
 * Mutates and returns state; call before advancing state.last/lastMarkTimestamp. */
export function accrueRangeKeeperTimeInRange(state:RangeKeeperLiveState,nextTimestamp:number,maxGapSeconds:number){
 const prev=state.last,gap=nextTimestamp-prev.source.timestamp,p=prev.position;
 if(!Number.isFinite(gap)||gap<=0||gap>maxGapSeconds)return state;
 if(state.activeTokenId===null||!p||p.tokenId!==state.activeTokenId||p.liquidity<=0n)return state;
 if(prev.tick>=p.tickLower&&prev.tick<p.tickUpper)state.activeSeconds+=gap;else state.outsideSeconds+=gap;
 return state;
}
export interface RangeKeeperLiveAction {
 id:string;campaignId:string;intent:PilotIntent;plan:RangeKeeperTxPlan;before:RangeKeeperSnapshot;
 status:'prepared'|'signed'|'confirmed'|'reverted'|'cancelled';raw:Hex|null;hash:Hex|null;
 receipt:unknown|null;createdAt:string;broadcastAt:string|null;error:string|null;
}

const marker='__rangekeeper_bigint_v1__';
export function rangeKeeperJson(value:unknown){return JSON.stringify(value,(_,v)=>typeof v==='bigint'?{[marker]:String(v)}:v);}
export function parseRangeKeeperJson<T>(value:unknown):T{
 return JSON.parse(typeof value==='string'?value:JSON.stringify(value),(_,v)=>{
  if(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===1&&marker in v){
   assert(typeof v[marker]==='string'&&/^-?(0|[1-9][0-9]*)$/.test(v[marker]),'Invalid persisted bigint');
   return BigInt(v[marker]);
  }
  return v;
 }) as T;
}
