// Read-only RWA pool research model.
//
// The page compares what a unit of liquidity earns across the indexed pool
// universe, so every number here is derived the same way the bounded universe
// screen derives it: fees come from the recorded Swap amounts (the pool charges
// `fee` pips of the input token) net of the protocol's cut, both legs are
// valued in USDG at the pool's own price, and active liquidity comes from the
// strategy checkpoints.
//
// Nothing here authorizes execution. The reference-position columns are a
// modeled no-rebalance entry over recorded flow, not realized LP performance.
import type { PoolClient } from "pg";
import { USDG } from "../constants.js";
import {
  sizeLiquidityForQuoteBudget,
  tickSpacingForFee,
} from "../simulator/math.js";

/** Trailing windows the page offers, in hours. */
export const RESEARCH_WINDOW_HOURS = [0.25, 1, 6, 24, 168] as const;

/**
 * Reference half-widths, as price fractions rounded out to the pool grid. The
 * set spans from about one tick spacing on the 500 tier out to a range wide
 * enough to hold through a weekend gap, because occupancy and liquidity share
 * pull in opposite directions and the useful width is a pool property. Widths
 * that round to the same grid ticks for a pool report the same numbers, which
 * is what a coarse tier genuinely offers.
 */
export const RESEARCH_HALF_WIDTH_FRACTIONS = [
  0.001,
  0.0025,
  0.005,
  0.01,
  0.02,
  0.05,
] as const;

/**
 * Series grain, in minutes. The strategy checkpoint collectors sample every
 * indexed pool about every 31 seconds, so a 15-minute bucket carries roughly
 * 29 samples and still reports when a collector run is missed. The grain has
 * to divide an hour, because the trailing windows above are named in hours and
 * are sliced out of this series in whole buckets.
 */
export const RESEARCH_BUCKET_MINUTES = 15;

/** Buckets per hour, at the grain above. */
export const RESEARCH_BUCKETS_PER_HOUR = 60 / RESEARCH_BUCKET_MINUTES;

if (!Number.isInteger(RESEARCH_BUCKETS_PER_HOUR)) {
  throw new Error(
    `research grain of ${RESEARCH_BUCKET_MINUTES} minutes does not divide an hour`,
  );
}

/** Retained history, in hours. */
export const RESEARCH_RETAINED_HOURS = 168;

/** Retained history at the series grain. */
export const RESEARCH_RETAINED_BUCKETS = RESEARCH_RETAINED_HOURS *
  RESEARCH_BUCKETS_PER_HOUR;

/** Reference position budget: 1,000 USDG at six decimals. */
export const RESEARCH_BUDGET_QUOTE = 1_000_000_000n;

const QUOTE_DECIMALS = 6;
const BUCKET_MS = RESEARCH_BUCKET_MINUTES * 60_000;
const TICK_LOG = Math.log(1.0001);
/** Ticks either side of spot kept in the depth curve; about +/-16% in price. */
const DEPTH_TICK_RADIUS = 1_500;

export interface ResearchBucket {
  readonly bucket: string;
  readonly swaps: number;
  readonly volumeQuote: string | null;
  readonly feesQuote: string | null;
  readonly meanLiquidity: string;
  readonly priceX18: string | null;
  readonly tickLast: number | null;
  readonly tickMin: number | null;
  readonly tickMax: number | null;
  readonly validShare: number | null;
  readonly deviationPpm: string | null;
}

export interface ResearchReference {
  readonly halfWidthTicks: number;
  readonly halfWidthPercent: number;
  readonly liquidity: string;
  readonly sharePpm: number | null;
  readonly inRangeBuckets: number;
  readonly modeledFeesQuote: string;
  readonly modeledNetQuote: string | null;
  readonly aprPpm: number | null;
}

export interface ResearchWindowSummary {
  /** Window length in hours; the series under it is sliced in buckets. */
  readonly hours: number;
  /** Exact trailing-window diagnostics. Null for bucket-aligned legacy windows. */
  readonly windowSeconds: number | null;
  readonly coveredSeconds: number | null;
  readonly freshnessSeconds: number | null;
  readonly maxGapSeconds: number | null;
  readonly asOf: string | null;
  readonly observedBuckets: number;
  readonly swaps: number | null;
  readonly volumeQuote: string | null;
  readonly feesQuote: string | null;
  readonly meanLiquidity: string;
  readonly priceChangePpm: number | null;
  readonly validShare: number | null;
  readonly references: readonly ResearchReference[];
  readonly limitation: string | null;
}

interface ExactCheckpointWindow {
  readonly count: number;
  readonly valid: number;
  readonly meanLiquidity: bigint;
  readonly firstAt: Date | null;
  readonly lastAt: Date | null;
  readonly maxGapSeconds: number | null;
}

interface EventTimestampCoverage {
  readonly fromAt: Date;
  readonly throughAt: Date;
}

export interface ResearchDepthPoint {
  readonly tick: number;
  readonly liquidity: string;
}

/**
 * The budget's liquidity at each half-width, sized at the pool's current price.
 * The depth curve is current state, so it cannot be read against the window
 * references, which are sized at the price the window opened at.
 */
export interface ResearchDepthReference {
  readonly halfWidthTicks: number;
  readonly halfWidthPercent: number;
  readonly liquidity: string;
}

export interface ResearchPool {
  readonly poolAddress: string;
  readonly rwaSymbol: string;
  readonly fee: number;
  /** Protocol fee divisors, per leg. Zero means the whole fee reaches LPs. */
  readonly feeProtocol0: number;
  readonly feeProtocol1: number;
  readonly tickSpacing: number;
  readonly quoteIsToken0: boolean;
  readonly rwaDecimals: number;
  readonly tick: number | null;
  readonly priceX18: string | null;
  readonly liquidity: string | null;
  readonly observedAt: string | null;
  readonly registryEnabled: boolean;
  readonly stateStatus: "current" | "stale" | "unverified" | "unavailable";
  readonly series: readonly ResearchBucket[];
  readonly windows: readonly ResearchWindowSummary[];
  readonly depth: readonly ResearchDepthPoint[];
  readonly depthReferences: readonly ResearchDepthReference[];
}

export interface ResearchCosts {
  readonly mintBundleQuote: string | null;
  readonly exitBundleQuote: string | null;
  readonly roundTripQuote: string | null;
}

export interface ResearchSnapshot {
  readonly generatedAt: string;
  readonly streamKey: string;
  readonly budgetQuote: string;
  readonly quoteDecimals: number;
  readonly bucketMinutes: number;
  readonly buckets: readonly string[];
  readonly costs: ResearchCosts;
  readonly pools: readonly ResearchPool[];
}

/**
 * The LP side of a charged fee. `feeProtocol` is the v3 divisor: the pool keeps
 * `feeAmount / feeProtocol` for the protocol and pays the rest to liquidity,
 * and zero means no protocol cut at all.
 *
 * The pool applies this per swap step; here it is applied to a bucket's total,
 * which can differ by up to a raw unit per swap from the on-chain split. Over
 * the NVDA 500 pool's whole recorded history the two agree at 24.96% against a
 * nominal 25%, the residue being protocol sweeps that straddle the range the
 * comparison was taken over.
 */
export function lpFeeOfGross(gross: bigint, feeProtocol: number): bigint {
  if (feeProtocol <= 0) return gross;
  return gross - gross / BigInt(feeProtocol);
}

/** Raw RWA amount valued in raw USDG at an 18-decimal USDG/RWA price. */
export function quoteValueOfRwa(
  rwaRaw: bigint,
  priceX18: bigint,
  rwaDecimals: number,
): bigint {
  const scale = 10n ** BigInt(rwaDecimals + 18 - QUOTE_DECIMALS);
  return rwaRaw * priceX18 / scale;
}

/** Active liquidity per initialized tick, accumulated from the lowest tick. */
export function depthCurve(
  ticks: readonly { readonly tick: number; readonly liquidityNet: bigint }[],
): readonly ResearchDepthPoint[] {
  let active = 0n;
  return ticks.map((entry) => {
    active += entry.liquidityNet;
    return { tick: entry.tick, liquidity: active.toString() };
  });
}

/** The budget's liquidity for one half-width, centred on a tick. */
function referenceSizing(
  pool: { readonly token0: string; readonly token1: string },
  tickSpacing: number,
  centreTick: number,
  sqrtPriceX96: bigint,
  fraction: number,
): { halfWidthTicks: number; halfWidthPercent: number; liquidity: bigint } {
  const halfWidthTicks = halfWidthTicksForFraction(fraction, tickSpacing);
  const base = Math.floor(centreTick / tickSpacing) * tickSpacing;
  const size = sizeLiquidityForQuoteBudget({
    budgetQuote: RESEARCH_BUDGET_QUOTE,
    quoteToken: USDG,
    sqrtPriceX96,
    tickLower: base - halfWidthTicks,
    tickUpper: base + halfWidthTicks,
    token0: pool.token0,
    token1: pool.token1,
  });
  return {
    halfWidthTicks,
    halfWidthPercent: (Math.exp(halfWidthTicks * TICK_LOG) - 1) * 100,
    liquidity: size.liquidity,
  };
}

/** Grid-aligned half-width in ticks for a target price fraction. */
export function halfWidthTicksForFraction(
  fraction: number,
  tickSpacing: number,
): number {
  const exact = Math.log(1 + fraction) / TICK_LOG;
  return Math.max(tickSpacing, Math.ceil(exact / tickSpacing) * tickSpacing);
}

interface PoolIdentity {
  readonly poolAddress: string;
  readonly rwaSymbol: string;
  readonly fee: number;
  readonly token0: string | null;
  readonly token1: string | null;
  readonly rwaDecimals: number;
  readonly tick: number | null;
  readonly sqrtPriceX96: bigint | null;
  readonly priceX18: bigint | null;
  readonly liquidity: bigint | null;
  readonly observedAt: Date | null;
  readonly registryEnabled: boolean;
  readonly stateStatus: "current" | "stale" | "unverified" | "unavailable";
}

interface BucketAccumulator {
  swaps: number;
  in0: bigint;
  in1: bigint;
  tickMin: number | null;
  tickMax: number | null;
  meanLiquidity: bigint;
  priceX18: bigint | null;
  sqrtPriceX96: bigint | null;
  tickLast: number | null;
  checkpoints: number;
  validCheckpoints: number;
  deviationPpm: bigint | null;
}

function emptyBucket(): BucketAccumulator {
  return {
    swaps: 0,
    in0: 0n,
    in1: 0n,
    tickMin: null,
    tickMax: null,
    meanLiquidity: 0n,
    priceX18: null,
    sqrtPriceX96: null,
    tickLast: null,
    checkpoints: 0,
    validCheckpoints: 0,
    deviationPpm: null,
  };
}

async function readCosts(client: PoolClient): Promise<ResearchCosts> {
  const { rows } = await client.query<{
    action_class: string;
    median: string | null;
  }>(
    `SELECT action_class,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY total_cost_quote_raw))::numeric(78, 0)::text AS median
       FROM v3_action_cost_valuations
      WHERE status = 'valid' AND action_class IN ('mint_bundle', 'exit_bundle')
      GROUP BY action_class`,
  );
  const median = new Map(rows.map((row) => [row.action_class, row.median]));
  const mint = median.get("mint_bundle") ?? null;
  const exit = median.get("exit_bundle") ?? null;
  return {
    mintBundleQuote: mint,
    exitBundleQuote: exit,
    roundTripQuote: mint !== null && exit !== null
      ? (BigInt(mint) + BigInt(exit)).toString()
      : null,
  };
}

async function readIdentities(
  client: PoolClient,
  streamKey: string,
): Promise<readonly PoolIdentity[]> {
  const { rows } = await client.query<{
    pool_address: string;
    rwa_symbol: string;
    fee: number;
    token0: string | null;
    token1: string | null;
    token_decimals: number | null;
    tick: number | null;
    sqrt_price_x96: string | null;
    pool_price_x18: string | null;
    liquidity: string | null;
    block_timestamp: Date | null;
    registry_enabled: boolean;
    checkpoint_status: string | null;
  }>(
    `SELECT lower(i.pool_address) AS pool_address, i.rwa_symbol, i.fee,
            p.token0, p.token1, p.token_decimals, p.tick,
            p.sqrt_price_x96::text, p.liquidity::text,
            p.pool_price_x18::text, p.block_timestamp, i.enabled AS registry_enabled,
            p.status AS checkpoint_status
       FROM indexer_pools i
       LEFT JOIN LATERAL (
         SELECT p.token0, p.token1, p.token_decimals, p.tick, p.sqrt_price_x96,
                p.liquidity, p.pool_price_x18, p.status, c.block_timestamp
           FROM v3_strategy_checkpoint_runs c
           JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id = c.id
          WHERE c.stream_key = i.stream_key
            AND lower(p.pool_address) = lower(i.pool_address)
          ORDER BY c.block_number DESC LIMIT 1
       ) p ON TRUE
      WHERE i.stream_key = $1
      ORDER BY lower(i.pool_address)`,
    [streamKey],
  );
  const now = Date.now();
  return rows.map((row) => ({
    poolAddress: row.pool_address,
    rwaSymbol: row.rwa_symbol,
    fee: row.fee,
    token0: row.token0,
    token1: row.token1,
    // The registry supplies identity even before its first checkpoint.
    rwaDecimals: row.token_decimals ?? 18,
    tick: row.tick,
    sqrtPriceX96: row.sqrt_price_x96 === null ? null : BigInt(row.sqrt_price_x96),
    priceX18: row.pool_price_x18 === null ? null : BigInt(row.pool_price_x18),
    liquidity: row.liquidity === null ? null : BigInt(row.liquidity),
    observedAt: row.block_timestamp,
    registryEnabled: row.registry_enabled,
    stateStatus: row.block_timestamp === null
      ? "unavailable"
      : row.checkpoint_status !== "valid"
      ? "unverified"
      : now - row.block_timestamp.getTime() > 6 * 60 * 60_000
      ? "stale"
      : "current",
  }));
}

/** Per-leg protocol fee divisors, keyed by lowercase pool address. */
interface ProtocolFee {
  readonly fee0: number;
  readonly fee1: number;
}

async function readProtocolFees(
  client: PoolClient,
  streamKey: string,
): Promise<ReadonlyMap<string, ProtocolFee>> {
  // The latest setting per pool. Every indexed pool is followed from its own
  // Initialize, so a pool with no event has never carried a protocol fee. The
  // setting is applied across the whole retained window, which is exact while
  // it is unchanged; a pool that changed it mid-window would have the buckets
  // before the change split at the new rate.
  const { rows } = await client.query<{
    pool_address: string;
    fee_protocol0: number;
    fee_protocol1: number;
  }>(
    `SELECT DISTINCT ON (lower(pool_address))
            lower(pool_address) AS pool_address,
            (event_args->>'feeProtocol0New')::int AS fee_protocol0,
            (event_args->>'feeProtocol1New')::int AS fee_protocol1
       FROM v3_pool_events
      WHERE stream_key = $1 AND event_name = 'SetFeeProtocol'
      ORDER BY lower(pool_address), block_number DESC,
               transaction_index DESC, log_index DESC`,
    [streamKey],
  );
  return new Map(
    rows.map((row) => [row.pool_address, {
      fee0: row.fee_protocol0,
      fee1: row.fee_protocol1,
    }]),
  );
}

interface BucketCheckpointRow {
  pool_address: string;
  bkt: Date;
  checkpoints: string;
  valid_checkpoints: string;
  mean_liquidity: string;
  tick_last: number;
  sqrt_last: string;
  price_last: string;
  mean_deviation: string | null;
  block_lo: string;
}

interface SwapBucketRow {
  pool_address: string;
  anchor: number;
  swaps: string;
  in0: string;
  in1: string;
  tick_min: number;
  tick_max: number;
}

/**
 * Dense ascending bucket axis ending at the bucket the current time falls in.
 * Buckets are floored against the Unix epoch, which is the same origin the
 * `date_bin` call below aligns to, so the two agree without a conversion.
 */
function bucketAxis(now: Date): readonly Date[] {
  const end = Math.floor(now.getTime() / BUCKET_MS) * BUCKET_MS;
  return Array.from(
    { length: RESEARCH_RETAINED_BUCKETS },
    (_unused, index) =>
      new Date(end - (RESEARCH_RETAINED_BUCKETS - 1 - index) * BUCKET_MS),
  );
}

function summarizeWindow(
  pool: PoolIdentity,
  tickSpacing: number,
  quoteIsToken0: boolean,
  series: readonly ResearchBucket[],
  accumulators: readonly BucketAccumulator[],
  hours: number,
  roundTripQuote: bigint | null,
): ResearchWindowSummary {
  // Windows are named in hours; the series under them is at the finer grain.
  const buckets = hours * RESEARCH_BUCKETS_PER_HOUR;
  const from = Math.max(0, series.length - buckets);
  const slice = series.slice(from);
  const sliceAccumulators = accumulators.slice(from);
  let swaps = 0;
  let volumeQuote = 0n;
  let feesQuote = 0n;
  let liquiditySum = 0n;
  let observedBuckets = 0;
  let checkpoints = 0;
  let validCheckpoints = 0;
  for (const [index, bucket] of slice.entries()) {
    swaps += bucket.swaps;
    const accumulator = sliceAccumulators[index]!;
    checkpoints += accumulator.checkpoints;
    validCheckpoints += accumulator.validCheckpoints;
    if (accumulator.checkpoints > 0) {
      if (bucket.volumeQuote !== null) volumeQuote += BigInt(bucket.volumeQuote);
      if (bucket.feesQuote !== null) feesQuote += BigInt(bucket.feesQuote);
      liquiditySum += accumulator.meanLiquidity;
      observedBuckets += 1;
    }
  }
  const meanLiquidity = observedBuckets > 0
    ? liquiditySum / BigInt(observedBuckets)
    : 0n;

  // The reference position enters at the window's opening price and is never
  // rebalanced, so it is sized once, from the close of the bucket before the
  // window when one is retained.
  const entry = accumulators[Math.max(0, from - 1)] ?? sliceAccumulators[0];
  const first = slice[0];
  const last = slice.at(-1);
  const priceChangePpm = first?.priceX18 != null && last?.priceX18 != null &&
      BigInt(first.priceX18) > 0n
    ? Number(
      (BigInt(last.priceX18) - BigInt(first.priceX18)) * 1_000_000n /
        BigInt(first.priceX18),
    )
    : null;

  const references: ResearchReference[] = [];
  if (entry?.tickLast != null && entry.sqrtPriceX96 != null) {
    const base = Math.floor(entry.tickLast / tickSpacing) * tickSpacing;
    for (const fraction of RESEARCH_HALF_WIDTH_FRACTIONS) {
      const sized = referenceSizing(
        { token0: pool.token0!, token1: pool.token1! },
        tickSpacing,
        entry.tickLast,
        entry.sqrtPriceX96,
        fraction,
      );
      const { halfWidthTicks } = sized;
      const size = { liquidity: sized.liquidity };
      let inRangeBuckets = 0;
      let modeledFeesQuote = 0n;
      for (const [index, bucket] of slice.entries()) {
        // A bucket the checkpoint collector missed has no observed liquidity,
        // so crediting it would hand the position the pool's whole fee take.
        if (sliceAccumulators[index]!.checkpoints === 0) continue;
        const low = bucket.tickMin ?? bucket.tickLast;
        const high = bucket.tickMax ?? bucket.tickLast;
        if (low === null || high === null) continue;
        if (low < base - halfWidthTicks || high > base + halfWidthTicks) {
          continue;
        }
        inRangeBuckets += 1;
        const shared = size.liquidity +
          sliceAccumulators[index]!.meanLiquidity;
        if (shared > 0n && bucket.feesQuote !== null) {
          modeledFeesQuote += BigInt(bucket.feesQuote) * size.liquidity /
            shared;
        }
      }
      const modeledNetQuote = roundTripQuote === null
        ? null
        : modeledFeesQuote - roundTripQuote;
      references.push({
        halfWidthTicks,
        halfWidthPercent: sized.halfWidthPercent,
        liquidity: size.liquidity.toString(),
        sharePpm: size.liquidity + meanLiquidity > 0n
          ? Number(
            size.liquidity * 1_000_000n / (size.liquidity + meanLiquidity),
          )
          : null,
        inRangeBuckets,
        modeledFeesQuote: modeledFeesQuote.toString(),
        modeledNetQuote: modeledNetQuote?.toString() ?? null,
        // The window is still measured in hours, so the annualization is
        // unaffected by the grain the buckets above are counted in.
        aprPpm: modeledNetQuote === null
          ? null
          : Number(modeledNetQuote * 1_000_000n / RESEARCH_BUDGET_QUOTE) *
            (8_760 / hours),
      });
    }
  }

  return {
    hours,
    windowSeconds: null,
    coveredSeconds: null,
    freshnessSeconds: null,
    maxGapSeconds: null,
    asOf: null,
    observedBuckets,
    swaps,
    volumeQuote: observedBuckets > 0 ? volumeQuote.toString() : null,
    feesQuote: observedBuckets > 0 ? feesQuote.toString() : null,
    meanLiquidity: meanLiquidity.toString(),
    priceChangePpm,
    validShare: checkpoints > 0 ? validCheckpoints / checkpoints : null,
    references,
    limitation: null,
  };
}

function exactWindowSummary(
  checkpoints: ExactCheckpointWindow,
  swaps: number | null,
  asOf: Date,
  coverageComplete: boolean,
): ResearchWindowSummary {
  const coveredSeconds = checkpoints.firstAt === null || checkpoints.lastAt === null
    ? 0
    : Math.max(0, Math.floor((checkpoints.lastAt.getTime() - checkpoints.firstAt.getTime()) / 1000));
  const freshnessSeconds = checkpoints.lastAt === null
    ? null
    : Math.max(0, Math.floor((asOf.getTime() - checkpoints.lastAt.getTime()) / 1000));
  return {
    hours: 0.25,
    windowSeconds: 900,
    coveredSeconds,
    freshnessSeconds,
    maxGapSeconds: checkpoints.maxGapSeconds,
    asOf: asOf.toISOString(),
    observedBuckets: checkpoints.count > 0 || swaps !== null ? 1 : 0,
    swaps,
    volumeQuote: null,
    feesQuote: null,
    meanLiquidity: checkpoints.meanLiquidity.toString(),
    priceChangePpm: null,
    validShare: checkpoints.count > 0 ? checkpoints.valid / checkpoints.count : null,
    references: [],
    limitation: coverageComplete ? "flow_valuation_unavailable" : "event_timestamp_coverage_incomplete",
  };
}

async function readEventTimestampCoverage(
  client: PoolClient,
  streamKey: string,
): Promise<EventTimestampCoverage | null> {
  const present = await client.query<{ present: boolean }>(
    "SELECT to_regclass('indexer_event_timestamp_coverage') IS NOT NULL AS present",
  );
  if (!present.rows[0]?.present) return null;
  // Coverage is usable only while its end anchor still agrees with the saved
  // canonical checkpoint and the active registry target set. The indexer
  // truncates this row on a detected rewind; these joins fail closed if the
  // persisted pieces ever disagree.
  const result = await client.query<{ from_timestamp: Date; through_timestamp: Date }>(
    `SELECT coverage.from_timestamp, coverage.through_timestamp
       FROM indexer_event_timestamp_coverage coverage
       JOIN indexer_checkpoints checkpoint
         ON checkpoint.stream_key = coverage.stream_key
        AND checkpoint.block_number = coverage.through_block
        AND lower(checkpoint.block_hash) = lower(coverage.through_hash)
       JOIN indexer_cursors scan
         ON scan.stream_key = coverage.stream_key
        AND scan.covered_through_block >= coverage.through_block
      WHERE coverage.stream_key = $1
        AND EXISTS (
          SELECT 1 FROM indexer_pools pool
           WHERE pool.stream_key = coverage.stream_key AND pool.enabled
        )
        AND NOT EXISTS (
          SELECT 1 FROM indexer_pools pool
           WHERE pool.stream_key = coverage.stream_key AND pool.enabled
             AND lower(pool.target_set_hash) <> lower(scan.target_set_hash)
        )`,
    [streamKey],
  );
  const row = result.rows[0];
  return row === undefined ? null : { fromAt: row.from_timestamp, throughAt: row.through_timestamp };
}

async function readExactSwapCounts(
  client: PoolClient,
  streamKey: string,
  since: Date,
  asOf: Date,
): Promise<ReadonlyMap<string, number> | null> {
  const result = await client.query<{ pool_address: string | null; swaps: string | null }>(
    `WITH valid_coverage AS (
       SELECT coverage.stream_key
         FROM indexer_event_timestamp_coverage coverage
         JOIN indexer_checkpoints checkpoint
           ON checkpoint.stream_key = coverage.stream_key
          AND checkpoint.block_number = coverage.through_block
          AND lower(checkpoint.block_hash) = lower(coverage.through_hash)
         JOIN indexer_cursors scan
           ON scan.stream_key = coverage.stream_key
          AND scan.covered_through_block >= coverage.through_block
        WHERE coverage.stream_key = $1
          AND coverage.from_timestamp <= $2
          AND coverage.through_timestamp = $3
          AND coverage.through_timestamp <= statement_timestamp()
          AND coverage.through_timestamp >= statement_timestamp() - INTERVAL '90 seconds'
          AND EXISTS (
            SELECT 1 FROM indexer_pools pool
             WHERE pool.stream_key = coverage.stream_key AND pool.enabled
          )
          AND NOT EXISTS (
            SELECT 1 FROM indexer_pools pool
             WHERE pool.stream_key = coverage.stream_key AND pool.enabled
               AND lower(pool.target_set_hash) <> lower(scan.target_set_hash)
          )
     ), swap_counts AS (
       SELECT lower(e.pool_address) AS pool_address, count(*)::text AS swaps
         FROM v3_pool_events e
         JOIN indexer_event_blocks b
           ON b.stream_key = e.stream_key
          AND b.block_number = e.block_number
          AND lower(b.block_hash) = lower(e.block_hash)
        WHERE e.stream_key = $1 AND e.event_name = 'Swap'
          AND b.block_timestamp >= $2 AND b.block_timestamp <= $3
          AND EXISTS (SELECT 1 FROM valid_coverage)
        GROUP BY lower(e.pool_address)
     )
     SELECT pool_address, swaps FROM swap_counts
     UNION ALL
     SELECT NULL::text, NULL::text WHERE NOT EXISTS (SELECT 1 FROM valid_coverage)`,
    [streamKey, since, asOf],
  );
  if (result.rows.some((row) => row.pool_address === null)) return null;
  return new Map(result.rows.map((row) => [row.pool_address!, Number(row.swaps)]));
}

async function readExactCheckpointWindow(
  client: PoolClient,
  streamKey: string,
  since: Date,
  asOf: Date,
): Promise<ReadonlyMap<string, ExactCheckpointWindow>> {
  const { rows } = await client.query<{
    pool_address: string; at: Date; status: string; liquidity: string;
  }>(
    `SELECT lower(p.pool_address) AS pool_address, c.block_timestamp AS at,
            p.status, p.liquidity::text
       FROM v3_strategy_pool_checkpoints p
       JOIN v3_strategy_checkpoint_runs c ON c.id = p.checkpoint_run_id
      WHERE c.stream_key = $1 AND c.block_timestamp >= $2 AND c.block_timestamp <= $3`,
    [streamKey, since, asOf],
  );
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.pool_address, [...(grouped.get(row.pool_address) ?? []), row]);
  const result = new Map<string, ExactCheckpointWindow>();
  for (const [address, entries] of grouped) {
    entries.sort((a, b) => a.at.getTime() - b.at.getTime());
    const within = entries.filter((row) => row.at >= since && row.at <= asOf);
    const first = within[0], last = within.at(-1);
    let maxGapSeconds: number | null = null;
    const times = [since, ...within.map((row) => row.at), asOf];
    if (within.length > 0) {
      maxGapSeconds = 0;
      for (let i = 1; i < times.length; i++) {
        maxGapSeconds = Math.max(maxGapSeconds, Math.floor((times[i]!.getTime() - times[i - 1]!.getTime()) / 1000));
      }
    }
    result.set(address, {
      count: within.length,
      valid: within.filter((row) => row.status === "valid").length,
      meanLiquidity: within.length === 0 ? 0n : within.reduce((sum, row) => sum + BigInt(row.liquidity), 0n) / BigInt(within.length),
      firstAt: first?.at ?? null,
      lastAt: last?.at ?? null,
      maxGapSeconds,
    });
  }
  return result;
}

export async function readResearch(
  client: PoolClient,
  streamKey: string,
): Promise<ResearchSnapshot> {
  const now = new Date();
  const axis = bucketAxis(now);
  const since = axis[0]!.toISOString();
  const eventTimestampCoverage = await readEventTimestampCoverage(client, streamKey);
  const exactAsOf = eventTimestampCoverage?.throughAt ?? now;
  const exactSince = new Date(exactAsOf.getTime() - 900_000);
  const coverageAgeMs = now.getTime() - exactAsOf.getTime();
  const eventTimestampCoverageComplete = eventTimestampCoverage !== null &&
    eventTimestampCoverage.fromAt <= exactSince &&
    coverageAgeMs >= 0 && coverageAgeMs <= 90_000;
  const identities = await readIdentities(client, streamKey);
  const costs = await readCosts(client);
  const protocolFees = await readProtocolFees(client, streamKey);
  const exactCheckpoints = await readExactCheckpointWindow(client, streamKey, exactSince, exactAsOf);
  const exactSwapCounts = eventTimestampCoverageComplete
    ? await readExactSwapCounts(client, streamKey, exactSince, exactAsOf)
    : null;
  const roundTripQuote = costs.roundTripQuote === null
    ? null
    : BigInt(costs.roundTripQuote);

  const bucketed = await client.query<BucketCheckpointRow>(
    // `date_bin` is anchored on the Unix epoch so the bins line up with the
    // axis above, which floors the same way.
    `SELECT lower(p.pool_address) AS pool_address,
            date_bin($3::interval, c.block_timestamp, TIMESTAMPTZ 'epoch') AS bkt,
            count(*)::text AS checkpoints,
            count(*) FILTER (WHERE p.status = 'valid')::text AS valid_checkpoints,
            avg(p.liquidity)::numeric(78, 0)::text AS mean_liquidity,
            (array_agg(p.tick ORDER BY c.block_number DESC))[1] AS tick_last,
            (array_agg(p.sqrt_price_x96::text ORDER BY c.block_number DESC))[1] AS sqrt_last,
            (array_agg(p.pool_price_x18::text ORDER BY c.block_number DESC))[1] AS price_last,
            avg(p.deviation_ppm)::numeric(78, 0)::text AS mean_deviation,
            min(c.block_number)::text AS block_lo
       FROM v3_strategy_checkpoint_runs c
       JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id = c.id
      WHERE c.stream_key = $1 AND c.block_timestamp >= $2
      GROUP BY 1, 2`,
    [streamKey, since, `${RESEARCH_BUCKET_MINUTES} minutes`],
  );

  const indexOfBucket = new Map(
    axis.map((bucket, index) => [bucket.getTime(), index]),
  );
  const accumulators = new Map<string, BucketAccumulator[]>();
  const bucketStartBlock = new Array<bigint | null>(axis.length).fill(null);
  for (const row of bucketed.rows) {
    const index = indexOfBucket.get(row.bkt.getTime());
    if (index === undefined) continue;
    const pool = row.pool_address;
    let series = accumulators.get(pool);
    if (series === undefined) {
      series = Array.from({ length: axis.length }, emptyBucket);
      accumulators.set(pool, series);
    }
    const entry = series[index]!;
    entry.checkpoints = Number(row.checkpoints);
    entry.validCheckpoints = Number(row.valid_checkpoints);
    entry.meanLiquidity = BigInt(row.mean_liquidity);
    entry.tickLast = row.tick_last;
    entry.sqrtPriceX96 = BigInt(row.sqrt_last);
    entry.priceX18 = BigInt(row.price_last);
    entry.deviationPpm = row.mean_deviation === null
      ? null
      : BigInt(row.mean_deviation);
    const blockLo = BigInt(row.block_lo);
    const known = bucketStartBlock[index] ?? null;
    if (known === null || blockLo < known) bucketStartBlock[index] = blockLo;
  }

  // Buckets the checkpoint collector missed carry no block boundary, so the
  // swap buckets are mapped onto the ones that do, in ascending block order.
  const anchored = bucketStartBlock
    .map((block, index) => ({ block, index }))
    .filter((entry): entry is { block: bigint; index: number } =>
      entry.block !== null
    )
    .sort((left, right) => (left.block < right.block ? -1 : 1));
  const boundaries = anchored.map((entry) => entry.block);

  if (boundaries.length > 0) {
    const swaps = await client.query<SwapBucketRow>(
      // Swaps are assigned to a bucket by the checkpoint block that opened it.
      // The event payload is projected down before aggregating: grouping the
      // raw rows sorts the whole jsonb column to disk and costs seconds.
      `SELECT pool_address, anchor, count(*)::text AS swaps,
              sum(in0)::numeric(78, 0)::text AS in0,
              sum(in1)::numeric(78, 0)::text AS in1,
              min(tick) AS tick_min, max(tick) AS tick_max
         FROM (SELECT lower(pool_address) AS pool_address,
                      width_bucket(block_number, $2::numeric[]) AS anchor,
                      GREATEST((event_args->>'amount0')::numeric, 0) AS in0,
                      GREATEST((event_args->>'amount1')::numeric, 0) AS in1,
                      (event_args->>'tick')::int AS tick
                 FROM v3_pool_events
                WHERE stream_key = $1 AND event_name = 'Swap'
                  AND block_number >= $3) flow
        GROUP BY 1, 2`,
      [
        streamKey,
        boundaries.map((block) => block.toString()),
        boundaries[0]!.toString(),
      ],
    );
    for (const row of swaps.rows) {
      const series = accumulators.get(row.pool_address);
      if (series === undefined) continue;
      const anchor = anchored[row.anchor - 1];
      if (anchor === undefined) continue;
      const entry = series[anchor.index]!;
      entry.swaps += Number(row.swaps);
      entry.in0 += BigInt(row.in0);
      entry.in1 += BigInt(row.in1);
      entry.tickMin = entry.tickMin === null
        ? row.tick_min
        : Math.min(entry.tickMin, row.tick_min);
      entry.tickMax = entry.tickMax === null
        ? row.tick_max
        : Math.max(entry.tickMax, row.tick_max);
    }
  }

  const depth = await client.query<{
    pool_address: string;
    tick: number;
    liquidity_net: string;
  }>(
    `SELECT lower(pool_address) AS pool_address, tick, liquidity_net::text
       FROM v3_replay_ticks
      WHERE stream_key = $1
      ORDER BY 1, tick`,
    [streamKey],
  );
  const ticksByPool = new Map<
    string,
    { tick: number; liquidityNet: bigint }[]
  >();
  for (const row of depth.rows) {
    const list = ticksByPool.get(row.pool_address) ?? [];
    list.push({ tick: row.tick, liquidityNet: BigInt(row.liquidity_net) });
    ticksByPool.set(row.pool_address, list);
  }

  const pools = identities.map((pool): ResearchPool => {
    const tickSpacing = tickSpacingForFee(pool.fee);
    const quoteIsToken0 = pool.token0?.toLowerCase() === USDG.toLowerCase();
    const protocol = protocolFees.get(pool.poolAddress) ?? { fee0: 0, fee1: 0 };
    const exactCheckpoint = exactCheckpoints.get(pool.poolAddress) ?? {
      count: 0, valid: 0, meanLiquidity: 0n, firstAt: null, lastAt: null,
      maxGapSeconds: null,
    };
    const exactSwapCount = eventTimestampCoverageComplete
      ? exactSwapCounts?.get(pool.poolAddress) ?? 0
      : null;
    const exactWindow = exactWindowSummary(
      exactCheckpoint, exactSwapCount, exactAsOf, eventTimestampCoverageComplete,
    );
    if (pool.token0 === null || pool.token1 === null || pool.tick === null ||
        pool.sqrtPriceX96 === null || pool.priceX18 === null || pool.liquidity === null ||
        pool.observedAt === null) {
      return {
        poolAddress: pool.poolAddress, rwaSymbol: pool.rwaSymbol, fee: pool.fee,
        feeProtocol0: protocol.fee0, feeProtocol1: protocol.fee1, tickSpacing,
        quoteIsToken0, rwaDecimals: pool.rwaDecimals, tick: null, priceX18: null,
        liquidity: null, observedAt: null, registryEnabled: pool.registryEnabled,
        stateStatus: pool.stateStatus, series: [], windows: [exactWindow,
          ...RESEARCH_WINDOW_HOURS.filter((hours) => hours !== 0.25).map((hours) => ({
            hours, windowSeconds: null, coveredSeconds: null, freshnessSeconds: null,
            maxGapSeconds: null, observedBuckets: 0, swaps: 0, volumeQuote: null,
            feesQuote: null, asOf: null, meanLiquidity: "0", priceChangePpm: null, validShare: null,
            references: [], limitation: null,
          }))],
        depth: [], depthReferences: [],
      };
    }
    const series = accumulators.get(pool.poolAddress) ??
      Array.from({ length: axis.length }, emptyBucket);
    const view = series.map((entry, index): ResearchBucket => {
      const priceX18 = entry.priceX18 ?? pool.priceX18!;
      // Only the LP side is reported: the protocol's cut never reaches a
      // position, so crediting it would overstate every fee column downstream.
      const fee0 = lpFeeOfGross(
        entry.in0 * BigInt(pool.fee) / 1_000_000n,
        protocol.fee0,
      );
      const fee1 = lpFeeOfGross(
        entry.in1 * BigInt(pool.fee) / 1_000_000n,
        protocol.fee1,
      );
      const value = (amount0: bigint, amount1: bigint): bigint =>
        quoteIsToken0
          ? amount0 + quoteValueOfRwa(amount1, priceX18, pool.rwaDecimals)
          : amount1 + quoteValueOfRwa(amount0, priceX18, pool.rwaDecimals);
      return {
        bucket: axis[index]!.toISOString(),
        swaps: entry.swaps,
        volumeQuote: entry.checkpoints > 0 ? value(entry.in0, entry.in1).toString() : null,
        feesQuote: entry.checkpoints > 0 ? value(fee0, fee1).toString() : null,
        meanLiquidity: entry.meanLiquidity.toString(),
        priceX18: entry.priceX18?.toString() ?? null,
        tickLast: entry.tickLast,
        tickMin: entry.tickMin,
        tickMax: entry.tickMax,
        validShare: entry.checkpoints > 0
          ? entry.validCheckpoints / entry.checkpoints
          : null,
        deviationPpm: entry.deviationPpm?.toString() ?? null,
      };
    });
    const curve = depthCurve(ticksByPool.get(pool.poolAddress) ?? []);
    return {
      poolAddress: pool.poolAddress,
      rwaSymbol: pool.rwaSymbol,
      fee: pool.fee,
      feeProtocol0: protocol.fee0,
      feeProtocol1: protocol.fee1,
      tickSpacing,
      quoteIsToken0,
      rwaDecimals: pool.rwaDecimals,
      tick: pool.tick,
      priceX18: pool.priceX18.toString(),
      liquidity: pool.liquidity.toString(),
      observedAt: pool.observedAt.toISOString(),
      registryEnabled: pool.registryEnabled,
      stateStatus: pool.stateStatus,
      series: view,
      windows: RESEARCH_WINDOW_HOURS.map((hours) => hours === 0.25
        ? exactWindow
        : summarizeWindow(
          pool,
          tickSpacing,
          quoteIsToken0,
          view,
          series,
          hours,
          roundTripQuote,
        )),
      depth: curve.filter((point) =>
        Math.abs(point.tick - pool.tick!) <= DEPTH_TICK_RADIUS
      ),
      depthReferences: RESEARCH_HALF_WIDTH_FRACTIONS.map((fraction) => {
        const sized = referenceSizing(
          { token0: pool.token0!, token1: pool.token1! },
          tickSpacing,
          pool.tick!,
          pool.sqrtPriceX96!,
          fraction,
        );
        return {
          halfWidthTicks: sized.halfWidthTicks,
          halfWidthPercent: sized.halfWidthPercent,
          liquidity: sized.liquidity.toString(),
        };
      }),
    };
  });

  return {
    generatedAt: now.toISOString(),
    streamKey,
    budgetQuote: RESEARCH_BUDGET_QUOTE.toString(),
    quoteDecimals: QUOTE_DECIMALS,
    bucketMinutes: RESEARCH_BUCKET_MINUTES,
    buckets: axis.map((bucket) => bucket.toISOString()),
    costs,
    pools: pools.sort((left, right) =>
      left.rwaSymbol.localeCompare(right.rwaSymbol) || left.fee - right.fee
    ),
  };
}
