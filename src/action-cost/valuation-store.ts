import pg, { type PoolClient } from "pg";
import { type Hash } from "viem";
import { assertSchemaReady } from "../storage/compatibility.js";
import type { ActionCostClass } from "./domain.js";
import type {
  ActionCostValuationObservation,
  ActionCostValuationRun,
  ActionCostValuationSource,
} from "./valuation-domain.js";

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
  chain_id: string;
  from_block: string;
  id: string;
  observation_count: number;
  stream_key: string;
  to_block: string;
  to_block_hash: string;
}

interface ObservationRow {
  action_class: string;
  block_hash: string;
  block_number: string;
  fee_components_complete: boolean;
  l1_data_fee_wei: string | null;
  l2_execution_fee_wei: string | null;
  stream_key: string;
  total_fee_wei: string;
  transaction_hash: string;
}

export interface ActionCostValuationSaveResult {
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
    throw new Error(`Stored action-cost valuation ${field} is invalid`);
  }
  return value as Hash;
}

function observation(row: ObservationRow): ActionCostValuationObservation {
  if (!ACTION_CLASSES.has(row.action_class as ActionCostClass)) {
    throw new Error(`Stored action class is invalid: ${row.action_class}`);
  }
  const feeComponentsComplete = row.fee_components_complete;
  if (feeComponentsComplete !== (
    row.l1_data_fee_wei !== null && row.l2_execution_fee_wei !== null
  )) {
    throw new Error(`Stored fee component state conflicts for ${row.transaction_hash}`);
  }
  return {
    actionClass: row.action_class as ActionCostClass,
    blockHash: hash(row.block_hash, "block hash"),
    blockNumber: BigInt(row.block_number),
    feeComponentsComplete,
    l1DataFeeWei: row.l1_data_fee_wei === null ? null : BigInt(row.l1_data_fee_wei),
    l2ExecutionFeeWei: row.l2_execution_fee_wei === null
      ? null
      : BigInt(row.l2_execution_fee_wei),
    streamKey: row.stream_key,
    totalFeeWei: BigInt(row.total_fee_wei),
    transactionHash: hash(row.transaction_hash, "transaction hash"),
  };
}

async function insertMark(
  client: PoolClient,
  valuationRunId: string,
  mark: ActionCostValuationRun["marks"][number],
): Promise<void> {
  await client.query(
    `INSERT INTO v3_action_cost_valuations (
       valuation_run_id, stream_key, transaction_hash, block_number,
       block_hash, block_timestamp, action_class, status, reasons,
       fee_components_complete, total_fee_wei, l1_data_fee_wei,
       l2_execution_fee_wei, total_cost_quote_raw, l1_data_cost_quote_raw,
       l2_execution_cost_quote_raw, eth_oracle, quote_oracle,
       execution_eligible, snapshot
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,
       $17::jsonb,$18::jsonb,$19,$20::jsonb
     )`,
    [
      valuationRunId,
      mark.streamKey,
      mark.transactionHash,
      mark.blockNumber.toString(),
      mark.blockHash,
      mark.blockTimestamp?.toString() ?? null,
      mark.actionClass,
      mark.status,
      json(mark.reasons),
      mark.feeComponentsComplete,
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

export class PostgresActionCostValuationStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 });
  }

  public async assertReady(): Promise<void> {
    await assertSchemaReady(this.pool);
  }

  public async loadSource(actionCostRunId?: string): Promise<ActionCostValuationSource> {
    if (actionCostRunId !== undefined && !/^[1-9]\d*$/u.test(actionCostRunId)) {
      throw new Error("Action-cost run ID must be a positive integer");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const runResult = actionCostRunId === undefined
        ? await client.query<RunRow>(
          `SELECT id::text, stream_key, chain_id::text, from_block::text,
                  to_block::text, to_block_hash, observation_count
           FROM v3_action_cost_runs
           ORDER BY to_block DESC, id DESC LIMIT 1`,
        )
        : await client.query<RunRow>(
          `SELECT id::text, stream_key, chain_id::text, from_block::text,
                  to_block::text, to_block_hash, observation_count
           FROM v3_action_cost_runs WHERE id = $1`,
          [actionCostRunId],
        );
      const run = runResult.rows[0];
      if (run === undefined) {
        throw new Error(actionCostRunId === undefined
          ? "No action-cost run is available"
          : `Action-cost run ${actionCostRunId} does not exist`);
      }
      const observationResult = await client.query<ObservationRow>(
        `SELECT o.stream_key, o.transaction_hash, o.block_number::text,
                o.block_hash, o.action_class, o.fee_components_complete,
                o.total_fee_wei::text, o.l1_data_fee_wei::text,
                o.l2_execution_fee_wei::text
         FROM v3_action_cost_run_observations ro
         JOIN v3_action_cost_observations o
           ON o.stream_key = ro.stream_key AND
              lower(o.transaction_hash) = lower(ro.transaction_hash)
         WHERE ro.run_id = $1
         ORDER BY o.block_number, o.transaction_index, o.transaction_hash`,
        [run.id],
      );
      if (observationResult.rows.length !== run.observation_count) {
        throw new Error(
          `Action-cost run ${run.id} expected ${run.observation_count} observations, ` +
          `loaded ${observationResult.rows.length}`,
        );
      }
      await client.query("COMMIT");
      return {
        actionCostRunId: run.id,
        chainId: Number(run.chain_id),
        fromBlock: BigInt(run.from_block),
        observations: observationResult.rows.map(observation),
        streamKey: run.stream_key,
        toBlock: BigInt(run.to_block),
        toBlockHash: hash(run.to_block_hash, "source block hash"),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(run: ActionCostValuationRun): Promise<ActionCostValuationSaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO v3_action_cost_valuation_runs (
           schema_version, action_cost_run_id, stream_key, chain_id,
           feed_directory_sha256, feed_directory, eth_feed, quote_feed,
           max_price_age_seconds, quote_decimals, observation_count,
           valid_observations, excluded_observations, complete_fee_components,
           methodology, execution_eligible, computed_at, summary, snapshot
         ) VALUES (
           $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,
           $13,$14,$15,$16,$17,$18::jsonb,$19::jsonb
         ) ON CONFLICT (
           schema_version, action_cost_run_id, feed_directory_sha256,
           max_price_age_seconds
         ) DO NOTHING RETURNING id::text`,
        [
          run.schemaVersion,
          run.source.actionCostRunId,
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
          run.summary.completeFeeComponents,
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
          `SELECT id::text FROM v3_action_cost_valuation_runs
           WHERE schema_version = $1 AND action_cost_run_id = $2 AND
                 feed_directory_sha256 = $3 AND max_price_age_seconds = $4`,
          [
            run.schemaVersion,
            run.source.actionCostRunId,
            run.feedDirectory.sha256,
            run.maxPriceAgeSeconds,
          ],
        );
        runId = existing.rows[0]?.id;
        if (runId === undefined) throw new Error("Action-cost valuation conflict vanished");
        await client.query("COMMIT");
        return { created: false, runId };
      }
      for (const mark of run.marks) await insertMark(client, runId, mark);
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
