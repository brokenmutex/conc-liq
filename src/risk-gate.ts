import pg from "pg";
import { z } from "zod";
import { log } from "./logger.js";
import { sanitizeRiskError } from "./risk/evaluate.js";
import {
  DEFAULT_RISK_GATE_MAX_CANONICALITY_AGE_SECONDS,
  DEFAULT_RISK_GATE_MAX_SNAPSHOT_AGE_SECONDS,
  readRiskGate,
} from "./risk/gate.js";

const { Pool } = pg;

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  INDEXER_STREAM_KEY: z.string().min(1).default("robinhood-v3-rwa-usdg-v1"),
  RISK_GATE_MAX_SNAPSHOT_AGE_SECONDS: z.coerce.number().int().positive()
    .default(DEFAULT_RISK_GATE_MAX_SNAPSHOT_AGE_SECONDS),
  RISK_GATE_MAX_CANONICALITY_AGE_SECONDS: z.coerce.number().int().positive()
    .default(DEFAULT_RISK_GATE_MAX_CANONICALITY_AGE_SECONDS),
});

async function main(): Promise<void> {
  const config = environmentSchema.parse(process.env);
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 1,
    options: "-c default_transaction_read_only=on",
  });
  try {
    const decision = await readRiskGate(
      pool,
      config.INDEXER_STREAM_KEY,
      config.RISK_GATE_MAX_SNAPSHOT_AGE_SECONDS,
      config.RISK_GATE_MAX_CANONICALITY_AGE_SECONDS,
    );
    log("info", "risk_gate_evaluated", { decision });
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  log("error", "risk_gate_failed", { error: sanitizeRiskError(error) });
  process.exitCode = 1;
});
