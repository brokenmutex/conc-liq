import pg, { type PoolClient } from "pg";
import { SCHEMA_SQL } from "../storage/schema.js";
import type {
  PerpCandle,
  PerpReferenceSnapshot,
  PerpWeekendAssessment,
} from "./domain.js";

const { Pool } = pg;

export interface SaveResult {
  readonly created: boolean;
  readonly runId: string;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

async function saveCandleBatch(input: {
  readonly candles: readonly PerpCandle[];
  readonly client: PoolClient;
  readonly coin: string;
  readonly dex: string;
  readonly fetchedAt: string;
  readonly source: string;
}): Promise<void> {
  if (input.candles.length === 0) return;
  const values: unknown[] = [];
  const rows = input.candles.map((candle, rowIndex) => {
    const start = rowIndex * 14;
    values.push(
      input.source,
      input.dex,
      input.coin,
      candle.interval,
      candle.openTimeMs,
      candle.closeTimeMs,
      candle.openPriceX18,
      candle.closePriceX18,
      candle.highPriceX18,
      candle.lowPriceX18,
      candle.volumeX18,
      candle.tradeCount,
      input.fetchedAt,
      json(candle.raw),
    );
    return `(${Array.from({ length: 14 }, (_, index) =>
      `$${start + index + 1}${index === 13 ? "::jsonb" : ""}`
    ).join(",")})`;
  });
  const result = await input.client.query<{ open_time_ms: string }>(
    `INSERT INTO perp_reference_candles (
       source, dex, coin, candle_interval, open_time_ms, close_time_ms,
       open_price_x18, close_price_x18, high_price_x18, low_price_x18,
       base_volume_x18, trade_count, fetched_at, snapshot
     ) VALUES ${rows.join(",")}
     ON CONFLICT (source, dex, coin, candle_interval, open_time_ms)
     DO UPDATE SET fetched_at = perp_reference_candles.fetched_at
     WHERE perp_reference_candles.close_time_ms = EXCLUDED.close_time_ms
       AND perp_reference_candles.open_price_x18 = EXCLUDED.open_price_x18
       AND perp_reference_candles.close_price_x18 = EXCLUDED.close_price_x18
       AND perp_reference_candles.high_price_x18 = EXCLUDED.high_price_x18
       AND perp_reference_candles.low_price_x18 = EXCLUDED.low_price_x18
       AND perp_reference_candles.base_volume_x18 = EXCLUDED.base_volume_x18
       AND perp_reference_candles.trade_count = EXCLUDED.trade_count
       AND perp_reference_candles.snapshot = EXCLUDED.snapshot
     RETURNING open_time_ms::text`,
    values,
  );
  if (result.rowCount !== input.candles.length) {
    throw new Error("Stored perp candle conflicts with the fetched immutable candle");
  }
}

export class PostgresPerpReferenceStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async saveSnapshot(snapshot: PerpReferenceSnapshot): Promise<SaveResult> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO perp_reference_snapshot_runs (
         schema_version, source, dex, coin, asset_index, observed_at,
         expected_pricing_mode, status, quality_pass, reasons, limitations,
         evidence_sha256, methodology, execution_eligible, snapshot
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15::jsonb
       ) RETURNING id::text`,
      [
        snapshot.schemaVersion,
        snapshot.source,
        snapshot.dex,
        snapshot.coin,
        snapshot.assetIndex,
        snapshot.observedAt,
        snapshot.expectedPricingMode,
        snapshot.status,
        snapshot.qualityPass,
        json(snapshot.reasons),
        json(snapshot.limitations),
        snapshot.evidence.sha256,
        snapshot.methodology,
        snapshot.executionEligible,
        json(snapshot),
      ],
    );
    return { created: true, runId: result.rows[0]!.id };
  }

  public async saveAssessment(input: {
    readonly assessment: PerpWeekendAssessment;
    readonly candles: readonly PerpCandle[];
  }): Promise<SaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (let index = 0; index < input.candles.length; index += 200) {
        await saveCandleBatch({
          candles: input.candles.slice(index, index + 200),
          client,
          coin: input.assessment.coin,
          dex: input.assessment.dex,
          fetchedAt: input.assessment.evidence.fetchedAt,
          source: input.assessment.source,
        });
      }
      const assessment = input.assessment;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO perp_weekend_assessment_runs (
           schema_version, source, dex, coin, candle_interval,
           from_time_ms, to_time_ms, candle_count, session_count,
           complete_sessions, excluded_sessions, evidence_sha256, fetched_at,
           methodology, execution_eligible, summary, snapshot
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb
         ) ON CONFLICT (
           schema_version, source, dex, coin, candle_interval,
           from_time_ms, to_time_ms, evidence_sha256
         ) DO NOTHING RETURNING id::text`,
        [
          assessment.schemaVersion,
          assessment.source,
          assessment.dex,
          assessment.coin,
          assessment.interval,
          assessment.fromTimeMs,
          assessment.toTimeMs,
          assessment.candleCount,
          assessment.summary.sessions,
          assessment.summary.completeSessions,
          assessment.summary.excludedSessions,
          assessment.evidence.sha256,
          assessment.evidence.fetchedAt,
          assessment.methodology,
          assessment.executionEligible,
          json(assessment.summary),
          json(assessment),
        ],
      );
      let runId = inserted.rows[0]?.id;
      const created = runId !== undefined;
      if (runId === undefined) {
        const existing = await client.query<{ id: string }>(
          `SELECT id::text FROM perp_weekend_assessment_runs
           WHERE schema_version = $1 AND source = $2 AND dex = $3 AND coin = $4
             AND candle_interval = $5 AND from_time_ms = $6 AND to_time_ms = $7
             AND evidence_sha256 = $8`,
          [
            assessment.schemaVersion,
            assessment.source,
            assessment.dex,
            assessment.coin,
            assessment.interval,
            assessment.fromTimeMs,
            assessment.toTimeMs,
            assessment.evidence.sha256,
          ],
        );
        runId = existing.rows[0]?.id;
      }
      if (runId === undefined) {
        throw new Error("Perp weekend assessment insert did not resolve a run ID");
      }
      if (created) {
        for (const session of assessment.sessions) {
          await client.query(
            `INSERT INTO perp_weekend_assessment_sessions (
               assessment_run_id, session_key, status, reasons,
               internal_start_ms, internal_end_ms, reopen_time_ms, candle_count,
               external_close_price_x18, weekend_close_price_x18,
               reopen_price_x18, weekend_move_ppm, reopen_gap_ppm,
               max_up_excursion_ppm, max_down_excursion_ppm, direction_correct,
               base_volume_x18, trade_count, snapshot
             ) VALUES (
               $1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               $17,$18,$19::jsonb
             )`,
            [
              runId,
              session.sessionKey,
              session.status,
              json(session.reasons),
              session.internalStartMs,
              session.internalEndMs,
              session.reopenTimeMs,
              session.candleCount,
              session.externalClosePriceX18,
              session.weekendClosePriceX18,
              session.reopenPriceX18,
              session.weekendMovePpm,
              session.reopenGapPpm,
              session.maxUpExcursionPpm,
              session.maxDownExcursionPpm,
              session.directionCorrect,
              session.baseVolumeX18,
              session.tradeCount,
              json(session),
            ],
          );
        }
      }
      await client.query("COMMIT");
      return { created, runId };
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
