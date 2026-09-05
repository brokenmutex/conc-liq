import pg, { type PoolClient } from "pg";
import { getAddress, type Hash } from "viem";
import { USDG } from "../constants.js";
import { SCHEMA_SQL } from "../storage/schema.js";
import type {
  ApprovalCostRun,
  ApprovalCostUniverse,
  ApprovalTokenTarget,
} from "./domain.js";

const { Pool } = pg;

interface CursorRow {
  chain_id: string;
  last_scanned_block: string | null;
  last_scanned_hash: string | null;
  target_set_hash: string;
}

interface TokenRow {
  rwa_address: string;
  rwa_symbol: string;
}

export interface ApprovalCostSaveResult {
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
    throw new Error(`Stored approval-cost ${field} is invalid`);
  }
  return value as Hash;
}

async function insertObservation(
  client: PoolClient,
  runId: string,
  observation: ApprovalCostRun["observations"][number],
): Promise<void> {
  await client.query(
    `INSERT INTO v3_approval_cost_observations (
       run_id, transaction_hash, block_number, block_hash, transaction_index,
       token_addresses, approval_events, owner_address, spender_address,
       approved_value, allowance_before, allowance_after, allowance_transition,
       recipient_address, selector, status, reasons, gas_used, gas_used_for_l1,
       l2_execution_gas_used, effective_gas_price, total_fee_wei,
       l1_data_fee_wei, l2_execution_fee_wei, fee_components_complete,
       attribution, execution_eligible, observed_at, snapshot
     ) VALUES (
       $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,
       $16,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb
     )`,
    [
      runId,
      observation.transactionHash,
      observation.blockNumber.toString(),
      observation.blockHash,
      observation.transactionIndex,
      json(observation.tokenAddresses),
      json(observation.approvals),
      observation.owner,
      observation.spender,
      observation.approvedValue?.toString() ?? null,
      observation.allowanceBefore?.toString() ?? null,
      observation.allowanceAfter?.toString() ?? null,
      observation.allowanceTransition,
      observation.recipient,
      observation.selector,
      observation.status,
      json(observation.reasons),
      observation.gasUsed.toString(),
      observation.gasUsedForL1?.toString() ?? null,
      observation.l2ExecutionGasUsed?.toString() ?? null,
      observation.effectiveGasPrice.toString(),
      observation.totalFeeWei.toString(),
      observation.l1DataFeeWei?.toString() ?? null,
      observation.l2ExecutionFeeWei?.toString() ?? null,
      observation.feeComponentsComplete,
      observation.attribution,
      observation.executionEligible,
      observation.observedAt,
      json(observation),
    ],
  );
}

export class PostgresApprovalCostStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async loadUniverse(input: {
    readonly lookbackBlocks: number;
    readonly positionManager: ApprovalCostUniverse["positionManager"];
    readonly streamKey: string;
  }): Promise<ApprovalCostUniverse> {
    if (!Number.isSafeInteger(input.lookbackBlocks) || input.lookbackBlocks <= 0) {
      throw new Error("Approval lookback must be a positive safe integer");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const cursorResult = await client.query<CursorRow>(
        `SELECT chain_id::text, target_set_hash, last_scanned_block::text,
                last_scanned_hash
         FROM indexer_cursors WHERE stream_key = $1`,
        [input.streamKey],
      );
      const cursor = cursorResult.rows[0];
      if (
        cursor === undefined || cursor.last_scanned_block === null ||
        cursor.last_scanned_hash === null
      ) {
        throw new Error(`Approval source cursor is unavailable for ${input.streamKey}`);
      }
      const tokenResult = await client.query<TokenRow>(
        `SELECT DISTINCT rwa_address, rwa_symbol FROM indexer_pools
         WHERE stream_key = $1 AND enabled
         ORDER BY rwa_symbol, rwa_address`,
        [input.streamKey],
      );
      const tokens: ApprovalTokenTarget[] = [{ address: USDG, symbol: "USDG" }];
      const known = new Map([[USDG.toLowerCase(), "USDG"]]);
      for (const row of tokenResult.rows) {
        const address = getAddress(row.rwa_address);
        const prior = known.get(address.toLowerCase());
        if (prior !== undefined && prior !== row.rwa_symbol) {
          throw new Error(`Token ${address} has conflicting symbols ${prior}/${row.rwa_symbol}`);
        }
        if (prior === undefined) {
          known.set(address.toLowerCase(), row.rwa_symbol);
          tokens.push({ address, symbol: row.rwa_symbol });
        }
      }
      if (tokens.length === 1) throw new Error("Approval source has no enabled RWA tokens");
      const toBlock = BigInt(cursor.last_scanned_block);
      const lookback = BigInt(input.lookbackBlocks);
      const fromBlock = toBlock + 1n > lookback ? toBlock + 1n - lookback : 0n;
      await client.query("COMMIT");
      return {
        chainId: Number(cursor.chain_id),
        fromBlock,
        positionManager: input.positionManager,
        streamKey: input.streamKey,
        targetSetHash: hash(cursor.target_set_hash, "target set hash"),
        tokens,
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

  public async save(run: ApprovalCostRun): Promise<ApprovalCostSaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO v3_approval_cost_runs (
           schema_version, stream_key, chain_id, from_block, to_block,
           to_block_hash, target_set_hash, position_manager_address,
           max_per_token, eligible_candidates, selected_candidates,
           comparable_observations, excluded_observations, methodology,
           execution_eligible, captured_at, summary, snapshot
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
           $17::jsonb,$18::jsonb
         ) ON CONFLICT (
           schema_version, stream_key, from_block, to_block, max_per_token,
           position_manager_address
         ) DO NOTHING RETURNING id::text`,
        [
          run.schemaVersion,
          run.source.streamKey,
          run.source.chainId,
          run.source.fromBlock.toString(),
          run.source.toBlock.toString(),
          run.source.toBlockHash,
          run.source.targetSetHash,
          run.source.positionManager,
          run.maxPerToken,
          run.source.eligibleCandidates,
          run.observations.length,
          run.summary.comparableObservations,
          run.summary.excludedObservations,
          run.methodology,
          run.executionEligible,
          run.capturedAt,
          json(run.summary),
          json(run),
        ],
      );
      let runId = inserted.rows[0]?.id;
      if (runId === undefined) {
        const existing = await client.query<{ id: string }>(
          `SELECT id::text FROM v3_approval_cost_runs
           WHERE schema_version = $1 AND stream_key = $2 AND from_block = $3 AND
                 to_block = $4 AND max_per_token = $5 AND
                 lower(position_manager_address) = lower($6)`,
          [
            run.schemaVersion,
            run.source.streamKey,
            run.source.fromBlock.toString(),
            run.source.toBlock.toString(),
            run.maxPerToken,
            run.source.positionManager,
          ],
        );
        runId = existing.rows[0]?.id;
        if (runId === undefined) throw new Error("Approval-cost run conflict vanished");
        await client.query("COMMIT");
        return { created: false, runId };
      }
      for (const observation of run.observations) {
        await insertObservation(client, runId, observation);
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
