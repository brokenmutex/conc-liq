// ALLOWANCE POLICY HELPER for the shared-wallet RangeKeeper owned-fork harnesses.
//
// Every assertion that depends on the product's token approval policy lives in
// this single file. The harness proper (rangekeeper-live-worker-fork.mjs and
// helpers/rangekeeper-live-pool-matrix.mjs) only calls the named functions below
// and never inspects allowances, approve stages or cleanup-proof allowance
// evidence itself.
//
// POLICY "persistent_capped_v1" (src/strategy/rangekeeper/allowance-policy.ts):
//   * an open on a fresh wallet approves, in this order of need, swapToken->PM,
//     acquiredToken->PM and swapToken->router (three approvals), then swaps and
//     mints. A pair that is already non-zero is never approved again while it
//     covers the stage, so a second campaign on a covered pair is swap + mint;
//   * there is NO per-stage zero cleanup: allowances stay non-zero after an open;
//   * a retained close zeroes ONLY pairs that are non-zero, belong to the closing
//     campaign's pool and are used by no other active campaign: beside a same-pool
//     sibling it is withdraw only, beside a USDG-only sibling withdraw + stock->PM
//     zero, as the last user withdraw + one zero per non-zero pair;
//   * invariant after every job: each allowance is zero, or registered token and
//     spender, a pair an active campaign uses, and at most its cap (5x the largest
//     exposure). The caps travel in `allowance_cleanup_json.allowancePolicy.caps`.
//   * approvals may go non-zero -> non-zero without a reset, so every token must
//     accept that: probeNonzeroToNonzeroApprove simulates it with eth_call.
//
// A different approval policy needs changes in THIS FILE ONLY: callers pass
// evidence in and every function returns a plain observation object that is copied
// into the JSON report (`allowanceObservations`).
import assert from 'node:assert/strict';
import {encodeFunctionData,parseAbi} from 'viem';
import {assertAllowancesWithinCaps,RANGEKEEPER_ALLOWANCE_CAP_MULTIPLE} from '../../../src/strategy/rangekeeper/allowance-policy.ts';

export const ALLOWANCE_POLICY='persistent_capped_v1';
export const ALLOWANCE_CAP_MULTIPLE=RANGEKEEPER_ALLOWANCE_CAP_MULTIPLE;
const allowanceAbi=parseAbi(['function allowance(address owner,address spender) view returns (uint256)',
 'function approve(address spender,uint256 amount) returns (bool)']);
const lower=value=>String(value).toLowerCase();
const key=(token,spender)=>`${lower(token)}:${lower(spender)}`;

/** Every token/spender pair whose allowance the wallet could hold. */
export function allowancePairs({profileRows,operatorConfig}){
 const pairs=new Map();
 for(const registered of profileRows)for(const token of [registered.profile.pool.token0,registered.profile.pool.token1])
  for(const spender of [registered.profile.pool.router,registered.profile.pool.positionManager])
   pairs.set(key(token,spender),{token,spender});
 for(const item of operatorConfig.zeroAllowances)pairs.set(key(item.token,item.spender),item);
 return [...pairs.values()];
}

/** Read the canonical allowance of every pair from the owned fork. */
export async function readWalletAllowances({local,wallet,profileRows,operatorConfig}){
 const pairs=allowancePairs({profileRows,operatorConfig});
 return Promise.all(pairs.map(async item=>({token:lower(item.token),spender:lower(item.spender),
  amount:BigInt(await local.readContract({address:item.token,abi:allowanceAbi,functionName:'allowance',args:[wallet,item.spender]}))})));
}
const nonzero=rows=>rows.filter(row=>row.amount!==0n);
const nonzeroKeys=rows=>new Set(nonzero(rows).map(row=>key(row.token,row.spender)));
/** Token/spender pairs a campaign's pool can use. */
export function poolPairKeys(pool){
 const keys=new Set();
 for(const token of [pool.token0,pool.token1])for(const spender of [pool.router,pool.positionManager])keys.add(key(token,spender));
 return keys;
}
const unionKeys=pools=>{const keys=new Set();for(const pool of pools)for(const item of poolPairKeys(pool))keys.add(item);return keys;};
/** A stage plan's approval target, resolved against the pool that planned it. */
const planPair=(plan,pool)=>key(plan.token===0?pool.token0:pool.token1,plan.spender==='router'?pool.router:pool.positionManager);
const observation=(label,rows,extra={})=>({policy:ALLOWANCE_POLICY,label,checkedPairs:rows.length,
 nonzero:nonzero(rows).map(row=>({token:row.token,spender:row.spender,amount:String(row.amount)})),...extra});

/** A freshly funded synthetic wallet starts with no allowance of any kind. */
export async function assertFreshWalletAllowances(ctx){
 const rows=await readWalletAllowances(ctx);
 assert(rows.every(row=>row.amount===0n),'Fresh synthetic wallet already holds an allowance');
 return observation('fresh_wallet',rows);
}

/** Wallet-wide invariant after a confirmed job, read from the canonical chain and checked
 * against the caps in the job's final cleanup proof AND the registered token/spender/used-pair scope. */
async function assertWalletInPolicy(ctx,{label,finalStage,activePools,requireNonzero}){
 const rows=await readWalletAllowances(ctx);
 const cleanup=finalStage?.allowance_cleanup_json;
 assert(cleanup&&cleanup.verified===true,`${label}: final cleanup proof is missing`);
 assert.equal(cleanup.allowancePolicy?.kind,ALLOWANCE_POLICY,`${label}: cleanup proof is not a ${ALLOWANCE_POLICY} proof`);
 const caps=cleanup.allowancePolicy.caps;
 assert(Array.isArray(caps),`${label}: cleanup proof carries no caps`);
 assertAllowancesWithinCaps(rows.map(row=>({token:row.token,spender:row.spender,amount:String(row.amount)})),caps);
 const tokens=new Set(ctx.profileRows.flatMap(row=>[lower(row.profile.pool.token0),lower(row.profile.pool.token1)]));
 const spenders=new Set(ctx.profileRows.flatMap(row=>[lower(row.profile.pool.router),lower(row.profile.pool.positionManager)]));
 const used=unionKeys(activePools),capOf=new Map(caps.map(item=>[key(item.token,item.spender),BigInt(item.cap)]));
 const detail=[];
 for(const row of nonzero(rows)){
  const pair=key(row.token,row.spender);
  assert(tokens.has(row.token),`${label}: allowance on an unregistered token ${pair}`);
  assert(spenders.has(row.spender),`${label}: allowance to an unregistered spender ${pair}`);
  assert(used.has(pair),`${label}: allowance on a pair no active campaign uses ${pair}`);
  const cap=capOf.get(pair);
  assert(cap!==undefined&&row.amount<=cap,`${label}: allowance above its cap ${pair}`);
  detail.push({token:row.token,spender:row.spender,amount:String(row.amount),cap:String(cap),
   capShareBps:Number(row.amount*10_000n/(cap===0n?1n:cap))});
 }
 if(requireNonzero)assert(detail.length>0,`${label}: persistent policy left no allowance after the open`);
 return {rows,observation:{policy:ALLOWANCE_POLICY,label,capMultiple:String(ALLOWANCE_CAP_MULTIPLE),checkedPairs:rows.length,
  nonzero:detail,caps:caps.map(item=>({...item}))}};
}

/** After a confirmed OPEN job: allowances persist, within caps, on pairs active campaigns use. */
export async function assertAllowancePolicyAfterJob(ctx,{label,stages,activePools}){
 assert(stages.length>0,`${label}: no stages`);
 assert(activePools?.length>0,`${label}: the active campaign pools are required`);
 return (await assertWalletInPolicy(ctx,{label,finalStage:stages.at(-1),activePools,requireNonzero:true})).observation;
}

/** After a retained close: whatever remains non-zero is used by a still-active sibling; with no
 * sibling the wallet holds no allowance at all. */
export async function assertAllowancePolicyAfterClose(ctx,{label,retainStages,siblingPools=[]}){
 assert(retainStages.length>0,`${label}: no retained close stages`);
 const {rows,observation:seen}=await assertWalletInPolicy(ctx,{label,finalStage:retainStages.at(-1),activePools:siblingPools,requireNonzero:false});
 if(siblingPools.length===0)assert(rows.every(row=>row.amount===0n),`${label}: the last campaign closed but an allowance remains`);
 return seen;
}

/** Observation only (no assertion): current non-zero allowances, for reports. */
export async function observeAllowances(ctx,label){
 return observation(label,await readWalletAllowances(ctx));
}

/** Non-zero pairs on chain right now, as a set of `token:spender` keys. */
export async function readNonzeroAllowanceKeys(ctx){return nonzeroKeys(await readWalletAllowances(ctx));}

/** The OPEN stage sequence of one or more jobs run back to back, in execution order. A job approves only the
 * pairs it needs that are not yet non-zero, never zeroes anything, and ends with its mint. Returns the
 * approval counts per job for the report. `jobs` carry {label,stages,pool,candidate} ordered by first stage. */
export function assertOpenApprovalShapes(jobs,{decode,initialNonzero}){
 const live=new Set(initialNonzero);const out=[];
 for(const job of jobs){
  const {label,pool,candidate}=job,plans=job.stages.map(row=>decode(row.plan_json));
  const kinds=plans.map(plan=>plan.kind),approves=plans.filter(plan=>plan.kind==='approve');
  assert(!approves.some(plan=>plan.amount===0n),`${label}: an open stage zeroed an allowance (${kinds.join(',')})`);
  assert.equal(kinds.at(-1),'mint',`${label}: an open must end with its mint, with no cleanup stage (${kinds.join(',')})`);
  const needed=[];
  if(candidate.swap){const acquired=candidate.swap.token===0?1:0;
   needed.push([candidate.swap.token,'positionManager'],[acquired,'positionManager'],[candidate.swap.token,'router']);}
  else{if(BigInt(candidate.amount0Desired)>0n)needed.push([0,'positionManager']);if(BigInt(candidate.amount1Desired)>0n)needed.push([1,'positionManager']);}
  const missing=needed.map(([token,spender])=>planPair({token,spender},pool)).filter(pair=>!live.has(pair));
  const approved=approves.map(plan=>planPair(plan,pool));
  assert.equal(approved.length,missing.length,`${label}: expected ${missing.length} approvals for pairs not yet covered, got ${approved.length} (${kinds.join(',')})`);
  assert.deepEqual([...approved].sort(),[...missing].sort(),`${label}: approvals target the wrong pairs`);
  assert.equal(new Set(approved).size,approved.length,`${label}: a pair was approved twice in one open`);
  for(const pair of approved)live.add(pair);
  out.push({label,kinds,approvals:approves.length,expectedApprovals:missing.length,stageCount:kinds.length});
 }
 return out;
}

/** The RETAINED CLOSE stage sequence: a withdraw, then a zero approval for exactly the pairs that are
 * non-zero, belong to the closing pool and are used by no other active campaign. */
export function assertRetainStagePlans(retainStages,{decode,label,nonzeroBefore,closingPool,siblingPools=[]}){
 assert(retainStages.length>=1&&retainStages.every(row=>row.status==='confirmed'),`${label}: retain receipts are incomplete`);
 const plans=retainStages.map(row=>decode(row.plan_json));
 assert.equal(plans[0].kind,'withdraw',`${label}: a retained close starts with the withdraw`);
 const rest=plans.slice(1);
 assert(rest.every(plan=>plan.kind==='approve'&&plan.amount===0n),`${label}: retain operation converted risky tokens or granted an allowance`);
 const owned=poolPairKeys(closingPool),shared=unionKeys(siblingPools);
 const expected=[...nonzeroBefore].filter(pair=>owned.has(pair)&&!shared.has(pair)).sort();
 const zeroed=rest.map(plan=>planPair(plan,closingPool)).sort();
 assert.deepEqual(zeroed,expected,`${label}: zero approvals differ from the non-zero pairs only this campaign used`);
 return {kinds:plans.map(plan=>plan.kind),zeroApprovals:zeroed.length,expectedZeroApprovals:expected.length,siblings:siblingPools.length};
}

/** Approvals may go non-zero -> non-zero without a reset: simulate it for every non-zero pair. */
export async function probeNonzeroToNonzeroApprove(ctx){
 const rows=nonzero(await readWalletAllowances(ctx)),probed=[];
 for(const row of rows){
  const data=encodeFunctionData({abi:allowanceAbi,functionName:'approve',args:[row.spender,row.amount+1n]});
  const result=await ctx.local.call({account:ctx.wallet,to:row.token,data});
  const accepted=result.data===undefined||result.data==='0x'||BigInt(result.data)===1n;
  assert(accepted,`Token ${row.token} refused a non-zero to non-zero approval for ${row.spender}`);
  probed.push({token:row.token,spender:row.spender,from:String(row.amount),to:String(row.amount+1n),accepted:true});
 }
 return {policy:ALLOWANCE_POLICY,probed};
}

/** Classify stages for the report. Economic kinds (swap, mint, withdraw) are policy independent;
 * the approval count is reported next to them. */
export function summarizeStagePolicy(stages,{decode}){
 const kinds=stages.map(row=>decode(row.plan_json).kind);
 return {kinds,approvals:kinds.filter(kind=>kind==='approve').length,economic:kinds.filter(kind=>kind!=='approve')};
}
