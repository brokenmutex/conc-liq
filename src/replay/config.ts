import { z } from "zod";

const replayEnvironmentSchema = z.object({
  REPLAY_BATCH_SIZE: z.coerce.number().int().positive().max(100_000).default(25_000),
});

export interface ReplayConfig {
  readonly batchSize: number;
}

export function loadReplayConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ReplayConfig {
  const parsed = replayEnvironmentSchema.parse(environment);
  return { batchSize: parsed.REPLAY_BATCH_SIZE };
}
