import type { RpcHealthEvaluation } from '../rpc-health/domain.js';
import type { PaperCurrentRiskRead } from './reference.js';
import { evaluatePaperCurrentRisk } from './reference.js';

export interface PaperHoldingPolicy {
  kind: 'bounded_infrastructure_v1'; maxLagBlocks: 30; chainPauseSeconds: 60; riskPauseSeconds: 30;
}
export interface PaperHoldingState {
  checkedAt: string;
  lastHealthAt: string | null;
  lastPrivateHead?: string;
  chainSince: string | null;
  riskSince: string | null;
  paused: boolean;
  resumeFromPause: boolean;
  exitReasons: string[];
  reasons: string[];
  healthSampleId: string | null;
  riskEvidence: ReturnType<typeof evaluatePaperCurrentRisk>['evidence'] | null;
  events?: {at:string;reasons:string[]}[];
  lastResume?: {at:string;fromBlock:string;toBlock:string};
  retryRequestedAt?: string;
  retryError?: string;
}
const transientChain = new Set([
  'reference_count_below_quorum', 'reference_hash_quorum_unavailable', 'private_probe_failed',
  'private_reports_syncing', 'private_confirmed_anchor_unavailable', 'private_block_lag_soft',
  'private_time_lag_soft', 'private_latency_soft',
]);
/** Raw incident health is separate from bulk-RPC and entry recovery hysteresis. */
export function holdingChainFault(sample: RpcHealthEvaluation, maxLagBlocks: number) {
  const transient: string[] = [], hard: string[] = [];
  try {
    for (const reason of sample.reasons) {
      if (reason === 'recovery_hysteresis') continue;
      (transientChain.has(reason) ? transient : hard).push(reason);
    }
    if (sample.warnings.some(r => r.startsWith('reference_anchor_disagreed:'))) hard.push('chain_anchor_hash_conflict');
    const hashes = new Set(sample.probes.filter(p => !p.error && !p.anchorError && p.anchorHash)
      .map(p => `${p.anchorBlock}:${p.anchorHash!.toLowerCase()}`));
    // Only compare responses at the same requested height. Different heights
    // cannot establish quorum and are malformed evidence.
    if (hashes.size > 1) hard.push('chain_anchor_hash_conflict_or_height_mismatch');
    if (sample.probes.some(p => p.chainId !== null && p.chainId !== 4663)) hard.push('chain_identity_mismatch');
    if (sample.lagBlocks !== null && BigInt(sample.lagBlocks) > BigInt(maxLagBlocks)) transient.push('private_block_lag_soft');
    if (sample.privateSyncing !== false) transient.push('private_syncing_unproven');
    const anchor = sample.anchorBlock == null ? null : BigInt(sample.anchorBlock);
    const matches = sample.probes.filter(p => anchor !== null && p.chainId === 4663 &&
      p.error === null && p.anchorError === null && p.anchorBlock !== null && BigInt(p.anchorBlock) === anchor &&
      p.anchorHash?.toLowerCase() === sample.anchorHash?.toLowerCase() && p.headBlock !== null &&
      BigInt(p.headBlock) - anchor >= 64n && p.headTimestamp !== null &&
      Math.floor(Date.parse(sample.observedAt)/1000) - Number(p.headTimestamp) >= 0 &&
      Math.floor(Date.parse(sample.observedAt)/1000) - Number(p.headTimestamp) <= 15);
    if (!sample.anchorHash || sample.privateAnchorHash?.toLowerCase() !== sample.anchorHash.toLowerCase() ||
      matches.filter(p => p.role === 'private').length !== 1 ||
      new Set(matches.filter(p => p.role === 'reference').map(p => p.name)).size < 2) transient.push('chain_anchor_quorum_unproven');
  } catch { hard.push('chain_health_evidence_malformed'); }
  return {transient: [...new Set(transient)], hard: [...new Set(hard)]};
}

export function advanceHolding(input: {
  now: string; policy: PaperHoldingPolicy; previous?: PaperHoldingState;
  samples: readonly {id: string; snapshot: RpcHealthEvaluation}[];
  risk: ReturnType<typeof evaluatePaperCurrentRisk> | null;
  riskRead: PaperCurrentRiskRead | null;
}) : PaperHoldingState {
  const {policy, previous, now} = input, time = Date.parse(now);
  const state: PaperHoldingState = {...previous, checkedAt: now, lastHealthAt: previous?.lastHealthAt ?? null,
    chainSince: previous?.chainSince ?? null, riskSince: previous?.riskSince ?? null,
    paused: false, resumeFromPause: previous?.resumeFromPause ?? false,
    exitReasons: [...(previous?.exitReasons ?? [])], reasons: [], healthSampleId: null,
    riskEvidence: input.risk?.evidence ?? null};
  const expireChain = (at: number) => {
    if (state.chainSince && at - Date.parse(state.chainSince) >= policy.chainPauseSeconds*1000)
      state.exitReasons.push('paper_chain_pause_expired');
  };
  const samples = [...input.samples].sort((a,b) => Date.parse(a.snapshot.observedAt)-Date.parse(b.snapshot.observedAt));
  // Inspect every new raw sample, including faults which recovered between ticks.
  for (const {snapshot: sample} of samples) {
    const at = Date.parse(sample.observedAt);
    if (!Number.isFinite(at) || at > time) { state.exitReasons.push('chain_health_clock_invalid'); continue; }
    if (state.lastHealthAt && at <= Date.parse(state.lastHealthAt)) continue;
    // On first use, inspect the interval since the previous accepted observation
    // supplied by the store; don't resurrect incidents from before entry.
    if (previous?.lastHealthAt && at-Date.parse(previous.lastHealthAt)>0 && state.lastHealthAt && at-Date.parse(state.lastHealthAt)>30000)
      state.chainSince ??= new Date(Date.parse(state.lastHealthAt)+30000).toISOString();
    const fault=holdingChainFault(sample,policy.maxLagBlocks);
    state.exitReasons.push(...fault.hard);
    if(sample.privateHead!=null){
      if(state.lastPrivateHead!==undefined && BigInt(sample.privateHead)<BigInt(state.lastPrivateHead)) state.exitReasons.push('chain_head_regressed');
      state.lastPrivateHead=String(sample.privateHead);
    }
    expireChain(at);
    if (fault.transient.length) state.chainSince ??= sample.observedAt;
    else state.chainSince=null;
    state.lastHealthAt=sample.observedAt;
  }
  const latest=samples.at(-1);
  state.healthSampleId=latest?.id ?? null;
  if (!Number.isFinite(time) || (previous && time<Date.parse(previous.checkedAt))) state.exitReasons.push('paper_holding_clock_invalid');
  if (!latest || time-Date.parse(latest.snapshot.observedAt)>30000) {
    state.chainSince ??= latest ? new Date(Date.parse(latest.snapshot.observedAt)+30000).toISOString() : now;
    state.reasons.push('chain_health_latest_stale');
  }
  expireChain(time);
  const latestFault=latest ? holdingChainFault(latest.snapshot,policy.maxLagBlocks) : null;
  if (latestFault) state.reasons.push(...latestFault.transient);
  const chainReady=!!latest && !state.chainSince && !latestFault?.hard.length && latest.snapshot.allowBulk;
  if (!chainReady) state.reasons.push('paper_holding_chain_pause');
  if(input.risk && !input.risk.eligible && input.risk.evidence.failedChecks.length===0) state.exitReasons.push(...input.risk.reasons);
  // A chain pause also stops the existing risk producer. Start its retry budget
  // when RPC is available again, not while bulk reads are prohibited.
  if (input.risk?.eligible) {
    const proofAt=Math.max(Date.parse(input.riskRead?.selected?.validatedAt ?? now),Date.parse(input.riskRead?.selected?.completedAt ?? now));
    if(state.riskSince && proofAt-Date.parse(state.riskSince)>=policy.riskPauseSeconds*1000) state.exitReasons.push('paper_risk_pause_expired');
    state.riskSince=null;delete state.retryRequestedAt;delete state.retryError;
  }
  else if (chainReady) {
    const read=input.riskRead, selected=read?.selected;
    const failed=input.risk?.evidence.failedChecks ?? [];
    const future=[read?.latest?.attemptedAt,selected?.attemptedAt,selected?.completedAt,selected?.validatedAt,
      selected?.snapshot?.observedAt,selected?.snapshot?.blockTimestamp].some(at=>at!=null&&Date.parse(at)>time);
    const hard= future || failed.includes('decision_clock_invalid') ||
      (!!selected?.snapshot && failed.includes('snapshot_identity_unproven')) ||
      (!!selected?.canonicalObservedHash && selected.canonicalObservedHash.toLowerCase()!==selected.blockHash?.toLowerCase());
    if (hard) state.exitReasons.push('paper_current_risk_evidence_invalid');
    else if (input.risk && !failed.length) state.exitReasons.push(...input.risk.reasons);
    else {
      state.riskSince ??= now;
      state.reasons.push('paper_holding_risk_pause');
      if (time-Date.parse(state.riskSince)>=policy.riskPauseSeconds*1000) state.exitReasons.push('paper_risk_pause_expired');
    }
  }
  // Exit intent is latched even when RPC cannot currently execute it.
  state.exitReasons=[...new Set(state.exitReasons)];
  state.paused=!chainReady || (!input.risk?.eligible && !state.exitReasons.length);
  if (state.paused) state.resumeFromPause=true;
  state.reasons=[...new Set([...state.reasons,...state.exitReasons])];
  if(JSON.stringify(previous?.reasons ?? [])!==JSON.stringify(state.reasons))
    state.events=[...(previous?.events ?? []),{at:now,reasons:state.reasons}].slice(-64);
  return state;
}
