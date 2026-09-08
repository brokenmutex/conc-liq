import { z } from "zod";
import { DEFAULT_PAPER_POLICY } from "./engine.js";
const raw = z.string().regex(/^\d+$/).transform(BigInt);
const strategy = z.object({
  mode: z.enum(["guarded", "research"]),
  budgetQuote: raw.refine(n => n > 0n).transform(String),
  halfWidthSpacings: z.number().int().min(1).max(1000),
  maxHoldingSeconds: z.number().int().min(60).max(604800),
  maxSourceAgeSeconds: z.number().int().min(30).max(300),
  maxGapSeconds: z.number().int().min(300).max(1800),
  maxLiquiditySharePpm: z.number().int().min(1).max(10000),
});
const executionPolicySchema = strategy.extend({ executionBasis: z.literal("transaction_simulation") }).strict();
const transactionPolicySchema = strategy.extend({
  executionBasis: z.literal("nitro_fork_v1"),
  feeAccounting: z.literal("initialized_boundaries_v1").optional(),
  lpAllocationPpm: z.number().int().min(100000).max(1000000).optional(),
  inventoryExitPpm: z.number().int().min(100000).max(1000000).optional(),
  reentry: z.object({
    cooldownSeconds: z.number().int().min(600).max(86400),
    previousSessionId: z.string().regex(/^[1-9]\d*$/).optional(),
  }).strict().optional(),
  maxSlippageBps: z.number().int().min(1).max(500),
  transactionTtlSeconds: z.number().int().min(60).max(1800),
  referencePolicy: z.object({
    kind: z.literal("continuous_bounded_v1"),
    maxHeldAgeSeconds: z.number().int().min(86400).max(345600),
    maxDeviationPpm: z.number().int().min(1).max(50000),
    maxGasPriceAgeSeconds: z.number().int().min(300).max(86400),
  }).strict().optional(),
}).strict().refine(p => BigInt(p.budgetQuote) <= 10000000000n, "Paper token budget is capped at 10000 USDG");
const illustrativePolicySchema = strategy.extend({
  entryCostQuote: raw.transform(String), exitCostQuote: raw.transform(String),
  slippageBps: z.number().int().min(0).max(1000),
}).strict().refine(p => BigInt(p.budgetQuote) > BigInt(p.entryCostQuote) + BigInt(p.exitCostQuote) + BigInt(p.budgetQuote) * BigInt(p.slippageBps) / 10000n, "Costs must leave a positive deployable paper balance");
// Reading a saved v1 policy must not change its hash or historical meaning.
export const paperPolicySchema = z.union([transactionPolicySchema, executionPolicySchema, illustrativePolicySchema]);
export function paperPolicy(overrides: unknown = {}) {
  return transactionPolicySchema.parse({ ...DEFAULT_PAPER_POLICY, ...(overrides as object) });
}
