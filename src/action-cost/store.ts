import pg, { type PoolClient } from "pg";
import { getAddress, type Hash } from "viem";
import { SCHEMA_SQL } from "../storage/schema.js";
import type {
  ActionCostCandidate,
  ActionCostRun,
  ActionCostSource,
} from "./domain.js";
import { classifyActionMix } from "./evaluate.js";

const { Pool } = pg;

interface CursorRow {
  chain_id: string;
  last_scanned_block: string | null;
  last_scanned_hash: string | null;
  target_set_hash: string;
}

interface CandidateRow {
  block_hash: string;
  block_number: string;
  chain_id: string;
  event_names: string[];
  pool_addresses: string[];
  transaction_hash: string;
  transaction_index: number;
}

export interface ActionCostSaveResult {
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
    throw new Error(`Stored action-cost ${field} is invalid`);
  }
  return value as Hash;
}

function eventCounts(names: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function candidate(row: CandidateRow): ActionCostCandidate {
  const counts = eventCounts(row.event_names);
  return {
    actionClass: classifyActionMix(counts),
    blockHash: hash(row.block_hash, "block hash"),
    blockNumber: BigInt(row.block_number),
    chainId: Number(row.chain_id),
    eventCounts: counts,
    poolAddresses: [...new Set(row.pool_addresses.map(getAddress))].sort((left, right) =>
      left.toLowerCase().localeCompare(right.toLowerCase())
    ),
    transactionHash: hash(row.transaction_hash, "transaction hash"),
    transactionIndex: row.transaction_index,
  };
}

async function insertObservation(
  client: PoolClient,
  observation: ActionCostRun["observations"][number],
): Promise<void> {
  await client.query(
    `INSERT INTO v3_action_cost_observations (
       stream_key, transaction_hash, schema_version, chain_id, block_number,
       block_hash, transaction_index, sender_address, recipient_address,
       selector, input_bytes, action_class, action_names, event_counts,
       pool_addresses, attribution, gas_used, gas_used_for_l1,
       l2_execution_gas_used, effective_gas_price, total_fee_wei,
       l1_data_fee_wei, l2_execution_fee_wei, fee_components_complete,
       execution_eligible, observed_at, snapshot
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,
       $15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::jsonb
     ) ON CONFLICT (stream_key, transaction_hash) DO NOTHING`,
    [
      observation.streamKey,
      observation.transactionHash,
      observation.schemaVersion,
      observation.chainId,
      observation.blockNumber.toString(),
      observation.blockHash,
      observation.transactionIndex,
      observation.from,
      observation.to,
      observation.selector,
      observation.inputBytes,
      observation.actionClass,
      json(observation.actionNames),
      json(observation.eventCounts),
      json(observation.poolAddresses),
      observation.attribution,
      observation.gasUsed.toString(),
      observation.gasUsedForL1?.toString() ?? null,
      observation.l2ExecutionGasUsed?.toString() ?? null,
      observation.effectiveGasPrice.toString(),
      observation.totalFeeWei.toString(),
      observation.l1DataFeeWei?.toString() ?? null,
      observation.l2ExecutionFeeWei?.toString() ?? null,
      observation.feeComponentsComplete,
      observation.executionEligible,
      observation.observedAt,
      json(observation),
    ],
  );
  const exact = await client.query<{ matches: boolean }>(
    `SELECT (
       chain_id = $3 AND block_number = $4 AND lower(block_hash) = lower($5) AND
       transaction_index = $6 AND action_class = $7 AND total_fee_wei = $8
     ) AS matches
     FROM v3_action_cost_observations
     WHERE stream_key = $1 AND lower(transaction_hash) = lower($2)`,
    [
      observation.streamKey,
      observation.transactionHash,
      observation.chainId,
      observation.blockNumber.toString(),
      observation.blockHash,
      observation.transactionIndex,
      observation.actionClass,
      observation.totalFeeWei.toString(),
    ],
  );
  if (exact.rows[0]?.matches !== true) {
    throw new Error(
      `Stored action-cost observation conflicts with ${observation.transactionHash}`,
    );
  }
}

export class PostgresActionCostStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async loadSource(input: {
    readonly lookbackBlocks: number;
    readonly maxPerClass: number;
    readonly streamKey: string;
  }): Promise<ActionCostSource> {
    if (!Number.isSafeInteger(input.lookbackBlocks) || input.lookbackBlocks <= 0) {
      throw new Error("Action-cost lookback must be a positive safe integer");
    }
    if (!Number.isSafeInteger(input.maxPerClass) || input.maxPerClass <= 0) {
      throw new Error("Action-cost class limit must be a positive safe integer");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const cursorResult = await client.query<CursorRow>(
        `SELECT chain_id::text, target_set_hash,
                last_scanned_block::text, last_scanned_hash
         FROM indexer_cursors WHERE stream_key = $1`,
        [input.streamKey],
      );
      const cursor = cursorResult.rows[0];
      if (
        cursor === undefined || cursor.last_scanned_block === null ||
        cursor.last_scanned_hash === null
      ) {
        throw new Error(`Action-cost source cursor is unavailable for ${input.streamKey}`);
      }
      const toBlock = BigInt(cursor.last_scanned_block);
      const lookback = BigInt(input.lookbackBlocks);
      const fromBlock = toBlock + 1n > lookback ? toBlock + 1n - lookback : 0n;
      const result = await client.query<CandidateRow>(
        `SELECT transaction_hash,
                min(chain_id)::text AS chain_id,
                min(block_number)::text AS block_number,
                min(block_hash) AS block_hash,
                min(transaction_index)::int AS transaction_index,
                array_agg(event_name ORDER BY log_index) AS event_names,
                array_agg(pool_address ORDER BY log_index) AS pool_addresses
         FROM v3_pool_events
         WHERE stream_key = $1 AND block_number BETWEEN $2 AND $3
         GROUP BY transaction_hash
         HAVING bool_or(event_name IN ('Mint','Burn','Collect','Swap'))
            AND count(DISTINCT chain_id) = 1
            AND count(DISTINCT block_number) = 1
            AND count(DISTINCT block_hash) = 1
            AND count(DISTINCT transaction_index) = 1
         ORDER BY min(block_number) DESC, min(transaction_index) DESC`,
        [input.streamKey, fromBlock.toString(), toBlock.toString()],
      );
      const all = result.rows.map(candidate);
      const counts = new Map<string, number>();
      const selected = all.filter((entry) => {
        const count = counts.get(entry.actionClass) ?? 0;
        if (count >= input.maxPerClass) return false;
        counts.set(entry.actionClass, count + 1);
        return true;
      });
      await client.query("COMMIT");
      return {
        candidates: selected,
        chainId: Number(cursor.chain_id),
        eligibleCandidates: all.length,
        fromBlock,
        streamKey: input.streamKey,
        targetSetHash: hash(cursor.target_set_hash, "target set hash"),
        toBlock,
        toBlockHash: hash(cursor.last_scanned_hash, "source block hash"),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(run: ActionCostRun): Promise<ActionCostSaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO v3_action_cost_runs (
           schema_version, stream_key, chain_id, from_block, to_block,
           to_block_hash, target_set_hash, max_per_class,
           eligible_candidates, observation_count, complete_fee_components,
           methodology, execution_eligible, captured_at, summary
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
         ON CONFLICT (
           schema_version, stream_key, from_block, to_block, max_per_class
         ) DO NOTHING RETURNING id::text`,
        [
          run.schemaVersion,
          run.source.streamKey,
          run.source.chainId,
          run.source.fromBlock.toString(),
          run.source.toBlock.toString(),
          run.source.toBlockHash,
          run.source.targetSetHash,
          run.maxPerClass,
          run.source.eligibleCandidates,
          run.observations.length,
          run.summary.completeFeeComponents,
          run.methodology,
          run.executionEligible,
          run.capturedAt,
          json(run.summary),
        ],
      );
      let runId = inserted.rows[0]?.id;
      if (runId === undefined) {
        const existing = await client.query<{ id: string }>(
          `SELECT id::text FROM v3_action_cost_runs
           WHERE schema_version = $1 AND stream_key = $2 AND
                 from_block = $3 AND to_block = $4 AND max_per_class = $5`,
          [
            run.schemaVersion,
            run.source.streamKey,
            run.source.fromBlock.toString(),
            run.source.toBlock.toString(),
            run.maxPerClass,
          ],
        );
        runId = existing.rows[0]?.id;
        if (runId === undefined) throw new Error("Action-cost run conflict vanished");
        await client.query("COMMIT");
        return { created: false, runId };
      }
      for (const observation of run.observations) {
        await insertObservation(client, observation);
        await client.query(
          `INSERT INTO v3_action_cost_run_observations (
             run_id, stream_key, transaction_hash
           ) VALUES ($1,$2,$3)`,
          [runId, observation.streamKey, observation.transactionHash],
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
