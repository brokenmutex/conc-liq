'use strict';
// Read-only research view over recorded RWA pool flow. No signing or execution controls.
let snapshot = null;
let detailSnapshot = null;
let refreshError = null;
let detailError = null;
let detailFailedKey = null;
let automaticMismatchRefreshUsed = false;
let summaryRequest = 0;
let detailRequest = 0;
let detailRequestKey = null;
let refreshTimer = null;
const state = { hours: 24, width: 2, pool: null, capital: '250', sort: 'net', descending: true };

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usdg = (raw) => raw == null ? null : Number(raw) / 1e6;
const money = (value, digits = 2) => value == null ? '—' : new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
function formatCapitalRaw(raw) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(raw ?? ''))) return '—';
  const value = BigInt(raw), whole = (value / 1_000_000n).toLocaleString('en-US');
  const fraction = String(value % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
const compact = (value) => value == null ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const percent = (fraction, digits = 1) => fraction == null ? '—' : `${(fraction * 100).toFixed(digits)}%`;
const SI_UNITS = [[1e18, 'E'], [1e15, 'P'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
// Intl compact notation stops at trillions and renders pool liquidity as an
// unreadable "13,800,000T", so magnitudes are named all the way up here.
const si = (value) => {
  if (value == null || !Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  for (const [scale, suffix] of SI_UNITS) {
    if (magnitude >= scale) return `${(value / scale).toFixed(magnitude / scale >= 100 ? 0 : 1)}${suffix}`;
  }
  return value.toFixed(0);
};
const signClass = (value) => value == null ? 'muted' : value >= 0 ? 'positive' : 'negative';
// The series grain is set by the read model and shipped in the snapshot, so
// the view derives its bucket arithmetic rather than assuming hourly points.
const perHour = (source) => 60 / source.bucketMinutes;
const minutesLabel = (minutes) => minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
const grain = (source) => minutesLabel(source.bucketMinutes);
// The plot is about 412px wide, so beyond this many bars they stop being
// distinguishable. Longer windows fold buckets together for the chart only;
// the league table and every window figure keep the full grain.
const MAX_BARS = 200;
const stride = (count) => Math.max(1, Math.ceil(count / MAX_BARS));
const barGrain = (source, count) => minutesLabel(source.bucketMinutes * stride(count));
const clock = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

function capitalQuoteRaw(value) {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const raw = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0') || '0');
  return raw >= 1_000_000n && raw <= 100_000n * 1_000_000n ? String(raw) : null;
}

function freshnessLabel(envelope, now = Date.now()) {
  const source = envelope?.sourceFreshness;
  if (source?.status === 'unavailable' && !source?.asOf && !envelope?.asOf) return 'source unavailable · age unavailable';
  const asOf = source?.asOf ?? envelope?.asOf;
  const timestamp = Date.parse(String(asOf ?? ''));
  if (!Number.isFinite(timestamp) || timestamp > now) return 'source age unavailable';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  const stated = source?.status;
  const maxAge = Number.isSafeInteger(source?.maxAgeSeconds) ? source.maxAgeSeconds : 90;
  const status = stated === 'unavailable' ? 'unavailable'
    : stated === 'stale' || seconds > maxAge ? 'stale' : 'fresh';
  const age = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `source ${status} · ${age} old`;
}

const WINDOWS = [[0.25, '15m'], [1, '1h'], [6, '6h'], [24, '24h'], [168, '7d']];
const COLUMNS = [
  ['pool', 'Pool', false], ['swaps', 'Exact swaps', true], ['volume', 'Volume · USDG', true],
  ['fees', 'LP fees', true], ['share', 'Your share', true], ['inRange', 'In range', true],
  ['gross', 'Modeled fees', true], ['net', 'Net of costs', true], ['apr', 'APR', true],
  ['gate', 'Gate-valid', true],
];

/**
 * Pool depth read as money: the USDG a reference position of the same width
 * would have to deploy to hold that much liquidity. Null when the pool has no
 * sizing to scale against, and the axis then falls back to raw L.
 */
function depthQuote(liquidity, reference, budgetQuote) {
  const referenceLiquidity = Number(reference?.liquidity ?? 0);
  if (!(referenceLiquidity > 0) || !Number.isFinite(liquidity)) return null;
  return liquidity / referenceLiquidity * (Number(budgetQuote) / 1e6);
}

/** Three horizontal gridlines with a left-hand value label on each. */
function yAxis({ width, height, padding }, label) {
  return [0, 0.5, 1].map((fraction) => {
    const y = height - padding.bottom - fraction * (height - padding.top - padding.bottom);
    return `<line x1="${padding.left}" x2="${width - padding.right}" y1="${y}" y2="${y}" stroke="#232d3a"/>` +
      `<text x="${padding.left - 6}" y="${y + 3}" text-anchor="end" fill="#91a0b2" font-size="10">${label(fraction)}</text>`;
  }).join('');
}

/** Proportion bar. Drawn with attributes because the page forbids inline styles. */
function bar(fraction) {
  const filled = Math.max(0, Math.min(1, fraction ?? 0)) * 100;
  return `<svg class="bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">` +
    `<rect width="100" height="4" rx="2" fill="#233040"/>` +
    `<rect width="${filled.toFixed(1)}" height="4" rx="2" fill="#69debd"/></svg>`;
}

/**
 * The protocol's share of the fee, as a percentage. `feeProtocol` is the v3
 * divisor, so a 4 hands a quarter of every fee to the protocol and a 0 hands
 * over nothing. The two legs are set independently and are shown as a range
 * when a pool ever splits them.
 */
function protocolCut(pool) {
  const share = (divisor) => divisor > 0 ? 100 / divisor : 0;
  const low = Math.min(share(pool.feeProtocol0), share(pool.feeProtocol1));
  const high = Math.max(share(pool.feeProtocol0), share(pool.feeProtocol1));
  return low === high ? `${low.toFixed(1)}%` : `${low.toFixed(1)}–${high.toFixed(1)}%`;
}

/** Human USDG price at a tick, anchored on the pool's observed price. */
function priceAtTick(pool, tick) {
  const direction = pool.quoteIsToken0 ? -1 : 1;
  return (Number(pool.priceX18) / 1e18) * Math.pow(1.0001, (tick - pool.tick) * direction);
}

/** One comparison row per pool for the selected window and half-width. */
function leagueRows(source, hours, widthIndex) {
  return source.pools.map((pool) => {
    const window = pool.windows.find((entry) => entry.hours === hours) ?? null;
    const reference = window?.references[widthIndex] ?? null;
    const bucketCount = source.bucketCount ?? source.buckets?.length ?? 0;
    return {
      pool,
      window,
      reference,
      key: `${pool.rwaSymbol}-${pool.fee}`,
      swaps: window?.swapAvailability === 'available' ? window.swaps : null,
      volume: usdg(window?.volumeQuote),
      fees: usdg(window?.feesQuote),
      share: reference?.sharePpm == null ? null : reference.sharePpm / 1e6,
      inRange: reference == null || window == null || bucketCount <= 0 ? null : reference.inRangeBuckets /
        Math.min(hours * perHour(source), bucketCount),
      gross: usdg(reference?.modeledFeesQuote),
      net: usdg(reference?.modeledNetQuote),
      apr: reference?.aprPpm == null ? null : reference.aprPpm / 1e6,
      gate: window?.validShare ?? null,
    };
  });
}

function sortRows(rows, column, descending) {
  // Unavailable values stay last in both directions: a pool with no modeled
  // result must never outrank one that produced a number.
  const direction = descending ? -1 : 1;
  return [...rows].sort((left, right) => {
    if (column === 'pool') return left.key.localeCompare(right.key) * direction;
    const a = left[column], b = right[column];
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return (a - b) * direction;
  });
}

function renderControls() {
  $('#window-select').innerHTML = WINDOWS.map(([hours, label]) =>
    `<button data-action="window" data-value="${hours}" aria-pressed="${state.hours === hours}">${label}</button>`).join('');
  const widths = state.hours === 0.25 ? [] : snapshot.pools.find((pool) => pool.windows.some((window) => window.references.length > 0))?.windows.find((window) => window.references.length > 0)?.references ?? [];
  $('#width-select').innerHTML = widths.map((reference, index) =>
    `<button data-action="width" data-value="${index}" aria-pressed="${state.width === index}">±${reference.halfWidthPercent.toFixed(2)}%</button>`).join('');
}

function renderTable(rows) {
  const label = WINDOWS.find(([hours]) => hours === state.hours)[1];
  $('#window-label').textContent = `trailing ${label}`;
  const budget = usdg(snapshot.budgetQuote);
  const roundTrip = usdg(snapshot.costs.roundTripQuote);
  const selectedWindow = rows[0]?.window;
  $('#assumptions').textContent = `${swapCountAvailability(selectedWindow)} ` +
    `Selected capital: ${formatCapitalRaw(snapshot.capitalQuoteRaw)} USDG. The input starts at the same 250 USDG default as setup; V3 token mix and liquidity share are recomputed for the selected amount using exact integer math. ` +
    `Volume, LP fees, and candidate economics use retained ${grain(snapshot)} buckets and are not exact-window values. ` +
    (state.hours === 0.25 ? '' :
    `Reference position enters at the window's opening price and is never rebalanced. ` +
    `Fees are the LP side only: the protocol's cut of each pool's fee is already removed. ` +
    `Modeled fees credit the position's liquidity share of recorded flow for the ${grain(snapshot)} buckets price stayed inside the range. ` +
    (roundTrip == null ? 'Round-trip action cost unavailable.' : `Net subtracts one ${money(roundTrip)} USDG recorded mint + exit cost estimate; actual costs can reprice.`));

  $('#league thead').innerHTML = `<tr>${COLUMNS.map(([key, title, numeric]) => {
    const sorted = state.sort === key ? (state.descending ? 'descending' : 'ascending') : null;
    return `<th data-action="sort" data-value="${key}"${numeric ? ' class="num"' : ''}${sorted ? ` aria-sort="${sorted}"` : ''}>${title}</th>`;
  }).join('')}</tr>`;

  $('#league tbody').innerHTML = rows.map((row) => {
    const selected = row.pool.poolAddress === state.pool;
    const status = !row.pool.registryEnabled ? 'Inactive' : row.pool.stateStatus === 'stale' ? 'Stale' : row.pool.stateStatus === 'unverified' ? 'Unverified' : row.pool.stateStatus === 'unavailable' ? 'No checkpoint' : '';
    return `<tr data-action="pool" data-value="${row.pool.poolAddress}" aria-selected="${selected}" tabindex="0">
      <td><span class="pool-cell">${esc(row.pool.rwaSymbol)}<span class="tier">${(row.pool.fee / 10000).toFixed(2)}%</span>${status ? `<span class="tier">${status}</span>` : ''}</span></td>
      <td class="num">${compact(row.swaps)}</td>
      <td class="num">${compact(row.volume)}</td>
      <td class="num">${money(row.fees)}</td>
      <td class="num">${percent(row.share, 2)}</td>
      <td class="num">${percent(row.inRange, 0)}${bar(row.inRange)}</td>
      <td class="num">${money(row.gross)}</td>
      <td class="num ${signClass(row.net)}">${money(row.net)}</td>
      <td class="num ${signClass(row.apr)}">${row.apr == null ? '—' : percent(row.apr, 0)}</td>
      <td class="num">${percent(row.gate, 0)}</td>
    </tr>`;
  }).join('');
}

/** Step curve of active liquidity by tick, with spot and the reference band. */
function depthChart(pool, widthIndex, budgetQuote) {
  const points = pool.depth;
  const reference = pool.depthReferences?.[widthIndex] ?? null;
  const halfWidthTicks = reference?.halfWidthTicks ?? pool.tickSpacing;
  const geometry = { width: 520, height: 230, padding: { top: 12, right: 14, bottom: 26, left: 54 } };
  const { width, height, padding } = geometry;
  if (points.length < 2) return `<svg class="chart" viewBox="0 0 ${width} ${height}"></svg>`;
  const ticks = points.map((point) => point.tick);
  const low = Math.min(...ticks, pool.tick), high = Math.max(...ticks, pool.tick);
  const peak = Math.max(...points.map((point) => Number(point.liquidity)), 1);
  const x = (tick) => padding.left + (tick - low) / (high - low || 1) * (width - padding.left - padding.right);
  const y = (liquidity) => height - padding.bottom - liquidity / peak * (height - padding.top - padding.bottom);
  let path = `M${x(low)},${height - padding.bottom}`;
  for (const [index, point] of points.entries()) {
    const next = points[index + 1]?.tick ?? high;
    path += ` L${x(point.tick)},${y(Number(point.liquidity))} L${x(next)},${y(Number(point.liquidity))}`;
  }
  path += ` L${x(high)},${height - padding.bottom} Z`;
  const base = Math.floor(pool.tick / pool.tickSpacing) * pool.tickSpacing;
  const bandLow = Math.max(low, base - halfWidthTicks), bandHigh = Math.min(high, base + halfWidthTicks);
  const xAxis = [low, Math.round((low + high) / 2), high].map((tick) =>
    `<text x="${x(tick)}" y="${height - 8}" text-anchor="middle" fill="#91a0b2" font-size="10">${money(priceAtTick(pool, tick), 2)}</text>`).join('');
  const scale = (value) => {
    const quote = depthQuote(value, reference, budgetQuote);
    return quote === null ? si(value) : compact(quote);
  };
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Depth by price for ${esc(pool.rwaSymbol)}, peak ${scale(peak)} USDG at the selected width, raw liquidity ${si(peak)}">
    ${yAxis(geometry, (fraction) => scale(peak * fraction))}
    <rect x="${x(bandLow)}" y="${padding.top}" width="${Math.max(1, x(bandHigh) - x(bandLow))}" height="${height - padding.top - padding.bottom}" fill="#69debd" opacity=".12"/>
    <path d="${path}" fill="#96acff" opacity=".28"/>
    <path d="${path}" fill="none" stroke="#96acff" stroke-width="1.2"/>
    <line x1="${x(pool.tick)}" x2="${x(pool.tick)}" y1="${padding.top}" y2="${height - padding.bottom}" stroke="#efbc72" stroke-width="1.4" stroke-dasharray="3 3"/>
    <line x1="${padding.left}" x2="${width - padding.right}" y1="${height - padding.bottom}" y2="${height - padding.bottom}" stroke="#28313d"/>
    ${xAxis}</svg>`;
}

/**
 * Fold a series down to at most MAX_BARS points. Fees add across a fold, and
 * the price is the last one the fold actually observed, so a fold that spans a
 * gap in the checkpoints still reports the price it ended on rather than none.
 */
function condense(series) {
  const step = stride(series.length);
  if (step === 1) return series;
  const folded = [];
  for (let index = 0; index < series.length; index += step) {
    const chunk = series.slice(index, index + step);
    const priced = chunk.filter((bucket) => bucket.priceX18 != null);
    const covered = chunk.every((bucket) => bucket.feesQuote != null);
    folded.push({
      bucket: chunk[0].bucket,
      feesQuote: covered ? chunk.reduce((total, bucket) => total + BigInt(bucket.feesQuote), 0n).toString() : null,
      priceX18: priced.length === 0 ? null : priced[priced.length - 1].priceX18,
    });
  }
  return folded;
}

/** Per-bucket fee bars on the left scale with the pool price on the right. */
function flowChart(pool, buckets) {
  const drawn = barGrain(snapshot, Math.min(buckets, pool.series.length));
  const series = condense(pool.series.slice(-buckets));
  const geometry = { width: 520, height: 230, padding: { top: 12, right: 54, bottom: 26, left: 54 } };
  const { width, height, padding } = geometry;
  if (series.length === 0) return `<svg class="chart" viewBox="0 0 ${width} ${height}"></svg>`;
  const fees = series.map((bucket) => usdg(bucket.feesQuote));
  const peak = Math.max(...fees, 1e-9);
  const prices = series.map((bucket) => bucket.priceX18 == null ? null : Number(bucket.priceX18) / 1e18);
  const known = prices.filter((price) => price != null);
  // Every price can be absent over a window the checkpoint collector missed;
  // the price scale is then undefined rather than an infinite span.
  const hasPrice = known.length > 0;
  const priceLow = hasPrice ? Math.min(...known) : 0, priceHigh = hasPrice ? Math.max(...known) : 0;
  const span = width - padding.left - padding.right;
  const barWidth = Math.max(1, span / series.length - 1);
  const x = (index) => padding.left + index * (span / series.length);
  const plot = height - padding.top - padding.bottom;
  const yFee = (value) => height - padding.bottom - value / peak * plot;
  const yPrice = (value) => height - padding.bottom - (value - priceLow) / (priceHigh - priceLow || 1) * plot;
  const bars = series.map((bucket, index) => fees[index] == null ? '' :
    `<rect x="${x(index)}" y="${yFee(fees[index])}" width="${barWidth}" height="${Math.max(0, height - padding.bottom - yFee(fees[index]))}" fill="#69debd" opacity=".55"/>`).join('');
  let line = '', open = false;
  for (const [index, price] of prices.entries()) {
    if (price == null) { open = false; continue; }
    line += `${open ? 'L' : 'M'}${x(index) + barWidth / 2},${yPrice(price)} `;
    open = true;
  }
  const priceAxis = hasPrice ? [0, 0.5, 1].map((fraction) => {
    const y = height - padding.bottom - fraction * plot;
    return `<text x="${width - padding.right + 6}" y="${y + 3}" text-anchor="start" fill="#efbc72" font-size="10">${money(priceLow + fraction * (priceHigh - priceLow), 2)}</text>`;
  }).join('') : '';
  const label = (index, anchor) => `<text x="${x(index) + barWidth / 2}" y="${height - 8}" text-anchor="${anchor}" fill="#91a0b2" font-size="10">${clock(series[index].bucket)}</text>`;
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Fees and price for ${esc(pool.rwaSymbol)} in ${drawn} buckets, peak ${money(peak)} USDG in a bucket">
    ${yAxis(geometry, (fraction) => compact(peak * fraction))}${priceAxis}
    ${bars}<path d="${line.trim()}" fill="none" stroke="#efbc72" stroke-width="1.4"/>
    <line x1="${padding.left}" x2="${width - padding.right}" y1="${height - padding.bottom}" y2="${height - padding.bottom}" stroke="#28313d"/>
    ${label(0, 'start')}${label(series.length - 1, 'end')}</svg>`;
}

function renderDetail(rows) {
  const summaryPool = snapshot?.pools.find((entry) => entry.poolAddress === state.pool);
  if (!summaryPool) { $('#detail').innerHTML = ''; return; }
  const matches = detailSnapshot?.snapshotId === snapshot.snapshotId &&
    detailSnapshot?.capitalQuoteRaw === snapshot.capitalQuoteRaw &&
    detailSnapshot?.pool?.poolAddress === state.pool &&
    detailSnapshot?.hours === state.hours && detailSnapshot?.width === state.width;
  const pool = matches ? detailSnapshot.pool : null;
  if (!pool) {
    const stateMessage = detailError ? `Selected-pool detail refresh failed (${esc(detailError)}). The summary snapshot is retained; detail values remain unavailable until a matching snapshot arrives.` : 'Loading selected-pool history for this snapshot…';
    $('#detail').innerHTML = `<div class="section-heading"><h2>${esc(summaryPool.rwaSymbol)} · ${(summaryPool.fee / 10000).toFixed(2)}% pool</h2><span class="badge">${esc(stateMessage)}</span></div>`;
    return;
  }
  const reference = pool.windows.find((window) => window.hours === state.hours)?.references?.[state.width] ?? null;
  if (pool.tick == null || pool.priceX18 == null) {
    const exact = pool.windows.find((window) => window.hours === state.hours);
    $('#detail').innerHTML = `<div class="section-heading"><h2>${esc(pool.rwaSymbol)} · ${(pool.fee / 10000).toFixed(2)}% pool</h2><span class="badge">${esc(pool.stateStatus)}</span></div>
      <p>Registered pool identity is available; checkpoint state is unavailable, so price, depth, and modeled candidate economics are unavailable.</p>
      ${exact ? `<p>Trailing ${WINDOWS.find(([hours]) => hours === state.hours)[1]}: ${esc(swapCountAvailability(exact))}</p>` : ''}`;
    return;
  }
  const exactWindow = pool.windows.find((window) => window.hours === state.hours);
  const exactFlowStatus = swapCountAvailability(exactWindow);
  const depthReference = pool.depthReferences?.[state.width] ?? null;
  const peakLiquidity = Math.max(...pool.depth.map((point) => Number(point.liquidity)), 0);
  $('#detail').innerHTML = `<div class="section-heading"><h2>${esc(pool.rwaSymbol)} · ${(pool.fee / 10000).toFixed(2)}% pool</h2>
      <span class="badge">${money(priceAtTick(pool, pool.tick), 2)} USDG</span>
      <span class="badge">tick ${pool.tick}</span>
      <span class="badge">spacing ${pool.tickSpacing}</span>
      <span class="badge">${protocolCut(pool)} to protocol</span></div>
    <div class="charts">
      <div class="chart-card"><h3>Liquidity by price</h3>
        <p>Competing liquidity across initialized ticks, now, priced as the USDG a ±${depthReference ? depthReference.halfWidthPercent.toFixed(2) : '—'}% position would deploy to match it. The band is that range at the current price; peak depth is ${si(peakLiquidity)} raw liquidity.</p>
        ${depthChart(pool, state.width, snapshot.budgetQuote)}
        <div class="legend"><span><i class="sw-depth"></i>Depth · USDG at ±${depthReference ? depthReference.halfWidthPercent.toFixed(2) : '—'}% (left)</span><span><i class="sw-spot"></i>Spot</span><span><i class="sw-range"></i>Reference range</span></div>
      </div>
      <div class="chart-card"><h3>Fees and price</h3>
        ${state.hours === 0.25
          ? `<p>${esc(exactFlowStatus)} Volume, fees, and candidate economics remain unavailable as exact-window values.</p>`
          : `<p>${esc(exactFlowStatus)} The flow chart shows retained ${barGrain(snapshot, Math.min(state.hours * perHour(snapshot), pool.series.length))} time buckets; its volume and fees are not exact-window values.</p>
        ${flowChart(pool, state.hours * perHour(snapshot))}
        <div class="legend"><span><i class="sw-range"></i>Pool fees · USDG (left)</span><span><i class="sw-spot"></i>Pool price · USDG (right)</span></div>`}
      </div>
    </div>`;
}

function render() {
  if (snapshot === null) return;
  const rows = sortRows(leagueRows(snapshot, state.hours, state.width), state.sort, state.descending);
  if (!rows.some((row) => row.pool.poolAddress === state.pool)) state.pool = rows[0]?.pool.poolAddress ?? null;
  renderControls();
  renderTable(rows);
  renderDetail(rows);
  const active = snapshot.pools.find((pool) => pool.poolAddress === state.pool);
  const selectedWindow = active?.windows.find((window) => window.hours === state.hours);
  const coverage = selectedWindow?.swapAvailability === 'available'
    ? ` · exact swaps as of ${clock(selectedWindow.swapAsOf)}`
    : ' · exact swaps unavailable';
  const sourceAge = freshnessLabel(snapshot);
  const selectedRaw = capitalQuoteRaw(state.capital);
  const amountStatus = selectedRaw && selectedRaw !== snapshot.capitalQuoteRaw
    ? ` · showing ${formatCapitalRaw(snapshot.capitalQuoteRaw)} USDG while updating for ${state.capital} USDG`
    : '';
  const failureStatus = refreshError ? ` · refresh failed; showing last snapshot (${sourceAge})` : '';
  $('#status').textContent = `Built ${clock(snapshot.generatedAt)} ET · ${sourceAge}${amountStatus}${failureStatus}`;
  $('#window-label').textContent = `${WINDOWS.find(([hours]) => hours === state.hours)[1]}${coverage}`;
  const retainedHours = snapshot.retainedHours ?? ((snapshot.bucketCount ?? snapshot.retainedBucketCount ?? snapshot.buckets?.length ?? 0) / perHour(snapshot));
  $('#footnote').textContent = `${snapshot.pools.length} pools · ${retainedHours}h retained in ${grain(snapshot)} buckets · stream ${snapshot.streamKey}`;
  if (!$('#research-panel').hidden) void loadSelectedDetail();
}

function swapCountAvailability(window) {
  if (window?.swapAvailability === 'available') {
    return `Exact swap count available as of ${clock(window.swapAsOf)}.`;
  }
  if (window?.swapAvailability === 'incomplete') {
    return `Exact swap count unavailable: canonical timestamp coverage does not span the full trailing ${WINDOWS.find(([hours]) => hours === state.hours)?.[1] ?? 'selected'} window through ${window.swapAsOf ? clock(window.swapAsOf) : 'a fresh canonical end'}.`;
  }
  if (window?.swapAvailability === 'changed') {
    return 'Exact swap count unavailable: canonical coverage changed during the read; refresh for a consistent result.';
  }
  return 'Exact swap count unavailable: no fresh, matching canonical coverage end is available.';
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (target === null) return;
  const value = target.dataset.value;
  if (target.dataset.action === 'window') state.hours = Number(value);
  else if (target.dataset.action === 'width') state.width = Number(value);
  else if (target.dataset.action === 'pool') state.pool = value;
  else if (target.dataset.action === 'sort') {
    if (state.sort === value) state.descending = !state.descending;
    else { state.sort = value; state.descending = value !== 'pool'; }
  } else return;
  render();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target.closest('[data-action="pool"]');
  if (target === null) return;
  event.preventDefault();
  state.pool = target.dataset.value;
  render();
});

async function loadSelectedDetail() {
  if (!snapshot || !state.pool) return;
  const raw = capitalQuoteRaw(state.capital);
  if (!raw || raw !== snapshot.capitalQuoteRaw) return;
  const key = `${snapshot.snapshotId}:${state.pool}:${raw}:${state.hours}:${state.width}`;
  if (detailFailedKey === key) return;
  if (detailRequestKey === key || (detailSnapshot?.snapshotId === snapshot.snapshotId &&
      detailSnapshot?.capitalQuoteRaw === raw && detailSnapshot?.pool?.poolAddress === state.pool &&
      detailSnapshot?.hours === state.hours && detailSnapshot?.width === state.width)) return;
  detailRequestKey = key;
  const request = ++detailRequest;
  try {
    const query = new URLSearchParams({pool:state.pool,capitalQuoteRaw:raw,
      hours:String(state.hours),width:String(state.width),snapshotId:snapshot.snapshotId});
    const response = await fetch(`/api/research/details?${query}`, {headers:{accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(20_000)});
    if (response.status === 409) {
      if (request === detailRequest) {
        detailRequestKey = null;
        if (automaticMismatchRefreshUsed) {
          detailFailedKey = key;
          detailError = 'snapshot changed repeatedly; refresh the Research summary to retry';
          render();
        } else {
          automaticMismatchRefreshUsed = true;
          detailFailedKey = key;
          void refreshSummary();
        }
      }
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (request !== detailRequest) return;
    if (result.snapshotId !== snapshot?.snapshotId || result.capitalQuoteRaw !== raw ||
        result.pool?.poolAddress !== state.pool || result.hours !== state.hours || result.width !== state.width) {
      detailRequestKey = null;
      detailFailedKey = key;
      detailError = 'detail did not match the current Research selection';
      render();
      return;
    }
    detailSnapshot = result;
    detailError = null;
    detailFailedKey = null;
    automaticMismatchRefreshUsed = false;
    render();
  } catch {
    if (request !== detailRequest) return;
    detailRequestKey = null;
    detailFailedKey = key;
    detailError = 'the selected pool history is unavailable';
    render();
  }
}

async function refreshSummary() {
  const raw = capitalQuoteRaw(state.capital);
  if (!raw) {
    refreshError = null;
    $('#status').textContent = 'Enter USDG capital from 1 to 100,000, with at most six decimal places.';
    $('#detail').innerHTML = '<p>Capital is outside the supported range. Existing results remain labeled with their original amount.</p>';
    return;
  }
  const request = ++summaryRequest;
  const refreshButton = $('#research-refresh');
  if (refreshButton) { refreshButton.disabled = true; refreshButton.textContent = 'Refreshing…'; }
  try {
    const response = await fetch(`/api/research?capitalQuoteRaw=${raw}`, {
      headers:{accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    if (request !== summaryRequest) return;
    if (!Array.isArray(next.pools) || next.capitalQuoteRaw !== raw ||
        typeof next.snapshotId !== 'string' || !next.snapshotId || !next.generatedAt) {
      throw new Error('research response did not match the selected capital or snapshot contract');
    }
    const identityChanged = snapshot?.snapshotId !== next.snapshotId ||
      snapshot?.capitalQuoteRaw !== next.capitalQuoteRaw;
    snapshot = next;
    refreshError = null;
    detailError = null;
    detailFailedKey = null;
    if (identityChanged) { detailSnapshot = null; detailRequestKey = null; }
    render();
    window.dispatchEvent(new CustomEvent('research-summary-updated', {detail:{
      snapshotId:snapshot.snapshotId,capitalQuoteRaw:snapshot.capitalQuoteRaw,pools:snapshot.pools,
    }}));
  } catch {
    if (request !== summaryRequest) return;
    refreshError = 'refresh unavailable';
    if (snapshot === null) {
      $('#status').textContent = 'Research snapshot unavailable. Use Refresh to retry; no current research data has been received.';
      $('#league tbody').innerHTML = '<tr><td colspan="10" class="empty">Research is unavailable. Retrying will request a new snapshot.</td></tr>';
    } else {
      render();
    }
  } finally {
    if (request === summaryRequest && refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh research';
    }
  }
}

if (typeof document !== 'undefined' && typeof document.querySelector === 'function' && document.querySelector('#research-panel')) {
  const capitalInput = $('#research-capital');
  let capitalTimer = null;
  if (capitalInput) {
    capitalInput.addEventListener('input', () => {
      state.capital = capitalInput.value;
      clearTimeout(capitalTimer);
      capitalTimer = setTimeout(() => void refreshSummary(), 300);
      if (snapshot) render();
    });
    capitalInput.addEventListener('change', () => void refreshSummary());
  }
  $('#research-refresh')?.addEventListener('click', () => void refreshSummary());
  $('#research-use-in-setup')?.addEventListener('click', () => {
    const raw = capitalQuoteRaw(state.capital);
    const selected = snapshot?.pools.find((pool) => pool.poolAddress === state.pool);
    if (!raw || !selected || snapshot?.capitalQuoteRaw !== raw) {
      $('#status').textContent = 'Choose valid USDG capital and a pool before sending this setup selection.';
      return;
    }
    window.dispatchEvent(new CustomEvent('research-setup-handoff', {detail:{
      capital:state.capital,poolAddress:selected.poolAddress,snapshotId:snapshot.snapshotId,
    }}));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !$('#research-panel').hidden) void refreshSummary();
  });
  window.addEventListener('dashboard-tab-change', (event) => {
    if (event.detail?.tabId === 'research-tab') void refreshSummary();
  });
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && !$('#research-panel').hidden) void refreshSummary();
  }, 60_000);
  void refreshSummary();
}
