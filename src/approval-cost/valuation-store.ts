import pg, { type PoolClient } from "pg";
import { type Hash } from "viem";
import { assertSchemaReady } from "../storage/compatibility.js";
import type {
  ApprovalCostValuationObservation,
  ApprovalCostValuationRun,
  ApprovalCostValuationSource,
} from "./valuation-domain.js";

const { Pool } = pg;

interface RunRow {
  chain_id: string;
  id: string;
  selected_candidates: number;
  stream_key: string;
}

interface ObservationRow {
  approval_events: unknown;
  block_hash: string;
  block_number: string;
  l1_data_fee_wei: string | null;
  l2_execution_fee_wei: string | null;
  reasons: unknown;
  status: string;
  total_fee_wei: string;
  transaction_hash: string;
}

export interface ApprovalCostValuationSaveResult {
  readonly created: boolean;
  readonly runId: string;
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry
  );
}

function hash(value: string, field: string): Hash {
  if (!/^0x[0-9a-f]{64}$/iu.test(value)) {
    throw new Error(`Stored approval valuation ${field} is invalid`);
  }
  return value as Hash;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Stored approval valuation ${field} is invalid`);
  }
  return value;
}

function tokenSymbols(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("Stored approval events are invalid");
  const symbols = value.map((entry) => {
    if (entry === null || typeof entry !== "object" || !("tokenSymbol" in entry)) {
      throw new Error("Stored approval event token symbol is missing");
    }
    const symbol = (entry as { readonly tokenSymbol?: unknown }).tokenSymbol;
    if (typeof symbol !== "string" || symbol.length === 0) {
      throw new Error("Stored approval event token symbol is invalid");
    }
    return symbol;
  });
  return [...new Set(symbols)].sort();
}

function observation(row: ObservationRow): ApprovalCostValuationObservation {
  if (row.status !== "comparable" && row.status !== "excluded") {
    throw new Error(`Stored approval status is invalid: ${row.status}`);
  }
  return {
    blockHash: hash(row.block_hash, "block hash"),
    blockNumber: BigInt(row.block_number),
    l1DataFeeWei: row.l1_data_fee_wei === null ? null : BigInt(row.l1_data_fee_wei),
    l2ExecutionFeeWei: row.l2_execution_fee_wei === null
      ? null
      : BigInt(row.l2_execution_fee_wei),
    sourceReasons: strings(row.reasons, "reasons"),
    sourceStatus: row.status,
    tokenSymbols: tokenSymbols(row.approval_events),
    totalFeeWei: BigInt(row.total_fee_wei),
    transactionHash: hash(row.transaction_hash, "transaction hash"),
  };
}

async function insertMark(
  client: PoolClient,
  valuationRunId: string,
  approvalCostRunId: string,
  mark: ApprovalCostValuationRun["marks"][number],
): Promise<void> {
  await client.query(
    `INSERT INTO v3_approval_cost_valuations (
       valuation_run_id, approval_cost_run_id, transaction_hash, block_number,
       block_hash, block_timestamp, token_symbols, source_status, status,
       reasons, total_fee_wei, l1_data_fee_wei, l2_execution_fee_wei,
       total_cost_quote_raw, l1_data_cost_quote_raw,
       l2_execution_cost_quote_raw, eth_oracle, quote_oracle,
       execution_eligible, snapshot
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,
       $16,$17::jsonb,$18::jsonb,$19,$20::jsonb
     )`,
    [
      valuationRunId,
      approvalCostRunId,
      mark.transactionHash,
      mark.blockNumber.toString(),
      mark.blockHash,
      mark.blockTimestamp?.toString() ?? null,
      json(mark.tokenSymbols),
      mark.sourceStatus,
      mark.status,
      json(mark.reasons),
      mark.totalFeeWei.toString(),
      mark.l1DataFeeWei?.toString() ?? null,
      mark.l2ExecutionFeeWei?.toString() ?? null,
      mark.totalCostQuoteRaw?.toString() ?? null,
      mark.l1DataCostQuoteRaw?.toString() ?? null,
      mark.l2ExecutionCostQuoteRaw?.toString() ?? null,
      mark.ethOracle === null ? null : json(mark.ethOracle),
      mark.quoteOracle === null ? null : json(mark.quoteOracle),
      mark.executionEligible,
      json(mark),
    ],
  );
}

export class PostgresApprovalCostValuationStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 });
  }

  public async assertReady(): Promise<void> {
    await assertSchemaReady(this.pool);
  }

  public async loadSource(approvalCostRunId?: string): Promise<ApprovalCostValuationSource> {
    if (approvalCostRunId !== undefined && !/^[1-9]\d*$/u.test(approvalCostRunId)) {
      throw new Error("Approval-cost run ID must be a positive integer");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const runResult = approvalCostRunId === undefined
        ? await client.query<RunRow>(
          `SELECT id::text, stream_key, chain_id::text, selected_candidates
           FROM v3_approval_cost_runs ORDER BY to_block DESC, id DESC LIMIT 1`,
        )
        : await client.query<RunRow>(
          `SELECT id::text, stream_key, chain_id::text, selected_candidates
           FROM v3_approval_cost_runs WHERE id = $1`,
          [approvalCostRunId],
        );
      const run = runResult.rows[0];
      if (run === undefined) {
        throw new Error(approvalCostRunId === undefined
          ? "No approval-cost run is available"
          : `Approval-cost run ${approvalCostRunId} does not exist`);
      }
      const result = await client.query<ObservationRow>(
        `SELECT transaction_hash, block_number::text, block_hash,
                approval_events, status, reasons, total_fee_wei::text,
                l1_data_fee_wei::text, l2_execution_fee_wei::text
         FROM v3_approval_cost_observations WHERE run_id = $1
         ORDER BY block_number, transaction_index, transaction_hash`,
        [run.id],
      );
      if (result.rows.length !== run.selected_candidates) {
        throw new Error(
          `Approval-cost run ${run.id} expected ${run.selected_candidates} rows, ` +
          `loaded ${result.rows.length}`,
        );
      }
      await client.query("COMMIT");
      return {
        approvalCostRunId: run.id,
        chainId: Number(run.chain_id),
        observations: result.rows.map(observation),
        streamKey: run.stream_key,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(run: ApprovalCostValuationRun): Promise<ApprovalCostValuationSaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO v3_approval_cost_valuation_runs (
           schema_version, approval_cost_run_id, stream_key, chain_id,
           feed_directory_sha256, feed_directory, eth_feed, quote_feed,
           max_price_age_seconds, quote_decimals, observation_count,
           valid_observations, excluded_observations, methodology,
           execution_eligible, computed_at, summary, snapshot
         ) VALUES (
           $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,
           $13,$14,$15,$16,$17::jsonb,$18::jsonb
         ) ON CONFLICT (
           schema_version, approval_cost_run_id, feed_directory_sha256,
           max_price_age_seconds
         ) DO NOTHING RETURNING id::text`,
        [
          run.schemaVersion,
          run.source.approvalCostRunId,
          run.source.streamKey,
          run.source.chainId,
          run.feedDirectory.sha256,
          json(run.feedDirectory),
          json(run.ethFeed),
          json(run.quoteFeed),
          run.maxPriceAgeSeconds,
          run.quoteDecimals,
          run.summary.observations,
          run.summary.validObservations,
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
          `SELECT id::text FROM v3_approval_cost_valuation_runs
           WHERE schema_version = $1 AND approval_cost_run_id = $2 AND
                 feed_directory_sha256 = $3 AND max_price_age_seconds = $4`,
          [
            run.schemaVersion,
            run.source.approvalCostRunId,
            run.feedDirectory.sha256,
            run.maxPriceAgeSeconds,
          ],
        );
        runId = existing.rows[0]?.id;
        if (runId === undefined) throw new Error("Approval valuation conflict vanished");
        await client.query("COMMIT");
        return { created: false, runId };
      }
      for (const mark of run.marks) {
        await insertMark(client, runId, run.source.approvalCostRunId, mark);
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
