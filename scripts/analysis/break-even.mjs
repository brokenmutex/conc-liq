// Break-even analysis for the active-LP strategy: at what deployed capital,
// and at what recentring cadence, does the strategy clear its own costs.
//
// This script is READ-ONLY. It opens one REPEATABLE READ READ ONLY
// transaction against the research database, reconstructs cost totals
// directly from the immutable action/cost ledgers of the two campaigns that
// have complete records (the closed NVDA/USDG live pilot and the closed
// AAPL/USDG RangeKeeper paper campaign), and prints:
//
//   1. an independent reconstruction of each campaign's cost total, checked
//      against the figures already published in docs/research/ (a drift
//      alarm, since the ledgers are append-only and should never change);
//   2. the break-even arithmetic model (see docs/research/break-even-2026-09-30.md
//      for the derivation and every assumption spelled out);
//   3. a capital/cadence sensitivity grid;
//   4. a dilution sensitivity built from the one liquidity snapshot series
//      this repository has (the NVDA campaign's per-mark pool-liquidity
//      reads).
//
// Every number below is labelled ESTABLISHED (read directly off the ledger
// in this run), CITED (published elsewhere, not re-derived here because it
// needs an oracle-price replay this script does not perform), or MODELLED
// (an assumption-bearing extrapolation, always with its assumptions named
// next to it). Nothing here is an execution recommendation.
//
// Usage:
//   node --import tsx scripts/analysis/break-even.mjs [--json]
//
// DATABASE_URL defaults to the same local socket connection used throughout
// this repository's read-only tooling.

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/conc_liq?host=/var/run/postgresql';
const PRINT_JSON = process.argv.includes('--json');

const NVDA_CAMPAIGN_ID = 'f8affe19-4d89-4132-b214-d67e5ad81331';
const AAPL_CAMPAIGN_ID = '31802d63-9ec8-423c-bc1b-f781f8b44f92';
const AAPL_POOL_ADDRESS = '0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d'; // AAPL/USDG fee-500, per docs/research/rangekeeper-operational-cost-reduction-2026-09-27.md
const STATIC_NO_SWAP_PATH = 'paper_static_manual_no_swap_v1';
const OPEN_STAGES = ['approve_token0', 'approve_token1', 'mint'];
const CLOSE_STAGES = ['withdraw_collect', 'cleanup_token0', 'cleanup_token1'];

const USDG_DECIMALS = 1_000_000n; // confirmed: NVDA campaign budgetQuote "250000000" == 250 USDG

function fmt(raw, decimals = USDG_DECIMALS, places = 6) {
  const n = Number(raw) / Number(decimals);
  return n.toFixed(places);
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const report = await buildReport(client);
    await client.query('COMMIT');
    if (PRINT_JSON) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHuman(report);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

async function buildReport(client) {
  const nvda = await loadNvdaCampaign(client);
  const aapl = await loadAaplCampaign(client);
  const calibration = await loadStaticCalibration(client);
  const model = buildBreakEvenModel(nvda, aapl);
  const sensitivity = buildSensitivityGrid(model);
  const dilution = buildDilutionModel(nvda);
  return { generatedAt: new Date().toISOString(), nvda, aapl, calibration, model, sensitivity, dilution };
}

// ---------------------------------------------------------------------------
// NVDA/USDG live pilot (live_pilot_v1) -- the campaign that lost money.
// ---------------------------------------------------------------------------
async function loadNvdaCampaign(client) {
  const campaign = (await client.query(
    `SELECT state, config FROM live_pilot_v1.campaigns WHERE id = $1`,
    [NVDA_CAMPAIGN_ID],
  )).rows[0];
  if (!campaign) throw new Error('NVDA live pilot campaign not found');
  const state = campaign.state;

  const byAction = (await client.query(
    `SELECT intent->>'action' AS action, status, count(*)::int AS n,
            coalesce(sum((receipt->'gasValuation'->>'quote')::numeric), 0)::text AS gas_quote_raw
     FROM live_pilot_v1.actions
     WHERE campaign_id = $1 AND status IN ('confirmed','reverted')
     GROUP BY 1,2 ORDER BY 1,2`,
    [NVDA_CAMPAIGN_ID],
  )).rows;

  const totalGasRaw = byAction.reduce((sum, row) => sum + BigInt(row.gas_quote_raw), 0n);

  const span = (await client.query(
    `SELECT min(created_at) AS first_action, max(created_at) AS last_action
     FROM live_pilot_v1.actions WHERE campaign_id = $1`,
    [NVDA_CAMPAIGN_ID],
  )).rows[0];

  const share = (await client.query(
    `SELECT
       min((own_liq::numeric / pool_liq::numeric) * 1000000) AS min_ppm,
       avg((own_liq::numeric / pool_liq::numeric) * 1000000) AS avg_ppm,
       max((own_liq::numeric / pool_liq::numeric) * 1000000) AS max_ppm,
       count(*) AS n
     FROM (
       SELECT (snapshot->'snapshot'->>'poolLiquidity')::numeric AS pool_liq,
              (snapshot->'snapshot'->'position'->>'liquidity')::numeric AS own_liq
       FROM live_pilot_v1.marks
       WHERE campaign_id = $1 AND kind = 'mark' AND snapshot->>'phase' = 'holding'
     ) t
     WHERE own_liq IS NOT NULL AND pool_liq > 0`,
    [NVDA_CAMPAIGN_ID],
  )).rows[0];

  return {
    label: 'NVDA/USDG live pilot (live_pilot_v1)',
    campaignId: NVDA_CAMPAIGN_ID,
    evidenceClass: 'measured',
    capitalUsdg: fmt(BigInt(campaign.config.initialCapitalQuote)),
    halfWidthSpacings: campaign.config.strategy.halfWidthSpacings,
    maxLiquiditySharePpm: campaign.config.strategy.maxLiquiditySharePpm,
    firstAction: span.first_action,
    lastAction: span.last_action,
    recenterCount: state.retiredTokenIds.length,
    gasSpentQuoteUsdg_fromState: fmt(BigInt(state.gasSpentQuote)),
    gasSpentQuoteUsdg_reconstructedFromLedger: fmt(totalGasRaw),
    ledgerReconciles: BigInt(state.gasSpentQuote) === totalGasRaw,
    actionsByKind: byAction.map((r) => ({ action: r.action, status: r.status, n: r.n, gasUsdg: fmt(BigInt(r.gas_quote_raw)) })),
    ownLiquidityShare: {
      note: 'own liquidity / pool liquidity at each holding-phase mark; established directly from this campaign\'s ledger',
      samples: Number(share.n),
      minPpm: Number(share.min_ppm),
      avgPpm: Number(share.avg_ppm),
      maxPpm: Number(share.max_ppm),
    },
    cited: {
      source: 'notes/live-cost-analysis-2026-09-17.md (unregistered analysis; scripts/data live outside the tracked script registry -- see report)',
      feesEarnedUsdg: '7.38',
      totalCostUsdg: '12.78',
      gasUsdg: '9.56',
      swapShortfallUsdg: '3.22',
      heldHours: '47.8',
      wallHours: '63.4',
      recenterEpisodes: 38,
      postAllowanceGasPerRecenterUsdg: '0.134',
      postAllowanceSwapShortfallPerRecenterUsdg: '0.051',
      postAllowanceAllInPerRecenterUsdg: '0.184',
      preAllowanceAllInPerRecenterUsdg: '0.239',
      timeoutChurnCostUsdg: '~3.3 (about a quarter of total cost; 8 of 12 exits were infrastructure/evidence timeouts, not operator decisions)',
    },
  };
}

// ---------------------------------------------------------------------------
// AAPL/USDG RangeKeeper paper campaign (rangekeeper_v1) -- second, independent
// campaign at a different capital and pool, used to check whether the NVDA
// cost structure generalises at all.
// ---------------------------------------------------------------------------
async function loadAaplCampaign(client) {
  const row = (await client.query(
    `SELECT state FROM rangekeeper_v1.campaigns WHERE id = $1`,
    [AAPL_CAMPAIGN_ID],
  )).rows[0];
  if (!row) throw new Error('AAPL RangeKeeper campaign not found');
  const s = row.state;
  const bi = (v) => BigInt(v.__rangekeeper_bigint_v1__ ?? v);

  const sums = (await client.query(
    `SELECT
       sum((e->'gasValue'->>'__rangekeeper_bigint_v1__')::numeric) AS gas,
       sum((e->'swapFeeValue'->>'__rangekeeper_bigint_v1__')::numeric) AS swap_fee,
       sum((e->'swapShortfallValue'->>'__rangekeeper_bigint_v1__')::numeric) AS shortfall,
       count(*) AS n
     FROM jsonb_array_elements($1::jsonb) e`,
    [JSON.stringify(s.costEvents)],
  )).rows[0];

  const gasUsdg = Number(sums.gas) / 1e18;
  const swapFeeUsdg = Number(sums.swap_fee) / 1e18;
  const shortfallUsdg = Number(sums.shortfall) / 1e18;
  const totalCostUsdg = gasUsdg + swapFeeUsdg + shortfallUsdg;

  return {
    label: 'AAPL/USDG RangeKeeper paper campaign (rangekeeper_v1)',
    campaignId: AAPL_CAMPAIGN_ID,
    evidenceClass: 'measured (paper; executionEligible=false)',
    capitalUsdg: fmt(bi(s.initial0)),
    createdAt: new Date(s.createdAt * 1000).toISOString(),
    closedAt: new Date(s.closedAt * 1000).toISOString(),
    recenterCount: s.recenters,
    activeSeconds: Number(s.activeSeconds),
    outsideSeconds: Number(s.outsideSeconds),
    costEvents: Number(sums.n),
    gasUsdg_reconstructedFromLedger: gasUsdg.toFixed(6),
    swapFeeUsdg_reconstructedFromLedger: swapFeeUsdg.toFixed(6),
    swapShortfallUsdg_reconstructedFromLedger: shortfallUsdg.toFixed(6),
    totalCostUsdg_reconstructedFromLedger: totalCostUsdg.toFixed(6),
    cited: {
      source: 'docs/research/rangekeeper-operational-cost-reduction-2026-09-27.md',
      feesEarnedUsdg: '1.856',
      totalCostUsdg: '2.048',
      netUsdg: '-1.178',
      recenterOnlyGasUsdg: '0.657',
      recenterOnlySwapFeeUsdg: '0.278',
      recenterOnlyShortfallUsdg: '0.446',
      recenterOnlyAllInUsdg: '1.380',
      perRecenterAllInUsdg: '0.345',
      perInRangeHourFeeUsdg: '0.0949',
      breakEvenHoursPerRecenter: '3.6',
      selfDilutionPpmAtClose: '7228 (cited from note; not reconstructed by this script)',
      halfWidthSpacings: 2,
      tickSpacing: 10,
    },
  };
}

// ---------------------------------------------------------------------------
// Today's static (no-swap) open+close round-trip gas calibration, freshest
// AAPL/USDG fee-500 size band near 250 USDG. This is the calibration point
// named in the task: it excludes swap entirely (path
// 'paper_static_manual_no_swap_v1' -- approvals, mint, withdraw+collect,
// cleanup only), so it is NOT directly comparable to a live recenter, which
// always includes a rebalancing swap. See report for the reconciliation.
// ---------------------------------------------------------------------------
async function loadStaticCalibration(client) {
  const freshest = (await client.query(
    `SELECT size_band, observed_until FROM public.deployment_calibration_profiles
     WHERE path_version = $1 AND pool_address = $2 AND stage = 'mint'
     ORDER BY observed_until DESC NULLS LAST LIMIT 1`,
    [STATIC_NO_SWAP_PATH, AAPL_POOL_ADDRESS],
  )).rows[0];
  if (!freshest) return null;

  const rows = (await client.query(
    `SELECT stage, model->>'gasUnitsExpected' AS exp, model->>'gasUnitsBound' AS bound
     FROM public.deployment_calibration_profiles
     WHERE path_version = $1 AND pool_address = $2 AND size_band = $3`,
    [STATIC_NO_SWAP_PATH, AAPL_POOL_ADDRESS, freshest.size_band],
  )).rows;
  const byStage = Object.fromEntries(rows.map((r) => [r.stage, { exp: BigInt(r.exp), bound: BigInt(r.bound) }]));
  const sum = (stages, field) => stages.reduce((acc, s) => acc + byStage[s][field], 0n);

  return {
    label: 'AAPL/USDG fee-500 static open+close round trip, no swap (deployment_calibration_profiles)',
    evidenceClass: 'fork_estimated, provisional',
    observedUntil: freshest.observed_until,
    sizeBand: freshest.size_band,
    openGasUnitsExpected: sum(OPEN_STAGES, 'exp').toString(),
    openGasUnitsBound: sum(OPEN_STAGES, 'bound').toString(),
    closeGasUnitsExpected: sum(CLOSE_STAGES, 'exp').toString(),
    closeGasUnitsBound: sum(CLOSE_STAGES, 'bound').toString(),
    totalGasUnitsExpected: (sum(OPEN_STAGES, 'exp') + sum(CLOSE_STAGES, 'exp')).toString(),
    totalGasUnitsBound: (sum(OPEN_STAGES, 'bound') + sum(CLOSE_STAGES, 'bound')).toString(),
    note: 'This gives gas UNITS only (exact, from the ledger). Converting to USDG needs the gas price and native reference price at query time, which this script does not fetch (they are not campaign-ledger data). The task-supplied figure of $0.0613 expected / $0.0995 bound implies a price of about 5.9e-8 USDG per gas unit, i.e. roughly 0.02-0.03 gwei at a ~2500 USDG/native reference -- distinctly cheaper than the 0.069-0.41 gwei (median 0.083) observed during the NVDA campaign. Gas price is time-varying; this is not an apples-to-apples comparison across dates.',
  };
}

// ---------------------------------------------------------------------------
// Break-even model. See docs/research/break-even-2026-09-30.md for the full
// derivation. In short:
//
//   net(C, n, T) = feeRatePerHour(C) * T  -  n * T * costPerRecenter(C)
//
//   costPerRecenter(C) = g + k * C     (g: capital-independent gas; k: swap
//                                        shortfall as a fraction of capital)
//   feeRatePerHour(C)  = r * C          (linear regime only: valid while the
//                                        position's pool share stays small
//                                        enough that dilution is negligible --
//                                        see the dilution model below for
//                                        where that regime ends)
//
// Break-even cadence for capital C:      n*(C) = r*C / (g + k*C)
// Break-even capital for cadence n:      C*(n) = n*g / (r - n*k)   [r > n*k]
// ---------------------------------------------------------------------------
function buildBreakEvenModel(nvda, aapl) {
  const C_nvda = 250;
  const heldHours_nvda = 47.8; // cited, notes/live-cost-analysis-2026-09-17.md
  const fees_nvda = 7.38; // cited
  const r_nvda = fees_nvda / C_nvda / heldHours_nvda; // USDG per USDG-hour
  const g_nvda = 0.134; // cited, post-allowance gas/recenter
  const k_nvda = 0.051 / C_nvda; // cited, post-allowance swap shortfall/recenter, as a fraction of capital

  const actualCadencePerHour_nvda = nvda.recenterCount / heldHours_nvda; // 43 / 47.8
  const breakEvenCadencePerHour_nvda = (r_nvda * C_nvda) / (g_nvda + k_nvda * C_nvda);
  const breakEvenCapital_atActualCadence_nvda = (actualCadencePerHour_nvda * g_nvda) / (r_nvda - actualCadencePerHour_nvda * k_nvda);

  const C_aapl = Number(aapl.capitalUsdg);
  const activeHours_aapl = aapl.activeSeconds / 3600;
  const fees_aapl = 1.856; // cited
  const r_aapl = fees_aapl / C_aapl / activeHours_aapl;
  const g_aapl = 0.657 / 4; // cited recenter-only gas / recenter count
  const k_aapl = (0.446 / 4) / C_aapl; // cited recenter-only shortfall / recenter count, as a fraction of capital

  return {
    assumptions: [
      'costPerRecenter(C) = g + k*C with g and k held constant across capital (gas units are size-independent; swap notional, and so shortfall, is assumed to scale linearly with capital at fixed range width) -- MODELLED, calibrated from a single campaign each.',
      'feeRatePerHour(C) = r*C, i.e. fee income linear in capital -- valid only while the position\'s share of in-range liquidity stays small (see dilution model). Not established at any capital beyond what was actually deployed ($250 and $276.27).',
      'g, k and r are campaign- and pool-specific (gas price on the day, pool volume, pool depth). The two calibrations below (NVDA fee-500, AAPL fee-500) disagree by roughly 2x on every parameter; there is no cross-pool average that is not itself an assumption.',
    ],
    nvdaCalibration: {
      C: C_nvda, heldHours: heldHours_nvda, feesUsdg: fees_nvda,
      feeRatePerHourUsdg: r_nvda,
      gasPerRecenterUsdg: g_nvda, shortfallRatePerRecenter: k_nvda,
      actualRecenterCount: nvda.recenterCount,
      actualCadencePerHour: actualCadencePerHour_nvda,
      actualCadenceIntervalHours: 1 / actualCadencePerHour_nvda,
      breakEvenCadencePerHour: breakEvenCadencePerHour_nvda,
      breakEvenCadenceIntervalHours: 1 / breakEvenCadencePerHour_nvda,
      breakEvenCapitalAtActualCadence: breakEvenCapital_atActualCadence_nvda,
      verdict: actualCadencePerHour_nvda > breakEvenCadencePerHour_nvda
        ? 'Actual cadence exceeded the break-even cadence for $250 -- the campaign was recentring faster than its own capital could sustain, even before infrastructure-timeout churn is added.'
        : 'Actual cadence was inside the break-even cadence for $250.',
    },
    aaplCalibration: {
      C: C_aapl, activeHours: activeHours_aapl, feesUsdg: fees_aapl,
      feeRatePerHourUsdg: r_aapl,
      gasPerRecenterUsdg: g_aapl, shortfallRatePerRecenter: k_aapl,
      actualRecenterCount: aapl.recenterCount,
    },
  };
}

function breakEvenCadencePerHour(r, C, g, k) {
  return (r * C) / (g + k * C);
}
function breakEvenCapital(n, r, g, k) {
  const denom = r - n * k;
  if (denom <= 0) return null; // cost scales with capital faster than fees at this cadence: no finite break-even capital
  return (n * g) / denom;
}

function buildSensitivityGrid(model) {
  const { feeRatePerHourUsdg: r, gasPerRecenterUsdg: g, shortfallRatePerRecenter: k } = model.nvdaCalibration;
  const capitals = [250, 500, 1000, 2500, 5000, 10000, 25000, 50000];
  const cadencesPerDay = [1, 2, 4, 8, 12, 19, 24, 48]; // 19/day reproduces the note's post-allowance steady-state figure
  return {
    note: 'Built from the NVDA fee-500 calibration only (g, k, r as above). This is one pool\'s cost/fee structure projected across capital and cadence; it is a MODEL, not a forecast for any other pool.',
    breakEvenCadencePerDay_byCapital: capitals.map((C) => ({
      capitalUsdg: C,
      breakEvenCadencePerDay: 24 * breakEvenCadencePerHour(r, C, g, k),
    })),
    breakEvenCapitalUsdg_byCadence: cadencesPerDay.map((perDay) => ({
      recentersPerDay: perDay,
      breakEvenCapitalUsdg: breakEvenCapital(perDay / 24, r, g, k),
    })),
  };
}

// ---------------------------------------------------------------------------
// Dilution: an LP's fee credit for a swap segment is
// ownLiquidity / (ownLiquidity + externalLiquidity) of that segment's fees
// (src/paper/diluted-fees.ts: paperSegmentCredit against segment.liquidity).
// ownLiquidity scales with capital at fixed range width; externalLiquidity is
// read from the one liquidity-snapshot series available (NVDA campaign
// marks). This gives a single point-in-time estimate of the capital at which
// dilution becomes first-order.
// ---------------------------------------------------------------------------
function buildDilutionModel(nvda) {
  const avgPpm = nvda.ownLiquidityShare.avgPpm;
  const C = Number(nvda.capitalUsdg);
  if (!avgPpm) return null;
  const externalCapitalEquivalent = C * (1_000_000 / avgPpm - 1);
  const capAtConfiguredSharePpm = C * (Number(nvda.maxLiquiditySharePpm) / avgPpm);
  return {
    evidenceClass: 'modelled (single liquidity snapshot series, one pool, three-day window)',
    avgOwnSharePpm_measured: avgPpm,
    maxOwnSharePpm_measured: nvda.ownLiquidityShare.maxPpm,
    capitalAtHalfPoolShare_usdg: externalCapitalEquivalent,
    capitalAtHalfPoolShareNote: 'Modelled capital at which own liquidity would equal the pool\'s external in-range liquidity observed during the NVDA campaign (share = 50%), holding external liquidity fixed and own liquidity linear in capital at the same range width. This is the point at which the linear fee-rate assumption above is roughly 2x optimistic, not a hard cap.',
    capitalAtConfiguredSharePpmCap_usdg: capAtConfiguredSharePpm,
    capitalAtConfiguredSharePpmCapNote: `The campaign's own maxLiquiditySharePpm (${nvda.maxLiquiditySharePpm}) implies an effective capital ceiling of about this many USDG at the liquidity level observed during the campaign -- a separate, already-configured constraint from the break-even question.`,
  };
}

function printHuman(report) {
  const { nvda, aapl, calibration, model, sensitivity, dilution } = report;

  console.log('=== NVDA/USDG live pilot: cost ledger reconstruction ===');
  console.log(`campaign ${nvda.campaignId}, capital ${nvda.capitalUsdg} USDG, half-width ${nvda.halfWidthSpacings} spacings`);
  console.log(`recenters (retired NFTs): ${nvda.recenterCount}`);
  console.log(`gas cost from campaign state:        ${nvda.gasSpentQuoteUsdg_fromState} USDG`);
  console.log(`gas cost reconstructed from actions:  ${nvda.gasSpentQuoteUsdg_reconstructedFromLedger} USDG  (reconciles: ${nvda.ledgerReconciles})`);
  console.log(`own liquidity share during holding: min ${dilution?.avgOwnSharePpm_measured ? nvda.ownLiquidityShare.minPpm.toFixed(1) : 'n/a'} / avg ${nvda.ownLiquidityShare.avgPpm.toFixed(1)} / max ${nvda.ownLiquidityShare.maxPpm.toFixed(1)} ppm (n=${nvda.ownLiquidityShare.samples})`);
  console.log(`cited (not reconstructed by this script): fees ${nvda.cited.feesEarnedUsdg} USDG, total cost ${nvda.cited.totalCostUsdg} USDG (${nvda.cited.gasUsdg} gas + ${nvda.cited.swapShortfallUsdg} swap shortfall)`);
  console.log(`cited: timeout-driven churn cost ${nvda.cited.timeoutChurnCostUsdg}`);
  console.log();

  console.log('=== AAPL/USDG RangeKeeper paper campaign: cost ledger reconstruction ===');
  console.log(`campaign ${aapl.campaignId}, capital ${aapl.capitalUsdg} USDG, recenters ${aapl.recenterCount}`);
  console.log(`gas ${aapl.gasUsdg_reconstructedFromLedger} + swap fee ${aapl.swapFeeUsdg_reconstructedFromLedger} + shortfall ${aapl.swapShortfallUsdg_reconstructedFromLedger} = ${aapl.totalCostUsdg_reconstructedFromLedger} USDG (n=${aapl.costEvents} cost events)`);
  console.log(`cited total cost: ${aapl.cited.totalCostUsdg} USDG, cited fees: ${aapl.cited.feesEarnedUsdg} USDG, net: ${aapl.cited.netUsdg} USDG`);
  console.log();

  if (calibration) {
    console.log('=== Today\'s static no-swap open+close gas calibration (AAPL/USDG fee-500) ===');
    console.log(`observed until ${calibration.observedUntil}, size band ${calibration.sizeBand}`);
    console.log(`open (approve x2 + mint):    ${calibration.openGasUnitsExpected} units expected / ${calibration.openGasUnitsBound} bound`);
    console.log(`close (withdraw + cleanup x2): ${calibration.closeGasUnitsExpected} units expected / ${calibration.closeGasUnitsBound} bound`);
    console.log(calibration.note);
    console.log();
  }

  console.log('=== Break-even model (calibrated on NVDA fee-500, $250) ===');
  const n = model.nvdaCalibration;
  console.log(`fee rate: ${n.feeRatePerHourUsdg.toFixed(6)} USDG/hour at $${n.C} (measured: ${n.feesUsdg} USDG / ${n.heldHours}h held)`);
  console.log(`cost per recenter: ${n.gasPerRecenterUsdg} USDG gas + ${(n.shortfallRatePerRecenter * n.C).toFixed(4)} USDG shortfall at $${n.C}`);
  console.log(`actual cadence: ${n.actualRecenterCount} recenters / ${n.heldHours}h held = 1 per ${n.actualCadenceIntervalHours.toFixed(3)}h`);
  console.log(`break-even cadence at $${n.C}: 1 per ${n.breakEvenCadenceIntervalHours.toFixed(3)}h`);
  console.log(`break-even capital at the actual cadence: ${n.breakEvenCapitalAtActualCadence.toFixed(2)} USDG (actual: ${n.C} USDG)`);
  console.log(n.verdict);
  console.log();

  console.log('=== Sensitivity: break-even cadence by capital (NVDA fee-500 model) ===');
  for (const row of sensitivity.breakEvenCadencePerDay_byCapital) {
    console.log(`  $${row.capitalUsdg}: break-even at ${row.breakEvenCadencePerDay.toFixed(2)} recenters/day (1 per ${(24 / row.breakEvenCadencePerDay).toFixed(2)}h)`);
  }
  console.log();
  console.log('=== Sensitivity: break-even capital by cadence (NVDA fee-500 model) ===');
  for (const row of sensitivity.breakEvenCapitalUsdg_byCadence) {
    console.log(`  ${row.recentersPerDay}/day: break-even capital ${row.breakEvenCapitalUsdg === null ? 'none (cost outpaces fees at any capital)' : row.breakEvenCapitalUsdg.toFixed(2) + ' USDG'}`);
  }
  console.log();

  if (dilution) {
    console.log('=== Dilution sensitivity (modelled, one liquidity snapshot series) ===');
    console.log(`measured own share during NVDA holding: avg ${dilution.avgOwnSharePpm_measured.toFixed(1)} ppm, max ${dilution.maxOwnSharePpm_measured.toFixed(1)} ppm`);
    console.log(`modelled capital at 50% pool share (linear-fee-rate assumption breaks down): ~${dilution.capitalAtHalfPoolShare_usdg.toFixed(0)} USDG`);
    console.log(`capital implied by the campaign's own configured 2% share cap at this liquidity level: ~${dilution.capitalAtConfiguredSharePpmCap_usdg.toFixed(0)} USDG`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
