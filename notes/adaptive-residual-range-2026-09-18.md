# W1: a one-sided residual range instead of exiting or swapping at the band edge

Date documented: 2026-09-18
Strategy version: `adaptive_paper_60m_v1` (`config/adaptive-paper-60m.json`), unmodified
Deployed release: `ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf`
Evidence directory: `notes/adaptive-residual-range-2026-09-18/`
Scripts: `scripts/adaptive-residual-range-sim.mjs`, `notes/adaptive-residual-range-2026-09-18/report.py`
Prerequisite: [fee-calibration-2026-09-18.md](fee-calibration-2026-09-18.md) —
`feePpm` = 1,000,000, fill haircut 0 bps
Predecessors: [adaptive-forecast-and-exit-rule-2026-09-17.md](adaptive-forecast-and-exit-rule-2026-09-17.md),
[adaptive-residence-cap-sweep-2026-09-17.md](adaptive-residence-cap-sweep-2026-09-17.md)

## Summary

1. **This is the first intervention in the series that wins on net fees in
   both windows and reproduces its own ranking between them.** Combined over
   the three books: 145.72 → 245.28 USDG over nine days (+68%) and 95.54 →
   180.58 over four (+89%). The width ordering w10 > w20 > w40 > w80 >
   baseline is identical in both windows, which the forecast-timescale sweep's
   arms never managed.
2. **And it is the first one that also improves alpha in both windows** — but
   at a different width. `residual_w20` takes combined alpha from 49.18 to
   62.85 (nine days) and 59.56 to 90.48 (four days), while giving up 9% and
   1% of the best net-fee arm's income. `residual_w10` earns the most and has
   the worst alpha of any residual arm, below baseline over nine days.
3. **The width ranker specified in the handoff is degenerate.**
   `residual_adaptive` is byte-identical to `residual_w10` on every book in
   both windows: forecast fee density scales as 1/width and the traverse
   charge (0.147 USDG times the probability of crossing) never grows enough to
   pay for a wider band. Ranking residual widths on forecast fees does not
   express the thing that actually separates them.
4. Time earning roughly doubles — 10,100 → 18,555 minutes over nine days at
   `residual_w20`, 3,991 → 12,032 over four — and stranded minutes fall 40%
   and 47%. The narrow arms recover the most stranded time; `residual_w80`
   makes it worse, because a band it fails to traverse leaves the book
   stranded on the far side instead.
5. **The mechanism is a covered call, and the numbers say so.** A one-sided
   band placed below a stranded RWA position sells that inventory back into
   the first bounce and keeps none of the rest of the recovery. That is why
   net fees and alpha separate by width: a 10-tick band liquidates the whole
   position over a 0.1% move, an 80-tick band over 0.8%. NVDA fell 6% over the
   nine days and is the book where this costs the most (alpha −14.12 → −46.27
   at w10, −31.42 at w20).
6. The result is not sensitive to the residual action's cost. Pricing it at
   the live campaign's post-allowance ratio instead of the config's own
   decomposition raises the action cost 19% and costs 2.4% of net fees.
7. The `baseline` arm reproduces the published `live_60m` figures to the
   microUSDG in **both** windows — 145.72/49.18 and 95.54/59.56 — which is the
   check that the wrapper does not perturb the base logic.
8. **The rule is ported** into `src/research/adaptive-lp.ts` behind
   `residualRange: boolean` (default false), with `residualWidthsTicks` so the
   band ladder can be pinned rather than left to the degenerate ranker. The
   ported policy reproduces this harness **exactly** — identical net fees,
   alpha, NAV, fee tokens, gas, recenters and residual counts on all three
   books for both `w20` and `adaptive` (§7).

Everything here is offline paper modelling against a frozen historical book.
Nothing was broadcast, no unit was started, and nothing here is evidence that
any variant is live-executable or profitable.

## 1. What the rule does

When the price leaves the band and the deployed gate declines to recenter, the
position is by construction entirely one token. Rather than exiting it (a
one-way door, per the exit-rule note) or swapping it at the band edge (which
realises the adverse move), mint a band adjacent to the current tick on the
side that keeps it one-sided in the token already held:

```
holding token1 (tick >= tickUpper):  [near - w, near]      near = floor(tick/s)*s
holding token0 (tick <  tickLower):  [near, near + w]      near = floor(tick/s)*s + s
```

No swap, no pool fee, no router approval — withdraw + collect + mint only. The
band is the closest swap-free placement the grid permits, so it is out of
range at placement by less than one tick spacing and earns as soon as the
price comes back by one spacing. The token held, not the token ordering,
decides the side; `quoteIsToken0` only decides whether that side is called
risky or quote, so the rule covers both crossings.

### Cost

The frozen fork-derived bundle already contains both legs of the action:

```
withdraw = recenter - entry     (entry is swap + mint)
mint     = recenter - exit      (exit is withdraw + swap)
residual = withdraw + mint = 2*recenter - entry - exit
```

NVDA 147,146 raw USDG (0.147), AAPL 153,749, GOOGL 147,159 — against a
recenter's 0.2205. The `residual_adaptive_livecost` arm prices it instead at
the live campaign's post-allowance ratio (mint 0.071 + withdraw 0.034 over
gas-only recenter 0.133 = 78.9% of the recenter), which is 0.174 for NVDA, 19%
more expensive. §4 reports both.

### Gate

The handoff's light gate, as specified: accept when forecast fees over the
horizon exceed the residual cost plus the 50% buffer, with no keep-vs-move
terminal comparison, because the inventory is identical either way. The keep
leg is the same forecast applied to the existing out-of-range position, which
is what stops the rule re-placing a band it already holds:

```
benefit = fees(best candidate) - traverseCharge - fees(keep existing position)
accept if benefit > residualCost * 1.5
```

Acceptance rates run from 0.02% to 1.97% of scored observations across the 24
book-arm-window cells, against the recenter gate's 0.17%. The narrow arms are
an order of magnitude more permissive, which is what a cheap action and a light
gate are supposed to buy; the ±80 arm is stricter than the recenter gate,
because a band that wide rarely forecasts enough fees to repay even 0.147.

### A forecast the deployed code cannot supply

`rangeOccupancy` is expected in-band time **until first exit**, and it returns
exactly zero for a position that starts outside its band. A residual range
always starts outside its band. So `forecastPortfolio` scores every candidate
at zero and the rule can never fire.

The right quantity is unstopped occupancy: the expected fraction of the
horizon a driftless walk started at the edge spends inside the band, without
stopping at first exit, because the residual position keeps earning every time
the price comes back. `bandOccupancy` — in the harness first, now in
`src/research/adaptive-forecast.ts` — computes

```
(1/T) ∫₀ᵀ [ Φ((b-x)/(σ√t)) - Φ((a-x)/(σ√t)) ] dt
```

with the same `t = T·u²`, Simpson-on-`u∈[0,1]` scheme `rangeOccupancy` uses,
so the two are directly comparable. The traverse charge is the residual cost
times the probability the walk ends the horizon past the band's far edge — the
state in which the position is fully converted and one-sided again.

## 2. Harness

`scripts/adaptive-residual-range-sim.mjs` subclasses the deployed
`AdaptiveLpReplay` and wraps `step()`. The base class gets first refusal on
every observation: a recenter its gate accepts still happens, and the residual
fires only where the deployed strategy would have sat stranded, only on the
base class's own 30-second decision cadence, and never while a quote is
pending. The residual mint is applied immediately rather than through a frozen
quote and later-block fill, because it has no swap to go stale — the
limitation is recorded in §6.

The residual mint never goes through the entry path, so the exit rule's
failure mode cannot recur: no `pending` record of kind `entry` is created and
`frozen_mint_minimum` does not appear in any arm's rejection counts.

Two windows, as the forecast note requires: 2026-09-08 02:00Z → 2026-09-17
14:05Z (NVDA nine days, AAPL and GOOGL four) and the fully warmed 2026-09-13
15:00Z → 2026-09-17 14:05Z. Warmup 75 minutes, the longest lookback any arm
uses. Chain-health gates are not applied.

## 3. Results

Combined over the books present, USDG. Net fees are `fees − gas`, the
published definition; the swap-inclusive column is in the per-book tables.

| Arm | 9-day net fees | 9-day alpha | 9-day directional | 9-day exposure | 4-day net fees | 4-day alpha | 4-day directional | 4-day exposure |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `baseline` | 145.72 | 49.18 | −45.16 | 35.6% | 95.54 | 59.56 | −2.27 | 31.6% |
| `residual_w10` | **245.28** | 30.49 | −94.42 | 52.1% | **180.58** | 57.49 | −29.06 | 40.2% |
| `residual_w20` | 223.78 | **62.85** | −61.30 | 52.1% | 178.49 | **90.48** | −9.56 | 42.2% |
| `residual_w40` | 211.15 | 48.81 | −76.68 | 47.7% | 165.48 | 79.73 | −19.28 | 38.3% |
| `residual_w80` | 184.66 | 55.30 | −65.04 | 48.5% | 142.44 | 84.16 | −7.92 | 37.8% |
| `residual_adaptive` | 245.28 | 30.49 | −94.42 | 52.1% | 180.58 | 57.49 | −29.06 | 40.2% |

Actions and time:

| Arm | 9d recenters | 9d residuals | 9d earning (min) | 9d stranded (min) | 4d recenters | 4d residuals | 4d earning | 4d stranded |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `baseline` | 32 | 0 | 10,100 | 5,363 | 23 | 0 | 3,991 | 3,642 |
| `residual_w10` | 61 | 153 | 17,500 | 3,308 | 45 | 126 | 11,553 | 1,553 |
| `residual_w20` | 46 | 79 | **18,555** | **3,235** | 32 | 79 | **12,032** | 1,928 |
| `residual_w40` | 41 | 47 | 13,813 | 5,541 | 29 | 41 | 8,478 | 3,067 |
| `residual_w80` | 32 | 10 | 11,915 | 6,939 | 21 | 10 | 7,774 | 3,097 |

Fraction of the baseline's stranded minutes recovered: nine days, NVDA 49%
(w10) and 64% (w20); AAPL 30% and 15%; GOOGL is never stranded under the
baseline so there is nothing to recover. Four days: NVDA 79%/77%, AAPL
19%/−1%, GOOGL 33%/1%. `residual_w40` and `residual_w80` go *negative* on
several books — a band wide enough not to be traversed leaves the position
stranded on the far side for longer than doing nothing did.

### Per book, nine days

| Book | Arm | Net fees | net of swap | Alpha | Directional | Recenters | Residuals | Earning (min) | Gate accepted/scored |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| NVDA | `baseline` | 71.11 | 67.28 | −14.12 | −63.53 | 15 | 0 | 5,455 | 0/0 |
| NVDA | `residual_w10` | 109.31 | 103.11 | −46.27 | −99.65 | 27 | 112 | 7,687 | 112/9,113 |
| NVDA | `residual_w20` | 93.60 | 88.89 | −31.42 | −81.17 | 19 | 58 | 9,322 | 58/6,514 |
| NVDA | `residual_w40` | 78.31 | 74.70 | −36.52 | −83.96 | 14 | 26 | 7,323 | 26/9,289 |
| NVDA | `residual_w80` | 76.42 | 73.14 | −22.57 | −76.40 | 13 | 4 | 5,864 | 4/10,743 |
| AAPL | `baseline` | 66.82 | 62.68 | 51.53 | 11.87 | 17 | 0 | 1,761 | 0/0 |
| AAPL | `residual_w10` | 92.93 | 88.45 | 55.11 | 6.66 | 18 | 23 | 4,370 | 23/3,076 |
| AAPL | `residual_w20` | 86.80 | 82.67 | 59.71 | 9.42 | 18 | 11 | 3,749 | 11/4,234 |
| AAPL | `residual_w40` | 73.69 | 70.03 | 50.89 | 8.99 | 15 | 8 | 3,334 | 8/5,006 |
| AAPL | `residual_w80` | 67.55 | 64.24 | 47.45 | 8.22 | 13 | 3 | 3,170 | 3/5,310 |
| GOOGL | `baseline` | 7.79 | 7.53 | 11.78 | 6.51 | 0 | 0 | 2,884 | 0/0 |
| GOOGL | `residual_w10` | 43.04 | 39.12 | 21.65 | −1.43 | 16 | 18 | 5,443 | 18/1,070 |
| GOOGL | `residual_w20` | 43.38 | 40.98 | 34.56 | 10.45 | 9 | 10 | 5,484 | 10/1,028 |
| GOOGL | `residual_w40` | **59.15** | 56.31 | 34.44 | −1.71 | 12 | 13 | 3,156 | 13/5,250 |
| GOOGL | `residual_w80` | 40.69 | 39.17 | 30.41 | 3.14 | 6 | 3 | 2,881 | 3/5,762 |

GOOGL is the clearest case: the deployed policy never recentred once in nine
days, sat in a ±160 band and earned 7.79. Every residual arm earns five to
eight times that and improves alpha by 19 to 23 USDG. Its baseline is the
`volFlat_feeFlat` pathology from the forecast note in miniature — a book that
does nothing, whose result is the price path.

### Cost sensitivity

Four-day window, combined net fees: `residual_adaptive` 180.58 against
`residual_adaptive_livecost` 176.20. A 19% more expensive action costs 2.4% of
income and changes no ranking. The gate is not operating near the cost
threshold; it is operating where forecast fees are several times it.

## 4. What did not work

- **The width ranker.** `residual_adaptive` never once chose anything but the
  narrowest candidate: it is identical to `residual_w10` on all three books in
  both windows, action for action. Forecast fee density scales as 1/width and
  the traverse charge is 0.147 USDG times a probability, against forecast fees
  of several tenths of a USDG over the horizon. The charge cannot buy a wider
  band. Ranking residual widths on forecast fees net of that charge therefore
  amounts to "always pick the narrowest", and the thing that actually
  separates the widths — how much of a reversion the band gives away — is not
  in the objective at all.
- **Net fees and alpha disagree about the width**, and the disagreement is
  systematic rather than noise: w10 earns most and has the worst alpha of the
  residual arms in both windows; w20 has the best alpha in both. The
  evaluation rule says rank on net fees, which selects w10; the metric the
  rule distrusts says w20. The reproducible part of that is the *ordering*,
  which holds in both windows for both metrics.
- **Wide residual bands make stranding worse.** `residual_w80` recovers −20%
  of NVDA's stranded minutes over nine days and −2% of AAPL's: the band is too
  wide to be traversed, so the position sits outside it instead of outside the
  old one. Only the two narrowest arms recover stranded time consistently.
- **Exposure rises a lot.** From 35.6% to 52.1% over nine days. The rule works
  by keeping inventory deployed, so this is the mechanism and not a side
  effect, but it is a 46% increase in the term that dominates P&L, and on the
  one book that fell it produced the worst directional number in the study
  (−99.65 against the baseline's −63.53).
- **The narrow arms recentre twice as often** (61 against 32 over nine days).
  A residual band adjacent to the price is frequently back in range, and the
  ordinary gate then has a live position to work with, so the rule
  indirectly increases recentering. Some of the extra income is that, not the
  residual placements themselves.

## 5. Reading this against the standing findings

The residence-cap sweep concluded the dominant loss is inventory stranded
after a crossing, and that the next lever is inventory handling rather than
the recenter gate. That is confirmed: the lever moves both metrics by more
than any width, horizon or timescale sweep did, on a sample where those
sweeps all returned differences inside the noise.

The forecast note's warning that fee capture and inventory damage are coupled
through the act of acting also survives, in a new form. Here there is no swap
at the band edge at all, and the coupling still appears — as a covered call
rather than a realised loss. Selling the recovery through a band is a
different mechanism from selling it at a market price, and it is cheaper, but
it is not free and the width controls the price.

One thing has changed: the ranking now reproduces on **both** metrics. Across
the five distinct arms, Spearman rank correlation between the two windows is
**+1.00 on net fees** and **+0.90 on alpha** — against the forecast grid's
+0.92 and +0.51. The single alpha transposition is baseline against
`residual_w40`, adjacent and separated by 0.4 USDG over nine days. The effect
is several times the one-day directional swing rather than comparable to it,
which is why even alpha holds its order here.

## 6. Limitations

- One price path, and a short one: NVDA nine days, AAPL and GOOGL four. NVDA
  fell 6% over it, which is the single fact most of the alpha spread turns on.
  A sample containing one sustained recovery would likely reverse the width
  ordering on alpha, and there is no such episode here.
- The residual mint is applied at the decision observation rather than through
  a frozen quote and a later-block fill. It has no swap, so there is no quote
  to expire, but a live implementation still needs the two-phase treatment and
  would lose some placements to it.
- `bandOccupancy` is a driftless diffusion in tick space, like everything else
  in this forecast. A one-sided band's payoff is explicitly directional, so
  the estimator is being used for the one case where a zero-drift assumption is
  least comfortable.
- Chain-health gates are not applied, so the simulation decides at timestamps
  the live runner would skip.
- The traverse charge uses the probability of ending the horizon past the far
  edge, not of touching it. Touching is the event that matters for a fee model
  and the two differ by roughly a factor of two for a band at the edge; the
  charge is small enough either way that no arm's ranking depends on it.
- Fee capture is validated only to 0.103% of pool liquidity (see the
  calibration note). These arms carry up to 52% exposure at 1,000 USDG, which
  is a capacity question, not a fee-model one.
- The arms differ in trajectory after their first divergence, so per-book
  comparisons are of whole paths, not of matched decisions.

## 7. The port, and the one thing it deliberately adds

The handoff conditions the port on winning net fees in both windows. It does,
so it is ported:

- `AdaptivePolicy.residualRange?: boolean`, default undefined, so the deployed
  policy is bit-for-bit unchanged.
- `AdaptivePolicy.residualWidthsTicks?: readonly number[]`, defaulting to
  `halfWidthsTicks`. **This is the addition the handoff did not ask for and the
  reason the port is safe.** Shipping the rule with the §4 ranker would freeze
  "always place the narrowest band" into the strategy — the arm with the worst
  alpha in both windows. Pinning the ladder lets the restart run `w20` instead.
- `ResearchLpCosts.residual?: bigint`, derived as `2*recenter − entry − exit`
  when absent, so no existing cost bundle has to change.
- `bandOccupancy`, `bandTraverseProbability` and `forecastCenterTick` move into
  `src/research/adaptive-forecast.ts` next to `rangeOccupancy`.
- The hook sits immediately after the recenter gate's try/catch in `step()`,
  so the gate always gets first refusal and the residual only fires on a
  position it declined to move.

**Equivalence check.** `scripts/adaptive-residual-range-sim.mjs` grows a
`sourcePolicy` arm flag that drives the ported `residualRange` instead of the
research wrapper. Over 2026-09-16 00:00Z → 2026-09-17 14:05Z on all three
books, `src_w20` against `wrapper_w20` and `src_adaptive` against
`wrapper_adaptive` agree on marked NAV, terminal cash, alpha, gas, both fee
tokens, fee value, entries, recenters and residual counts — identical in the
raw integer, not rounded. Evidence: `port-check.json`, `port-arms.json`.

Tests in `test/adaptive-lp.test.ts`: the flag is off by default and changes
nothing; a declined recenter is followed by a one-sided band adjacent to the
tick with no swap and the derived cost; the same placement is refused when its
forecast fees do not repay it; the mirrored token0 band starts strictly above
the tick; the cost is taken from the bundle when supplied and a span that does
not fit the grid is rejected; unstopped occupancy is positive at an edge where
stopped occupancy is exactly zero.

What the port does **not** fix is §4: the default ranker is still degenerate.
A width rule that expresses the covered-call trade-off — scoring candidates on
the terminal inventory value `forecastPortfolio` already computes, rather than
on fees alone — is the first item of the next workstream.

## 8. Reproduction

```bash
R=/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf
E=notes/adaptive-residual-range-2026-09-18

SIM_START=2026-09-08T02:00:00Z SIM_END=2026-09-17T14:05:00Z $R/bin/node \
  scripts/adaptive-residual-range-sim.mjs $E/residual-full.json --arms $E/arms-full.json
SIM_START=2026-09-13T15:00:00Z SIM_END=2026-09-17T14:05:00Z $R/bin/node \
  scripts/adaptive-residual-range-sim.mjs $E/residual-warmed.json --arms $E/arms.json

python3 $E/report.py $E/residual-full.json $E/residual-warmed.json

# Ported policy against the research wrapper, decision for decision
npm run build
CONC_LIQ_RELEASE=$PWD SIM_START=2026-09-16T00:00:00Z SIM_END=2026-09-17T14:05:00Z \
  node scripts/adaptive-residual-range-sim.mjs $E/port-check.json --arms $E/port-arms.json
```

`SIM_FEE_PPM` defaults to the calibrated 1,000,000. The harness reads the
local database directly, imports the compiled strategy from the release
directory, and never writes to the database or to any live session state.
