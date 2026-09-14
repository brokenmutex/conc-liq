import assert from 'node:assert/strict';
import {replayBoundedApprovals, type AllowanceAction} from './live-execution-cost.js';

const MAX = (1n << 256n) - 1n;
export interface PersistentAllowancePolicy {
  caps: Record<string, string>;
  /** Only keys whose deployed token behavior was verified may use this rule. */
  maximumDoesNotDecrease: readonly string[];
  preserveCashExitCleanup: boolean;
}

/** Fixed-trade research counterfactual. Does not authorize or submit transactions. */
export function replayPersistentAllowances(actions: readonly AllowanceAction[], policy: PersistentAllowancePolicy) {
  // Reconcile every original receipt and consumed nonce before using its evidence.
  replayBoundedApprovals(actions);
  const shadow = new Map(Object.entries(actions[0]!.before).map(([k,v])=>[k,BigInt(v)]));
  assert([...shadow.values()].every(v=>v===0n), 'Replay must start without inherited authorization');
  assert.deepEqual(Object.keys(policy.caps).sort(), [...shadow.keys()].sort(), 'Caps must cover exactly the recorded token/spender pairs');
  for (const cap of Object.values(policy.caps)) assert(BigInt(cap)>0n && BigInt(cap)<=MAX);
  for (const key of policy.maximumDoesNotDecrease) assert(shadow.has(key), 'Unknown maximum-allowance behavior');
  const rows: {nonce:number; key:string; kind:'grant'|'revoke'; replacement:string|null; omittedGasQuote:string|null}[]=[];
  const extraRevocations: {afterNonce:number; key:string; amount:string; gasQuote:null}[]=[];
  const spending = new Map([...shadow.keys()].map(k=>[k,0n]));
  for (const action of actions) {
    if (!action.reverted) {
      if (action.approval) {
        const a=action.approval, prior=shadow.get(a.key)!;
        const required=BigInt(a.amount), cap=BigInt(policy.caps[a.key]!);
        let replacement: bigint|null=null;
        if (required===0n) {
          if (policy.preserveCashExitCleanup && prior>0n) replacement=0n;
        } else if (prior<required) {
          assert(cap>=required, 'Persistent cap cannot fund a recorded request');
          replacement=cap;
        }
        if (replacement!==null) shadow.set(a.key,replacement);
        rows.push({nonce:action.nonce,key:a.key,kind:required===0n?'revoke':'grant',replacement:replacement===null?null:String(replacement),omittedGasQuote:replacement===null?action.gasQuote:'0'});
      } else for (const spend of action.spends) {
        const amount=BigInt(spend.amount), prior=shadow.get(spend.key)!;
        assert(amount>=0n && prior>=amount, 'Persistent allowance cannot fund a recorded spend');
        spending.set(spend.key,spending.get(spend.key)!+amount);
        if (!(prior===MAX && policy.maximumDoesNotDecrease.includes(spend.key))) shadow.set(spend.key,prior-amount);
      }
    }
    if (action.clearAtBoundary && policy.preserveCashExitCleanup) {
      for (const [key,amount] of shadow) if (amount>0n) {
        extraRevocations.push({afterNonce:action.nonce,key,amount:String(amount),gasQuote:null});
        shadow.set(key,0n);
      }
    }
  }
  const retained=rows.filter(r=>r.replacement!==null), omitted=rows.filter(r=>r.replacement===null);
  return {policy,rows,originalApprovals:rows.length,grants:retained.filter(r=>r.kind==='grant').length,
    retainedRevocations:retained.filter(r=>r.kind==='revoke').length,extraRevocations,
    totalApprovalTransactions:retained.length+extraRevocations.length,omittedOriginalTransactions:omitted.length,
    omittedRecordedGasQuote:omitted.every(r=>r.omittedGasQuote!==null)?String(omitted.reduce((n,r)=>n+BigInt(r.omittedGasQuote!),0n)):null,
    cumulativeSpend:Object.fromEntries([...spending].map(([k,v])=>[k,String(v)])),
    endingAllowances:Object.fromEntries([...shadow].map(([k,v])=>[k,String(v)])),
    netGasSavingQuote:null,executionEligible:false as const};
}
