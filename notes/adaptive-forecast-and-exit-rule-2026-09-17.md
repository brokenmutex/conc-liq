# Decoupled forecast sweep, exit-to-cash rule, and a metric correction

Date documented: 2026-09-18 (work run 2026-09-17)
Strategy version: `adaptive_paper_60m_v1` (`config/adaptive-paper-60m.json`)
Deployed release: `ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf` (occupancy correction, from 2026-09-17 08:45:48 UTC)
Documented source commit: `56e5d04`
Evidence directories: `notes/adaptive-forecast-sweep-2026-09-17/`, `notes/adaptive-exit-rule-2026-09-17/`
Scripts: `scripts/adaptive-forecast-sweep.mjs`, `scripts/adaptive-exit-rule-sim.mjs`, `scripts/report-forecast-sweep.py`
Predecessor: [adaptive-residence-cap-sweep-2026-09-17.md](adaptive-residence-cap-sweep-2026-09-17.md)

## Summary

1. `agileForecastStats` derives two estimates from one window: the variance
   that drives width selection, and the fee growth that drives the economic
   gate. The deployed config uses a hard 60-minute cutoff for both. A 12-arm
   sweep crossing the volatility timescale against the fee timescale, against
   the deployed occupancy ranker, was run over two windows.
2. **Ranking these arms by alpha does not reproduce.** Between the two
   windows the rank correlation of alpha is +0.51; of net fees earned
   (fees minus gas) it is +0.92. Alpha nets against a fixed passive
   benchmark while the arms carry 12–70% exposure, and that drift generates
   P&L larger than the effect being measured.
3. On net fees, the fee timescale dominates and faster is better: a
   15-minute fee half-life beats both slower settings in 6 of 6 rows across
   both windows. The best arm in both windows is `volFlat_fee15m` — a flat
   6-hour variance estimate with a 15-minute fee half-life — which the
   2026-09-14 agility study's arm design could not express.
4. **No arm is a deployment candidate.** `volFlat_fee15m` earns 57% more net
   fees than the deployed config and has worse alpha in both windows: 30
   recenters on NVDA against 2. Each recenter swaps at the band edge and
   realises the adverse move that put it there. Fee capture and inventory
   damage are coupled through the act of recentering.
5. The exit-to-USDG rule proposed as the residence-cap sweep's next step was
   simulated. It does not act as an inventory policy; it is a one-way door.
   On NVDA it entered once, exited once, and held a position for 3.9 hours
   out of 229, sitting in cash for the rest of the nine days. Its apparent
   alpha improvement (−14.12 to −0.41) is the strategy ceasing to trade
   shortly before a 6% decline, with net fees collapsing from 71.11 to 1.85.
6. Two independent mechanisms hold the door shut. The re-entry gate accepted
   31 of 23,837 attempts (0.13%), and 30 of those 31 then failed at the fill
   on `frozen_mint_minimum`, because entry fills assert both mint legs land
   within slippage of the quote while recenters use the looser bounded
   adaptive funding convention. Minting two-sided from 100% cash needs a
   swap and is far more sensitive to drift between quote and fill.
7. Every intervention tested across three studies now reshuffles decisions
   inside a gate that rejects essentially all of them: the recenter gate
   accepts 0.17%, the re-entry gate 0.13%. At 1,000 USDG against a
   10-minute horizon no action of any kind clears its own cost.

Everything here is offline paper modelling against a frozen historical book.
Nothing was broadcast, and nothing here is evidence that any variant is
live-executable or profitable.

## 1. What the lookback actually controls

`src/research/agile-forecast.ts` returns `varianceTicksPerMs`, `growth0` and
`growth1` from one causal window. `AgileForecastSpec` already supports
decoupling them — `volatilityHalfLifeMs` weights the variance, `feeHalfLifeMs`
and `weightedFeePpm` weight the fee growth — and the live config uses none of
them. `src/adaptive-paper.ts:33` pins `lookbackMs` as `z.literal(3600000)`,
which blocks deploying a different value but not simulating one; the sweep
reads the config JSON directly and never goes through zod.

Samples are one per minute (`src/adaptive-paper.ts:134`), so a 60-minute
window is n≈60. The relative standard error of a variance estimate is about
sqrt(2/n): 18% at 60 minutes, 26% at 30, 37% at 15. Width candidates are
spaced 2x apart and occupancy scales as width²/variance, so neighbouring
candidates are 4x apart in variance. Estimator precision is not the binding
constraint on width selection; lag is.

The fee term is the opposite case. It feeds the gate, and a trailing window
that spans the pre-open quiet underestimates the next ten minutes of fees
exactly when fee density is highest. The two estimands want different
windows, which is what the grid tests.

## 2. Design

All arms replay in one pass over a shared `ExperimentMarket` and a shared
sample buffer, each with its own `AdaptiveLpReplay`. Identical data admission
by construction, and it avoids re-reading ~3M pool events per arm. Nothing in
`adaptive-lp.ts`, `agile-lp.ts` or `adaptive-forecast.ts` mutates the source
object, so sharing it is safe.

Warmup scales to the longest lookback (6h + 30m). The residence-cap sim's
75-minute warmup would have started the 6h arms cold and scored them on
availability rather than on their estimates. The harness warns when a book
cannot supply it, which is how the first run's defect was caught (§3).

Twelve arms: three rolling controls (`live_60m` reproducing the deployed
config, `rolling_30m`, `rolling_120m`) and a 3x3 grid crossing the volatility
half-life (15m, 60m, flat) against the fee half-life (15m, 60m, flat) on a
common 6-hour lookback with the 6h/2h/60 admission of the 2026-09-14 study's
EWMA arms. Forecast horizon stays at the deployed 10 minutes.

## 3. Two windows, and why there are two

The first run used 2026-09-08 to 09-17. AAPL and GOOGL checkpoints begin
2026-09-13, after that start, so both books ran with no warmup and the 6h
arms lost their first two hours of decisions while `live_60m` needed only 40
minutes. The harness emitted `WARNING: only -7572 min of warmup for a 360 min
lookback` for both. The run was repeated over 2026-09-13 15:00Z to 09-17
14:05Z, where all three books hold a full 390-minute warmup.

NVDA is clean in both runs. The corrected window is shorter, so both are
reported rather than one superseding the other.

## 4. Alpha does not reproduce; net fees do

Combined over the books present, USDG:

| Arm | 9-day alpha | 9-day netfee | 4-day alpha | 4-day netfee |
| --- | ---: | ---: | ---: | ---: |
| `live_60m` | 49.18 | 145.72 | 59.56 | 95.54 |
| `rolling_30m` | 40.24 | 185.64 | 67.93 | 121.31 |
| `rolling_120m` | 28.64 | 116.16 | 54.49 | 86.71 |
| `vol15m_fee15m` | 44.47 | 165.71 | 61.03 | 111.25 |
| `vol15m_fee60m` | 22.78 | 117.56 | 49.58 | 80.64 |
| `vol15m_feeFlat` | 4.13 | 121.04 | 46.58 | 84.36 |
| `vol60m_fee15m` | 29.14 | 182.98 | 52.54 | 134.36 |
| `vol60m_fee60m` | -4.59 | 65.76 | 48.25 | 64.81 |
| `vol60m_feeFlat` | -30.22 | 67.49 | 23.55 | 48.15 |
| `volFlat_fee15m` | 27.93 | **229.01** | 46.28 | **165.46** |
| `volFlat_fee60m` | -4.24 | 97.62 | 41.10 | 67.03 |
| `volFlat_feeFlat` | -21.92 | 39.94 | **73.58** | 73.81 |

Rank correlation between the two windows: alpha +0.51, net fees +0.92. Net
fees select the same winner in both; alpha does not.

`volFlat_feeFlat` is the clearest case. It is the worst arm in one window and
the best in the other, with **zero recenters in both**: it enters once and
holds at 70% exposure. Its ranking is the direction of the price path, not a
property of the estimator.

Net fees is the term the strategy controls. It is not a sufficient objective —
it ignores inventory P&L entirely — but it is the part of the result that
reproduces, and arms cannot be ranked on this sample by anything else.

## 5. The fee timescale, on the metric that reproduces

Net fees by grid cell, USDG:

| | 9-day fee15m | fee60m | feeFlat | 4-day fee15m | fee60m | feeFlat |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| vol15m | 165.71 | 117.56 | 121.04 | 111.25 | 80.64 | 84.36 |
| vol60m | 182.98 | 65.76 | 67.49 | 134.36 | 64.81 | 48.15 |
| volFlat | 229.01 | 97.62 | 39.94 | 165.46 | 67.03 | 73.81 |

A 15-minute fee half-life beats both slower settings in all six rows. The
ordering of `fee60m` against `feeFlat` is mixed, so only the fast-fee
advantage is clean. The volatility axis is weak by comparison, and the best
cell pairs the *slowest* variance estimate with the fastest fee estimate.

This supports the lag explanation over the stability one. A slow fee window
does not buy a steadier gate; it makes the gate late.

## 6. Why the best fee arm is not the best arm

`volFlat_fee15m` earns 229.01 against `live_60m`'s 145.72 in net fees over
nine days, and has worse alpha in both windows. On NVDA it recentres 30 times
against 2, at 12.6% average exposure against 45.0%.

More recentering keeps the book nearer the money and earns more, and each
recentre swaps at the band edge, realising the adverse move that put the
price there. The same mechanism appears in §7: acting at a crossing
crystallises the loss. Fee capture and inventory damage are not independent
terms that can be optimised separately.

## 7. The exit-to-USDG rule

`scripts/adaptive-exit-rule-sim.mjs` subclasses the deployed
`AdaptiveLpReplay` and wraps `step()` rather than reimplementing it. The base
class gets first refusal on every observation, so a recentre its gate accepts
still happens; the exit fires only where the deployed strategy would have sat
stranded. The `baseline` arm reproduces `live_60m` to the microUSDG
(−11923, 19410407, 17220070), which is the check that the wrapper does not
perturb the base logic.

"Stranded on the risky side" depends on token ordering. With the quote as
token0 the position is all RWA above the range; with the quote as token1 it
is all RWA below it. Both are the same economic event and
`isStrandedRisky` dispatches on `quoteIsToken0` rather than assuming a tick
direction.

Re-entry needs its own gate. In `adaptive-lp.ts` the economic gate is
`if(this.policy.economicGate && this.position)` — entry is ungated — so
exit-then-enter would be an ungated recentre at `exit + entry` (0.29) against
a gated recentre's 0.22. The `exit_0m_ungated` arm omits the gate to measure
exactly that.

2026-09-08 to 09-17, 1,000 USDG per book, USDG:

| Book | Arm | Alpha | Net fees | Recenters | Exits | Cash (min) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| NVDA | `baseline` | -14.12 | 71.11 | 15 | 0 | 1 |
| NVDA | `exit_0m` | -0.41 | 1.85 | 0 | 1 | 13,454 |
| NVDA | `exit_15m` | -1.73 | 1.85 | 0 | 1 | 13,438 |
| NVDA | `exit_60m` | -2.67 | 1.85 | 0 | 1 | 13,393 |
| NVDA | `exit_0m_ungated` | -30.81 | 36.34 | 0 | 8 | 134 |
| AAPL | `baseline` | 51.53 | 66.82 | 17 | 0 | 41 |
| AAPL | `exit_0m` | 10.86 | 21.36 | 3 | 2 | 4,088 |
| AAPL | `exit_15m` | 22.82 | 38.03 | 9 | 2 | 3,751 |
| AAPL | `exit_60m` | 23.27 | 38.18 | 9 | 2 | 3,631 |
| AAPL | `exit_0m_ungated` | 34.86 | 61.13 | 7 | 8 | 60 |
| GOOGL | all | 11.78 | 7.79 | 0 | 0 | 41 |

NVDA's action log is `entry`, `exit`, then nothing for nine days: 3.9 hours
holding a position out of 229. The alpha improvement is the strategy ceasing
to trade before a 6% decline, not an inventory policy working. GOOGL was
never stranded in this window and contributes nothing either way.

The one-way door has two independent causes:

- The re-entry gate accepted 31 of 23,837 attempts on NVDA (0.13%), 27 of
  7,686 on AAPL.
- Of NVDA's 31 acceptances, 30 failed at the fill with `frozen_mint_minimum`
  (22 on AAPL). Entry fills assert both mint legs land within slippage of the
  quote; recenters use the looser bounded adaptive funding convention.
  Minting two-sided from 100% cash requires a swap, so entry is much more
  sensitive to price drift between quote and fill.

An earlier 1.5-day smoke over 2026-09-16 to 09-17 showed the complementary
failure: GOOGL sat stranded 202 minutes under the baseline and still finished
at +17.22 because price returned into range, while every exit arm fired once
and lost 12–16 USDG. A downside crossing is a local low; exiting there
realises the loss and pays for the privilege if price reverts.

## 8. Limitations

- One price path, and a short one. NVDA has nine days, AAPL and GOOGL four.
  The forecast grid spread (50–75 USDG combined) is comparable to one day of
  directional swing on one book, which is why §4 argues from reproducibility
  across windows rather than from any single ranking.
- Three observed crossing episodes total, of which one trended and two
  reverted. That is not enough to characterise the exit rule's dependence on
  what price does next.
- Net fees ignores inventory P&L. It is the reproducible component, not a
  sufficient objective.
- The exit sim's AAPL and GOOGL books start without warmup, costing 74
  observations. The deployed spec needs only 40 minutes, so the effect is
  immaterial here, unlike the 6h arms in §3.
- The paper model credits fees at full liquidity share and fills at quoted
  prices. The 250 USDG live pilot earned 7.40 USDG of fees against a 3.22
  USDG swap shortfall, so real capture is lower than modelled. No result here
  has been calibrated against that.
- Chain health gates are not applied, so the simulations decide at timestamps
  the live runner would skip.
- The `covered` flag in the checkpoint query still flips false for every row
  when the indexer cursor reads back an old block; both harnesses retry, and
  the live runner filters on the same flag and would silently drop those
  checkpoints. Observed twice during these runs.

## 9. Consequences for the paper books

The three 1,000 USDG adaptive paper sessions were stopped and disabled on
2026-09-17 20:29 UTC+3 after 26 hours: NVDA 997.47 (-2.53), AAPL 1006.66
(+6.66), GOOGL 999.93 (-0.07), one entry each and 8/7/4 recenters. Final
state, status and marks are archived under
`data/adaptive-paper-60m-2026-09-16/ARCHIVED-stopped-2026-09-17/` (the
`data/` tree is not tracked). Data collection — `conc-liq-tail`,
`conc-liq-rpc-health`, and the checkpoint timers — was deliberately left
running, since history accrual is the binding constraint on every study here.

That archive directory was cleared on 2026-09-20 together with the live 60-minute
state; the numbers above stand, but the state, status and mark files behind them
are no longer on disk.

A replacement set was scoped but not started. Two findings bear on it:

- Of the 15 indexed and enabled pools, only three are papered, all on the 500
  fee tier. Over the last ~300k blocks GLD-3000 (1,488 USDG gross fees) and
  MSFT-3000 (1,176) both out-earn the papered AAPL-500 (782).
- The 3000 tier is **not** simply a 6x fee lever. Tick spacing there is 60
  (verified: every `tickLower` on both pools is a multiple of 60), so minimum
  bands are 6x wider and fee density scales as 1/width. The effects largely
  cancel for a given capital, and the question is fee yield per unit of pool
  liquidity, where MSFT-3000 leads and GLD-3000 is below NVDA-500.
- `AdaptiveLpReplay`'s constructor asserts `market.fee===500 &&
  market.tickSpacing===10`. No 3000-tier book can run in the paper runner or
  in either simulation harness without a source change.

## 10. Next steps

1. The budget lever is the only one tested or scoped so far that changes the
   ratio the gate is failing on, rather than redistributing decisions beneath
   it: recentre cost is fixed in gas while forecast fees scale with capital.
   It also scales inventory exposure proportionally, and NVDA and GOOGL are
   the only books with capacity headroom (0.86% and 0.52% of pool liquidity
   at 1,000 USDG; AAPL is already at 13.09%).
2. Calibrate modelled fee capture against the live pilot's realised fees
   before trusting any net-fee number, including §4's.
3. Investigate the `frozen_mint_minimum` fill check for entries funded from
   cash. If exiting to cash is ever to be part of the strategy, re-entry
   cannot fail 97% of the time after passing its gate.
4. Relax the `market.fee===500` assertion if the 3000-tier books are wanted.
5. Investigate the indexer cursor flake and count how many live decisions it
   has cost; it may explain part of the `blocked` tallies. Carried over
   unresolved from the residence-cap sweep.
6. Do not run further width, horizon or forecast-timescale sweeps on this
   sample. Three studies have now returned differences inside its noise.

## 11. Reproduction

```bash
R=/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf

# Forecast grid, both windows
SIM_START=2026-09-08T02:00:00Z SIM_END=2026-09-17T14:05:00Z $R/bin/node \
  scripts/adaptive-forecast-sweep.mjs notes/adaptive-forecast-sweep-2026-09-17/sweep.json \
  --arms notes/adaptive-forecast-sweep-2026-09-17/arms.json
SIM_START=2026-09-13T15:00:00Z SIM_END=2026-09-17T14:05:00Z $R/bin/node \
  scripts/adaptive-forecast-sweep.mjs notes/adaptive-forecast-sweep-2026-09-17/sweep-warmed.json \
  --arms notes/adaptive-forecast-sweep-2026-09-17/arms.json
python3 scripts/report-forecast-sweep.py notes/adaptive-forecast-sweep-2026-09-17/sweep-warmed.json

# Exit rule
SIM_START=2026-09-08T02:00:00Z SIM_END=2026-09-17T14:05:00Z $R/bin/node \
  scripts/adaptive-exit-rule-sim.mjs notes/adaptive-exit-rule-2026-09-17/exit-sweep.json
```

Both harnesses read the local database directly and import the compiled
strategy from the release directory (`CONC_LIQ_RELEASE` overrides the path).
Neither writes to the database or to any live session state.
`--intersect` on the forecast sweep restricts decisions to observations where
every arm has a forecast, separating estimator quality from the >15-minute
gap rule in `agileForecastStats`. It was not needed here: on the warmed
window every arm recorded zero unavailable observations, so data admission
was already identical. On the unwarmed window the spread was 334
observations on NVDA and 196 on AAPL and GOOGL.
