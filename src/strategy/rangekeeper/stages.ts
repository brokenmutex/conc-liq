import assert from 'node:assert/strict';
import type {Hex} from 'viem';

export type RangeKeeperStage='approve'|'withdraw_collect'|'swap'|'mint'|'cleanup';
export interface RangeKeeperStageLedger {
 stage:RangeKeeperStage|null;completedHashes:Hex[];gasSpentWei:bigint;costSpentValue:bigint|null;
 wallet0:bigint;wallet1:bigint;activeTokenId:string|null;haltedReason:string|null;
}
export interface RangeKeeperStageReceipt {
 stage:RangeKeeperStage;hash:Hex;canonical:boolean;status:'success'|'reverted';gasWei:bigint;
 costValue:bigint|null;nextStage:RangeKeeperStage|null;
 walletAfter?:{amount0:bigint;amount1:bigint};activeTokenIdAfter?:string|null;
}

/** Canonical hash is recorded for both outcomes, so repeated reverted receipts
 * cannot charge gas again. Unvalued gas remains unvalued and halts spending. */
export function applyRangeKeeperStageReceipt(ledger:RangeKeeperStageLedger,event:RangeKeeperStageReceipt){
 assert(event.hash.length===66&&event.gasWei>=0n);
 if(ledger.completedHashes.some(hash=>hash.toLowerCase()===event.hash.toLowerCase()))return false;
 assert(event.canonical,'rangekeeper_receipt_noncanonical');
 assert(ledger.stage===event.stage,'rangekeeper_stage_out_of_order');
 assert(event.costValue===null||event.costValue>=0n,'Invalid receipt cost');
 const next=structuredClone(ledger);
 next.completedHashes.push(event.hash);next.gasSpentWei+=event.gasWei;
 next.costSpentValue=next.costSpentValue===null||event.costValue===null?null:next.costSpentValue+event.costValue;
 if(event.status==='reverted')next.haltedReason=`reverted:${event.stage}:${event.hash}`;
 else{
  if(event.walletAfter){assert(event.walletAfter.amount0>=0n&&event.walletAfter.amount1>=0n);next.wallet0=event.walletAfter.amount0;next.wallet1=event.walletAfter.amount1;}
  if(event.activeTokenIdAfter!==undefined)next.activeTokenId=event.activeTokenIdAfter;
  next.stage=event.nextStage;next.haltedReason=next.costSpentValue===null?'receipt_cost_unavailable':null;
 }
 Object.assign(ledger,next);
 return true;
}
