import pg from "pg";
import { SCHEMA_SQL } from "../storage/schema.js";
import type { RiskSnapshot } from "./domain.js";
import { sanitizeRiskError } from "./evaluate.js";

const { Pool } = pg;

export class PostgresRiskStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async startAttempt(): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO risk_snapshot_attempts (status)
       VALUES ('started') RETURNING id`,
    );
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error("PostgreSQL did not return a risk snapshot attempt ID");
    }
    return id;
  }

  public async failAttempt(attemptId: string, error: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE risk_snapshot_attempts
       SET status = 'failed', completed_at = NOW(), error = $2
       WHERE id = $1`,
      [attemptId, sanitizeRiskError(error)],
    );
  }

  public async save(attemptId: string, snapshot: RiskSnapshot): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `INSERT INTO risk_snapshot_runs (
           schema_version, chain_id, block_number, block_hash, block_timestamp,
           observed_at, registry_fetched_at, registry_sha256,
           feed_directory_fetched_at, feed_directory_sha256,
           market_session_fetched_at, market_session_sha256,
           sequencer_status, execution_eligible, reasons, snapshot
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb
         ) RETURNING id`,
        [
          snapshot.schemaVersion,
          snapshot.chainId,
          snapshot.blockNumber,
          snapshot.blockHash,
          snapshot.blockTimestamp,
          snapshot.observedAt,
          snapshot.registry.fetchedAt,
          snapshot.registry.sha256,
          snapshot.feedDirectory.fetchedAt,
          snapshot.feedDirectory.sha256,
          snapshot.marketSession.evidence.fetchedAt,
          snapshot.marketSession.evidence.sha256,
          snapshot.sequencer.status,
          snapshot.executionEligible,
          JSON.stringify(snapshot.reasons),
          JSON.stringify(snapshot),
        ],
      );
      const runId = result.rows[0]?.id;
      if (runId === undefined) {
        throw new Error("PostgreSQL did not return a risk snapshot run ID");
      }
      for (const asset of snapshot.assets) {
        await client.query(
          `INSERT INTO asset_risk_snapshots (
             run_id, symbol, token_address, oracle_address,
             execution_eligible, reasons, snapshot
           ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
          [
            runId,
            asset.registry.symbol,
            asset.registry.address,
            asset.oracle?.feed.address ?? null,
            asset.executionEligible,
            JSON.stringify(asset.reasons),
            JSON.stringify(asset),
          ],
        );
      }
      const updated = await client.query(
        `UPDATE risk_snapshot_attempts
         SET status = 'succeeded', completed_at = NOW(), risk_run_id = $2
         WHERE id = $1 AND status = 'started'`,
        [attemptId, runId],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`Risk snapshot attempt ${attemptId} is not in started state`);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function collectAndSaveRiskSnapshot(input: {
  readonly blockNumber: bigint;
  readonly collect: () => Promise<RiskSnapshot>;
  readonly store: PostgresRiskStore;
}): Promise<RiskSnapshot> {
  const attemptId = await input.store.startAttempt();
  try {
    const snapshot = await input.collect();
    if (snapshot.blockNumber !== input.blockNumber.toString()) {
      throw new Error(
        `Risk snapshot block ${snapshot.blockNumber} does not match ${input.blockNumber}`,
      );
    }
    await input.store.save(attemptId, snapshot);
    return snapshot;
  } catch (error) {
    await input.store.failAttempt(attemptId, error);
    throw error;
  }
}
