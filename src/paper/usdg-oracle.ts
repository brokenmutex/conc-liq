import type { OracleRiskSnapshot } from '../risk/domain.js';
import { evaluateOracleRisk } from '../risk/evaluate.js';

export interface PaperUsdgFreshness {
  basis: 'heartbeat_valid' | 'heartbeat_grace' | 'unavailable';
  heartbeatMaxAgeSeconds: number;
  acceptedMaxAgeSeconds: number;
  graceSeconds: number;
  priceAgeSeconds: number | null;
  updatedAt: string | null;
  warnings: string[];
}

export type PaperUsdgOracle = OracleRiskSnapshot & { freshness?: PaperUsdgFreshness };

/** Paper-only grace; preserve the observed feed, round and timestamp verbatim. */
export function evaluatePaperUsdgOracle(
  input: Parameters<typeof evaluateOracleRisk>[0],
  graceSeconds = 0,
): PaperUsdgOracle {
  if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 0 || graceSeconds > 1800) {
    throw new Error('Paper USDG heartbeat grace must be between 0 and 1800 seconds');
  }
  if (input.feed.baseAsset !== 'USDG' || input.feed.quoteAsset !== 'USD') {
    throw new Error('Paper USDG heartbeat grace requires the USDG/USD feed');
  }
  const oracle = evaluateOracleRisk(input);
  // Old policies retain their original behavior and serialized evidence.
  if (graceSeconds === 0) return oracle;
  // A deliberately stricter configured age limit remains strict.
  const effectiveGrace = oracle.maxAgeSeconds === input.feed.heartbeatSeconds ? graceSeconds : 0;
  const acceptedMaxAgeSeconds = oracle.maxAgeSeconds + effectiveGrace;
  const inGrace = oracle.reasons.length === 1 && oracle.reasons[0] === 'oracle_price_stale' &&
    oracle.state !== null && BigInt(oracle.state.updatedAt) > 0n &&
    oracle.priceAgeSeconds !== null && oracle.priceAgeSeconds > oracle.maxAgeSeconds &&
    oracle.priceAgeSeconds <= acceptedMaxAgeSeconds;
  return {
    ...oracle,
    // priceFresh still describes the original heartbeat. Acceptance under grace
    // is explicit and never changes the general risk evaluator's freshness.
    executionEligible: oracle.executionEligible || inGrace,
    reasons: inGrace ? [] : oracle.reasons,
    freshness: {
      basis: inGrace ? 'heartbeat_grace' : oracle.executionEligible ? 'heartbeat_valid' : 'unavailable',
      heartbeatMaxAgeSeconds: oracle.maxAgeSeconds,
      acceptedMaxAgeSeconds,
      graceSeconds: effectiveGrace,
      priceAgeSeconds: oracle.priceAgeSeconds,
      updatedAt: oracle.state?.updatedAt ?? null,
      warnings: inGrace ? ['paper_usdg_heartbeat_grace'] : [],
    },
  };
}
