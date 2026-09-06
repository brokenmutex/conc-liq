import { z } from "zod";
import { DEFAULT_PAPER_POLICY } from "./engine.js";
const raw = z.string().regex(/^\d+$/).transform(BigInt);
export const paperPolicySchema = z.object({
  mode: z.enum(["guarded", "research"]),
  budgetQuote: raw.refine(n => n > 0n).transform(String),
  halfWidthSpacings: z.number().int().min(1).max(1000),
  entryCostQuote: raw.transform(String), exitCostQuote: raw.transform(String),
  slippageBps: z.number().int().min(0).max(1000),
  maxHoldingSeconds: z.number().int().min(60).max(604800),
  maxSourceAgeSeconds: z.number().int().min(30).max(300),
  maxGapSeconds: z.number().int().min(300).max(1800),
  maxLiquiditySharePpm: z.number().int().min(1).max(10000),
}).strict().refine(p => BigInt(p.budgetQuote) > BigInt(p.entryCostQuote) + BigInt(p.exitCostQuote) + BigInt(p.budgetQuote) * BigInt(p.slippageBps) / 10000n, "Costs must leave a positive deployable paper balance");
export function paperPolicy(overrides: unknown = {}) {
  return paperPolicySchema.parse({ ...DEFAULT_PAPER_POLICY, ...(overrides as object) });
}
