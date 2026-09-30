// Fee-income reconstruction for the closed NVDA/USDG live pilot
// (`live_pilot_v1`, campaign f8affe19-4d89-4132-b214-d67e5ad81331).
//
// docs/research/break-even-2026-09-30.md cites 7.38 USDG of fee income for
// this campaign from notes/live-cost-analysis-2026-09-17.md, a note whose
// backing data directory is gitignored and unregistered in
// research/manifests/ -- unlike the studies docs/research/index.md tracks.
// The break-even model's fee rate (Section 4 of that note) is calibrated
// directly on that one number. This script reconstructs it independently
// from the database, without touching that note or its gitignored data.
//
// Method (see docs/research/fee-reconstruction-2026-09-30.md for the full
// argument):
//
//   1. AUTHORITATIVE: for each of the 43 confirmed `withdraw` actions, the
//      decoded on-chain events in `receipt->'facts'->'liquidityEvents'` give
//      a `DecreaseLiquidity` (principal returned) and a `Collect` (principal
//      + fees returned) for the same position. `Collect - DecreaseLiquidity`
//      is the realised fee for that withdraw, in raw token units, read
//      directly off confirmed transaction receipts -- no simulation, no
//      interpolation, no double counting (cancelled/never-broadcast withdraws
//      carry no receipt and contribute nothing; there are no reverted
//      withdraws in this campaign).
//   2. CROSS-CHECK A: the campaign's own running accumulator,
//      `campaigns.state.collectedFee0` / `collectedFee1`, is compared byte
//      for byte against the ledger sum.
//   3. CROSS-CHECK B: the last holding-phase `uncollected0`/`uncollected1`
//      mark recorded for each position before its withdraw is summed
//      separately. This is expected to run slightly BELOW the Collect-based
//      total (marks are polled roughly every 10s; fees keep accruing between
//      the last poll and the withdraw's actual confirmation block) -- so
//      this is a plausibility check, not an independent valuation.
//   4. VALUATION: token0 (USDG) fees need no conversion. Token1 (NVDA) fees
//      are converted to USDG using the pool's own spot price
//      (`receipt->'after'->'sqrtPriceX96'`, the pool state read immediately
//      after each withdraw confirms), via the exact integer formula
//      `src/simulator/math.ts#quoteValue` uses everywhere else in this
//      codebase's own NAV/benchmark accounting. This is a deliberate,
//      argued departure from the task's default preference for an oracle
//      reference: `public.asset_risk_snapshots` shows the NVDA/USD oracle
//      feed was never `execution_eligible` at any point in this campaign
//      (or anywhere in the database's full history) -- see the oracle
//      section below. Pool spot is not a second-best proxy here; it is the
//      only price reference this system ever had for NVDA, and the one its
//      own accounting already uses.
//
// This script is READ-ONLY. It opens one REPEATABLE READ READ ONLY
// transaction and performs no writes.
//
// Usage:
//   node --import tsx scripts/analysis/fee-reconstruction.mjs        # human-readable
//   node --import tsx scripts/analysis/fee-reconstruction.mjs --json # machine-readable

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/conc_liq?host=/var/run/postgresql';
const PRINT_JSON = process.argv.includes('--json');

const NVDA_CAMPAIGN_ID = 'f8affe19-4d89-4132-b214-d67e5ad81331';
const USDG_DECIMALS = 1_000_000n;
const NVDA_DECIMALS = 1_000_000_000_000_000_000n;
const Q192 = 1n << 192n;

// CITED, docs/research/break-even-2026-09-30.md Section 4. Not reconstructed
// by this script (this script is scoped to the fee side only); reused here
// only to show what the break-even model does with an updated fee total.
const CITED_FEES_USDG = 7.38;
const CITED_HELD_HOURS = 47.8;
const CITED_C = 250;
const CITED_G_PER_RECENTER = 0.134;
const CITED_K_AT_250 = 0.051;

function fmtUsdg(raw) {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const s = (Number(abs) / Number(USDG_DECIMALS)).toFixed(6);
  return neg ? `-${s}` : s;
}

function fmtNvda(raw) {
  return (Number(raw) / Number(NVDA_DECIMALS)).toFixed(9);
}

// Integer NVDA(token1)->USDG(token0) conversion at a given pool sqrtPriceX96,
// matching src/simulator/math.ts#quoteValue's quoteIsToken0 branch exactly:
//   value = amount0 + amount1 * 2^192 / sqrtPriceX96^2
function valueToken1InUsdg(amount1Raw, sqrtPriceX96) {
  return (amount1Raw * Q192) / (sqrtPriceX96 * sqrtPriceX96);
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
  const campaign = await loadCampaign(client);
  const withdraws = await loadWithdrawFeeEvents(client);
  const ledgerTotals = sumLedgerFees(withdraws);
  const stateCrossCheck = compareToState(campaign, ledgerTotals);
  const marksCrossCheck = await loadUncollectedCrossCheck(client, withdraws);
  const oracle = await loadOracleAvailability(client, campaign);
  const heldHours = await loadHeldHoursSanityCheck(client, withdraws);
  const reconciliation = compareToCited(ledgerTotals);
  const model = buildBreakEvenComparison(ledgerTotals, heldHours);

  return {
    generatedAt: new Date().toISOString(),
    campaign,
    withdrawCount: withdraws.length,
    ledgerTotals,
    stateCrossCheck,
    marksCrossCheck,
    oracle,
    heldHours,
    reconciliation,
    model,
  };
}

async function loadCampaign(client) {
  const row = (await client.query(
    `SELECT state, config FROM live_pilot_v1.campaigns WHERE id = $1`,
    [NVDA_CAMPAIGN_ID],
  )).rows[0];
  if (!row) throw new Error('NVDA live pilot campaign not found');
  return {
    campaignId: NVDA_CAMPAIGN_ID,
    capitalUsdg: fmtUsdg(BigInt(row.config.initialCapitalQuote)),
    createdAt: row.state.createdAt,
    closedAt: row.state.closedAt,
    recenterCount: row.state.retiredTokenIds.length,
    collectedFee0Raw: row.state.collectedFee0,
    collectedFee1Raw: row.state.collectedFee1,
  };
}

// Pull, per confirmed withdraw, the decoded DecreaseLiquidity and Collect
// events and the pool's post-confirmation sqrtPriceX96. Asserts the shape
// this campaign is known to have (exactly one of each event per withdraw);
// throws loudly rather than silently mis-summing if that shape ever changes.
async function loadWithdrawFeeEvents(client) {
  const rows = (await client.query(
    `SELECT nonce, id,
            receipt->'facts'->'liquidityEvents' AS events,
            receipt->'after'->>'sqrtPriceX96' AS sqrt_price_x96,
            receipt->'after'->>'block' AS after_block,
            before_state->'position'->>'tokenId' AS token_id,
            created_at
     FROM live_pilot_v1.actions
     WHERE campaign_id = $1 AND intent->>'action' = 'withdraw' AND status = 'confirmed'
     ORDER BY nonce`,
    [NVDA_CAMPAIGN_ID],
  )).rows;

  return rows.map((row) => {
    const events = row.events ?? [];
    const decreases = events.filter((e) => e.kind === 'DecreaseLiquidity');
    const collects = events.filter((e) => e.kind === 'Collect');
    if (decreases.length !== 1 || collects.length !== 1) {
      throw new Error(`withdraw nonce ${row.nonce}: expected exactly 1 DecreaseLiquidity + 1 Collect, got ${decreases.length}+${collects.length}`);
    }
    const dec = decreases[0];
    const col = collects[0];
    const fee0 = BigInt(col.amount0) - BigInt(dec.amount0);
    const fee1 = BigInt(col.amount1) - BigInt(dec.amount1);
    if (fee0 < 0n || fee1 < 0n) {
      throw new Error(`withdraw nonce ${row.nonce}: negative fee (Collect < DecreaseLiquidity) -- data integrity issue`);
    }
    const sqrtPriceX96 = BigInt(row.sqrt_price_x96);
    const valuedUsdgRaw = fee0 + valueToken1InUsdg(fee1, sqrtPriceX96);
    return {
      nonce: row.nonce,
      actionId: row.id,
      tokenId: row.token_id,
      createdAt: row.created_at,
      afterBlock: row.after_block,
      fee0Raw: fee0,
      fee1Raw: fee1,
      sqrtPriceX96,
      valuedUsdgRaw,
    };
  });
}

function sumLedgerFees(withdraws) {
  const totalFee0Raw = withdraws.reduce((acc, w) => acc + w.fee0Raw, 0n);
  const totalFee1Raw = withdraws.reduce((acc, w) => acc + w.fee1Raw, 0n);
  const totalValuedUsdgRaw = withdraws.reduce((acc, w) => acc + w.valuedUsdgRaw, 0n);
  return {
    n: withdraws.length,
    totalFee0Raw: totalFee0Raw.toString(),
    totalFee0Usdg: fmtUsdg(totalFee0Raw),
    totalFee1Raw: totalFee1Raw.toString(),
    totalFee1Nvda: fmtNvda(totalFee1Raw),
    totalValuedUsdgRaw: totalValuedUsdgRaw.toString(),
    totalValuedUsdg: fmtUsdg(totalValuedUsdgRaw),
    valuedNvdaLegUsdg: fmtUsdg(totalValuedUsdgRaw - totalFee0Raw),
    method: 'Collect - DecreaseLiquidity per confirmed withdraw (raw token units, exact); NVDA leg valued at each withdraw\'s own post-confirmation pool sqrtPriceX96 via the quoteValue formula in src/simulator/math.ts.',
  };
}

function compareToState(campaign, ledgerTotals) {
  const stateFee0 = BigInt(campaign.collectedFee0Raw);
  const stateFee1 = BigInt(campaign.collectedFee1Raw);
  const ledgerFee0 = BigInt(ledgerTotals.totalFee0Raw);
  const ledgerFee1 = BigInt(ledgerTotals.totalFee1Raw);
  return {
    note: 'campaigns.state.collectedFee0/collectedFee1 is the campaign\'s own running accumulator, updated at every withdraw -- the same kind of cross-check break-even.mjs performs against state.gasSpentQuote.',
    stateFee0Raw: campaign.collectedFee0Raw,
    ledgerFee0Raw: ledgerTotals.totalFee0Raw,
    fee0DiffRaw: (ledgerFee0 - stateFee0).toString(),
    fee0Reconciles: ledgerFee0 === stateFee0,
    stateFee1Raw: campaign.collectedFee1Raw,
    ledgerFee1Raw: ledgerTotals.totalFee1Raw,
    fee1DiffRaw: (ledgerFee1 - stateFee1).toString(),
    fee1Reconciles: ledgerFee1 === stateFee1,
  };
}

// For each withdrawn position, find the last holding-phase mark recorded
// before the withdraw's creation, and sum its uncollected0/uncollected1.
// This necessarily undercounts (fees keep accruing between the last ~10s
// poll and the actual withdraw confirmation), so it is a lower-bound
// plausibility check on the Collect-based total, not a competing estimate.
async function loadUncollectedCrossCheck(client, withdraws) {
  const rows = (await client.query(
    `WITH wd AS (
       SELECT nonce, created_at, before_state->'position'->>'tokenId' AS token_id
       FROM live_pilot_v1.actions
       WHERE campaign_id = $1 AND intent->>'action' = 'withdraw' AND status = 'confirmed'
     ),
     last_mark AS (
       SELECT wd.nonce,
         (SELECT m.id FROM live_pilot_v1.marks m
          WHERE m.campaign_id = $1 AND m.kind = 'mark' AND m.snapshot->>'phase' = 'holding'
            AND m.snapshot->'snapshot'->'position'->>'tokenId' = wd.token_id
            AND m.at <= wd.created_at
          ORDER BY m.at DESC LIMIT 1) AS mark_id
       FROM wd
     )
     SELECT lm.nonce, (m.snapshot->>'uncollected0')::numeric AS unc0,
            (m.snapshot->>'uncollected1')::numeric AS unc1,
            (m.snapshot->'snapshot'->>'sqrtPriceX96')::numeric AS sqrtp
     FROM last_mark lm JOIN live_pilot_v1.marks m ON m.id = lm.mark_id
     ORDER BY lm.nonce`,
    [NVDA_CAMPAIGN_ID],
  )).rows;

  let totalUnc0 = 0n, totalUnc1 = 0n, totalValuedRaw = 0n;
  for (const row of rows) {
    const unc0 = BigInt(row.unc0);
    const unc1 = BigInt(row.unc1);
    const sqrtp = BigInt(row.sqrtp);
    totalUnc0 += unc0;
    totalUnc1 += unc1;
    totalValuedRaw += unc0 + valueToken1InUsdg(unc1, sqrtp);
  }
  return {
    n: rows.length,
    note: 'Last holding-phase uncollected0/uncollected1 mark before each withdraw, valued at that mark\'s own pool sqrtPriceX96. Expected to run BELOW the Collect-based total (marks are polled ~every 10s; the actual withdraw confirms slightly later, after more fees accrue).',
    totalUncollected0Raw: totalUnc0.toString(),
    totalUncollected1Raw: totalUnc1.toString(),
    totalValuedUsdgRaw: totalValuedRaw.toString(),
    totalValuedUsdg: fmtUsdg(totalValuedRaw),
  };
}

async function loadOracleAvailability(client, campaign) {
  const windowRow = (await client.query(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE a.execution_eligible)::int AS eligible_n
     FROM public.asset_risk_snapshots a
     JOIN public.risk_snapshot_runs r ON r.id = a.run_id
     WHERE a.symbol = 'NVDA' AND r.block_timestamp BETWEEN $1 AND $2`,
    [campaign.createdAt, campaign.closedAt],
  )).rows[0];

  const allTimeRow = (await client.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE execution_eligible)::int AS eligible_n
     FROM public.asset_risk_snapshots WHERE symbol = 'NVDA'`,
  )).rows[0];

  const reasons = (await client.query(
    `SELECT reasons, count(*)::int AS n FROM public.asset_risk_snapshots
     WHERE symbol = 'NVDA' GROUP BY reasons ORDER BY n DESC LIMIT 5`,
  )).rows;

  return {
    note: 'The independent NVDA/USD oracle reference (asset_risk_snapshots, the primaryTokenizedPrice feed selectOracleFeed would pick for symbol NVDA) was checked for whether it was usable during the campaign, and system-wide.',
    campaignWindow: { n: windowRow.n, executionEligibleN: windowRow.eligible_n },
    allTime: { n: allTimeRow.n, executionEligibleN: allTimeRow.eligible_n },
    topReasons: reasons.map((r) => ({ reasons: r.reasons, n: r.n })),
    conclusion: windowRow.eligible_n === 0 && allTimeRow.eligible_n === 0
      ? 'The NVDA/USD oracle feed was never execution_eligible in this campaign or anywhere in the database\'s recorded history (reasons consistently include sequencer_feed_unavailable / oracle_price_stale / quote_oracle_unavailable). Pool spot is not a fallback of convenience here; it is the only NVDA price reference this system has ever recorded, and the one its own live-pilot NAV/benchmark accounting (src/live-pilot/chain.ts#mark) already uses.'
      : 'The NVDA/USD oracle feed was execution_eligible at least once; re-check whether an oracle-based valuation is possible instead of pool spot.',
  };
}

// Supplementary, not load-bearing: cross-checks the CITED 47.8 held hours
// figure using first-holding-mark-to-withdraw-confirmation per position.
// Distinct methodology from whatever notes/live-cost-analysis-2026-09-17.md
// used; this script does not have access to that (gitignored) method.
async function loadHeldHoursSanityCheck(client, withdraws) {
  const rows = (await client.query(
    `WITH wd AS (
       SELECT nonce, created_at, before_state->'position'->>'tokenId' AS token_id
       FROM live_pilot_v1.actions
       WHERE campaign_id = $1 AND intent->>'action' = 'withdraw' AND status = 'confirmed'
     )
     SELECT wd.nonce, wd.created_at AS withdraw_at,
       (SELECT min(m.at) FROM live_pilot_v1.marks m
        WHERE m.campaign_id = $1 AND m.kind = 'mark' AND m.snapshot->>'phase' = 'holding'
          AND m.snapshot->'snapshot'->'position'->>'tokenId' = wd.token_id) AS first_hold_at
     FROM wd`,
    [NVDA_CAMPAIGN_ID],
  )).rows;

  let totalSeconds = 0;
  for (const row of rows) {
    totalSeconds += (new Date(row.withdraw_at).getTime() - new Date(row.first_hold_at).getTime()) / 1000;
  }
  const totalHours = totalSeconds / 3600;
  return {
    note: 'Sanity check only, not a reconstruction of the CITED 47.8h figure: sum, per position, of (withdraw confirmation time - first holding-phase mark time).',
    n: rows.length,
    reconstructedHeldHours: totalHours,
    citedHeldHours: CITED_HELD_HOURS,
    diffHours: totalHours - CITED_HELD_HOURS,
  };
}

function compareToCited(ledgerTotals) {
  const established = Number(ledgerTotals.totalValuedUsdg);
  const diff = established - CITED_FEES_USDG;
  const diffPct = (diff / CITED_FEES_USDG) * 100;
  return {
    establishedUsdg: established,
    citedUsdg: CITED_FEES_USDG,
    diffUsdg: diff,
    diffPct,
    verdict: Math.abs(diffPct) < 1
      ? `Reconciles closely but not exactly: ${diff >= 0 ? '+' : ''}${diff.toFixed(6)} USDG (${diffPct.toFixed(3)}%) above the cited figure. Consistent with a valuation-methodology difference (per-withdraw pool spot here vs whatever the September 17 note used); this script cannot see that note's method since its backing data is gitignored.`
      : `Does NOT reconcile: ${diff >= 0 ? '+' : ''}${diff.toFixed(6)} USDG (${diffPct.toFixed(2)}%) away from the cited figure -- investigate before trusting either number.`,
  };
}

function buildBreakEvenComparison(ledgerTotals, heldHours) {
  const establishedFees = Number(ledgerTotals.totalValuedUsdg);

  const withHours = (heldHoursVal, feesVal, label) => {
    const R = feesVal / heldHoursVal; // USDG/hour at C=250, i.e. r*C
    const r = R / CITED_C;
    const k = CITED_K_AT_250 / CITED_C;
    const actualCadencePerHour = 43 / heldHoursVal;
    const breakEvenCadencePerHour = R / (CITED_G_PER_RECENTER + CITED_K_AT_250);
    const breakEvenCapital = (actualCadencePerHour * CITED_G_PER_RECENTER) / (r - actualCadencePerHour * k);
    return {
      label,
      heldHours: heldHoursVal,
      feesUsdg: feesVal,
      feeRatePerHourUsdg: R,
      actualCadencePerDay: actualCadencePerHour * 24,
      breakEvenCadencePerDay: breakEvenCadencePerHour * 24,
      breakEvenCapitalUsdg: breakEvenCapital,
    };
  };

  return {
    note: 'g=0.134 USDG/recenter and k*C=0.051 USDG at C=250 are CITED from docs/research/break-even-2026-09-30.md (post-allowance gas + swap shortfall) and are not re-derived here; only the fee total r*C and, as a sanity variant, held hours are swapped in from this session\'s reconstruction.',
    citedBaseline: withHours(CITED_HELD_HOURS, CITED_FEES_USDG, 'cited (7.38 USDG / 47.8h, as published)'),
    establishedFeesCitedHours: withHours(CITED_HELD_HOURS, establishedFees, 'this session\'s fee total / cited 47.8h'),
    establishedFeesEstablishedHours: withHours(heldHours.reconstructedHeldHours, establishedFees, 'this session\'s fee total / this session\'s held-hours sanity check'),
  };
}

function printHuman(report) {
  const { campaign, ledgerTotals, stateCrossCheck, marksCrossCheck, oracle, heldHours, reconciliation, model } = report;

  console.log('=== NVDA/USDG live pilot: fee-income reconstruction ===');
  console.log(`campaign ${campaign.campaignId}, capital ${campaign.capitalUsdg} USDG, ${campaign.recenterCount} recenters, ${campaign.createdAt} to ${campaign.closedAt}`);
  console.log(`confirmed withdraws (= positions closed): ${report.withdrawCount}`);
  console.log();

  console.log('--- Ledger reconstruction (Collect - DecreaseLiquidity per withdraw) ---');
  console.log(`token0 (USDG) fees: ${ledgerTotals.totalFee0Usdg} USDG (raw ${ledgerTotals.totalFee0Raw})`);
  console.log(`token1 (NVDA) fees: ${ledgerTotals.totalFee1Nvda} NVDA (raw ${ledgerTotals.totalFee1Raw})`);
  console.log(`token1 leg valued at pool spot (per-withdraw sqrtPriceX96): ${ledgerTotals.valuedNvdaLegUsdg} USDG`);
  console.log(`TOTAL fee income, ESTABLISHED: ${ledgerTotals.totalValuedUsdg} USDG`);
  console.log();

  console.log('--- Cross-check A: campaign state.collectedFee0/collectedFee1 accumulator ---');
  console.log(`fee0: state ${stateCrossCheck.stateFee0Raw} vs ledger ${stateCrossCheck.ledgerFee0Raw} (diff ${stateCrossCheck.fee0DiffRaw} raw, reconciles: ${stateCrossCheck.fee0Reconciles})`);
  console.log(`fee1: state ${stateCrossCheck.stateFee1Raw} vs ledger ${stateCrossCheck.ledgerFee1Raw} (diff ${stateCrossCheck.fee1DiffRaw} raw, reconciles: ${stateCrossCheck.fee1Reconciles})`);
  console.log();

  console.log('--- Cross-check B: last-mark uncollected0/uncollected1 before each withdraw ---');
  console.log(`n=${marksCrossCheck.n}, valued total: ${marksCrossCheck.totalValuedUsdg} USDG (expected below the ledger total: ${ledgerTotals.totalValuedUsdg})`);
  console.log(marksCrossCheck.note);
  console.log();

  console.log('--- NVDA/USD oracle availability ---');
  console.log(`campaign window: ${oracle.campaignWindow.n} snapshots, ${oracle.campaignWindow.executionEligibleN} execution_eligible`);
  console.log(`all time:        ${oracle.allTime.n} snapshots, ${oracle.allTime.executionEligibleN} execution_eligible`);
  console.log(oracle.conclusion);
  console.log();

  console.log('--- Held-hours sanity check (not a reconstruction) ---');
  console.log(`reconstructed: ${heldHours.reconstructedHeldHours.toFixed(3)}h vs cited ${heldHours.citedHeldHours}h (diff ${heldHours.diffHours.toFixed(3)}h)`);
  console.log();

  console.log('--- Reconciliation against the cited 7.38 USDG ---');
  console.log(`established ${reconciliation.establishedUsdg.toFixed(6)} USDG vs cited ${reconciliation.citedUsdg} USDG`);
  console.log(reconciliation.verdict);
  console.log();

  console.log('--- Consequence for the break-even model (Section 4) ---');
  for (const key of ['citedBaseline', 'establishedFeesCitedHours', 'establishedFeesEstablishedHours']) {
    const m = model[key];
    console.log(`${m.label}:`);
    console.log(`  fee rate r*C: ${m.feeRatePerHourUsdg.toFixed(6)} USDG/hour; actual cadence ${m.actualCadencePerDay.toFixed(2)}/day; break-even cadence ${m.breakEvenCadencePerDay.toFixed(2)}/day; break-even capital ${m.breakEvenCapitalUsdg.toFixed(2)} USDG`);
  }
  console.log();
  console.log(model.note);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
