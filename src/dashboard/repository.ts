import pg, { type PoolClient } from "pg";
import { USDG } from "../constants.js";
import { readRiskGate } from "../risk/gate.js";
import type { DashboardConfig } from "./config.js";
import type {
  ActivityBucket,
  AssetRiskRow,
  DashboardOverview,
  DashboardSnapshot,
  FeeAccountingPoolRow,
  FeeAccountingRunRow,
  FeeAccountingView,
  PoolRow,
  PositionCoverageRow,
  RiskAttemptRow,
  RiskSourceEvidence,
  StableFeeBaselineView,
  StableFeePoolRow,
} from "./domain.js";

const { Pool } = pg;

interface OverviewRow {
  active_positions: string;
  attempt_completed_at: Date | null;
  attempt_id: string | null;
  attempt_started_at: Date | null;
  attempt_status: string | null;
  chain_id: string | null;
  complete_through_block: string | null;
  complete_through_hash: string | null;
  events_applied: string | null;
  index_updated_at: Date | null;
  initialized_ticks: string;
  last_scanned_block: string | null;
  last_scanned_hash: string | null;
  pool_count: string;
  replay_updated_at: Date | null;
  risk_block: string | null;
  risk_eligible: boolean | null;
  risk_observed_at: Date | null;
  risk_reasons: unknown;
  risk_run_id: string | null;
  server_time: Date;
}

interface PoolDbRow {
  active_positions: string;
  event_count: string;
  fee: number;
  initialized: boolean;
  initialized_ticks: string;
  last_event_block: string | null;
  liquidity: string;
  mint_count: string;
  pool_address: string;
  rwa_symbol: string;
  sqrt_price_x96: string | null;
  swap_count: string;
  tick: number | null;
}

interface ActivityDbRow {
  block_end: string;
  block_start: string;
  burn: string;
  collect: string;
  flash: string;
  initialize: string;
  mint: string;
  swap: string;
  total: string;
}

interface PositionDbRow {
  active_liquidity: string;
  active_positions: string;
  distinct_owners: string;
  fee: number;
  max_tick_upper: number | null;
  min_tick_lower: number | null;
  pool_address: string;
  rwa_symbol: string;
}

interface RiskDbRow {
  answer: string | null;
  corporate_action_pending: boolean | null;
  current_multiplier: string | null;
  execution_eligible: boolean;
  feed_decimals: number | null;
  market_hours: string | null;
  multiplier_consistent: boolean | null;
  oracle_address: string | null;
  oracle_age_seconds: string | null;
  oracle_paused: boolean | null;
  reasons: unknown;
  registry_status: string | null;
  rwa_symbol: string;
  trading_tradable: boolean | null;
  ui_multiplier: string | null;
}

interface AttemptDbRow {
  attempted_at: Date;
  block: string | null;
  completed_at: Date | null;
  error: string | null;
  execution_eligible: boolean | null;
  id: string;
  status: string;
}

interface SourceDbRow {
  feed_fetched_at: string | null;
  feed_sha256: string | null;
  feed_url: string | null;
  registry_fetched_at: string | null;
  registry_sha256: string | null;
  registry_url: string | null;
  session_fetched_at: string | null;
  session_sha256: string | null;
  session_status: string | null;
  session_url: string | null;
}

interface AccountingRunDbRow {
  block_hash: string;
  block_number: string;
  events_applied: string;
  id: string;
  observed_at: Date;
  pool_count: string;
  position_count: string;
  schema_version: number;
  tick_count: string;
}

interface AccountingPoolDbRow {
  active_positions: string;
  claimable0: string;
  claimable1: string;
  fee: number;
  pending0: string;
  pending1: string;
  pool_address: string;
  positions: string;
  rwa_symbol: string;
  token0: string;
  token1: string;
  tokens_owed0: string;
  tokens_owed1: string;
}

interface StableFeeBaselineDbRow {
  block_delta: string;
  computed_at: Date;
  elapsed_seconds: string;
  entered_positions: string;
  exited_positions: string;
  from_block: string;
  from_run_id: string;
  id: string;
  limitations: unknown;
  paired_active_positions: string;
  stable_positions: string;
  to_block: string;
  to_run_id: string;
  touched_positions: string;
}

interface StableFeePoolDbRow {
  accrued0: string;
  accrued1: string;
  entered_positions: string;
  exited_positions: string;
  fee: number;
  paired_active_positions: string;
  pool_address: string;
  rwa_symbol: string;
  stable_positions: string;
  token0: string;
  token1: string;
  touched_positions: string;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function accountingTokenSymbol(
  address: string,
  rwaSymbol: string,
): string {
  return address.toLowerCase() === USDG.toLowerCase() ? "USDG" : rwaSymbol;
}

async function feeAccounting(
  client: PoolClient,
  streamKey: string,
): Promise<FeeAccountingView | null> {
  const runResult = await client.query<AccountingRunDbRow>(
    `SELECT id, schema_version, block_number::text, block_hash,
            events_applied::text, observed_at, pool_count::text,
            tick_count::text, position_count::text
     FROM v3_fee_accounting_runs
     WHERE stream_key = $1
     ORDER BY id DESC
     LIMIT 1`,
    [streamKey],
  );
  const run = runResult.rows[0];
  if (run === undefined) return null;

  const poolResult = await client.query<AccountingPoolDbRow>(
    `SELECT pool_address, rwa_symbol, fee, token0, token1,
            positions::text, active_positions::text,
            tokens_owed0::text, tokens_owed1::text,
            pending0::text, pending1::text,
            claimable0::text, claimable1::text
     FROM v3_pool_fee_accounting
     WHERE run_id = $1
     ORDER BY rwa_symbol, fee`,
    [run.id],
  );
  const pools: FeeAccountingPoolRow[] = poolResult.rows.map((row) => ({
    activePositions: row.active_positions,
    claimable0: row.claimable0,
    claimable1: row.claimable1,
    fee: row.fee,
    pending0: row.pending0,
    pending1: row.pending1,
    poolAddress: row.pool_address,
    positions: row.positions,
    rwaSymbol: row.rwa_symbol,
    token0: row.token0,
    token0Symbol: accountingTokenSymbol(row.token0, row.rwa_symbol),
    token1: row.token1,
    token1Symbol: accountingTokenSymbol(row.token1, row.rwa_symbol),
    tokensOwed0: row.tokens_owed0,
    tokensOwed1: row.tokens_owed1,
  }));
  return {
    block: run.block_number,
    blockHash: run.block_hash,
    eventsApplied: run.events_applied,
    observedAt: run.observed_at.toISOString(),
    poolCount: run.pool_count,
    pools,
    positionCount: run.position_count,
    runId: run.id,
    schemaVersion: run.schema_version,
    tickCount: run.tick_count,
  };
}

async function feeAccountingHistory(
  client: PoolClient,
  streamKey: string,
): Promise<FeeAccountingRunRow[]> {
  const result = await client.query<AccountingRunDbRow>(
    `SELECT id, schema_version, block_number::text, block_hash,
            events_applied::text, observed_at, pool_count::text,
            tick_count::text, position_count::text
     FROM v3_fee_accounting_runs
     WHERE stream_key = $1
     ORDER BY id DESC
     LIMIT 32`,
    [streamKey],
  );
  return result.rows.map((row) => ({
    block: row.block_number,
    blockHash: row.block_hash,
    observedAt: row.observed_at.toISOString(),
    poolCount: row.pool_count,
    positionCount: row.position_count,
    runId: row.id,
    tickCount: row.tick_count,
  }));
}

async function stableFeeBaseline(
  client: PoolClient,
  streamKey: string,
): Promise<StableFeeBaselineView | null> {
  const result = await client.query<StableFeeBaselineDbRow>(
    `SELECT b.id, b.from_accounting_run_id AS from_run_id,
            b.to_accounting_run_id AS to_run_id,
            f.block_number::text AS from_block,
            t.block_number::text AS to_block,
            b.computed_at, b.block_delta::text, b.elapsed_seconds::text,
            b.paired_active_positions::text, b.stable_positions::text,
            b.touched_positions::text, b.entered_positions::text,
            b.exited_positions::text, b.limitations
     FROM v3_stable_fee_baseline_runs b
     JOIN v3_fee_accounting_runs f ON f.id = b.from_accounting_run_id
     JOIN v3_fee_accounting_runs t ON t.id = b.to_accounting_run_id
     WHERE b.stream_key = $1
     ORDER BY t.block_number DESC, b.id DESC
     LIMIT 1`,
    [streamKey],
  );
  const baseline = result.rows[0];
  if (baseline === undefined) return null;
  const poolResult = await client.query<StableFeePoolDbRow>(
    `SELECT pool_address, rwa_symbol, fee, token0, token1,
            paired_active_positions::text, stable_positions::text,
            touched_positions::text, entered_positions::text,
            exited_positions::text, accrued0::text, accrued1::text
     FROM v3_stable_fee_pool_baselines
     WHERE baseline_run_id = $1
     ORDER BY rwa_symbol, fee`,
    [baseline.id],
  );
  const pools: StableFeePoolRow[] = poolResult.rows.map((row) => ({
    accrued0: row.accrued0,
    accrued1: row.accrued1,
    enteredPositions: row.entered_positions,
    exitedPositions: row.exited_positions,
    fee: row.fee,
    pairedActivePositions: row.paired_active_positions,
    poolAddress: row.pool_address,
    rwaSymbol: row.rwa_symbol,
    stablePositions: row.stable_positions,
    token0: row.token0,
    token0Symbol: accountingTokenSymbol(row.token0, row.rwa_symbol),
    token1: row.token1,
    token1Symbol: accountingTokenSymbol(row.token1, row.rwa_symbol),
    touchedPositions: row.touched_positions,
  }));
  return {
    baselineId: baseline.id,
    blockDelta: baseline.block_delta,
    computedAt: baseline.computed_at.toISOString(),
    elapsedSeconds: baseline.elapsed_seconds,
    enteredPositions: baseline.entered_positions,
    exitedPositions: baseline.exited_positions,
    fromBlock: baseline.from_block,
    fromRunId: baseline.from_run_id,
    limitations: stringArray(baseline.limitations),
    pairedActivePositions: baseline.paired_active_positions,
    pools,
    stablePositions: baseline.stable_positions,
    toBlock: baseline.to_block,
    toRunId: baseline.to_run_id,
    touchedPositions: baseline.touched_positions,
  };
}

function mapOverview(row: OverviewRow, streamKey: string): DashboardOverview {
  const indexed = row.last_scanned_block === null ? null : BigInt(row.last_scanned_block);
  const replayed = row.complete_through_block === null
    ? null
    : BigInt(row.complete_through_block);
  return {
    activePositions: row.active_positions,
    chainId: row.chain_id === null ? null : Number(row.chain_id),
    indexedEvents: row.events_applied ?? "0",
    indexer: {
      block: row.last_scanned_block,
      hash: row.last_scanned_hash,
      updatedAt: iso(row.index_updated_at),
    },
    initializedTicks: row.initialized_ticks,
    poolCount: row.pool_count,
    replay: {
      block: row.complete_through_block,
      hash: row.complete_through_hash,
      updatedAt: iso(row.replay_updated_at),
    },
    risk: {
      attemptCompletedAt: iso(row.attempt_completed_at),
      attemptId: row.attempt_id,
      attemptStartedAt: iso(row.attempt_started_at),
      attemptStatus: row.attempt_status,
      block: row.risk_block,
      executionEligible: row.risk_eligible,
      observedAt: iso(row.risk_observed_at),
      reasons: stringArray(row.risk_reasons),
      runId: row.risk_run_id,
    },
    serverTime: row.server_time.toISOString(),
    streamKey,
    sync: {
      blockLag: indexed === null || replayed === null
        ? null
        : (indexed - replayed).toString(),
      hashesMatch:
        row.last_scanned_hash === null || row.complete_through_hash === null
          ? null
          : row.last_scanned_hash === row.complete_through_hash,
    },
  };
}

async function overview(client: PoolClient, streamKey: string): Promise<DashboardOverview> {
  const result = await client.query<OverviewRow>(
    `WITH index_cursor AS (
       SELECT chain_id, last_scanned_block, last_scanned_hash, updated_at
       FROM indexer_cursors WHERE stream_key = $1
     ), replay_cursor AS (
       SELECT complete_through_block, complete_through_hash, events_applied, updated_at
       FROM v3_replay_cursors WHERE stream_key = $1
     ), latest_attempt AS (
       SELECT id, status, attempted_at, completed_at
       FROM risk_snapshot_attempts ORDER BY id DESC LIMIT 1
     ), latest_risk AS (
       SELECT id, block_number, observed_at, execution_eligible, reasons
       FROM risk_snapshot_runs ORDER BY id DESC LIMIT 1
     )
     SELECT
       NOW() AS server_time,
       i.chain_id, i.last_scanned_block, i.last_scanned_hash,
       i.updated_at AS index_updated_at,
       r.complete_through_block, r.complete_through_hash, r.events_applied,
       r.updated_at AS replay_updated_at,
       a.id AS attempt_id, a.status AS attempt_status,
       a.attempted_at AS attempt_started_at,
       a.completed_at AS attempt_completed_at,
       risk.id AS risk_run_id, risk.block_number AS risk_block,
       risk.observed_at AS risk_observed_at,
       risk.execution_eligible AS risk_eligible,
       risk.reasons AS risk_reasons,
       (SELECT COUNT(*)::text FROM indexer_pools
        WHERE stream_key = $1 AND enabled) AS pool_count,
       (SELECT COUNT(*)::text FROM v3_replay_ticks
        WHERE stream_key = $1) AS initialized_ticks,
       (SELECT COUNT(*)::text FROM v3_replay_positions
        WHERE stream_key = $1 AND liquidity > 0) AS active_positions
     FROM (SELECT 1) seed
     LEFT JOIN index_cursor i ON TRUE
     LEFT JOIN replay_cursor r ON TRUE
     LEFT JOIN latest_attempt a ON TRUE
     LEFT JOIN latest_risk risk ON TRUE`,
    [streamKey],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Dashboard overview query returned no row");
  }
  return mapOverview(row, streamKey);
}

async function pools(client: PoolClient, streamKey: string): Promise<PoolRow[]> {
  const result = await client.query<PoolDbRow>(
    `WITH ticks AS (
       SELECT pool_address, COUNT(*)::text AS initialized_ticks
       FROM v3_replay_ticks WHERE stream_key = $1 GROUP BY pool_address
     ), positions AS (
       SELECT pool_address, COUNT(*) FILTER (WHERE liquidity > 0)::text AS active_positions
       FROM v3_replay_positions WHERE stream_key = $1 GROUP BY pool_address
     )
     SELECT p.pool_address, p.rwa_symbol, p.fee, p.initialized, p.tick,
            p.liquidity::text, p.sqrt_price_x96::text, p.event_count::text,
            p.mint_count::text, p.swap_count::text, p.last_event_block::text,
            COALESCE(t.initialized_ticks, '0') AS initialized_ticks,
            COALESCE(pos.active_positions, '0') AS active_positions
     FROM v3_replay_pools p
     LEFT JOIN ticks t USING (pool_address)
     LEFT JOIN positions pos USING (pool_address)
     WHERE p.stream_key = $1
     ORDER BY p.rwa_symbol, p.fee`,
    [streamKey],
  );
  return result.rows.map((row) => ({
    activePositions: row.active_positions,
    eventCount: row.event_count,
    fee: row.fee,
    initialized: row.initialized,
    initializedTicks: row.initialized_ticks,
    lastEventBlock: row.last_event_block,
    liquidity: row.liquidity,
    mintCount: row.mint_count,
    poolAddress: row.pool_address,
    rwaSymbol: row.rwa_symbol,
    sqrtPriceX96: row.sqrt_price_x96,
    swapCount: row.swap_count,
    tick: row.tick,
  }));
}

async function activity(
  client: PoolClient,
  config: DashboardConfig,
): Promise<ActivityBucket[]> {
  const result = await client.query<ActivityDbRow>(
    `WITH bounds AS (
       SELECT complete_through_block AS end_block,
              GREATEST(0, complete_through_block - $2::numeric + 1) AS start_block
       FROM v3_replay_cursors WHERE stream_key = $1
     ), bucketed AS (
       SELECT b.end_block,
              FLOOR((e.block_number - b.start_block) / $3::numeric) * $3::numeric
                + b.start_block AS block_start,
              e.event_name
       FROM bounds b
       JOIN v3_pool_events e ON e.stream_key = $1
         AND e.block_number BETWEEN b.start_block AND b.end_block
     )
     SELECT block_start::text,
            LEAST(block_start + $3::numeric - 1, MAX(end_block))::text AS block_end,
            COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE event_name = 'Initialize')::text AS initialize,
            COUNT(*) FILTER (WHERE event_name = 'Mint')::text AS mint,
            COUNT(*) FILTER (WHERE event_name = 'Burn')::text AS burn,
            COUNT(*) FILTER (WHERE event_name = 'Collect')::text AS collect,
            COUNT(*) FILTER (WHERE event_name = 'Swap')::text AS swap,
            COUNT(*) FILTER (WHERE event_name = 'Flash')::text AS flash
     FROM bucketed
     GROUP BY block_start
     ORDER BY block_start`,
    [
      config.streamKey,
      config.activityWindowBlocks,
      config.activityBucketBlocks,
    ],
  );
  return result.rows.map((row) => ({
    blockEnd: row.block_end,
    blockStart: row.block_start,
    burn: row.burn,
    collect: row.collect,
    flash: row.flash,
    initialize: row.initialize,
    mint: row.mint,
    swap: row.swap,
    total: row.total,
  }));
}

async function positions(
  client: PoolClient,
  streamKey: string,
): Promise<PositionCoverageRow[]> {
  const result = await client.query<PositionDbRow>(
    `SELECT p.pool_address, p.rwa_symbol, p.fee,
            COUNT(pos.owner_address) FILTER (WHERE pos.liquidity > 0)::text
              AS active_positions,
            COUNT(DISTINCT pos.owner_address) FILTER (WHERE pos.liquidity > 0)::text
              AS distinct_owners,
            COALESCE(SUM(pos.liquidity) FILTER (WHERE pos.liquidity > 0), 0)::text
              AS active_liquidity,
            MIN(pos.tick_lower) FILTER (WHERE pos.liquidity > 0) AS min_tick_lower,
            MAX(pos.tick_upper) FILTER (WHERE pos.liquidity > 0) AS max_tick_upper
     FROM v3_replay_pools p
     LEFT JOIN v3_replay_positions pos
       ON pos.stream_key = p.stream_key AND pos.pool_address = p.pool_address
     WHERE p.stream_key = $1
     GROUP BY p.pool_address, p.rwa_symbol, p.fee
     ORDER BY p.rwa_symbol, p.fee`,
    [streamKey],
  );
  return result.rows.map((row) => ({
    activeLiquidity: row.active_liquidity,
    activePositions: row.active_positions,
    distinctOwners: row.distinct_owners,
    fee: row.fee,
    maxTickUpper: row.max_tick_upper,
    minTickLower: row.min_tick_lower,
    poolAddress: row.pool_address,
    rwaSymbol: row.rwa_symbol,
  }));
}

async function riskAssets(client: PoolClient): Promise<AssetRiskRow[]> {
  const result = await client.query<RiskDbRow>(
    `WITH latest AS (SELECT id FROM risk_snapshot_runs ORDER BY id DESC LIMIT 1)
     SELECT a.symbol AS rwa_symbol, a.oracle_address, a.execution_eligible,
            a.reasons,
            (a.snapshot->'registry'->>'status') AS registry_status,
            (a.snapshot->'registry'->>'currentMultiplier') AS current_multiplier,
            (a.snapshot->'onchain'->>'uiMultiplier') AS ui_multiplier,
            (a.snapshot->'onchain'->>'oraclePaused')::boolean AS oracle_paused,
            (a.snapshot->'flags'->>'corporateActionPending')::boolean
              AS corporate_action_pending,
            (a.snapshot->'flags'->>'multiplierConsistent')::boolean
              AS multiplier_consistent,
            (a.snapshot->'flags'->>'tradingCapabilitiesTradable')::boolean
              AS trading_tradable,
            (a.snapshot->'oracle'->>'priceAgeSeconds') AS oracle_age_seconds,
            (a.snapshot->'oracle'->'state'->>'answer') AS answer,
            (a.snapshot->'oracle'->'state'->>'decimals')::integer AS feed_decimals,
            (a.snapshot->'oracle'->'feed'->>'marketHours') AS market_hours
     FROM asset_risk_snapshots a
     JOIN latest ON latest.id = a.run_id
     ORDER BY a.symbol`,
  );
  return result.rows.map((row) => ({
    answer: row.answer,
    corporateActionPending: row.corporate_action_pending,
    currentMultiplier: row.current_multiplier,
    executionEligible: row.execution_eligible,
    feedDecimals: row.feed_decimals,
    marketHours: row.market_hours,
    multiplierConsistent: row.multiplier_consistent,
    oracleAddress: row.oracle_address,
    oracleAgeSeconds: row.oracle_age_seconds,
    oraclePaused: row.oracle_paused,
    reasons: stringArray(row.reasons),
    registryStatus: row.registry_status,
    rwaSymbol: row.rwa_symbol,
    tradingTradable: row.trading_tradable,
    uiMultiplier: row.ui_multiplier,
  }));
}

async function attempts(client: PoolClient): Promise<RiskAttemptRow[]> {
  const result = await client.query<AttemptDbRow>(
    `SELECT a.id, a.status, a.attempted_at, a.completed_at, a.error,
            r.block_number::text AS block, r.execution_eligible
     FROM risk_snapshot_attempts a
     LEFT JOIN risk_snapshot_runs r ON r.id = a.risk_run_id
     ORDER BY a.id DESC LIMIT 12`,
  );
  return result.rows.map((row) => ({
    attemptedAt: row.attempted_at.toISOString(),
    block: row.block,
    completedAt: iso(row.completed_at),
    error: row.error,
    executionEligible: row.execution_eligible,
    id: row.id,
    status: row.status,
  }));
}

async function sources(client: PoolClient): Promise<RiskSourceEvidence> {
  const result = await client.query<SourceDbRow>(
    `SELECT snapshot->'registry'->>'url' AS registry_url,
            snapshot->'registry'->>'fetchedAt' AS registry_fetched_at,
            snapshot->'registry'->>'sha256' AS registry_sha256,
            snapshot->'feedDirectory'->>'url' AS feed_url,
            snapshot->'feedDirectory'->>'fetchedAt' AS feed_fetched_at,
            snapshot->'feedDirectory'->>'sha256' AS feed_sha256,
            snapshot->'marketSession'->'evidence'->>'url' AS session_url,
            snapshot->'marketSession'->'evidence'->>'fetchedAt' AS session_fetched_at,
            snapshot->'marketSession'->'evidence'->>'sha256' AS session_sha256,
            snapshot->'marketSession'->>'status' AS session_status
     FROM risk_snapshot_runs ORDER BY id DESC LIMIT 1`,
  );
  const row = result.rows[0];
  return {
    feedDirectory: {
      fetchedAt: row?.feed_fetched_at ?? null,
      sha256: row?.feed_sha256 ?? null,
      url: row?.feed_url ?? null,
    },
    registry: {
      fetchedAt: row?.registry_fetched_at ?? null,
      sha256: row?.registry_sha256 ?? null,
      url: row?.registry_url ?? null,
    },
    marketSession: {
      fetchedAt: row?.session_fetched_at ?? null,
      sha256: row?.session_sha256 ?? null,
      status: row?.session_status ?? null,
      url: row?.session_url ?? null,
    },
  };
}

export class DashboardRepository {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(private readonly config: DashboardConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 4,
      options: "-c default_transaction_read_only=on",
    });
  }

  public async snapshot(): Promise<DashboardSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const data = {
        accounting: await feeAccounting(client, this.config.streamKey),
        accountingHistory: await feeAccountingHistory(
          client,
          this.config.streamKey,
        ),
        activity: await activity(client, this.config),
        attempts: await attempts(client),
        overview: await overview(client, this.config.streamKey),
        pools: await pools(client, this.config.streamKey),
        positions: await positions(client, this.config.streamKey),
        refreshMs: this.config.refreshMs,
        riskGate: await readRiskGate(
          client,
          this.config.streamKey,
          this.config.riskGateMaxSnapshotAgeSeconds,
          this.config.riskGateMaxCanonicalityAgeSeconds,
        ),
        riskAssets: await riskAssets(client),
        sources: await sources(client),
        stableFeeBaseline: await stableFeeBaseline(
          client,
          this.config.streamKey,
        ),
      } satisfies DashboardSnapshot;
      await client.query("COMMIT");
      return data;
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
