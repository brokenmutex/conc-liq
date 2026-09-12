import assert from 'node:assert/strict';
export interface SharePolicy {maxLiquiditySharePpm:number;liquidityShareMode?:'warn_v1'}
export function liquidityShare(ours:bigint,existing:bigint,policy:SharePolicy){
 assert(ours>=0n&&existing>=0n);
 return {mode:policy.liquidityShareMode??'hard_cap',thresholdPpm:policy.maxLiquiditySharePpm,
  ratioToExistingPpm:existing>0n?String(ours*1000000n/existing):null,
  shareAfterDepositPpm:ours+existing>0n?String(ours*1000000n/(ours+existing)):null,
  exceedsThreshold:ours*1000000n>existing*BigInt(policy.maxLiquiditySharePpm)};
}
export function liquidityShareAllowed(ours:bigint,existing:bigint,policy:SharePolicy){return policy.liquidityShareMode==='warn_v1'||!liquidityShare(ours,existing,policy).exceedsThreshold;}
