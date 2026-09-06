import type {
  CostSample,
  GuardedCostModel,
  GuardedCostModelEvidence,
  GuardedCostModelSource,
} from "./domain.js";

function validateSample(sample: CostSample, name: string): void {
  if (!Number.isSafeInteger(sample.sampleCount) || sample.sampleCount < 0) {
    throw new Error(`${name} sample count is invalid`);
  }
  if ((sample.sampleCount === 0) !== (sample.p90QuoteRaw === null)) {
    throw new Error(`${name} sample count and P90 availability disagree`);
  }
  if (sample.p90QuoteRaw !== null && sample.p90QuoteRaw < 0n) {
    throw new Error(`${name} P90 cost cannot be negative`);
  }
}

export function resolveGuardedCostModel(input: {
  readonly evidence: GuardedCostModelEvidence;
  readonly source: GuardedCostModelSource;
}): GuardedCostModel {
  if (!Number.isSafeInteger(input.source.fee) || input.source.fee <= 0) {
    throw new Error("Cost-model pool fee is invalid");
  }
  for (const [name, sample] of [
    ["initial mint", input.evidence.initialMint],
    ["RWA approval", input.evidence.rwaApproval],
    ["quote approval", input.evidence.quoteApproval],
  ] as const) validateSample(sample, name);
  const reasons: string[] = ["rebalance_execution_path_unset"];
  const warnings: string[] = [];
  const entryComponents = [
    ["initial_mint", input.evidence.initialMint],
    ["rwa_approval", input.evidence.rwaApproval],
    ["quote_approval", input.evidence.quoteApproval],
  ] as const;
  for (const [name, sample] of entryComponents) {
    if (sample.p90QuoteRaw === null) reasons.push(`${name}_cost_unavailable`);
    if (sample.sampleCount > 0 && sample.sampleCount < 3) {
      warnings.push(`${name}_sample_below_three`);
    }
  }
  const entryReady = entryComponents.every(([, sample]) =>
    sample.p90QuoteRaw !== null
  );
  const entryCostQuoteRaw = entryReady
    ? entryComponents.reduce((total, [, sample]) => total + sample.p90QuoteRaw!, 0n)
    : null;
  return {
    computedAt: new Date().toISOString(),
    entryCostQuoteRaw,
    evidence: input.evidence,
    executionEligible: false,
    methodology: "pool_specific_direct_call_p90_v1",
    quoteDecimals: 6,
    reasons: [...new Set(reasons)],
    rebalanceCostQuoteRaw: null,
    exitCostQuoteRaw: null,
    schemaVersion: 1,
    source: input.source,
    status: entryReady ? "entry_measured" : "unavailable",
    warnings: [...new Set(warnings)],
  };
}
