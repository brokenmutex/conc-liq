import assert from 'node:assert/strict';
import type {Address} from 'viem';
import type {RangeKeeperCandidate,RangeKeeperLimits} from './domain.js';

const WAD=10n**18n;
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
const AAPL_POOL='0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D';

/** Upper gas-unit allowances from the 68,644,757 AAPL/USDG fork lifecycle.
 * These are admission envelopes, not canonical live costs. Every submitted
 * stage still needs a fresh exact-call estimate inside its individual bound. */
export const rangeKeeperForkGasUnits={
 approval:80_000n,swap:240_000n,mint:650_000n,
 withdrawCollect:300_000n,cleanupApproval:70_000n,
} as const;

export interface RangeKeeperCostEnvelope {
 source:'aapl_usdg_pinned_fork_68644757';
 maxFeePerGasWei:bigint;priorityFeePerGasWei:0n;
 actionGasUnits:bigint;actionGasWei:bigint;actionCostValue:bigint;
 completeExitGasUnits:bigint;requiredExitReserveWei:bigint;
}

/** Conservative direct-route lifecycle. The two-token approvals and four
 * revocations are budgeted even if an observed allowance lets one be skipped.
 * Swap fee and independent-reference shortfall are charged once. */
export function rangeKeeperCostEnvelope(input:{
 candidate:RangeKeeperCandidate;limits:RangeKeeperLimits;baseFeePerGasWei:bigint;marketGasPriceWei:bigint;
 nativePriceValue:bigint;existingPosition:boolean;poolAddress:Address;
}):RangeKeeperCostEnvelope {
 const {candidate:c,limits:l}=input,u=rangeKeeperForkGasUnits;
 assert.equal(input.poolAddress.toLowerCase(),AAPL_POOL.toLowerCase(),'No fork gas evidence for this pool');
 assert(input.baseFeePerGasWei>0n&&input.marketGasPriceWei>0n&&input.nativePriceValue>0n,
  'Fresh fee and native reference required');
 assert(c.swap===null||c.swap.feeValue>=0n&&c.swap.shortfallValue>=0n);
 // A 25% next-block fee margin. A higher future base fee must stop submission
 // and require a new envelope; the controller must never silently increase it.
 const marketFee=input.marketGasPriceWei>input.baseFeePerGasWei?input.marketGasPriceWei:input.baseFeePerGasWei;
 const fee=ceil(marketFee*5n,4n);
 const actionUnits=(input.existingPosition?u.withdrawCollect:0n)+u.approval*2n+u.mint+
  (c.swap?u.approval+u.swap:0n);
 const exitUnits=u.withdrawCollect+u.approval+u.swap+u.cleanupApproval*4n;
 const actionGasWei=actionUnits*fee;
 const actionCostValue=ceil(actionGasWei*input.nativePriceValue,WAD)+
  (c.swap?c.swap.feeValue+c.swap.shortfallValue:0n);
 const requiredExitReserveWei=exitUnits*fee>l.exitReserveWei?exitUnits*fee:l.exitReserveWei;
 return {source:'aapl_usdg_pinned_fork_68644757',maxFeePerGasWei:fee,priorityFeePerGasWei:0n,
  actionGasUnits:actionUnits,actionGasWei,actionCostValue,completeExitGasUnits:exitUnits,requiredExitReserveWei};
}

/** A stage exceeding its fork-derived bound is unproven and may not sign. */
export function assertRangeKeeperStageGas(kind:'approval'|'swap'|'mint'|'withdrawCollect'|'cleanupApproval',estimatedGas:bigint){
 assert(estimatedGas>0n&&estimatedGas<=rangeKeeperForkGasUnits[kind],`rangekeeper_${kind}_gas_bound`);
}
