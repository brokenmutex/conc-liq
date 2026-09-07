import pg, { type PoolClient } from "pg";
import { getAddress, type Hash, type Hex } from "viem";
import { assertSchemaReady } from "../storage/compatibility.js";
import type { ActionCostClass } from "./domain.js";
import type {
  ActionCostCallAssessmentRun,
  ActionCostCallSource,
  ActionCostCallSourceMark,
} from "./comparability-domain.js";

const { Pool } = pg;

const ACTION_CLASSES = new Set<ActionCostClass>([
  "collect_bundle",
  "exit_bundle",
  "mint_bundle",
  "mixed",
  "rebalance_bundle",
  "swap_only",
]);

interface RunRow {
  id: string;
  observation_count: number;
  stream_key: string;
}

interface MarkRow {
  action_class: string;
  recipient_address: string | null;
  reasons: unknown;
  selector: string | null;
  status: string;
  total_cost_quote_raw: string | null;
  transaction_hash: string;
}

export interface ActionCostCallSaveResult {
  readonly created: boolean;
  readonly runId: string;
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry
  );
}

function hash(value: string): Hash {
  if (!/^0x[0-9a-f]{64}$/iu.test(value)) throw new Error("Stored transaction hash is invalid");
  return value as Hash;
}

function selector(value: string | null): Hex | null {
  if (value === null) return null;
  if (!/^0x[0-9a-f]{8}$/iu.test(value)) throw new Error("Stored selector is invalid");
  return value as Hex;
}

function reasons(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Stored valuation reasons are invalid");
  }
  return value;
}

function sourceMark(row: MarkRow): ActionCostCallSourceMark {
  if (!ACTION_CLASSES.has(row.action_class as ActionCostClass)) {
    throw new Error(`Stored action class is invalid: ${row.action_class}`);
  }
  if (row.status !== "valid" && row.status !== "excluded") {
    throw new Error(`Stored valuation status is invalid: ${row.status}`);
  }
  return {
    actionClass: row.action_class as ActionCostClass,
    recipient: row.recipient_address === null ? null : getAddress(row.recipient_address),
    selector: selector(row.selector),
    sourceReasons: reasons(row.reasons),
    sourceStatus: row.status,
    totalCostQuoteRaw: row.total_cost_quote_raw === null
      ? null
      : BigInt(row.total_cost_quote_raw),
    transactionHash: hash(row.transaction_hash),
  };
}

async function insertAssessment(
  client: PoolClient,
  assessmentRunId: string,
  valuationRunId: string,
  assessment: ActionCostCallAssessmentRun["assessments"][number],
): Promise<void> {
  await client.query(
    `INSERT INTO v3_action_cost_call_assessments (
       assessment_run_id, valuation_run_id, transaction_hash, action_class,
       recipient_address, selector, call_family, intended_action, status,
       reasons, total_cost_quote_raw, execution_eligible, snapshot
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb)`,
    [
      assessmentRunId,
      valuationRunId,
      assessment.transactionHash,
      assessment.actionClass,
      assessment.recipient,
      assessment.selector,
      assessment.callFamily,
      assessment.intendedAction,
      assessment.status,
      json(assessment.reasons),
      assessment.totalCostQuoteRaw?.toString() ?? null,
      assessment.executionEligible,
      json(assessment),
    ],
  );
}

export class PostgresActionCostCallStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 });
  }

  public async assertReady(): Promise<void> {
    await assertSchemaReady(this.pool);
  }

  public async loadSource(valuationRunId?: string): Promise<ActionCostCallSource> {
    if (valuationRunId !== undefined && !/^[1-9]\d*$/u.test(valuationRunId)) {
      throw new Error("Valuation run ID must be a positive integer");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const runResult = valuationRunId === undefined
        ? await client.query<RunRow>(
          `SELECT id::text, stream_key, observation_count
           FROM v3_action_cost_valuation_runs
           ORDER BY computed_at DESC, id DESC LIMIT 1`,
        )
        : await client.query<RunRow>(
          `SELECT id::text, stream_key, observation_count
           FROM v3_action_cost_valuation_runs WHERE id = $1`,
          [valuationRunId],
        );
      const run = runResult.rows[0];
      if (run === undefined) {
        throw new Error(valuationRunId === undefined
          ? "No action-cost valuation run is available"
          : `Action-cost valuation run ${valuationRunId} does not exist`);
      }
      const markResult = await client.query<MarkRow>(
        `SELECT v.transaction_hash, v.action_class, v.status, v.reasons,
                v.total_cost_quote_raw::text, o.recipient_address, o.selector
         FROM v3_action_cost_valuations v
         JOIN v3_action_cost_observations o
           ON o.stream_key = v.stream_key AND
              lower(o.transaction_hash) = lower(v.transaction_hash)
         WHERE v.valuation_run_id = $1
         ORDER BY v.block_number, v.transaction_hash`,
        [run.id],
      );
      if (markResult.rows.length !== run.observation_count) {
        throw new Error(
          `Valuation run ${run.id} expected ${run.observation_count} marks, ` +
          `loaded ${markResult.rows.length}`,
        );
      }
      await client.query("COMMIT");
      return {
        marks: markResult.rows.map(sourceMark),
        streamKey: run.stream_key,
        valuationRunId: run.id,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(run: ActionCostCallAssessmentRun): Promise<ActionCostCallSaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO v3_action_cost_call_assessment_runs (
           schema_version, valuation_run_id, stream_key,
           position_manager_address, observation_count,
           comparable_observations, opaque_observations,
           excluded_observations, methodology, execution_eligible,
           computed_at, summary, snapshot
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
         ON CONFLICT (schema_version, valuation_run_id, position_manager_address)
         DO NOTHING RETURNING id::text`,
        [
          run.schemaVersion,
          run.source.valuationRunId,
          run.source.streamKey,
          run.positionManager,
          run.summary.observations,
          run.summary.comparableObservations,
          run.summary.opaqueObservations,
          run.summary.excludedObservations,
          run.methodology,
          run.executionEligible,
          run.computedAt,
          json(run.summary),
          json(run),
        ],
      );
      let runId = inserted.rows[0]?.id;
      if (runId === undefined) {
        const existing = await client.query<{ id: string }>(
          `SELECT id::text FROM v3_action_cost_call_assessment_runs
           WHERE schema_version = $1 AND valuation_run_id = $2 AND
                 lower(position_manager_address) = lower($3)`,
          [run.schemaVersion, run.source.valuationRunId, run.positionManager],
        );
        runId = existing.rows[0]?.id;
        if (runId === undefined) throw new Error("Call assessment conflict vanished");
        await client.query("COMMIT");
        return { created: false, runId };
      }
      for (const assessment of run.assessments) {
        await insertAssessment(
          client,
          runId,
          run.source.valuationRunId,
          assessment,
        );
      }
      await client.query("COMMIT");
      return { created: true, runId };
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
