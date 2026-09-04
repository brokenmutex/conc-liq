import { z } from "zod";

const booleanFlag = z
  .enum(["0", "1", "false", "true"])
  .default("false")
  .transform((value) => value === "1" || value === "true");

const environmentSchema = z.object({
  STRATEGY_CHECKPOINT_CONCURRENCY: z.coerce.number().int().positive().max(24).default(4),
  STRATEGY_CHECKPOINT_ENABLED: booleanFlag,
});

export interface StrategyCheckpointConfig {
  readonly concurrency: number;
  readonly enabled: boolean;
}

export function loadStrategyCheckpointConfig(
  environment: NodeJS.ProcessEnv = process.env,
): StrategyCheckpointConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    concurrency: parsed.STRATEGY_CHECKPOINT_CONCURRENCY,
    enabled: parsed.STRATEGY_CHECKPOINT_ENABLED,
  };
}
