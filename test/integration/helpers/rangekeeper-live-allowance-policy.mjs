// ALLOWANCE POLICY HELPER for the shared-wallet RangeKeeper owned-fork harnesses.
//
// Every assertion that depends on the product's token approval policy lives in
// this single file. The harness proper (rangekeeper-live-worker-fork.mjs and
// rangekeeper-live-pool-matrix.mjs) only calls the named functions below and
// never inspects allowances, approve stages or allowance-cleanup evidence itself.
//
// CURRENT POLICY ("zero_cleanup", the policy deployed at 95f3197):
//   * a stage grants a one-shot allowance sized to the stage's inventory;
//   * every opening/retained-close job ends with explicit zero approvals, so after
//     any confirmed job every allowance of every registered token/spender pair
//     (router, position manager, configured zero-allowance pairs) is exactly 0;
//   * the final stage of a job carries a verified `allowance_cleanup_json` proof;
//   * a retained close only withdraws liquidity (and zeroes allowances) - it never
//     swaps a risky token and never grants a non-zero allowance.
//
// WP-A (persistent capped allowances, no per-stage zero cleanup) must replace the
// bodies of the functions in this file ONLY. Nothing else in the harness needs to
// change: callers pass evidence in, and every function returns a plain
// observation object that is copied into the JSON report ("allowanceObservations").
import assert from 'node:assert/strict';
import {parseAbi} from 'viem';

export const ALLOWANCE_POLICY='zero_cleanup';
const allowanceAbi=parseAbi(['function allowance(address owner,address spender) view returns (uint256)']);

/** Every token/spender pair whose allowance the wallet could hold. */
export function allowancePairs({profileRows,operatorConfig}){
 const pairs=new Map();
 for(const registered of profileRows)for(const token of [registered.profile.pool.token0,registered.profile.pool.token1])
  for(const spender of [registered.profile.pool.router,registered.profile.pool.positionManager])
   pairs.set(`${token.toLowerCase()}:${spender.toLowerCase()}`,{token,spender});
 for(const item of operatorConfig.zeroAllowances)pairs.set(`${item.token.toLowerCase()}:${item.spender.toLowerCase()}`,item);
 return [...pairs.values()];
}

/** Read the canonical allowance of every pair from the owned fork. */
export async function readWalletAllowances({local,wallet,profileRows,operatorConfig}){
 const pairs=allowancePairs({profileRows,operatorConfig});
 return Promise.all(pairs.map(async item=>({token:item.token.toLowerCase(),spender:item.spender.toLowerCase(),
  amount:BigInt(await local.readContract({address:item.token,abi:allowanceAbi,functionName:'allowance',args:[wallet,item.spender]}))})));
}
const nonzero=rows=>rows.filter(row=>row.amount!==0n).map(row=>({token:row.token,spender:row.spender,amount:String(row.amount)}));

/** A freshly funded synthetic wallet starts with no allowance of any kind. */
export async function assertFreshWalletAllowances(ctx){
 const rows=await readWalletAllowances(ctx);
 assert(rows.every(row=>row.amount===0n),'Fresh synthetic wallet already holds an allowance');
 return {policy:ALLOWANCE_POLICY,label:'fresh_wallet',checkedPairs:rows.length,nonzero:[]};
}

/** After a confirmed OPEN job (and, in the two-pool legacy flow, after every job). */
export async function assertAllowancePolicyAfterJob(ctx,{label,stages}){
 const rows=await readWalletAllowances(ctx);
 assert(stages.length>0&&stages.at(-1).allowance_cleanup_json,`${label}: final allowance cleanup proof is missing`);
 assert(rows.every(row=>row.amount===0n),`${label}: a stage allowance survived confirmed cleanup`);
 return {policy:ALLOWANCE_POLICY,label,checkedPairs:rows.length,nonzero:nonzero(rows)};
}

/** After a retained close the cleanup state must hold as well. */
export async function assertAllowancePolicyAfterClose(ctx,{label,retainStages}){
 const rows=await readWalletAllowances(ctx);
 assert(retainStages.length>0&&retainStages.at(-1).allowance_cleanup_json,`${label}: retained close cleanup proof is missing`);
 assert(rows.every(row=>row.amount===0n),`${label}: an allowance survived the retained close`);
 return {policy:ALLOWANCE_POLICY,label,checkedPairs:rows.length,nonzero:nonzero(rows)};
}

/** Observation only (no assertion): current non-zero allowances, for reports. */
export async function observeAllowances(ctx,label){
 const rows=await readWalletAllowances(ctx);
 return {policy:ALLOWANCE_POLICY,label,checkedPairs:rows.length,nonzero:nonzero(rows)};
}

/** A retained close may only withdraw and zero allowances; it must not swap or grant. */
export function assertRetainStagePlans(retainStages,{decode,label}){
 assert(retainStages.length>=1&&retainStages.every(row=>row.status==='confirmed'),`${label}: retain receipts are incomplete`);
 assert(retainStages.every(row=>{const plan=decode(row.plan_json);return plan.kind==='withdraw'||plan.kind==='approve'&&plan.amount===0n;}),
  `${label}: retain operation converted risky tokens or granted an allowance`);
}

/** Classify stages into approval and economic actions for the report. The
 * economic kinds (swap, mint, withdraw) are policy independent; only the
 * `approvals` count is allowance policy and is reported, never asserted. */
export function summarizeStagePolicy(stages,{decode}){
 const kinds=stages.map(row=>decode(row.plan_json).kind);
 return {kinds,approvals:kinds.filter(kind=>kind==='approve').length,
  economic:kinds.filter(kind=>kind!=='approve')};
}
