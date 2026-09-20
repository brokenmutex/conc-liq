'use strict';
// Read-only research view over recorded RWA pool flow. No signing, no controls.
let snapshot = null;
const state = { hours: 24, width: 2, pool: null, sort: 'net', descending: true };

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usdg = (raw) => raw == null ? null : Number(raw) / 1e6;
const money = (value, digits = 2) => value == null ? '—' : new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
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
const clock = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

const WINDOWS = [[1, '1h'], [6, '6h'], [24, '24h'], [168, '7d']];
const COLUMNS = [
  ['pool', 'Pool', false], ['swaps', 'Swaps', true], ['volume', 'Volume · USDG', true],
  ['fees', 'Pool fees', true], ['share', 'Your share', true], ['inRange', 'In range', true],
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
    return {
      pool,
      window,
      reference,
      key: `${pool.rwaSymbol}-${pool.fee}`,
      swaps: window?.swaps ?? 0,
      volume: usdg(window?.volumeQuote) ?? 0,
      fees: usdg(window?.feesQuote) ?? 0,
      share: reference?.sharePpm == null ? null : reference.sharePpm / 1e6,
      inRange: reference == null || window == null ? null : reference.inRangeHours / Math.min(hours, source.hours.length),
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
  const widths = snapshot.pools[0]?.windows[0]?.references ?? [];
  $('#width-select').innerHTML = widths.map((reference, index) =>
    `<button data-action="width" data-value="${index}" aria-pressed="${state.width === index}">±${reference.halfWidthPercent.toFixed(2)}%</button>`).join('');
}

function renderTable(rows) {
  const label = WINDOWS.find(([hours]) => hours === state.hours)[1];
  $('#window-label').textContent = `trailing ${label}`;
  const budget = usdg(snapshot.budgetQuote);
  const roundTrip = usdg(snapshot.costs.roundTripQuote);
  $('#assumptions').textContent =
    `Reference position: ${money(budget, 0)} USDG entered at the window's opening price and never rebalanced. ` +
    `Modeled fees credit the position's liquidity share of recorded flow for the hours price stayed inside the range. ` +
    (roundTrip == null ? 'Round-trip action cost unavailable.' : `Net subtracts one ${money(roundTrip)} USDG mint + exit round trip.`);

  $('#league thead').innerHTML = `<tr>${COLUMNS.map(([key, title, numeric]) => {
    const sorted = state.sort === key ? (state.descending ? 'descending' : 'ascending') : null;
    return `<th data-action="sort" data-value="${key}"${numeric ? ' class="num"' : ''}${sorted ? ` aria-sort="${sorted}"` : ''}>${title}</th>`;
  }).join('')}</tr>`;

  $('#league tbody').innerHTML = rows.map((row) => {
    const selected = row.pool.poolAddress === state.pool;
    return `<tr data-action="pool" data-value="${row.pool.poolAddress}" aria-selected="${selected}" tabindex="0">
      <td><span class="pool-cell">${esc(row.pool.rwaSymbol)}<span class="tier">${(row.pool.fee / 10000).toFixed(2)}%</span></span></td>
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

/** Hourly fee bars on the left scale with the pool price on the right. */
function flowChart(pool, hours) {
  const series = pool.series.slice(-hours);
  const geometry = { width: 520, height: 230, padding: { top: 12, right: 54, bottom: 26, left: 54 } };
  const { width, height, padding } = geometry;
  if (series.length === 0) return `<svg class="chart" viewBox="0 0 ${width} ${height}"></svg>`;
  const fees = series.map((hour) => usdg(hour.feesQuote));
  const peak = Math.max(...fees, 1e-9);
  const prices = series.map((hour) => hour.priceX18 == null ? null : Number(hour.priceX18) / 1e18);
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
  const bars = series.map((hour, index) =>
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
  const label = (index, anchor) => `<text x="${x(index) + barWidth / 2}" y="${height - 8}" text-anchor="${anchor}" fill="#91a0b2" font-size="10">${clock(series[index].hour)}</text>`;
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Hourly fees and price for ${esc(pool.rwaSymbol)}, peak ${money(peak)} USDG in an hour">
    ${yAxis(geometry, (fraction) => compact(peak * fraction))}${priceAxis}
    ${bars}<path d="${line.trim()}" fill="none" stroke="#efbc72" stroke-width="1.4"/>
    <line x1="${padding.left}" x2="${width - padding.right}" y1="${height - padding.bottom}" y2="${height - padding.bottom}" stroke="#28313d"/>
    ${label(0, 'start')}${label(series.length - 1, 'end')}</svg>`;
}

function renderDetail(rows) {
  const row = rows.find((entry) => entry.pool.poolAddress === state.pool) ?? rows[0];
  if (row === undefined) { $('#detail').innerHTML = ''; return; }
  const pool = row.pool, reference = row.reference;
  const depthReference = pool.depthReferences?.[state.width] ?? null;
  const peakLiquidity = Math.max(...pool.depth.map((point) => Number(point.liquidity)), 0);
  $('#detail').innerHTML = `<div class="section-heading"><h2>${esc(pool.rwaSymbol)} · ${(pool.fee / 10000).toFixed(2)}% pool</h2>
      <span class="badge">${money(priceAtTick(pool, pool.tick), 2)} USDG</span>
      <span class="badge">tick ${pool.tick}</span>
      <span class="badge">spacing ${pool.tickSpacing}</span></div>
    <div class="charts">
      <div class="chart-card"><h3>Liquidity by price</h3>
        <p>Competing liquidity across initialized ticks, now, priced as the USDG a ±${depthReference ? depthReference.halfWidthPercent.toFixed(2) : '—'}% position would deploy to match it. The band is that range at the current price; peak depth is ${si(peakLiquidity)} raw liquidity.</p>
        ${depthChart(pool, state.width, snapshot.budgetQuote)}
        <div class="legend"><span><i class="sw-depth"></i>Depth · USDG at ±${depthReference ? depthReference.halfWidthPercent.toFixed(2) : '—'}% (left)</span><span><i class="sw-spot"></i>Spot</span><span><i class="sw-range"></i>Reference range</span></div>
      </div>
      <div class="chart-card"><h3>Hourly fees and price</h3>
        <p>Fees the whole pool charged each hour, against the pool price. Selected window.</p>
        ${flowChart(pool, state.hours)}
        <div class="legend"><span><i class="sw-range"></i>Pool fees · USDG (left)</span><span><i class="sw-spot"></i>Pool price · USDG (right)</span></div>
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
  $('#status').textContent = `Built ${clock(snapshot.generatedAt)} ET`;
  $('#footnote').textContent = `${snapshot.pools.length} pools · ${snapshot.hours.length}h retained · stream ${snapshot.streamKey}`;
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

async function load() {
  try {
    const response = await fetch('/api/research', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`research ${response.status}`);
    snapshot = await response.json();
    render();
  } catch {
    $('#status').textContent = 'Research unavailable';
    $('#league tbody').innerHTML = '<tr><td colspan="10" class="empty">Research snapshot unavailable. It is built in the background and takes a few seconds after the dashboard starts.</td></tr>';
  }
}

load();
