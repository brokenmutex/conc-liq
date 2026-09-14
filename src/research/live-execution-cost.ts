import assert from 'node:assert/strict';

/** Research-only policy: approve at most the available managed inventory.
 * This module is not imported by the live controller or signer. */
export function boundedSwapApproval(required: bigint, available: bigint, allowance: bigint): bigint | null {
  assert(required > 0n && available >= required && allowance >= 0n, 'Invalid managed approval budget');
  return allowance >= required ? null : available;
}

export interface AllowanceAction {
  id: string;
  nonce: number;
  reverted: boolean;
  before: Record<string, string>;
  after: Record<string, string>;
  approval?: {key: string; amount: string; managedAvailable: string; swapRouter: boolean};
  spends: {key: string; amount: string}[];
  gasQuote: string | null;
  clearAtBoundary?: boolean;
}

/** Keep the recorded trade amounts and order fixed. This identifies removable
 * approvals, not a replay of market movement after changing execution latency. */
export function replayBoundedApprovals(actions: readonly AllowanceAction[]) {
  assert(actions.length > 0);
  const actual = new Map(Object.entries(actions[0]!.before).map(([k, v]) => [k, BigInt(v)]));
  const shadow = new Map(actual);
  const rows: {id: string; nonce: number; original: string; replacement: string | null;
    previousShadow: string; omittedGasQuote: string | null}[] = [];
  let omittedGas = 0n, complete = true;
  const additionalRevocations: {afterId:string;key:string;amount:string;gasQuote:null}[] = [];
  for (const [i, action] of actions.entries()) {
    assert.equal(action.nonce, actions[0]!.nonce + i, 'Noncontiguous consumed nonces');
    assert.deepEqual(Object.fromEntries(actual), Object.fromEntries(Object.entries(action.before).map(([k,v])=>[k,BigInt(v)])), 'Recorded allowance continuity changed');
    if (!action.reverted) {
      if (action.approval) {
        assert.equal(action.spends.length, 0);
        const a = action.approval, amount = BigInt(a.amount), available = BigInt(a.managedAvailable);
        assert(amount >= 0n && available >= amount, 'Approval exceeds managed inventory');
        const prior = shadow.get(a.key); assert(prior !== undefined, 'Unknown spender');
        const replacement = amount === 0n ? (prior === 0n ? null : 0n) :
          a.swapRouter ? boundedSwapApproval(amount, available, prior) : prior >= amount ? null : amount;
        actual.set(a.key, amount);
        if (replacement !== null) shadow.set(a.key, replacement);
        else if (action.gasQuote === null) complete = false;
        else omittedGas += BigInt(action.gasQuote);
        rows.push({id:action.id,nonce:action.nonce,original:a.amount,replacement:replacement===null?null:String(replacement),
          previousShadow:String(prior),omittedGasQuote:replacement===null?action.gasQuote:'0'});
      } else {
        for (const spend of action.spends) {
          const amount = BigInt(spend.amount); assert(amount >= 0n);
          for (const allowances of [actual, shadow]) {
            const previous = allowances.get(spend.key); assert(previous !== undefined && previous >= amount, 'Trade exceeds allowance');
            allowances.set(spend.key, previous - amount);
          }
        }
      }
    }
    assert.deepEqual(Object.fromEntries(actual),Object.fromEntries(Object.entries(action.after).map(([k,v])=>[k,BigInt(v)])), 'Recorded receipt allowance mismatch');
    if (action.clearAtBoundary) {
      assert([...actual.values()].every(v=>v===0n),'Recorded closed session retained an allowance');
      for (const [key,amount] of shadow) if(amount>0n) {
        additionalRevocations.push({afterId:action.id,key,amount:String(amount),gasQuote:null});shadow.set(key,0n);
      }
    }
  }
  return {rows,originalApprovals:rows.length,retainedApprovals:rows.filter(r=>r.replacement!==null).length,
    omittedApprovals:rows.filter(r=>r.replacement===null).length,
    omittedRecordedGasQuote:complete?String(omittedGas):null,
    additionalRevocations,
    endingAllowances:Object.fromEntries([...shadow].map(([k,v])=>[k,String(v)])),
    executionEligible:false as const,
    limitations:['Recorded token trades and timing are held fixed.',
      'Omitted receipt charges are a diagnostic, not net savings: retained approval storage costs and terminal revocation can change.']};
}

export interface CostedRoute {
  id: string;
  sourceBlock: string;
  sourceHash: string;
  referencePriceX18: string;
  amount0: string;
  amount1: string;
  gasQuote: string | null;
  complete: boolean;
}

/** Value final wallet + minted principal with one independent reference. Never
 * rank gross swap output or compare different chain/reference snapshots. */
export function compareCostedRoutes(baseline: CostedRoute, candidate: CostedRoute) {
  for (const key of ['sourceBlock','referencePriceX18'] as const) assert.equal(candidate[key],baseline[key],'Mismatched valuation source');
  assert.equal(candidate.sourceHash.toLowerCase(),baseline.sourceHash.toLowerCase(),'Mismatched canonical hash');
  assert(BigInt(baseline.referencePriceX18)>0n);
  const value=(r:CostedRoute)=>{
    assert(BigInt(r.amount0)>=0n&&BigInt(r.amount1)>=0n);
    return BigInt(r.amount0)+BigInt(r.amount1)*BigInt(r.referencePriceX18)/10n**30n;
  };
  const grossDelta=value(candidate)-value(baseline);
  if (!baseline.complete || !candidate.complete || baseline.gasQuote===null || candidate.gasQuote===null)
    return {grossDeltaQuote:String(grossDelta),gasDeltaQuote:null,netDeltaQuote:null,preferred:false,executionEligible:false as const};
  assert(BigInt(baseline.gasQuote)>=0n&&BigInt(candidate.gasQuote)>=0n);
  const gasDelta=BigInt(candidate.gasQuote)-BigInt(baseline.gasQuote),net=grossDelta-gasDelta;
  return {grossDeltaQuote:String(grossDelta),gasDeltaQuote:String(gasDelta),netDeltaQuote:String(net),preferred:net>0n,executionEligible:false as const};
}
