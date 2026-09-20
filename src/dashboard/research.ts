// Read-only RWA pool research model.
//
// The page compares what a unit of liquidity earns across the indexed pool
// universe, so every number here is derived the same way the bounded universe
// screen derives it: gross fees come from the recorded Swap amounts (the pool
// charges `fee` pips of the input token), both legs are valued in USDG at the
// pool's own price, and active liquidity comes from the strategy checkpoints.
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
export const RESEARCH_WINDOW_HOURS = [1, 6, 24, 168] as const;

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

/** Retained history. Seven days of hourly buckets. */
export const RESEARCH_RETAINED_HOURS = 168;

/** Reference position budget: 1,000 USDG at six decimals. */
export const RESEARCH_BUDGET_QUOTE = 1_000_000_000n;

const QUOTE_DECIMALS = 6;
const HOUR_MS = 3_600_000;
const TICK_LOG = Math.log(1.0001);
/** Ticks either side of spot kept in the depth curve; about +/-16% in price. */
const DEPTH_TICK_RADIUS = 1_500;

export interface ResearchHour {
  readonly hour: string;
  readonly swaps: number;
  readonly volumeQuote: string;
  readonly feesQuote: string;
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
  readonly inRangeHours: number;
  readonly modeledFeesQuote: string;
  readonly modeledNetQuote: string | null;
  readonly aprPpm: number | null;
}

export interface ResearchWindowSummary {
  readonly hours: number;
  readonly observedHours: number;
  readonly swaps: number;
  readonly volumeQuote: string;
  readonly feesQuote: string;
  readonly meanLiquidity: string;
  readonly priceChangePpm: number | null;
  readonly validShare: number | null;
  readonly references: readonly ResearchReference[];
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
  readonly tickSpacing: number;
  readonly quoteIsToken0: boolean;
  readonly rwaDecimals: number;
  readonly tick: number;
  readonly priceX18: string;
  readonly liquidity: string;
  readonly observedAt: string;
  readonly series: readonly ResearchHour[];
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
  readonly hours: readonly string[];
  readonly costs: ResearchCosts;
  readonly pools: readonly ResearchPool[];
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
  readonly token0: string;
  readonly token1: string;
  readonly rwaDecimals: number;
  readonly tick: number;
  readonly sqrtPriceX96: bigint;
  readonly priceX18: bigint;
  readonly liquidity: bigint;
  readonly observedAt: Date;
}

interface HourAccumulator {
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

function emptyHour(): HourAccumulator {
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
    token0: string;
    token1: string;
    token_decimals: number | null;
    tick: number;
    sqrt_price_x96: string;
    pool_price_x18: string;
    liquidity: string;
    block_timestamp: Date;
  }>(
    `SELECT DISTINCT ON (p.pool_address)
            p.pool_address, p.rwa_symbol, p.fee, p.token0, p.token1,
            p.token_decimals, p.tick, p.sqrt_price_x96::text, p.liquidity::text,
            p.pool_price_x18::text, c.block_timestamp
       FROM v3_strategy_checkpoint_runs c
       JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id = c.id
      WHERE c.stream_key = $1
        AND c.block_timestamp >= now() - interval '6 hours'
      ORDER BY p.pool_address, c.block_number DESC`,
    [streamKey],
  );
  return rows.map((row) => ({
    poolAddress: row.pool_address,
    rwaSymbol: row.rwa_symbol,
    fee: row.fee,
    token0: row.token0,
    token1: row.token1,
    // Checkpoints only carry decimals on a gate-valid row; the indexed universe
    // is uniformly 18-decimal RWA against 6-decimal USDG.
    rwaDecimals: row.token_decimals ?? 18,
    tick: row.tick,
    sqrtPriceX96: BigInt(row.sqrt_price_x96),
    priceX18: BigInt(row.pool_price_x18),
    liquidity: BigInt(row.liquidity),
    observedAt: row.block_timestamp,
  }));
}

interface HourlyCheckpointRow {
  pool_address: string;
  hr: Date;
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

/** Dense descending-to-ascending hour axis ending at the current hour. */
function hourAxis(now: Date): readonly Date[] {
  const end = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  return Array.from(
    { length: RESEARCH_RETAINED_HOURS },
    (_unused, index) =>
      new Date(end - (RESEARCH_RETAINED_HOURS - 1 - index) * HOUR_MS),
  );
}

function summarizeWindow(
  pool: PoolIdentity,
  tickSpacing: number,
  quoteIsToken0: boolean,
  series: readonly ResearchHour[],
  accumulators: readonly HourAccumulator[],
  hours: number,
  roundTripQuote: bigint | null,
): ResearchWindowSummary {
  const from = Math.max(0, series.length - hours);
  const slice = series.slice(from);
  const sliceAccumulators = accumulators.slice(from);
  let swaps = 0;
  let volumeQuote = 0n;
  let feesQuote = 0n;
  let liquiditySum = 0n;
  let observedHours = 0;
  let checkpoints = 0;
  let validCheckpoints = 0;
  for (const [index, hour] of slice.entries()) {
    swaps += hour.swaps;
    volumeQuote += BigInt(hour.volumeQuote);
    feesQuote += BigInt(hour.feesQuote);
    const accumulator = sliceAccumulators[index]!;
    checkpoints += accumulator.checkpoints;
    validCheckpoints += accumulator.validCheckpoints;
    if (accumulator.checkpoints > 0) {
      liquiditySum += accumulator.meanLiquidity;
      observedHours += 1;
    }
  }
  const meanLiquidity = observedHours > 0
    ? liquiditySum / BigInt(observedHours)
    : 0n;

  // The reference position enters at the window's opening price and is never
  // rebalanced, so it is sized once, from the close of the hour before the
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
        pool,
        tickSpacing,
        entry.tickLast,
        entry.sqrtPriceX96,
        fraction,
      );
      const { halfWidthTicks } = sized;
      const size = { liquidity: sized.liquidity };
      let inRangeHours = 0;
      let modeledFeesQuote = 0n;
      for (const [index, hour] of slice.entries()) {
        // An hour the checkpoint collector missed has no observed liquidity, so
        // crediting it would hand the position the pool's whole fee take.
        if (sliceAccumulators[index]!.checkpoints === 0) continue;
        const low = hour.tickMin ?? hour.tickLast;
        const high = hour.tickMax ?? hour.tickLast;
        if (low === null || high === null) continue;
        if (low < base - halfWidthTicks || high > base + halfWidthTicks) {
          continue;
        }
        inRangeHours += 1;
        const shared = size.liquidity +
          sliceAccumulators[index]!.meanLiquidity;
        if (shared > 0n) {
          modeledFeesQuote += BigInt(hour.feesQuote) * size.liquidity / shared;
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
        inRangeHours,
        modeledFeesQuote: modeledFeesQuote.toString(),
        modeledNetQuote: modeledNetQuote?.toString() ?? null,
        aprPpm: modeledNetQuote === null
          ? null
          : Number(modeledNetQuote * 1_000_000n / RESEARCH_BUDGET_QUOTE) *
            (8_760 / hours),
      });
    }
  }

  return {
    hours,
    observedHours,
    swaps,
    volumeQuote: volumeQuote.toString(),
    feesQuote: feesQuote.toString(),
    meanLiquidity: meanLiquidity.toString(),
    priceChangePpm,
    validShare: checkpoints > 0 ? validCheckpoints / checkpoints : null,
    references,
  };
}

export async function readResearch(
  client: PoolClient,
  streamKey: string,
): Promise<ResearchSnapshot> {
  const now = new Date();
  const axis = hourAxis(now);
  const since = axis[0]!.toISOString();
  const identities = await readIdentities(client, streamKey);
  const costs = await readCosts(client);
  const roundTripQuote = costs.roundTripQuote === null
    ? null
    : BigInt(costs.roundTripQuote);

  const hourly = await client.query<HourlyCheckpointRow>(
    `SELECT p.pool_address,
            date_trunc('hour', c.block_timestamp) AS hr,
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
    [streamKey, since],
  );

  const indexOfHour = new Map(
    axis.map((hour, index) => [hour.getTime(), index]),
  );
  const accumulators = new Map<string, HourAccumulator[]>();
  const hourStartBlock = new Array<bigint | null>(axis.length).fill(null);
  for (const row of hourly.rows) {
    const index = indexOfHour.get(row.hr.getTime());
    if (index === undefined) continue;
    const pool = row.pool_address;
    let series = accumulators.get(pool);
    if (series === undefined) {
      series = Array.from({ length: axis.length }, emptyHour);
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
    const known = hourStartBlock[index] ?? null;
    if (known === null || blockLo < known) hourStartBlock[index] = blockLo;
  }

  // Hours the checkpoint collector missed carry no block boundary, so the swap
  // buckets are mapped onto the hours that do, in ascending block order.
  const anchored = hourStartBlock
    .map((block, index) => ({ block, index }))
    .filter((entry): entry is { block: bigint; index: number } =>
      entry.block !== null
    )
    .sort((left, right) => (left.block < right.block ? -1 : 1));
  const boundaries = anchored.map((entry) => entry.block);

  if (boundaries.length > 0) {
    const swaps = await client.query<SwapBucketRow>(
      // Swaps are assigned to an hour by the checkpoint block that opened it.
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
    const quoteIsToken0 = pool.token0.toLowerCase() === USDG.toLowerCase();
    const series = accumulators.get(pool.poolAddress) ??
      Array.from({ length: axis.length }, emptyHour);
    const view = series.map((entry, index): ResearchHour => {
      const priceX18 = entry.priceX18 ?? pool.priceX18;
      const fee0 = entry.in0 * BigInt(pool.fee) / 1_000_000n;
      const fee1 = entry.in1 * BigInt(pool.fee) / 1_000_000n;
      const value = (amount0: bigint, amount1: bigint): bigint =>
        quoteIsToken0
          ? amount0 + quoteValueOfRwa(amount1, priceX18, pool.rwaDecimals)
          : amount1 + quoteValueOfRwa(amount0, priceX18, pool.rwaDecimals);
      return {
        hour: axis[index]!.toISOString(),
        swaps: entry.swaps,
        volumeQuote: value(entry.in0, entry.in1).toString(),
        feesQuote: value(fee0, fee1).toString(),
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
      tickSpacing,
      quoteIsToken0,
      rwaDecimals: pool.rwaDecimals,
      tick: pool.tick,
      priceX18: pool.priceX18.toString(),
      liquidity: pool.liquidity.toString(),
      observedAt: pool.observedAt.toISOString(),
      series: view,
      windows: RESEARCH_WINDOW_HOURS.map((hours) =>
        summarizeWindow(
          pool,
          tickSpacing,
          quoteIsToken0,
          view,
          series,
          hours,
          roundTripQuote,
        )
      ),
      depth: curve.filter((point) =>
        Math.abs(point.tick - pool.tick) <= DEPTH_TICK_RADIUS
      ),
      depthReferences: RESEARCH_HALF_WIDTH_FRACTIONS.map((fraction) => {
        const sized = referenceSizing(
          pool,
          tickSpacing,
          pool.tick,
          pool.sqrtPriceX96,
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
    hours: axis.map((hour) => hour.toISOString()),
    costs,
    pools: pools.sort((left, right) =>
      left.rwaSymbol.localeCompare(right.rwaSymbol) || left.fee - right.fee
    ),
  };
}
