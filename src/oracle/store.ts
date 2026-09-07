import pg from "pg";
import { assertSchemaReady } from "../storage/compatibility.js";
import type { OracleCalibrationRun } from "./domain.js";

const { Pool } = pg;

export interface OracleCalibrationSaveResult {
  readonly calibrationRunId: string;
  readonly created: boolean;
}

export class PostgresOracleCalibrationStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async assertReady(): Promise<void> {
    await assertSchemaReady(this.pool);
  }

  public async save(
    calibration: OracleCalibrationRun,
  ): Promise<OracleCalibrationSaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `INSERT INTO v3_range_oracle_calibration_runs (
           schema_version, stream_key, first_accounting_run_id,
           last_accounting_run_id, computed_at, pool_address, rwa_symbol,
           fee, token0, token1, quote_token, quote_decimals, rwa_decimals,
           rwa_feed_address, quote_feed_address, max_price_age_seconds,
           registry_fetched_at, registry_sha256, registry_url,
           feed_directory_fetched_at, feed_directory_sha256,
           feed_directory_url, calibration_hash, methodology,
           execution_eligible, valid_marks, excluded_marks, assumptions,
           registry_asset, rwa_feed, quote_feed
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
           $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,
           $29::jsonb,$30::jsonb,$31::jsonb
         )
         ON CONFLICT (
           schema_version, stream_key, first_accounting_run_id,
           last_accounting_run_id, pool_address, calibration_hash
         ) DO NOTHING
         RETURNING id`,
        [
          calibration.schemaVersion,
          calibration.streamKey,
          calibration.first.runId,
          calibration.last.runId,
          calibration.computedAt,
          calibration.poolAddress.toLowerCase(),
          calibration.rwaSymbol,
          calibration.fee,
          calibration.token0.toLowerCase(),
          calibration.token1.toLowerCase(),
          calibration.quoteToken.toLowerCase(),
          calibration.quoteDecimals,
          calibration.registryAsset.decimals,
          calibration.rwaFeed.address.toLowerCase(),
          calibration.quoteFeed.address.toLowerCase(),
          calibration.maxPriceAgeSeconds,
          calibration.registry.fetchedAt,
          calibration.registry.sha256,
          calibration.registry.url,
          calibration.feedDirectory.fetchedAt,
          calibration.feedDirectory.sha256,
          calibration.feedDirectory.url,
          calibration.calibrationHash,
          calibration.methodology,
          calibration.executionEligible,
          calibration.validMarks,
          calibration.excludedMarks,
          JSON.stringify(calibration.assumptions),
          JSON.stringify(calibration.registryAsset),
          JSON.stringify(calibration.rwaFeed),
          JSON.stringify(calibration.quoteFeed),
        ],
      );
      let calibrationRunId = result.rows[0]?.id;
      if (calibrationRunId === undefined) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM v3_range_oracle_calibration_runs
           WHERE schema_version = $1 AND stream_key = $2
             AND first_accounting_run_id = $3
             AND last_accounting_run_id = $4
             AND pool_address = $5 AND calibration_hash = $6`,
          [
            calibration.schemaVersion,
            calibration.streamKey,
            calibration.first.runId,
            calibration.last.runId,
            calibration.poolAddress.toLowerCase(),
            calibration.calibrationHash,
          ],
        );
        calibrationRunId = existing.rows[0]?.id;
        if (calibrationRunId === undefined) {
          throw new Error("PostgreSQL did not resolve the oracle calibration conflict");
        }
        await client.query("COMMIT");
        return { calibrationRunId, created: false };
      }
      for (const mark of calibration.marks) {
        await client.query(
          `INSERT INTO v3_range_oracle_calibration_marks (
             calibration_run_id, accounting_run_id, status, reasons,
             pool_price_x18, oracle_price_x18, deviation_ppm,
             rwa_oracle_answer, rwa_oracle_updated_at,
             rwa_oracle_age_seconds, quote_oracle_answer,
             quote_oracle_updated_at, quote_oracle_age_seconds,
             token_decimals, token_ui_multiplier, token_new_ui_multiplier,
             token_multiplier_effective_at, token_oracle_paused, mark
           ) VALUES (
             $1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
             $16,$17,$18,$19::jsonb
           )`,
          [
            calibrationRunId,
            mark.accountingRunId,
            mark.status,
            JSON.stringify(mark.reasons),
            mark.poolPriceX18,
            mark.oraclePriceX18,
            mark.deviationPpm,
            mark.rwaOracle?.answer ?? null,
            mark.rwaOracle?.updatedAt ?? null,
            mark.rwaOracleAgeSeconds,
            mark.quoteOracle?.answer ?? null,
            mark.quoteOracle?.updatedAt ?? null,
            mark.quoteOracleAgeSeconds,
            mark.tokenDecimals,
            mark.token?.uiMultiplier ?? null,
            mark.token?.newUIMultiplier ?? null,
            mark.token?.effectiveAt ?? null,
            mark.token?.oraclePaused ?? null,
            JSON.stringify(mark),
          ],
        );
      }
      await client.query("COMMIT");
      return { calibrationRunId, created: true };
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
