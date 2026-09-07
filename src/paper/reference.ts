import type { PoolClient } from 'pg';
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

export async function readPaperReferenceGate(client: Pick<PoolClient,'query'>, cp: PaperCheckpoint, policy: ContinuousPaperReferencePolicy, now: string) {
  const row=(await client.query<{snapshot:RiskSnapshot;canonical:boolean}>(`SELECT r.snapshot,
    (r.chain_id=4663 AND r.block_number=c.block_number AND LOWER(r.block_hash)=LOWER(c.block_hash)
      AND v.canonical IS TRUE AND v.block_number=c.block_number AND LOWER(v.expected_hash)=LOWER(c.block_hash)
      AND LOWER(v.observed_hash)=LOWER(c.block_hash)) AS canonical
    FROM v3_strategy_checkpoint_runs c JOIN risk_snapshot_runs r ON r.id=c.risk_run_id
    LEFT JOIN risk_snapshot_canonicality v ON v.risk_run_id=r.id
    WHERE c.id=$1 AND c.block_number=$2 AND LOWER(c.block_hash)=LOWER($3)`,[cp.id,cp.block,cp.hash])).rows[0];
  if (!row || row.canonical!==true || row.snapshot.blockNumber!==cp.block || row.snapshot.blockHash.toLowerCase()!==cp.hash.toLowerCase())
    return {eligible:false,reasons:['paper_reference_source_unproven'],reference:null};
  const reference=evaluatePaperReference({snapshot:row.snapshot,checkpoint:cp,policy});
  const latest=(await client.query<{status:string;snapshot:RiskSnapshot|null;canonical:boolean;validated_at:Date|null}>(`SELECT a.status,r.snapshot,
    (v.canonical IS TRUE AND v.block_number=r.block_number AND LOWER(v.expected_hash)=LOWER(r.block_hash)
      AND LOWER(v.observed_hash)=LOWER(r.block_hash)) AS canonical,v.validated_at
    FROM risk_snapshot_attempts a LEFT JOIN risk_snapshot_runs r ON r.id=a.risk_run_id
    LEFT JOIN risk_snapshot_canonicality v ON v.risk_run_id=r.id
    ORDER BY a.attempted_at DESC,a.id DESC LIMIT 1`)).rows[0];
  const age=(at:string|Date)=> (Date.parse(now)-new Date(at).getTime())/1000;
  const reasons=[...reference.reasons];
  if (!latest || latest.status!=='succeeded' || !latest.snapshot || latest.canonical!==true || !latest.validated_at ||
    age(latest.validated_at)<0 || age(latest.validated_at)>30 || age(latest.snapshot.observedAt)<0 || age(latest.snapshot.observedAt)>180 ||
    age(latest.snapshot.blockTimestamp)<0 || age(latest.snapshot.blockTimestamp)>180) reasons.push('paper_current_risk_evidence_unavailable');
  else reasons.push(...evaluatePaperReference({snapshot:latest.snapshot,checkpoint:cp,policy}).reasons);
  return {eligible:reasons.length===0,reasons:[...new Set(reasons)],reference};
}
