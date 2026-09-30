# Fee-income reconstruction, NVDA/USDG live pilot — 2026-09-30

Status: research only, closed-live ledger analysis. This note does not
authorize execution or a policy change.

`docs/research/break-even-2026-09-30.md` calibrates its whole break-even
model on one number: **7.38 USDG** of fee income for the closed NVDA/USDG
live pilot (`live_pilot_v1`, campaign `f8affe19-4d89-4132-b214-d67e5ad81331`,
2026-09-12 14:24:30 to 2026-09-15 05:50:33 UTC, 43 recenters). That note
cites the figure from `notes/live-cost-analysis-2026-09-17.md` rather than
reconstructing it, and flags its own provenance gap: the underlying
`data/live-cost-analysis-2026-09-17/` directory is `.gitignore`d and has no
`research/manifests/` entry with an immutable source hash, unlike the studies
`docs/research/index.md` tracks. This note reconstructs the figure directly
from the database instead.

Every number below is labelled **ESTABLISHED** (reconstructed here from the
append-only ledger, reproducible by `scripts/analysis/fee-reconstruction.mjs`),
**CITED** (published elsewhere, reused without re-derivation), or **MODELLED**
(an arithmetic projection with its assumptions named).

## 1. Headline result

**ESTABLISHED: 7.405557 USDG**, against 43 confirmed withdraws over the
campaign's full 2026-09-12–09-15 window. This is **+0.025557 USDG (+0.35%)**
above the CITED 7.38 USDG. That is a close reconciliation, not an exact one —
see Section 4.

| Quantity | Value | Label |
|---|---:|---|
| Token0 (USDG) fees collected | 3.494895 USDG | ESTABLISHED |
| Token1 (NVDA) fees collected | 0.018287239639169606 NVDA | ESTABLISHED |
| Token1 leg, valued at pool spot | 3.910662 USDG | ESTABLISHED |
| **Total fee income** | **7.405557 USDG** | **ESTABLISHED** |
| Cited total fee income | 7.38 USDG | CITED |
| Difference | +0.025557 USDG (+0.35%) | — |

## 2. Method

### 2.1 What the ledger holds

Three tables in `live_pilot_v1` carry candidate fee evidence:

- **`actions`**, 361 rows for this campaign: 302 broadcast (confirmed or
  reverted — 3 reverted mints, no reverted withdraws), 59 prepared-and-cancelled
  (never broadcast, no cost or fee effect), 43 of the confirmed rows are
  `withdraw` actions. Each confirmed withdraw's `receipt->'facts'->'liquidityEvents'`
  decodes the transaction's real on-chain events: exactly one `DecreaseLiquidity`
  (principal returned) and one `Collect` (principal + fees returned) per
  withdraw, verified — this is not an assumption, every one of the 43 rows
  was checked.
- **`marks`**, 17,667 rows: 17,360 of `kind = 'mark'` (17,101 holding-phase +
  151 recenter + 60 exit + 45 entry + 3 halted) carry per-mark
  `uncollected0`/`uncollected1`. These are not off-chain interpolations: the
  campaign's own `mark()` function (`src/live-pilot/chain.ts`) computes them
  by *simulating* the position's `collect()` call against the live NFT
  position manager at that block (`simulateContract(..., functionName:
  'collect', ...)`) — an `eth_call`, not an estimate. They still lag the
  actual withdraw because marks are polled roughly every 10 seconds and fees
  keep accruing between the last poll and the withdraw's confirmation block.
- **`campaigns.state`**: `collectedFee0` / `collectedFee1` are running
  accumulators, updated at every withdraw, of the same kind as
  `state.gasSpentQuote` (which `docs/research/break-even-2026-09-30.md`
  already cross-checked against its own ledger reconstruction).

### 2.2 Which source is authoritative, and why

**`Collect - DecreaseLiquidity` per confirmed withdraw is the authoritative
fee figure.** It is decoded directly from mined-transaction event logs — the
same on-chain truth the position manager itself paid out — with no
simulation, no polling lag, and no interpolation. There is no double-counting
risk: 43 recenters produced exactly 43 positions and exactly 43 confirmed
withdraws (`status = 'confirmed'`); the 8 `cancelled` withdraw-intent rows
were never broadcast and moved no tokens; there are zero `reverted` withdraws
in this campaign. Every confirmed withdraw's `liquidityEvents` array was
verified to contain exactly one `DecreaseLiquidity` and one `Collect` — the
reconstruction script asserts this and would fail loudly if it were ever not
true.

**Cross-check A — state accumulator.** `campaigns.state.collectedFee1`
matches the ledger sum **exactly**: 18,287,239,639,169,606 raw NVDA both
ways. `collectedFee0` is off by **2 raw units** (3,494,893 in state vs.
3,494,895 reconstructed from the ledger) — 0.000002 USDG, immaterial at six
decimal places, and small enough to be ordinary integer-rounding noise
accumulated across 43 sequential state updates rather than a data integrity
problem. Flagged rather than hidden, per this repository's evidence standard.

**Cross-check B — uncollected marks series.** Summing each position's last
holding-phase `uncollected0`/`uncollected1` mark before its withdraw (valued
the same way) gives **7.122802 USDG**, reliably *below* the Collect-based
7.405557 USDG — exactly the direction the ~10s polling lag predicts, since
fees keep accruing until the withdraw actually confirms. This corroborates
the Collect-based total as a lower-bound-consistent estimate; it is not used
as the headline figure because it structurally undercounts.

The task's own scale check — "a ~0.4 USDG peak across 43 positions lands near
7.4 USDG" — is confirmed exactly: the single largest per-position uncollected
mark in the whole campaign is nonce-290's position (tokenId `1171979`), at
**402,891 raw USDG (0.402891 USDG) and 1,664,163,092,785,331 raw NVDA**,
matching the task's stated maxima to the raw unit.

### 2.3 Valuation: why pool spot, not an oracle

Token0 (USDG) fees need no conversion. Token1 (NVDA) fees must be converted
to USDG, and the task's default instruction is to use an independent oracle
reference rather than pool spot, pointing at the ETH/USD + USDG/USD proof
shape in `receipt->'gasValuation'->'proof'` as the pattern this codebase
uses.

That pattern does not extend to NVDA. `src/live-pilot/valuation.ts`
(`pilotGasValuer`) only ever reads the `ETH` and `USDG` oracle feeds — it has
no NVDA branch, because it exists solely to value *gas* (paid in ETH) into
USDG. Nowhere in this campaign's own execution or accounting code
(`src/live-pilot/chain.ts#mark`, which computes `netNavQuote` and
`benchmarkQuote`) is an NVDA oracle read; both use `quoteValue()`
(`src/simulator/math.ts`), which prices token1 against token0 using the
pool's own `sqrtPriceX96` — pool spot, by construction.

This session checked whether an independent NVDA/USD oracle reading exists
anywhere in the database that could be used instead, via
`public.asset_risk_snapshots` (the `primaryTokenizedPrice` feed
`selectOracleFeed` would pick for symbol `NVDA`, per
`src/risk/source.ts#expectedProductType`):

| Window | Snapshots | `execution_eligible = true` |
|---|---:|---:|
| Campaign window (2026-09-12–09-15) | 12,635 | **0** |
| All recorded history (symbol NVDA) | 116,858 | **0** |

Every recorded NVDA snapshot, in this campaign and in the database's entire
history, carries `execution_eligible = false`, with reasons consistently
including `sequencer_feed_unavailable`, `oracle_price_stale`, and
`quote_oracle_unavailable`.

**Corrected on review — this does not establish that no usable NVDA price
exists.** Two findings narrow it, and both matter for anyone reusing this
reasoning:

1. `execution_eligible = false` is universal across **every** asset, not just
   NVDA: 116,872 NVDA snapshots and 84,136 each for GLD, GOOGL, AAPL, QQQ, SPY
   and MSFT, with zero eligible in any of them. A flag that is false for the
   entire universe is not evidence about one feed. It is a stricter,
   session-sensitive gate than the one the paper reference path applies —
   `market_session_unverified` is among its reasons, while
   `evaluateRangeKeeperReferences` explicitly admits a `held_equity_reference`
   for a stock token outside its regular session. That is why paper previews
   resolve eligible references today while every stored snapshot reads
   ineligible.
2. Oracle answers **do** exist in the database: 196,538 of 621,695 rows carry
   `snapshot->'oracle'->'state'->>'answer'`. For NVDA they run **2026-09-23 to
   2026-09-30**, 41,555 rows.

The campaign window is the exception, and retention is why: of 40,125 NVDA
snapshots between 2026-09-10 and 2026-09-19, **zero** retain an oracle answer.
They were dedup-pruned by the seven-day telemetry retention, which strips the
detail blob and keeps only `symbol`, `oracle_address`, `execution_eligible` and
`reasons` as columns.

So the operative constraint is narrower and more actionable than a broken feed:
**the independent NVDA prices for this campaign existed and were deleted before
anyone tried to value its fees against them.** The choice of pool spot below is
forced, but by retention, not by the feed.

Given that, **pool spot is the only NVDA price reference still recoverable for
this campaign's window**, and it is the one this
campaign's own NAV and benchmark accounting already uses throughout. This
session values each withdraw's NVDA fee leg at that withdraw's own
post-confirmation pool state (`receipt->'after'->'sqrtPriceX96'`, read
immediately after the withdraw transaction confirms — the same "receipt
block" timing convention `pilotGasValuer` uses for gas), via the exact
integer formula from `quoteValue()`:

```
value_usdg = amount0 + amount1 * 2^192 / sqrtPriceX96^2
```

**Error characterization.** Pool spot at the moment of realization has two
sources of deviation from a "true" independent price: (a) it is the AMM's
own price, which can differ from an external reference by the pool's
in-range liquidity depth and any transient imbalance — not bounded here,
since no independent reference exists to bound it against; (b) it is a
point-in-time price (one block), not a TWAP, so it inherits whatever
single-block noise the pool had. Both are structural limits of this
valuation choice, not bugs in its execution — and both apply equally to this
campaign's own live NAV accounting, since it uses the identical formula.

## 3. What this reconstruction could not determine

- **An oracle-based valuation for NVDA.** The independent reference the task
  asked for does not exist in usable form anywhere in this database. This is
  not fixable by better querying; it would need either a working NVDA/USD
  feed at the time (not available) or an archived off-chain price series
  this repository does not hold under the database-only scope of this task.
- **The exact source of the +0.35% gap against the cited 7.38 USDG.** The
  September 17 note's own valuation method is not visible to this session —
  its data directory is gitignored and this task's scope was DB-only, not a
  re-read of that gitignored material. A per-withdraw pool-spot valuation
  (used here) and whatever method that note used (single aggregate price?
  QuoterV2 requote, as it used for swap shortfall? a different block
  convention?) are plausible, unverified candidates for the gap. Reported
  plainly rather than tuned away.
- **A tighter bound on the pool-spot valuation error**, for lack of any
  independent reference to bound it against (Section 2.3).

## 4. Reconciliation with the cited 7.38 USDG

**Reconciles closely, not exactly: +0.025557 USDG, +0.35%.** This is small
relative to the total and in a direction (this session's figure higher) that
is not explained by an obvious double-count or omission on either side — the
ledger reconstruction here is exact-integer, receipt-verified, and
cross-checked twice (Section 2.2). The gap most likely reflects a valuation
methodology difference from the September 17 note, which this session cannot
inspect (Section 3). This is reported as a genuine, small discrepancy rather
than adjusted to match.

## 5. A data-retention finding worth flagging

`public.asset_risk_snapshots` rows for the campaign window carry a `pruned`
marker in their `snapshot` JSON (`"policy": "telemetry-retention-v1"`,
`"recoverable": true`) — the per-row detail was removed by the 7-day
telemetry dedup-prune, consistent with this repository's disk/retention
policy. The `symbol`, `oracle_address`, `execution_eligible` and `reasons`
columns are untouched by that prune (they live outside the pruned JSON blob),
which is what makes the Section 2.3 oracle-availability finding possible at
all despite the prune. Had those columns also been pruned, this session would
have had no way to determine NVDA oracle availability from the database and
would have had to say so plainly rather than guess.

## 6. Consequence for the break-even model

`docs/research/break-even-2026-09-30.md` Section 4 derives a fee rate of
0.1544 USDG/hour at 250 USDG (from 7.38 USDG / 47.8 held hours, CITED), and
from it a break-even capital of **277.71 USDG** and a break-even cadence of
**20.0 recenters/day (1 per 1.198h)** against an actual cadence of 21.6/day.

Substituting this session's ESTABLISHED 7.405557 USDG (holding the CITED
47.8 held hours, and the CITED `g = 0.134` USDG/recenter and `k·C = 0.051`
USDG-at-$250 unchanged — this note does not re-derive the cost side, which
`docs/research/break-even-2026-09-30.md` already reconstructed):

| Quantity | Cited (7.38 / 47.8h) | This session (7.405557 / 47.8h) | This session (7.405557 / 47.92h*) |
|---|---:|---:|---:|
| Fee rate r·C | 0.1544 USDG/hour | 0.1549 USDG/hour | 0.1545 USDG/hour |
| Actual cadence | 21.59/day | 21.59/day | 21.53/day |
| Break-even cadence | 20.03/day | 20.10/day | 20.05/day |
| **Break-even capital** | **277.71 USDG** | **276.35 USDG** | **276.35 USDG** |

\* `scripts/analysis/fee-reconstruction.mjs` also reconstructs held hours as
a supplementary sanity check (first holding-phase mark to withdraw
confirmation, summed per position): **47.924h**, 0.26% from the cited 47.8h.
This is a different methodology from whatever the September 17 note used and
is reported as a plausibility check, not a replacement measurement.

**The break-even capital and cadence survive this reconstruction.** The fee
total moves by +0.35%, which moves the break-even capital by about -0.5%
(276.35 vs. 277.71 USDG) and the break-even cadence by about +0.3–0.4%
(20.03–20.10 vs. 20.0/day) — changes an order of magnitude smaller than the
7-8% cadence overshoot the original note already treats as "real but
modest." Every qualitative claim in Sections 3–4 of
`docs/research/break-even-2026-09-30.md` — that the deployed capital (250
USDG) sat modestly below its break-even threshold, that this gap alone
cannot explain the 5.40 USDG cost-vs-fee deficit, and that entry/exit/
timeout churn is the larger driver — is unaffected by this reconstruction.

## Reproduction

`scripts/analysis/fee-reconstruction.mjs` opens one
`REPEATABLE READ READ ONLY` transaction against the research database and
reproduces every ESTABLISHED number in this note: the withdraw-by-withdraw
ledger reconstruction, both cross-checks, the oracle-availability query, the
held-hours sanity check, and the break-even-model comparison in Section 6.
It performs no writes. Run it with:

```
export PATH=/root/conc-liq/.tools/node/bin:$PATH
node --import tsx scripts/analysis/fee-reconstruction.mjs        # human-readable
node --import tsx scripts/analysis/fee-reconstruction.mjs --json # machine-readable
```

The CITED 7.38 USDG and 47.8 held-hours figures are printed alongside the
reconstruction for comparison but are not re-derived, since this session
cannot read `notes/live-cost-analysis-2026-09-17.md`'s gitignored backing
data. The script lives in `scripts/analysis/`, an owned subdirectory per
`scripts/workflows.json`'s `layoutPolicy`; `generate-script-registry.mjs`
lists `scripts` non-recursively (`readdirSync("scripts")`, filtered to
`.isFile()`), so this file — one directory level down — is outside the flat
registry `validate-script-registry.mjs` checks. Confirmed by regenerating
the registry to a scratch file and diffing against `scripts/workflows.json`:
only the `generatedAt` timestamp differs.
