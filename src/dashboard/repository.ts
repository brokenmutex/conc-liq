import { assertSchemaReady } from "../storage/compatibility.js";
import pg, { type PoolClient } from "pg";
import { USDG } from "../constants.js";
import { readRiskGate } from "../risk/gate.js";
import type { DashboardConfig } from "./config.js";
import { readPaperDashboard } from "./paper.js";
import { readDashboardFocus } from "./focus.js";
import type {
  ActivityBucket,
  AssetRiskRow,
  DashboardOverview,
  DashboardSnapshot,
  FeeAccountingPoolRow,
  FeeAccountingRunRow,
  FeeAccountingView,
  OracleCalibrationMarkRow,
  OracleCalibrationView,
  PoolRow,
  PositionCoverageRow,
  PrincipalAccountingView,
  PrincipalPoolRow,
  RangePolicyReplayCandidateRow,
  RangePolicyReplayView,
  RangeSimulationCandidateRow,
  RangeSimulationView,
  RiskAttemptRow,
  RiskSourceEvidence,
  StableFeeBaselineView,
  StableFeePoolRow,
  TrackedNftPositionRow,
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

interface PrincipalRunDbRow {
  above_range_positions: string;
  accounting_run_id: string;
  below_range_positions: string;
  block_hash: string;
  block_number: string;
  computed_at: Date;
  id: string;
  in_range_positions: string;
  pool_count: string;
  position_count: string;
  schema_version: number;
}

interface PrincipalPoolDbRow {
  above_range_positions: string;
  amount0: string;
  amount1: string;
  below_range_positions: string;
  fee: number;
  in_range_positions: string;
  pool_address: string;
  position_count: string;
  rwa_symbol: string;
  token0: string;
  token1: string;
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

interface TrackedNftPositionDbRow {
  accounting_run_id: string;
  block_hash: string;
  block_number: string;
  claimable0: string;
  claimable1: string;
  computed_at: Date;
  current_tick: number;
  fee: number;
  liquidity: string;
  owner_address: string;
  pending0: string;
  pending1: string;
  pool_address: string;
  principal0: string;
  principal1: string;
  region: string;
  rwa_symbol: string;
  tick_lower: number;
  tick_upper: number;
  token0: string;
  token0_decimals: number;
  token1: string;
  token1_decimals: number;
  token_id: string;
}

interface RangeSimulationDbRow {
  assumptions: unknown;
  budget_quote: string;
  completed_candidates: number;
  computed_at: Date;
  cost_quote: string;
  excluded_candidates: number;
  fee: number;
  from_block: string;
  from_run_id: string;
  id: string;
  path_max_tick: number;
  path_min_tick: number;
  pool_address: string;
  quote_decimals: number;
  rwa_symbol: string;
  swap_count: string;
  tick_spacing: number;
  to_block: string;
  to_run_id: string;
}

interface RangeSimulationCandidateDbRow {
  absolute_pnl_quote: string | null;
  divergence_quote: string | null;
  exclusion_reason: string | null;
  fee_value_quote: string | null;
  half_width_spacings: number;
  liquidity_share_ppm: string;
  lp_alpha_quote: string | null;
  net_end_value_quote: string | null;
  rank: number | null;
  status: string;
  tick_lower: number;
  tick_upper: number;
}

interface RangePolicyReplayDbRow {
  assumptions: unknown;
  budget_quote: string;
  checkpoint_count: number;
  completed_candidates: number;
  computed_at: Date;
  entry_cost_quote: string;
  excluded_candidates: number;
  fee: number;
  first_block: string;
  first_run_id: string;
  id: string;
  interval_count: number;
  last_block: string;
  last_run_id: string;
  pool_address: string;
  quote_decimals: number;
  rebalance_cost_quote: string;
  rwa_symbol: string;
  tick_spacing: number;
  trigger_percent: number;
}

interface RangePolicyReplayCandidateDbRow {
  absolute_pnl_quote: string | null;
  completed_intervals: number;
  failure_reason: string | null;
  failure_run_id: string | null;
  fee_value_quote: string;
  final_nav_quote: string | null;
  half_width_spacings: number;
  lp_alpha_quote: string | null;
  max_drawdown_ppm: string;
  rank: number | null;
  rebalances: number;
  status: string;
  total_cost_quote: string;
}

interface OracleCalibrationDbRow {
  assumptions: unknown;
  computed_at: Date;
  excluded_marks: number;
  feed_directory_fetched_at: Date;
  feed_directory_sha256: string;
  fee: number;
  first_run_id: string;
  id: string;
  last_run_id: string;
  max_price_age_seconds: number;
  pool_address: string;
  quote_feed_address: string;
  rwa_feed_address: string;
  rwa_symbol: string;
  valid_marks: number;
}

interface OracleCalibrationMarkDbRow {
  accounting_run_id: string;
  block_number: string;
  block_timestamp: string;
  deviation_ppm: string | null;
  oracle_price_x18: string | null;
  pool_price_x18: string;
  quote_oracle_age_seconds: string | null;
  reasons: unknown;
  rwa_oracle_age_seconds: string | null;
  status: string;
  token_new_ui_multiplier: string | null;
  token_oracle_paused: boolean | null;
  token_ui_multiplier: string | null;
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

async function principalAccounting(
  client: PoolClient,
  streamKey: string,
): Promise<PrincipalAccountingView | null> {
  const result = await client.query<PrincipalRunDbRow>(
    `SELECT p.id, p.schema_version,
            p.accounting_run_id::text AS accounting_run_id,
            a.block_number::text, a.block_hash, p.computed_at,
            p.pool_count::text, p.position_count::text,
            p.below_range_positions::text, p.in_range_positions::text,
            p.above_range_positions::text
     FROM v3_principal_accounting_runs p
     JOIN v3_fee_accounting_runs a ON a.id = p.accounting_run_id
     WHERE a.stream_key = $1
     ORDER BY a.block_number DESC, p.id DESC
     LIMIT 1`,
    [streamKey],
  );
  const principal = result.rows[0];
  if (principal === undefined) return null;
  const poolResult = await client.query<PrincipalPoolDbRow>(
    `SELECT pool_address, rwa_symbol, fee, token0, token1,
            position_count::text, below_range_positions::text,
            in_range_positions::text, above_range_positions::text,
            amount0::text, amount1::text
     FROM v3_pool_principal_accounting
     WHERE principal_run_id = $1
     ORDER BY rwa_symbol, fee`,
    [principal.id],
  );
  const pools: PrincipalPoolRow[] = poolResult.rows.map((pool) => ({
    aboveRangePositions: pool.above_range_positions,
    amount0: pool.amount0,
    amount1: pool.amount1,
    belowRangePositions: pool.below_range_positions,
    fee: pool.fee,
    inRangePositions: pool.in_range_positions,
    poolAddress: pool.pool_address,
    positionCount: pool.position_count,
    rwaSymbol: pool.rwa_symbol,
    token0: pool.token0,
    token0Symbol: accountingTokenSymbol(pool.token0, pool.rwa_symbol),
    token1: pool.token1,
    token1Symbol: accountingTokenSymbol(pool.token1, pool.rwa_symbol),
  }));
  return {
    aboveRangePositions: principal.above_range_positions,
    accountingRunId: principal.accounting_run_id,
    belowRangePositions: principal.below_range_positions,
    block: principal.block_number,
    blockHash: principal.block_hash,
    computedAt: principal.computed_at.toISOString(),
    inRangePositions: principal.in_range_positions,
    poolCount: principal.pool_count,
    pools,
    positionCount: principal.position_count,
    principalRunId: principal.id,
    schemaVersion: principal.schema_version,
  };
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

async function trackedNftPositions(
  client: PoolClient,
  streamKey: string,
): Promise<TrackedNftPositionRow[]> {
  const result = await client.query<TrackedNftPositionDbRow>(
    `SELECT *
     FROM (
       SELECT DISTINCT ON (n.position_manager, n.token_id)
              n.accounting_run_id::text, a.block_number::text,
              a.block_hash, n.computed_at, n.token_id::text,
              n.owner_address, n.pool_address, n.rwa_symbol, n.fee,
              n.token0, n.token1, n.token0_decimals, n.token1_decimals,
              n.tick_lower, n.tick_upper, n.current_tick,
              n.liquidity::text, n.region, n.principal0::text,
              n.principal1::text, n.pending0::text, n.pending1::text,
              n.claimable0::text, n.claimable1::text
       FROM v3_nft_position_snapshots n
       JOIN v3_fee_accounting_runs a ON a.id = n.accounting_run_id
       WHERE a.stream_key = $1
       ORDER BY n.position_manager, n.token_id,
                a.block_number DESC, n.id DESC
     ) latest
     ORDER BY rwa_symbol, fee, token_id::numeric`,
    [streamKey],
  );
  return result.rows.map((row) => ({
    accountingRunId: row.accounting_run_id,
    block: row.block_number,
    blockHash: row.block_hash,
    claimable0: row.claimable0,
    claimable1: row.claimable1,
    computedAt: row.computed_at.toISOString(),
    currentTick: row.current_tick,
    fee: row.fee,
    liquidity: row.liquidity,
    ownerAddress: row.owner_address,
    pending0: row.pending0,
    pending1: row.pending1,
    poolAddress: row.pool_address,
    principal0: row.principal0,
    principal1: row.principal1,
    region: row.region,
    rwaSymbol: row.rwa_symbol,
    tickLower: row.tick_lower,
    tickUpper: row.tick_upper,
    token0: row.token0,
    token0Decimals: row.token0_decimals,
    token0Symbol: accountingTokenSymbol(row.token0, row.rwa_symbol),
    token1: row.token1,
    token1Decimals: row.token1_decimals,
    token1Symbol: accountingTokenSymbol(row.token1, row.rwa_symbol),
    tokenId: row.token_id,
  }));
}

async function rangeSimulation(
  client: PoolClient,
  streamKey: string,
): Promise<RangeSimulationView | null> {
  const result = await client.query<RangeSimulationDbRow>(
    `SELECT s.id, s.computed_at, s.pool_address, s.rwa_symbol, s.fee,
            s.quote_decimals, s.budget_quote::text, s.cost_quote::text,
            s.tick_spacing, s.path_min_tick, s.path_max_tick,
            s.swap_count::text, s.completed_candidates,
            s.excluded_candidates, s.assumptions,
            s.from_accounting_run_id::text AS from_run_id,
            s.to_accounting_run_id::text AS to_run_id,
            f.block_number::text AS from_block,
            t.block_number::text AS to_block
     FROM v3_range_simulation_runs s
     JOIN v3_fee_accounting_runs f ON f.id = s.from_accounting_run_id
     JOIN v3_fee_accounting_runs t ON t.id = s.to_accounting_run_id
     WHERE s.stream_key = $1
     ORDER BY s.computed_at DESC, s.id DESC
     LIMIT 1`,
    [streamKey],
  );
  const simulation = result.rows[0];
  if (simulation === undefined) return null;
  const candidates = await client.query<RangeSimulationCandidateDbRow>(
    `SELECT half_width_spacings, tick_lower, tick_upper, status,
            exclusion_reason, rank, liquidity_share_ppm::text,
            fee_value_quote::text, net_end_value_quote::text,
            divergence_quote::text, absolute_pnl_quote::text,
            lp_alpha_quote::text
     FROM v3_range_simulation_candidates
     WHERE simulation_run_id = $1
     ORDER BY half_width_spacings`,
    [simulation.id],
  );
  const mapped: RangeSimulationCandidateRow[] = candidates.rows.map((row) => ({
    absolutePnlQuote: row.absolute_pnl_quote,
    divergenceQuote: row.divergence_quote,
    exclusionReason: row.exclusion_reason,
    feeValueQuote: row.fee_value_quote,
    halfWidthSpacings: row.half_width_spacings,
    liquiditySharePpm: row.liquidity_share_ppm,
    lpAlphaQuote: row.lp_alpha_quote,
    netEndValueQuote: row.net_end_value_quote,
    rank: row.rank,
    status: row.status,
    tickLower: row.tick_lower,
    tickUpper: row.tick_upper,
  }));
  return {
    assumptions: stringArray(simulation.assumptions),
    budgetQuote: simulation.budget_quote,
    candidates: mapped,
    completedCandidates: simulation.completed_candidates,
    computedAt: simulation.computed_at.toISOString(),
    costQuote: simulation.cost_quote,
    excludedCandidates: simulation.excluded_candidates,
    fee: simulation.fee,
    fromBlock: simulation.from_block,
    fromRunId: simulation.from_run_id,
    pathMaxTick: simulation.path_max_tick,
    pathMinTick: simulation.path_min_tick,
    poolAddress: simulation.pool_address,
    quoteDecimals: simulation.quote_decimals,
    rwaSymbol: simulation.rwa_symbol,
    simulationRunId: simulation.id,
    swapCount: simulation.swap_count,
    tickSpacing: simulation.tick_spacing,
    toBlock: simulation.to_block,
    toRunId: simulation.to_run_id,
  };
}

async function rangePolicyReplay(
  client: PoolClient,
  streamKey: string,
): Promise<RangePolicyReplayView | null> {
  const result = await client.query<RangePolicyReplayDbRow>(
    `SELECT r.id, r.computed_at, r.pool_address, r.rwa_symbol, r.fee,
            r.quote_decimals, r.budget_quote::text,
            r.entry_cost_quote::text, r.rebalance_cost_quote::text,
            r.trigger_percent, r.tick_spacing, r.checkpoint_count,
            r.interval_count, r.completed_candidates, r.excluded_candidates,
            r.assumptions,
            r.first_accounting_run_id::text AS first_run_id,
            r.last_accounting_run_id::text AS last_run_id,
            f.block_number::text AS first_block,
            l.block_number::text AS last_block
     FROM v3_range_policy_replay_runs r
     JOIN v3_fee_accounting_runs f ON f.id = r.first_accounting_run_id
     JOIN v3_fee_accounting_runs l ON l.id = r.last_accounting_run_id
     WHERE r.stream_key = $1
     ORDER BY r.computed_at DESC, r.id DESC
     LIMIT 1`,
    [streamKey],
  );
  const replay = result.rows[0];
  if (replay === undefined) return null;
  const candidates = await client.query<RangePolicyReplayCandidateDbRow>(
    `SELECT half_width_spacings, status, failure_reason,
            failure_run_id::text, rank,
            completed_intervals, rebalances, total_cost_quote::text,
            fee_value_quote::text, max_drawdown_ppm::text,
            final_nav_quote::text, absolute_pnl_quote::text,
            lp_alpha_quote::text
     FROM v3_range_policy_replay_candidates
     WHERE replay_run_id = $1
     ORDER BY half_width_spacings`,
    [replay.id],
  );
  const mapped: RangePolicyReplayCandidateRow[] = candidates.rows.map((row) => ({
    absolutePnlQuote: row.absolute_pnl_quote,
    completedIntervals: row.completed_intervals,
    failureReason: row.failure_reason,
    failureRunId: row.failure_run_id,
    feeValueQuote: row.fee_value_quote,
    finalNavQuote: row.final_nav_quote,
    halfWidthSpacings: row.half_width_spacings,
    lpAlphaQuote: row.lp_alpha_quote,
    maxDrawdownPpm: row.max_drawdown_ppm,
    rank: row.rank,
    rebalances: row.rebalances,
    status: row.status,
    totalCostQuote: row.total_cost_quote,
  }));
  return {
    assumptions: stringArray(replay.assumptions),
    budgetQuote: replay.budget_quote,
    candidates: mapped,
    checkpointCount: replay.checkpoint_count,
    completedCandidates: replay.completed_candidates,
    computedAt: replay.computed_at.toISOString(),
    entryCostQuote: replay.entry_cost_quote,
    excludedCandidates: replay.excluded_candidates,
    fee: replay.fee,
    firstBlock: replay.first_block,
    firstRunId: replay.first_run_id,
    intervalCount: replay.interval_count,
    lastBlock: replay.last_block,
    lastRunId: replay.last_run_id,
    poolAddress: replay.pool_address,
    quoteDecimals: replay.quote_decimals,
    rebalanceCostQuote: replay.rebalance_cost_quote,
    replayRunId: replay.id,
    rwaSymbol: replay.rwa_symbol,
    tickSpacing: replay.tick_spacing,
    triggerPercent: replay.trigger_percent,
  };
}

async function oracleCalibration(
  client: PoolClient,
  streamKey: string,
): Promise<OracleCalibrationView | null> {
  const result = await client.query<OracleCalibrationDbRow>(
    `SELECT c.id, c.computed_at, c.pool_address, c.rwa_symbol, c.fee,
            c.max_price_age_seconds, c.rwa_feed_address,
            c.quote_feed_address, c.feed_directory_fetched_at,
            c.feed_directory_sha256, c.valid_marks, c.excluded_marks,
            c.assumptions,
            c.first_accounting_run_id::text AS first_run_id,
            c.last_accounting_run_id::text AS last_run_id
     FROM v3_range_oracle_calibration_runs c
     WHERE c.stream_key = $1
     ORDER BY c.computed_at DESC, c.id DESC
     LIMIT 1`,
    [streamKey],
  );
  const calibration = result.rows[0];
  if (calibration === undefined) return null;
  const marks = await client.query<OracleCalibrationMarkDbRow>(
    `SELECT m.accounting_run_id::text, a.block_number::text,
            m.mark->>'blockTimestamp' AS block_timestamp, m.status,
            m.reasons, m.pool_price_x18::text, m.oracle_price_x18::text,
            m.deviation_ppm::text, m.rwa_oracle_age_seconds::text,
            m.quote_oracle_age_seconds::text,
            m.token_ui_multiplier::text,
            m.token_new_ui_multiplier::text, m.token_oracle_paused
     FROM v3_range_oracle_calibration_marks m
     JOIN v3_fee_accounting_runs a ON a.id = m.accounting_run_id
     WHERE m.calibration_run_id = $1
     ORDER BY a.block_number, a.id`,
    [calibration.id],
  );
  const mapped: OracleCalibrationMarkRow[] = marks.rows.map((mark) => ({
    accountingRunId: mark.accounting_run_id,
    blockNumber: mark.block_number,
    blockTimestamp: mark.block_timestamp,
    deviationPpm: mark.deviation_ppm,
    oraclePaused: mark.token_oracle_paused,
    oraclePriceX18: mark.oracle_price_x18,
    poolPriceX18: mark.pool_price_x18,
    quoteOracleAgeSeconds: mark.quote_oracle_age_seconds,
    reasons: stringArray(mark.reasons),
    rwaOracleAgeSeconds: mark.rwa_oracle_age_seconds,
    status: mark.status,
    tokenNewUiMultiplier: mark.token_new_ui_multiplier,
    tokenUiMultiplier: mark.token_ui_multiplier,
  }));
  return {
    assumptions: stringArray(calibration.assumptions),
    calibrationRunId: calibration.id,
    computedAt: calibration.computed_at.toISOString(),
    excludedMarks: calibration.excluded_marks,
    feedDirectoryFetchedAt: calibration.feed_directory_fetched_at.toISOString(),
    feedDirectorySha256: calibration.feed_directory_sha256,
    fee: calibration.fee,
    firstRunId: calibration.first_run_id,
    lastRunId: calibration.last_run_id,
    marks: mapped,
    maxPriceAgeSeconds: calibration.max_price_age_seconds,
    poolAddress: calibration.pool_address,
    quoteFeedAddress: calibration.quote_feed_address,
    rwaFeedAddress: calibration.rwa_feed_address,
    rwaSymbol: calibration.rwa_symbol,
    validMarks: calibration.valid_marks,
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

  public async assertReady(): Promise<void> { await assertSchemaReady(this.pool); }

  public async snapshot(): Promise<DashboardSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const data = {
        focus: await readDashboardFocus(client, this.config),
        paper: await readPaperDashboard(client, this.config.streamKey),
        accounting: await feeAccounting(client, this.config.streamKey),
        accountingHistory: await feeAccountingHistory(
          client,
          this.config.streamKey,
        ),
        activity: await activity(client, this.config),
        attempts: await attempts(client),
        oracleCalibration: await oracleCalibration(
          client,
          this.config.streamKey,
        ),
        overview: await overview(client, this.config.streamKey),
        pools: await pools(client, this.config.streamKey),
        positions: await positions(client, this.config.streamKey),
        principal: await principalAccounting(client, this.config.streamKey),
        rangePolicyReplay: await rangePolicyReplay(
          client,
          this.config.streamKey,
        ),
        rangeSimulation: await rangeSimulation(client, this.config.streamKey),
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
        trackedNftPositions: await trackedNftPositions(
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
