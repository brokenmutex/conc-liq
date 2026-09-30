# Break-even capital and recentring cadence — 2026-09-30

Status: research only, paper and closed-live ledger analysis. This document
does not authorize execution or a policy change.

This note answers the central open question restated in the task that
produced it: at what deployed capital, and at what recentring frequency, does
the active-LP strategy clear its own action costs out of fee income. It uses
two campaigns with complete, immutable ledgers — the closed 250 USDG NVDA/USDG
live pilot (`live_pilot_v1`, campaign `f8affe19`) and the closed 276.27 USDG
AAPL/USDG RangeKeeper paper campaign (`rangekeeper_v1`, campaign `31802d63`)
— plus today's static gas calibration. Every number below is labelled:

- **ESTABLISHED** — reconstructed in this session directly from the
  append-only action/cost ledgers in the database, and reproducible by
  `scripts/analysis/break-even.mjs`.
- **CITED** — published in an existing document, not re-derived here (usually
  because doing so needs an oracle-price replay this note does not perform).
- **MODELLED** — an arithmetic projection built on the measured numbers,
  always with every assumption named next to it.
- **ASSUMED** — a value with no measurement behind it at all, used only where
  explicitly marked.

This note keeps fee-vs-cost break-even separate from total strategy P&L
(NAV vs cash, alpha vs passive), per the evaluation contract in
`docs/strategy/active-lp.md`. "Break-even" here means fee income covers
action cost. It does not mean the campaign was profitable in total —
inventory/price movement is a separate, larger effect that this note does not
decompose (see the AAPL section below, where it matters).

## 1. The 12.78 USDG deficit, decomposed

The completed NVDA/USDG live pilot earned **7.38 USDG** in fees and spent
**12.78 USDG** on actions (both CITED, `notes/live-cost-analysis-2026-09-17.md`).
This session independently reconstructed the cost side directly from
`live_pilot_v1.actions.receipt->'gasValuation'->'quote'` and cross-checked it
against the campaign's own `state.gasSpentQuote`: both give **9.561928 USDG**
of gas, to the raw unit (ESTABLISHED, exact reconciliation, 302 confirmed +
3 reverted broadcast transactions out of 361 recorded actions; 59 were
prepared and cancelled before broadcast and cost nothing). The remaining
**3.22 USDG** is swap shortfall against pre-trade spot on 6,277 USDG of swap
notional (5.1 bps: 3.14 of the 3.22 is exactly the pool's 0.05% fee, 0.08 is
price impact) — CITED, not independently re-derived here, since reconstructing
it needs the same-block quote replay the September 17 note already performed.

| Gas by action (ESTABLISHED, this session) | n | USDG |
|---|---:|---:|
| approve (confirmed) | 155 | 1.797533 |
| mint (confirmed) | 43 | 3.759250 |
| mint (reverted, still paid) | 3 | 0.122803 |
| swap (confirmed) | 58 | 2.024884 |
| withdraw (confirmed) | 43 | 1.857458 |
| **Total gas** | | **9.561928** |

| Phase (CITED, `notes/live-cost-analysis-2026-09-17.md`) | tx | all-in USDG | share |
|---|---:|---:|---:|
| recenter (38 episodes) | 188 | 8.04 | 62.9% |
| entry (11) | 55 | 2.67 | 20.9% |
| exit (12) | 59 | 2.08 | 16.3% |

Eight of the twelve exits were infrastructure or evidence timeouts, not
operator decisions (`private_block_lag_hard` x3, `paper_chain_pause_expired`
x2, `paper_risk_pause_expired` x2, `paper_current_risk_evidence_invalid`).
Timeout-driven churn cost **about 3.3 USDG, roughly a quarter of the
campaign's total cost, for zero fee benefit** (CITED).

**A data-provenance gap worth flagging plainly:** the 12.78/7.38 figures that
`docs/research/current-evidence.md` states as established fact trace to
`notes/live-cost-analysis-2026-09-17.md` and its `data/live-cost-analysis-2026-09-17/`
outputs. That data directory is `.gitignore`d (`data/`) and neither the note
nor its scripts are registered in `research/manifests/` with an immutable
source hash, unlike the September 18 and September 20 studies that
`docs/research/index.md` tracks. This session could still read the underlying
database rows and reconstruct the gas total exactly (see the table above), so
the headline figures hold up — but the repository's own evidence-discipline
convention (register a study, hash its inputs, keep it reproducible without a
local, gitignored directory) was not applied to the one figure that most
directly explains why the live campaign lost money. `scripts/analysis/break-even.mjs`
reconstructs the gas side from the database on every run precisely so this
figure no longer depends on that local directory continuing to exist.

## 2. A second, independent campaign: AAPL/USDG RangeKeeper

The RangeKeeper AAPL/USDG paper campaign (`31802d63`, fee-500, 276.27 USDG,
2026-09-22 09:33 to 2026-09-23 16:24, half-width 2 spacings / 20 ticks /
about ±0.20% — the same half-width as the NVDA live pilot) gives a second,
independent measurement at a different pool and capital.

This session reconstructed its cost total directly from
`rangekeeper_v1.campaigns.state.costEvents` (54 cost events, X18 fixed-point):

| Component | ESTABLISHED (this session) | CITED (`rangekeeper-operational-cost-reduction-2026-09-27.md`) |
|---|---:|---:|
| Gas | 0.912659 | 0.913 |
| Swap fee | 0.394498 | 0.394 |
| Swap shortfall | 0.740847 | 0.741 |
| **Total cost** | **2.048004** | **2.048** |

Fees earned were 1.856 USDG (CITED). **Fees minus costs is a deficit of only
0.192 USDG** — small, and close to break-even. The note's headline
"**net -1.178 USDG**" is a different, larger number: it is total strategy P&L
(NAV vs cash), which includes inventory/price movement over the window, not
just the fee-cost gap. Reading the note's $2.048 cost figure as the cause of
its $1.178 net loss overstates the case by about 6x; only 0.192 of it is a
fee-cost story, and the remaining ~0.986 is a price/inventory effect the
note's own stated scope ("operational cost reduction") does not decompose.
This note is careful to keep the two apart for exactly this reason.

Four recenters over 27.71 active hours (ESTABLISHED, `state.activeSeconds`)
cost 1.380 USDG all-in (0.345/recenter, CITED), against a measured fee rate of
0.0949 USDG per in-range hour (CITED) — a break-even threshold of **3.6
in-range hours per recenter** (CITED, and reproduced by the formula in
Section 4 below). At 6.9 hours/recenter actually observed
(27.71h / 4), the AAPL campaign's recenters ran comfortably inside their own
break-even bar. Its cost problem was not recenter cadence.

## 3. Verdict: action COUNT, not action PRICE

The task's premise — that today's $0.0613 expected / $0.0995 bound static
open+close round-trip gas cost (AAPL/USDG fee-500, size band matching 250
USDG, `deployment_calibration_profiles`, freshest row observed
2026-09-30 13:32 EEST) is far below the 12.78 USDG campaign total — is true
but is not, by itself, a fair test: 12.78 USDG is a *sum* over roughly 46
open/close-equivalent round trips (43 mints + 43 withdraws, plus approvals and
swaps), not one. Dividing by that count gives a per-cycle cost in the same
order of magnitude as the static figure, so the raw comparison in the prompt
mostly restates that a campaign has many actions. The correct test is
per-action, not campaign-total-vs-single-action.

Run correctly, the evidence still says **action count, not action price**,
but for reasons that need stating precisely rather than assumed:

1. **Gas price was not abnormal.** The NVDA campaign's effective gas price was
   0.069-0.41 gwei (median 0.083, CITED). Back-solving today's static figure
   ($0.0613 for 1,042,522 gas units, ESTABLISHED unit count from
   `deployment_calibration_profiles`) implies roughly 0.02-0.03 gwei today —
   *cheaper* than the campaign, not more expensive. If anything this cuts
   against a "price was the problem" story even harder: the live campaign ran
   at higher-than-today's gas prices and still only lost 12.78 USDG total, on
   46-plus round trips.

2. **The recenter economics alone were close to break-even, not badly
   negative.** Section 4 shows the NVDA campaign's actual cadence (1 recenter
   per 1.112 held hours) narrowly exceeded its own break-even cadence at 250
   USDG (1 per 1.198h) — a roughly 7-8% overshoot, implying a break-even
   capital of about 277.71 USDG against the 250 USDG actually deployed. That
   gap (about 28 USDG) cannot explain a 5.40 USDG (12.78 - 7.38) deficit by
   itself.

3. **Most of the deficit is extra, unproductive actions.** Entry cost 2.67
   USDG over 11 entries and exit cost 2.08 USDG over 12 exits (CITED) — a
   single continuous campaign needs exactly one of each. Eight of those
   twelve exits were infrastructure timeouts costing about 3.3 USDG for zero
   fee benefit (CITED). Together, entry+exit+timeout-churn overhead
   (roughly 4.75 - 3.3 double-counts partially with the exit figure; taking
   the phase table at face value, entry+exit = 4.75 USDG) accounts for more
   of the 5.40 USDG deficit than the recenter cadence overshoot does.

4. **The AAPL campaign corroborates this from a different angle.** Its
   recenters ran well inside their own break-even bar (6.9h vs a 3.6h
   threshold) — cadence was not the problem there at all — yet the campaign
   still shows a fee-cost gap, driven by entry/exit/revocation overhead
   relative to a short, four-recenter campaign.

The common thread across both campaigns is **the number and mix of actions
relative to how long the position actually held collectible fees**, not the
price of any individual action. Per-action gas and swap costs, where measured,
were unremarkable and consistent with the static fork calibration; the
deficit tracks entry/exit/timeout churn and, more marginally, recentring
cadence running slightly past its break-even point.

One more piece of corroborating evidence: `docs/research/rangekeeper-operational-cost-reduction-2026-09-27.md`
records that a half-width sweep on NVDA/500 (`v3_range_policy_replay_runs` id
1, CITED, illustrative $1.00 costs, five intervals) excluded half-widths 1, 2
and 5 as `observed_tick_path_crossed_range` — **unsurvivable** — and ranked
half-width 10 first among the widths it could complete. Both the NVDA live
pilot and the AAPL RangeKeeper campaign ran at **half-width 2**, inside the
band that sweep excluded. This is circumstantial (the sweep is NVDA/500, the
AAPL campaign shares only the tick spacing) but consistent: the deployed
range was narrow enough, relative to this asset class's tick volatility, to
mechanically force a high recenter count.

## 4. The break-even model

Over a window of length `T`, with cadence `n` (recenters per unit time) and
capital `C`:

```
net(C, n, T) = feeRatePerHour(C) * T  -  n * T * costPerRecenter(C)  -  entry/exit (amortized)
```

with, calibrated locally around each campaign's own capital:

```
costPerRecenter(C) = g + k * C
feeRatePerHour(C)   = r * C
```

- `g` — gas cost per recenter, ASSUMED capital-independent (mint/withdraw gas
  units do not scale with position size; this holds structurally, per
  `src/deployments/paper-cost.ts`, but is only calibrated at the one capital
  each campaign actually used).
- `k` — swap shortfall per recenter as a fraction of capital, MODELLED as
  linear in `C` (swap notional is assumed proportional to capital at fixed
  range width; not verified at any other capital).
- `r` — fee income per USDG-hour of capital, MODELLED as linear in `C`; valid
  only while the position's pool share stays small enough that dilution is
  negligible (Section 5 gives the point where that breaks down).

Solving for break-even:

```
break-even cadence for capital C:   n*(C) = r*C / (g + k*C)
break-even capital for cadence n:   C*(n) = n*g / (r - n*k)     [requires r > n*k]
```

**NVDA fee-500 calibration** (post-allowance regime, CITED per-recenter
figures; `r` from this session's ESTABLISHED fee/held-hours reconstruction):

| Quantity | Value |
|---|---:|
| Capital C | 250 USDG |
| Fee rate r*C (measured: 7.38 USDG / 47.8 held hours) | 0.1544 USDG/hour |
| Gas per recenter, g | 0.134 USDG |
| Shortfall rate, k*C at C=250 | 0.051 USDG |
| Actual cadence | 43 recenters / 47.8h = 1 per 1.112h (21.6/day) |
| **Break-even cadence at C=250** | **1 per 1.198h (20.0/day)** |
| **Break-even capital at the actual cadence** | **277.71 USDG** |

The campaign deployed 250 USDG and recentred slightly faster than that
capital could sustain on recenter economics alone — a real but modest
overshoot, dwarfed by the entry/exit/timeout-churn overhead in Section 3.

Two structural sensitivities fall out of this model directly:

- **The break-even cadence rises with capital but saturates.** Because both
  the fee term and the shortfall term scale with `C`, the gas term `g` is the
  only piece that capital dilutes away. In the limit of large `C`,
  `n*(C) -> r/k`, a constant (about 72.7 recenters/day on the NVDA
  calibration) — capital alone cannot buy an arbitrarily high sustainable
  cadence, because swap shortfall scales with the trade, not just the fixed
  overhead.
- **The break-even capital for a fixed, modest cadence is small.** At 4
  recenters/day the NVDA-calibrated break-even capital is about 38 USDG; the
  250-2,500 USDG paper books already comfortably clear that bar *if held to a
  low cadence*. The strategy's problem at 250 USDG was never that capital was
  too small for fee income to matter — it was cadence (and non-recenter
  overhead) running ahead of what any modest capital size can sustain.

Full sensitivity grid (MODELLED, NVDA fee-500 calibration only — this is one
pool's cost/fee structure projected across capital and cadence, not a
cross-pool forecast):

| Capital (USDG) | Break-even cadence (recenters/day) | Break-even interval |
|---:|---:|---:|
| 250 | 20.0 | 1.20h |
| 500 | 31.4 | 0.76h |
| 1,000 | 43.9 | 0.55h |
| 2,500 | 57.5 | 0.42h |
| 5,000 | 64.2 | 0.37h |
| 10,000 | 68.2 | 0.35h |
| 25,000 | 70.8 | 0.34h |
| 50,000 | 71.7 | 0.33h |

| Cadence (recenters/day) | Break-even capital (USDG) |
|---:|---:|
| 1 | 9.2 |
| 2 | 18.6 |
| 4 | 38.3 |
| 8 | 81.3 |
| 12 | 130.0 |
| 19 (the note's post-allowance steady state) | 232.6 |
| 24 | 324.0 |
| 48 | 1,278.8 |

The AAPL calibration (`g`=0.164, `k`=0.000404, `r`=0.000024 at C=276.27) gives
materially different numbers from the same formula — its fee rate is about
4x lower and its shortfall rate about 2x higher than NVDA's — which is the
clearest evidence that **`g`, `k` and `r` are pool- and gas-price-specific,
not universal constants.** There is no cross-pool average of these parameters
that is not itself an unverified assumption; this note deliberately does not
produce one.

## 5. Sensitivity: pool share and dilution

`src/paper/diluted-fees.ts` credits an LP's fee share for a swap segment as
`ownLiquidity / (ownLiquidity + externalLiquidity)` of that segment's fees
(the standard Uniswap v3 fee-growth mechanism) — so `feeRatePerHour(C)` is
only linear in `C` while `ownLiquidity(C)` stays small relative to external
in-range liquidity. This session reconstructed the NVDA campaign's own
liquidity share directly from its `live_pilot_v1.marks` snapshots
(ESTABLISHED, 17,101 holding-phase marks): **min 144.4 ppm, average 644.9 ppm,
max 1,028.7 ppm** — at most about 0.10% of in-range pool liquidity, well
inside the campaign's own 20,000 ppm (2%) `maxLiquiditySharePpm` guard. This
corroborates `docs/research/current-evidence.md`'s claim that "the observed
fill haircut was negligible at that size and liquidity share" — it is, by a
wide margin.

Using the average measured share as a single point-in-time liquidity
snapshot: holding external liquidity fixed and scaling own liquidity linearly
with capital at the same range width (both MODELLED, unverified assumptions),
own liquidity would equal the pool's external in-range liquidity — the point
at which the linear fee-rate assumption above is roughly 2x optimistic — at
around **387,000 USDG**. Separately, the campaign's own configured 2% share
cap implies an effective capital ceiling of about **7,750 USDG** at the
liquidity level observed during the campaign — a pre-existing configuration
constraint, not a break-even result, but worth noting because it binds well
before the modelled dilution halfway point.

At the 250-2,500 USDG capital actually used in the current four-book paper
campaign, dilution is not a first-order concern by this model: it would take
roughly a 30-100x increase in deployed capital (at this pool's observed
liquidity depth, one point in time) before self-dilution materially bends the
fee curve. **This is a model built from one liquidity snapshot series on one
pool over a three-day window; it says nothing about how NVDA/USDG's external
liquidity would react to a much larger position being added, or about any
other pool.**

## 6. Sensitivity: fee tier and range width

This is the weakest-evidenced sensitivity in this note, and is presented as
such.

- **Range width.** The only width sweep in the repository
  (`v3_range_policy_replay_runs` id 1, NVDA/500, CITED, five intervals,
  illustrative $1.00 entry/rebalance costs) shows a genuine interior optimum:
  half-width 10 spacings ranked first ($5.63 fee, $2.38 modelled alpha, 1
  rebalance), half-width 20 second ($2.82, $1.85, 0 rebalances), half-width
  50 third ($1.14, $0.75, 0 rebalances); half-widths 1, 2 and 5 were excluded
  outright as unsurvivable (the price crossed the range within the tested
  interval). Both real campaigns analyzed in this note ran at half-width 2 —
  inside the excluded band. Re-run against the two campaigns' *measured* cost
  stack (0.184-0.345 USDG/recenter) instead of the sweep's $1.00 placeholder,
  every width that survived at all (10, 20, 50) clears its own recenter cost
  by a wide margin, because completed rebalance counts in that sweep were 0
  or 1 per interval. This is consistent with, but does not prove, the
  hypothesis that widening past half-width 2 would materially cut recenter
  count without giving up all the fee income. **It is a five-interval replay
  on one pool with placeholder costs; it is not a validated width policy.**
- **Fee tier.** `docs/research/rangekeeper-operational-cost-reduction-2026-09-27.md`
  notes that the 3000 tier (60-tick spacing vs 500's 10) gives a 6x wider
  range at the same `fullWidthSpacings`, at 6x the fee per unit volume on
  materially lower observed volume, and states this "has never been swept."
  `docs/research/current-evidence.md` separately notes that MSFT fee-3000's
  action costs are borrowed from NVDA fee-500 and are a scenario, not
  execution evidence. **This session found no quantified fee-tier sensitivity
  anywhere in the repository and did not produce one; the honest answer is
  that it does not exist yet.**

## 7. What this note could not determine

- **A validated width or fee-tier policy.** Section 6 is the clearest gap:
  the only width evidence is a five-interval, illustrative-cost replay on one
  pool, and fee tier has never been swept at all. Determining this needs a
  `v3_range_policy_replay_runs`-style sweep across half-width and
  `trigger_percent`, fed the measured cost stack (not the $1.00 placeholder),
  on held-out symbols and windows, per the rangekeeper note's own stated
  standard.
- **The true shape of `g(C)` and `k(C)` beyond each campaign's own capital.**
  Both are calibrated at a single capital point per pool (250 USDG for NVDA,
  276.27 USDG for AAPL). Whether `k` (shortfall as a fraction of capital)
  actually stays constant as capital grows, or whether larger swaps see worse
  price impact than the 0.08 USDG of impact measured on ~115 USDG median
  swaps, is not known. This needs size-specific cost probes, which
  `docs/research/current-evidence.md`'s open gates already call for ("Probe
  MSFT-specific entry, recenter and exit costs") but which do not yet exist
  for any capital above roughly 276 USDG.
- **How external pool liquidity reacts to a much larger own position.** The
  dilution model in Section 5 holds external liquidity fixed. A position
  large enough to move the pool's own depth (through its presence, or through
  other LPs' response to it) is outside what one point-in-time snapshot can
  say anything about.
- **Fee-tier-specific action costs.** MSFT fee-3000's costs are borrowed from
  NVDA fee-500 (CITED, `current-evidence.md`); this note did not add a fee-3000
  cost measurement.
- **A single number for "the" break-even capital or cadence.** The two
  calibrations in Section 4 disagree by roughly 2-4x on every input
  parameter. This note reports both, not an average, because averaging two
  pool-specific measurements is itself an unverified assumption.

## Reproduction

`scripts/analysis/break-even.mjs` opens one `REPEATABLE READ READ ONLY`
transaction against the research database and reproduces every ESTABLISHED
number in this note: the NVDA and AAPL cost-ledger reconstructions (Sections
1-2), today's static gas-calibration unit counts (Section 3), the break-even
model and sensitivity grid (Section 4), and the dilution model (Section 5).
It performs no writes. Run it with:

```
export PATH=/root/conc-liq/.tools/node/bin:$PATH
node --import tsx scripts/analysis/break-even.mjs        # human-readable
node --import tsx scripts/analysis/break-even.mjs --json # machine-readable
```

CITED figures (fee totals, the September 17 and September 27 note's cost
tables, the half-width sweep) are printed alongside the reconstruction for
comparison but are not re-derived by the script, since doing so would require
replaying oracle prices and the fork-quote comparisons those notes already
performed. The script lives in `scripts/analysis/`, an owned subdirectory
per `scripts/workflows.json`'s `layoutPolicy`; it is therefore outside the
flat top-level script registry that `validate-script-registry.mjs` checks
(confirmed by re-running `scripts/maintenance/generate-script-registry.mjs`
to a scratch file and diffing: only the `generatedAt` timestamp changes), and
adding it required no registry update.
