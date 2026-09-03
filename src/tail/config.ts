import { z } from "zod";

const environmentSchema = z.object({
  TAIL_ERROR_DELAY_MS: z.coerce.number().int().positive().default(5_000),
  TAIL_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(5),
  TAIL_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
});

export interface TailConfig {
  readonly errorDelayMs: number;
  readonly maxConsecutiveFailures: number;
  readonly pollIntervalMs: number;
}

export function loadTailConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TailConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    errorDelayMs: parsed.TAIL_ERROR_DELAY_MS,
    maxConsecutiveFailures: parsed.TAIL_MAX_CONSECUTIVE_FAILURES,
    pollIntervalMs: parsed.TAIL_POLL_INTERVAL_MS,
  };
}
