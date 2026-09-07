import pg from "pg";
import { assertSchemaReady } from "../storage/compatibility.js";
import type { RiskSnapshot } from "./domain.js";
import { sanitizeRiskError } from "./evaluate.js";
import type { RiskBlock } from "./reader.js";

const { Pool } = pg;

interface LatestRiskRunRow {
  block_hash: string;
  block_number: string;
  id: string;
}

export interface RiskCanonicalityValidation {
  readonly blockNumber: string;
  readonly canonical: boolean;
  readonly error: string | null;
  readonly expectedHash: string;
  readonly observedHash: string | null;
  readonly riskRunId: string;
  readonly validatedAt: string;
}

export class PostgresRiskStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 });
  }

  public async assertReady(): Promise<void> {
    await assertSchemaReady(this.pool);
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

  private async validateCanonicalRow(
    row: LatestRiskRunRow,
    readBlock: (blockNumber: bigint) => Promise<RiskBlock>,
  ): Promise<RiskCanonicalityValidation> {
    let canonical = false;
    let observedHash: string | null = null;
    let error: string | null = null;
    try {
      const block = await readBlock(BigInt(row.block_number));
      observedHash = block.hash;
      if (block.number !== BigInt(row.block_number)) {
        error = `RPC returned block ${block.number} for requested ${row.block_number}`;
      } else {
        canonical = observedHash.toLowerCase() === row.block_hash.toLowerCase();
      }
    } catch (caught) {
      error = sanitizeRiskError(caught);
    }

    const saved = await this.pool.query<{ validated_at: Date }>(
      `INSERT INTO risk_snapshot_canonicality (
         risk_run_id, block_number, expected_hash, observed_hash,
         canonical, validated_at, error
       ) VALUES ($1,$2,$3,$4,$5,NOW(),$6)
       ON CONFLICT (risk_run_id) DO UPDATE SET
         block_number = EXCLUDED.block_number,
         expected_hash = EXCLUDED.expected_hash,
         observed_hash = EXCLUDED.observed_hash,
         canonical = EXCLUDED.canonical,
         validated_at = NOW(),
         error = EXCLUDED.error
       RETURNING validated_at`,
      [
        row.id,
        row.block_number,
        row.block_hash,
        observedHash,
        canonical,
        error,
      ],
    );
    const validatedAt = saved.rows[0]?.validated_at;
    if (validatedAt === undefined) {
      throw new Error("PostgreSQL did not return a canonicality validation time");
    }
    return {
      blockNumber: row.block_number,
      canonical,
      error,
      expectedHash: row.block_hash,
      observedHash,
      riskRunId: row.id,
      validatedAt: validatedAt.toISOString(),
    };
  }

  public async validateLatestCanonical(
    readBlock: (blockNumber: bigint) => Promise<RiskBlock>,
  ): Promise<RiskCanonicalityValidation | null> {
    const latest = await this.pool.query<LatestRiskRunRow>(
      `SELECT id, block_number::text, block_hash
       FROM risk_snapshot_runs
       ORDER BY id DESC
       LIMIT 1`,
    );
    const row = latest.rows[0];
    return row === undefined ? null : this.validateCanonicalRow(row, readBlock);
  }

  public async validateRunCanonical(
    riskRunId: string,
    readBlock: (blockNumber: bigint) => Promise<RiskBlock>,
  ): Promise<RiskCanonicalityValidation> {
    if (!/^[1-9]\d*$/u.test(riskRunId)) throw new Error("Risk run ID is invalid");
    const result = await this.pool.query<LatestRiskRunRow>(
      `SELECT id, block_number::text, block_hash
       FROM risk_snapshot_runs WHERE id = $1`,
      [riskRunId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Risk run ${riskRunId} does not exist`);
    return this.validateCanonicalRow(row, readBlock);
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
