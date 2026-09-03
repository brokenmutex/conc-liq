import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();

const environmentSchema = z.object({
  DASHBOARD_ACTIVITY_BUCKET_BLOCKS: positiveInteger.default(500),
  DASHBOARD_ACTIVITY_WINDOW_BLOCKS: positiveInteger.default(20_000),
  DASHBOARD_HOST: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
  DASHBOARD_PORT: z.coerce.number().int().min(1).max(65_535).default(4_173),
  DASHBOARD_REFRESH_MS: z.coerce.number().int().min(1_000).default(10_000),
  DATABASE_URL: z.string().min(1),
  INDEXER_STREAM_KEY: z.string().min(1).default("robinhood-v3-rwa-usdg-v1"),
});

export interface DashboardConfig {
  readonly activityBucketBlocks: number;
  readonly activityWindowBlocks: number;
  readonly databaseUrl: string;
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly refreshMs: number;
  readonly streamKey: string;
}

export function loadDashboardConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DashboardConfig {
  const parsed = environmentSchema.parse(environment);
  if (
    parsed.DASHBOARD_ACTIVITY_BUCKET_BLOCKS >
    parsed.DASHBOARD_ACTIVITY_WINDOW_BLOCKS
  ) {
    throw new Error(
      "DASHBOARD_ACTIVITY_BUCKET_BLOCKS must not exceed DASHBOARD_ACTIVITY_WINDOW_BLOCKS",
    );
  }
  return {
    activityBucketBlocks: parsed.DASHBOARD_ACTIVITY_BUCKET_BLOCKS,
    activityWindowBlocks: parsed.DASHBOARD_ACTIVITY_WINDOW_BLOCKS,
    databaseUrl: parsed.DATABASE_URL,
    host: parsed.DASHBOARD_HOST,
    port: parsed.DASHBOARD_PORT,
    refreshMs: parsed.DASHBOARD_REFRESH_MS,
    streamKey: parsed.INDEXER_STREAM_KEY,
  };
}
