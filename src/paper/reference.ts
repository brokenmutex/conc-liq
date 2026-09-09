import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import type { OracleRiskSnapshot, RiskSnapshot } from '../risk/domain.js';
import { evaluateOracleRisk } from '../risk/evaluate.js';
import { regularEquitySession } from '../canary-plan/entry-readiness.js';
import { quoteValue } from '../simulator/math.js';
import { USDG } from '../constants.js';
import { PAPER_NVDA, type PaperCheckpoint } from './engine.js';

export interface ContinuousPaperReferencePolicy {
  kind: 'continuous_bounded_v1';
  maxHeldAgeSeconds: number;
  maxDeviationPpm: number;
  maxGasPriceAgeSeconds: number;
}
export interface PaperReferenceDecision {
  eligible: boolean; reasons: string[];
  basis: 'heartbeat_valid' | 'held_equity_reference' | 'unavailable';
  ageSeconds: number | null; referencePriceX18: string | null;
  poolPriceX18: string; deviationPpm: string | null;
  referenceUpdatedAt: string | null; sourceBlock: string;
  maxAgeSeconds: number; maxDeviationPpm: number;
}

// Require a held quote to have updated during the most recent equity session.
// This allows weekends/holidays without disguising a missed weekday as a closure.
export function latestEquitySessionStart(now: string): number | null {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) return null;
  const today = new Date(at); today.setUTCHours(16, 0, 0, 0);
  for (let back = 0; back < 7; back++) {
    const noon = new Date(today.getTime() - back * 86400000);
    if (regularEquitySession(noon.toISOString()) !== 'regular_session') continue;
    const hour = Number(new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(noon));
    const start = noon.getTime() + (9 - hour) * 3600000 + 30 * 60000;
    if (start <= at) return start;
  }
  return null;
}

export function heartbeatOracle(oracle: OracleRiskSnapshot | null, blockTimestamp: bigint, maxAgeSeconds: number) {
  return oracle ? evaluateOracleRisk({feed:oracle.feed,state:oracle.state,blockTimestamp,
    maxPriceAgeSeconds:maxAgeSeconds}) : null;
}

export function evaluatePaperReference(input: {
  snapshot: RiskSnapshot; checkpoint: PaperCheckpoint; policy: ContinuousPaperReferencePolicy;
}): PaperReferenceDecision {
  const {snapshot,checkpoint:cp,policy} = input;
  const sourceTime = BigInt(Math.floor(Date.parse(snapshot.blockTimestamp) / 1000));
  const asset = snapshot.assets.find(a=>a.registry.symbol==='NVDA' && a.registry.address.toLowerCase()===PAPER_NVDA);
  const poolPrice = quoteValue({amount0:0n,amount1:10n**18n,token0:USDG,token1:PAPER_NVDA,quoteToken:USDG,sqrtPriceX96:BigInt(cp.sqrtPriceX96)}) * 10n**12n;
  const decision: PaperReferenceDecision = {eligible:false,reasons:[],basis:'unavailable',ageSeconds:null,
    referencePriceX18:null,poolPriceX18:String(poolPrice),deviationPpm:null,referenceUpdatedAt:null,
    sourceBlock:snapshot.blockNumber,maxAgeSeconds:policy.maxHeldAgeSeconds,maxDeviationPpm:policy.maxDeviationPpm};
  if (!asset) { decision.reasons.push('paper_nvda_risk_missing'); return decision; }
  if (snapshot.chainId!==4663 || snapshot.marketSession.status!=='open_24_7' || !snapshot.marketSession.executionEligible) decision.reasons.push('paper_token_market_policy_unverified');
  // Only reference-age/quote/absent-sequencer findings are reevaluated here.
  // Pause, issuer, multiplier, registry and other findings retain their effect.
  const replaced=new Set(['sequencer_feed_unavailable','oracle_price_stale','quote_oracle_unavailable']);
  decision.reasons.push(...asset.reasons.filter(r=>!replaced.has(r)));
  if (!asset.onchain || asset.onchain.oraclePaused || !asset.flags.registryActive || !asset.flags.multiplierConsistent || asset.flags.corporateActionPending || !asset.flags.tradingCapabilitiesComplete || !asset.flags.tradingCapabilitiesTradable) decision.reasons.push('paper_token_safety_check_failed');
  const quote=heartbeatOracle(snapshot.quoteOracle,sourceTime,policy.maxGasPriceAgeSeconds);
  const oracle=heartbeatOracle(asset.oracle,sourceTime,86400);
  if (!quote?.executionEligible || !quote.state) decision.reasons.push(...(quote?.reasons??['oracle_missing']).map(r=>`paper_usdg_${r}`));
  if (!oracle?.state) {decision.reasons.push('paper_equity_oracle_missing');return decision;}
  decision.ageSeconds=oracle.priceAgeSeconds;
  decision.referenceUpdatedAt=new Date(Number(oracle.state.updatedAt)*1000).toISOString();
  const structural=oracle.reasons.filter(r=>r!=='oracle_price_stale');
  decision.reasons.push(...structural.map(r=>`paper_equity_${r}`));
  const latestSession=latestEquitySessionStart(snapshot.blockTimestamp);
  const heldAllowed=regularEquitySession(snapshot.blockTimestamp)==='closed' && latestSession!==null &&
    Number(oracle.state.updatedAt)*1000>=latestSession && oracle.priceAgeSeconds!==null &&
    oracle.priceAgeSeconds>=0 && oracle.priceAgeSeconds<=policy.maxHeldAgeSeconds;
  if (oracle.executionEligible) decision.basis='heartbeat_valid';
  else if (!structural.length && heldAllowed) decision.basis='held_equity_reference';
  else decision.reasons.push('paper_equity_reference_age_unacceptable');
  if (quote?.executionEligible && quote.state && structural.length===0 && BigInt(oracle.state.answer)>0n) {
    const reference=BigInt(oracle.state.answer)*10n**BigInt(quote.state.decimals)*10n**18n /
      (BigInt(quote.state.answer)*10n**BigInt(oracle.state.decimals));
    decision.referencePriceX18=String(reference);
    const deviation=(poolPrice-reference)*1000000n/reference;
    decision.deviationPpm=String(deviation);
    if (deviation>BigInt(policy.maxDeviationPpm) || deviation< -BigInt(policy.maxDeviationPpm)) decision.reasons.push('paper_reference_band_exceeded');
  }
  decision.reasons=[...new Set(decision.reasons)];
  decision.eligible=decision.reasons.length===0;
  return decision;
}

export interface PaperRiskAttempt {
  id: string; status: string; attemptedAt: string; completedAt: string | null; riskRunId: string | null;
}
export interface PaperCurrentRiskRead {
  evaluatedAt: string;
  latest: PaperRiskAttempt | null;
  selected: (PaperRiskAttempt & {snapshot: RiskSnapshot | null; canonical: boolean | null;
    validatedAt: string | null; blockNumber: string | null; blockHash: string | null}) | null;
  inFlightStartedAt: string | null;
}

/** Pure evaluation also used by prospective comparisons; never synthesizes historical freshness. */
export function evaluatePaperCurrentRisk(read: PaperCurrentRiskRead, cp: PaperCheckpoint, policy: ContinuousPaperReferencePolicy) {
  const {latest, selected} = read;
  const age = (at: string | null | undefined) => at == null ? NaN : (Date.parse(read.evaluatedAt) - Date.parse(at)) / 1000;
  const within = (at: string | null | undefined, limit: number) => Number.isFinite(age(at)) && age(at) >= 0 && age(at) <= limit;
  const failedChecks: string[] = [];
  const check = (ok: boolean, reason: string) => { if (!ok) failedChecks.push(reason); };
  check(Number.isFinite(Date.parse(read.evaluatedAt)), 'decision_clock_invalid');
  check(latest !== null, 'latest_attempt_missing');
  check(latest?.status === 'succeeded' || latest?.status === 'started', 'latest_attempt_not_success_or_refresh');
  check(within(latest?.attemptedAt, 180), 'latest_attempt_age');
  if (latest?.status === 'started') {
    check(within(read.inFlightStartedAt, 10) && within(latest.attemptedAt, 10), 'refresh_age_over_10_seconds_or_future');
    check(selected !== null && BigInt(selected.id) < BigInt(latest.id), 'refresh_predecessor_missing');
  } else check(selected?.id === latest?.id, 'selected_attempt_not_latest');
  check(selected?.status === 'succeeded', 'selected_attempt_not_succeeded');
  check(within(selected?.attemptedAt, 180) && within(selected?.completedAt, 180), 'selected_attempt_age');
  check(selected?.canonical === true, 'selected_canonicality_unproven');
  check(within(selected?.validatedAt, 30), 'canonical_validation_age');
  check(within(selected?.snapshot?.observedAt, 180), 'snapshot_observation_age');
  check(within(selected?.snapshot?.blockTimestamp, 180), 'snapshot_source_age');
  check(!!selected?.snapshot && selected.snapshot.chainId === 4663 && selected.snapshot.blockNumber === selected.blockNumber &&
    selected.snapshot.blockHash.toLowerCase() === selected.blockHash?.toLowerCase(), 'snapshot_identity_unproven');
  const reference = failedChecks.length === 0 ? evaluatePaperReference({snapshot:selected!.snapshot!,checkpoint:cp,policy}) : null;
  const reasons = failedChecks.length ? ['paper_current_risk_evidence_unavailable'] : reference!.reasons;
  const withoutSnapshot = ({snapshot:_snapshot, ...details}:NonNullable<PaperCurrentRiskRead['selected']>) => details;
  const snapshot = selected?.snapshot;
  const evidence = {version:1 as const, evaluatedAt:read.evaluatedAt, latest, selected:selected ? withoutSnapshot(selected) : null,
    inFlightStartedAt:read.inFlightStartedAt, usingPreviousCompleted:latest?.status === 'started' && failedChecks.length === 0,
    snapshotSha256:snapshot ? createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') : null,
    snapshotObservedAt:snapshot?.observedAt ?? null, snapshotSourceAt:snapshot?.blockTimestamp ?? null,
    limits:{refreshSeconds:10,validationSeconds:30,sourceSeconds:180}, failedChecks, reference};
  return {eligible:reasons.length === 0, reasons, evidence};
}

export async function readPaperReferenceGate(client: Pick<PoolClient,'query'>, cp: PaperCheckpoint, policy: ContinuousPaperReferencePolicy, now: string) {
  // One statement gives selection, canonicality and its clock the same MVCC view.
  // A new failed completion is never skipped in favor of an older successful one.
  const row=(await client.query<PaperCurrentRiskRead & {source:{snapshot:RiskSnapshot;canonical:boolean}|null}>(`
    WITH latest AS (SELECT * FROM risk_snapshot_attempts ORDER BY attempted_at DESC,id DESC LIMIT 1),
    completed AS (SELECT * FROM risk_snapshot_attempts WHERE status <> 'started' ORDER BY attempted_at DESC,id DESC LIMIT 1),
    selected AS (SELECT * FROM latest WHERE status <> 'started' UNION ALL
      SELECT completed.* FROM completed,latest WHERE latest.status='started'),
    source AS (SELECT r.snapshot,
    (r.chain_id=4663 AND r.block_number=c.block_number AND LOWER(r.block_hash)=LOWER(c.block_hash)
      AND v.canonical IS TRUE AND v.block_number=c.block_number AND LOWER(v.expected_hash)=LOWER(c.block_hash)
      AND LOWER(v.observed_hash)=LOWER(c.block_hash)) AS canonical
    FROM v3_strategy_checkpoint_runs c JOIN risk_snapshot_runs r ON r.id=c.risk_run_id
    LEFT JOIN risk_snapshot_canonicality v ON v.risk_run_id=r.id
    WHERE c.id=$1 AND c.block_number=$2 AND LOWER(c.block_hash)=LOWER($3))
    SELECT statement_timestamp()::text AS "evaluatedAt", (SELECT to_jsonb(source) FROM source) AS source,
      (SELECT jsonb_build_object('id',id::text,'status',status,'attemptedAt',attempted_at,'completedAt',completed_at,'riskRunId',risk_run_id::text) FROM latest) AS latest,
      (SELECT jsonb_build_object('id',a.id::text,'status',a.status,'attemptedAt',a.attempted_at,'completedAt',a.completed_at,'riskRunId',a.risk_run_id::text,
        'snapshot',r.snapshot,'blockNumber',r.block_number::text,'blockHash',r.block_hash,'validatedAt',v.validated_at,
        'canonical',r.chain_id=4663 AND v.canonical IS TRUE AND v.block_number=r.block_number AND LOWER(v.expected_hash)=LOWER(r.block_hash) AND LOWER(v.observed_hash)=LOWER(r.block_hash))
       FROM selected a LEFT JOIN risk_snapshot_runs r ON r.id=a.risk_run_id LEFT JOIN risk_snapshot_canonicality v ON v.risk_run_id=r.id) AS selected,
      (SELECT MIN(a.attempted_at)::text FROM risk_snapshot_attempts a,completed c
       WHERE a.status='started' AND (a.attempted_at,a.id)>(c.attempted_at,c.id)) AS "inFlightStartedAt"`,[cp.id,cp.block,cp.hash])).rows[0]!;
  const current = evaluatePaperCurrentRisk(row,cp,policy);
  const source = row.source;
  const sourceProven = !!source && source.canonical === true && source.snapshot.blockNumber === cp.block && source.snapshot.blockHash.toLowerCase() === cp.hash.toLowerCase();
  const reference = sourceProven ? evaluatePaperReference({snapshot:source.snapshot,checkpoint:cp,policy}) : null;
  const reasons = [...(reference?.reasons ?? ['paper_reference_source_unproven']), ...current.reasons];
  const evidence = {requestedAt:now,checkpointId:cp.id,sourceProven,current:current.evidence};
  return {eligible:reasons.length===0,reasons:[...new Set(reasons)],reference,evidence};
}

export type PaperReferenceEvidence = Awaited<ReturnType<typeof readPaperReferenceGate>>['evidence'];

export class PaperReferenceGateError extends Error {
  constructor(readonly gate: Awaited<ReturnType<typeof readPaperReferenceGate>>) {
    super(gate.reasons.join(', '));
    this.name = 'PaperReferenceGateError';
  }
}
