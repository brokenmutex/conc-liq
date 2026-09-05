import pg from "pg";
import { getAddress } from "viem";
import { SCHEMA_SQL } from "../storage/schema.js";
import type {
  CostSample,
  GuardedCostModel,
  GuardedCostModelEvidence,
  GuardedCostModelSource,
} from "./domain.js";

const { Pool } = pg;

interface PoolRow {
  fee: number;
  pool_address: string;
  rwa_symbol: string;
}

interface RunRow {
  id: string;
  stream_key: string;
}

interface CostRow {
  total_cost_quote_raw: string;
}

export interface GuardedCostModelSaveResult {
  readonly created: boolean;
  readonly modelId: string;
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry
  );
}

function percentile90(rows: readonly CostRow[]): CostSample {
  if (rows.length === 0) return { p90QuoteRaw: null, sampleCount: 0 };
  const values = rows.map((row) => BigInt(row.total_cost_quote_raw))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return {
    p90QuoteRaw: values[Math.ceil(values.length * 0.9) - 1]!,
    sampleCount: values.length,
  };
}

export class PostgresGuardedCostModelStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async load(input: {
    readonly actionAssessmentRunId?: string;
    readonly approvalValuationRunId?: string;
    readonly fee: number;
    readonly rwaSymbol: string;
    readonly streamKey: string;
  }): Promise<{
    readonly evidence: GuardedCostModelEvidence;
    readonly source: GuardedCostModelSource;
  }> {
    for (const [name, value] of [
      ["action assessment", input.actionAssessmentRunId],
      ["approval valuation", input.approvalValuationRunId],
    ] as const) {
      if (value !== undefined && !/^[1-9]\d*$/u.test(value)) {
        throw new Error(`${name} run ID must be a positive integer`);
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const poolResult = await client.query<PoolRow>(
        `SELECT pool_address, rwa_symbol, fee FROM indexer_pools
         WHERE stream_key = $1 AND upper(rwa_symbol) = upper($2) AND
               fee = $3 AND enabled`,
        [input.streamKey, input.rwaSymbol, input.fee],
      );
      if (poolResult.rows.length !== 1) {
        throw new Error(
          `Expected one enabled ${input.rwaSymbol}/${input.fee} pool, ` +
          `found ${poolResult.rows.length}`,
        );
      }
      const pool = poolResult.rows[0]!;
      const actionRunResult = input.actionAssessmentRunId === undefined
        ? await client.query<RunRow>(
          `SELECT id::text, stream_key FROM v3_action_cost_call_assessment_runs
           WHERE stream_key = $1 ORDER BY computed_at DESC, id DESC LIMIT 1`,
          [input.streamKey],
        )
        : await client.query<RunRow>(
          `SELECT id::text, stream_key FROM v3_action_cost_call_assessment_runs
           WHERE id = $1 AND stream_key = $2`,
          [input.actionAssessmentRunId, input.streamKey],
        );
      const actionRun = actionRunResult.rows[0];
      if (actionRun === undefined) throw new Error("Compatible action assessment is unavailable");
      const approvalRunResult = input.approvalValuationRunId === undefined
        ? await client.query<RunRow>(
          `SELECT id::text, stream_key FROM v3_approval_cost_valuation_runs
           WHERE stream_key = $1 ORDER BY computed_at DESC, id DESC LIMIT 1`,
          [input.streamKey],
        )
        : await client.query<RunRow>(
          `SELECT id::text, stream_key FROM v3_approval_cost_valuation_runs
           WHERE id = $1 AND stream_key = $2`,
          [input.approvalValuationRunId, input.streamKey],
        );
      const approvalRun = approvalRunResult.rows[0];
      if (approvalRun === undefined) throw new Error("Compatible approval valuation is unavailable");
      const mintRows = await client.query<CostRow>(
        `SELECT a.total_cost_quote_raw::text
         FROM v3_action_cost_call_assessments a
         JOIN v3_action_cost_observations o
           ON lower(o.transaction_hash) = lower(a.transaction_hash) AND
              o.stream_key = $3
         WHERE a.assessment_run_id = $1 AND a.status = 'comparable' AND
               a.intended_action = 'initial_mint' AND
               EXISTS (
                 SELECT 1 FROM jsonb_array_elements_text(o.pool_addresses) p
                 WHERE lower(p) = lower($2)
               )`,
        [actionRun.id, pool.pool_address, input.streamKey],
      );
      const approvalRows = async (symbol: string) => client.query<CostRow>(
        `SELECT total_cost_quote_raw::text FROM v3_approval_cost_valuations
         WHERE valuation_run_id = $1 AND status = 'valid' AND
               token_symbols @> $2::jsonb`,
        [approvalRun.id, json([symbol])],
      );
      const [rwaApprovals, quoteApprovals] = await Promise.all([
        approvalRows(pool.rwa_symbol),
        approvalRows("USDG"),
      ]);
      await client.query("COMMIT");
      return {
        evidence: {
          actionAssessmentRunId: actionRun.id,
          approvalValuationRunId: approvalRun.id,
          initialMint: percentile90(mintRows.rows),
          quoteApproval: percentile90(quoteApprovals.rows),
          rwaApproval: percentile90(rwaApprovals.rows),
        },
        source: {
          fee: pool.fee,
          poolAddress: getAddress(pool.pool_address),
          rwaSymbol: pool.rwa_symbol,
          streamKey: input.streamKey,
        },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(model: GuardedCostModel): Promise<GuardedCostModelSaveResult> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO v3_guarded_cost_models (
         schema_version, stream_key, pool_address, rwa_symbol, fee,
         action_assessment_run_id, approval_valuation_run_id, status,
         quote_decimals, entry_cost_quote_raw, rebalance_cost_quote_raw,
         reasons, warnings, components, methodology, execution_eligible,
         computed_at, snapshot
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,
         $14::jsonb,$15,$16,$17,$18::jsonb
       ) ON CONFLICT (
         schema_version, stream_key, pool_address, action_assessment_run_id,
         approval_valuation_run_id
       ) DO NOTHING RETURNING id::text`,
      [
        model.schemaVersion,
        model.source.streamKey,
        model.source.poolAddress,
        model.source.rwaSymbol,
        model.source.fee,
        model.evidence.actionAssessmentRunId,
        model.evidence.approvalValuationRunId,
        model.status,
        model.quoteDecimals,
        model.entryCostQuoteRaw?.toString() ?? null,
        model.rebalanceCostQuoteRaw,
        json(model.reasons),
        json(model.warnings),
        json(model.evidence),
        model.methodology,
        model.executionEligible,
        model.computedAt,
        json(model),
      ],
    );
    const id = result.rows[0]?.id;
    if (id !== undefined) return { created: true, modelId: id };
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id::text FROM v3_guarded_cost_models
       WHERE schema_version = $1 AND stream_key = $2 AND
             lower(pool_address) = lower($3) AND
             action_assessment_run_id = $4 AND approval_valuation_run_id = $5`,
      [
        model.schemaVersion,
        model.source.streamKey,
        model.source.poolAddress,
        model.evidence.actionAssessmentRunId,
        model.evidence.approvalValuationRunId,
      ],
    );
    const modelId = existing.rows[0]?.id;
    if (modelId === undefined) throw new Error("Guarded cost-model conflict vanished");
    return { created: false, modelId };
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
