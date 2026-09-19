# Adaptive-width paper: open-day diagnosis, ranker verification and residence-cap sweep

Date documented: 2026-09-17  
Strategy version: `adaptive_paper_60m_v1` (`config/adaptive-paper-60m.json`)  
Session state: `data/adaptive-paper-60m-2026-09-16/state.json`  
Deployed release: `ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf` (occupancy correction, from 2026-09-17 08:45:48 UTC; previously `f602f6a12a6ce8cf3b56427539a77ac8d90f23d7813f4097811ebcad4b0c1048`)  
Documented source commit: `56e5d04`  
Evidence directory: `notes/adaptive-residence-cap-sweep-2026-09-17/`  
Scripts: `scripts/adaptive-width-replay.mjs`, `scripts/adaptive-residence-cap-sim.mjs`  
Companion policy description: [adaptive-paper-60m-economic-gate-2026-09-17.md](adaptive-paper-60m-economic-gate-2026-09-17.md)

## Summary

1. At the US open on 2026-09-17 the three 1,000 USDG adaptive paper books had
   been out of range 73–94% of their lives. Fees of about 26 USDG over 20
   hours were offset by about 23 USDG of inventory loss in ±10-tick bands.
2. Before the occupancy release every one of the 21 entries and recenters
   chose the narrowest candidate. An offline replay of the deployed release
   reproduces the live economic scores exactly and shows the ranker now
   choosing 40–160 ticks at open volatility. AAPL's first wide recenter
   (80-tick band) filled live at 14:02:09 UTC.
3. The economic gate cannot pass at 1,000 USDG in normal conditions: an
   all-in recenter costs 0.6–0.8 USDG against 10-minute fee forecasts of
   0.05–0.35 USDG. It rejected 2,190 (NVDA), 1,582 (AAPL) and 2,019 (GOOGL)
   attempts by 13:55 UTC.
4. The proposed fix, amortising the recenter cost over expected in-range
   residence with a cap of 60, 120 or 240 minutes, was simulated over
   2026-09-08 to 2026-09-17. The caps are indistinguishable from each other
   and all underperform the fixed ranker at the existing 10-minute horizon.
   Longer horizons choose wider bands, in-range time rises from about 40%
   to 95%, and fee income falls because fee density falls with width.
5. Every variant's P&L is dominated by directional exposure, not by
   recenter costs. NVDA fell 6% over the window and each variant carried
   40–55% average exposure, losing 41–62 USDG to price alone.
6. Recommendation: do not adopt a residence cap. The next lever is inventory
   handling after a band is left, not the recenter gate.

Everything here is offline paper modelling. Nothing was broadcast, and
nothing here is evidence that any variant is live-executable or profitable.

## 1. State at the open, 2026-09-17

Marks from `state.json.*.marks.jsonl`, first mark 2026-09-16 17:48 UTC to
13:55 UTC on 2026-09-17 (about 20 hours):

| Book | NAV at 13:55 | Time in range | Fees earned | Gas + swap | Recenters | Out of range since |
|---|---:|---:|---:|---:|---:|---|
| NVDA | 997.47 | 4% (0.9 h) | 7.30 | 2.91 | 8 | 09-16 19:30 UTC |
| AAPL | 1002.03 | 21% (4.3 h) | 7.77 | 0.00 | 6 | 13:44 UTC, holding 99.6% AAPL |
| GOOGL | 999.93 | 9% (1.8 h) | 11.11 | 1.58 | 4 | 09-16 23:40 UTC |

Combined the books were flat against holding USDG. NVDA recentred eight
times in thirty minutes on 2026-09-16 between 18:53 and 19:23 UTC, chasing
the price down one tick-spacing at a time; NAV fell from 1003.5 to 996.2 in
that window. AAPL did the same on entry: four recenters in fourteen minutes
with forecast fees of 2.7 USDG per ten minutes and realised fees of zero.

The gate only clears when the trailing 60-minute fee rate spikes, which is
exactly when a 20-tick band is crossed immediately. In quiet conditions the
benefit is negative in every hour: the fixed gas (0.22), the swap through
the pool (0.1–0.3), the crossing charge and the 50% buffer sum to 0.6–0.8
USDG against 10-minute fees of 0.05–0.35.

The fee forecast is poorly calibrated in both directions. At the open AAPL
forecast 0.2 USDG per ten minutes and realised 1.7–1.9; the previous
afternoon in-range forecasts of 0.35–0.68 realised zero for thirty minutes.

## 2. Ranker verification against the deployed release

`scripts/adaptive-width-replay.mjs` restores the 08:45 UTC pre-release
snapshot (`state.pre-occupancy-runtime-migration-2026-09-17.json`), advances
the pool book from canonical events, and at every 30-second decision scores
all five half-widths with the compiled code in the release directory. Chain
health gates are not applied, so the replay decides at some timestamps the
live runner skipped.

Output: `width-replay-2026-09-17.json`.

| Book | Decisions | Match live score | Mismatch | No live score |
|---|---:|---:|---:|---:|
| NVDA | 585 | 486 | 0 | 99 |
| AAPL | 552 | 467 | 0 | 85 |
| GOOGL | 569 | 482 | 0 | 87 |

Chosen half-width since 08:45 UTC:

| Book | 10 | 20 | 40 | 80 | 160 |
|---|---:|---:|---:|---:|---:|
| NVDA | 190 | 134 | 9 | 32 | 220 |
| AAPL | 362 | 7 | 44 | 1 | 138 |
| GOOGL | 310 | 25 | 48 | 3 | 183 |

At the open, with ten-minute sigma of 17–24 ticks, the 10-tick occupancy
falls to about 0.2 and the ranker picks 40–160. In quiet hours it flips
between 10 and 160 because the terminal values of all widths sit within a
few cents of each other and swap-cost rounding decides the order.

The only acceptance of the day was AAPL at 14:01:39 UTC with half-width 40
(benefit 0.225 against buffer 0.152). The live run recorded the same
acceptance and filled at 14:02:09 UTC into 218230–218310. In the same
window every NVDA and GOOGL decision was rejected: NVDA sat 220–260 ticks
from its stale range and every width showed a benefit of −0.7 to −1.5 USDG.

## 3. The amortisation hypothesis

The gate compares a one-off recenter cost to ten minutes of fees. The
alternative is to compare it to the fees expected until the new band is
left. For a driftless walk started at the band centre with half-width `w`
ticks and variance `v` ticks² per minute, expected first-exit time is
`w² / v`. The existing forecast already computes `E[min(exit, horizon)]`
through its occupancy integral, so the amortised gate is exactly the
existing gate with `horizonMs` raised to the residence cap. No other code
changes.

### 3.1 Volatility and volume by hour

From checkpoints 2026-09-09 to 2026-09-17 (weekdays), sigma in ticks per
ten minutes moves by a factor of 2–5 within an hour or two at the regime
edges: NVDA 10 at 12:00 UTC, 22 at 13:00, 7 by 16:00, 4 by 20:00. This
motivates a cap of about twice the 60-minute lookback.

The pools do not go quiet after the US close. Share of weekday USDG volume
by UTC block:

| Book | 08–13:30 | 13:30–15 | 15–19 | 19–20 | 20–24 | 00–08 | Daily volume |
|---|---:|---:|---:|---:|---:|---:|---:|
| NVDA | 17% | 24% | 29% | 6% | 9% | 16% | 27.0M |
| AAPL | 15% | 25% | 34% | 5% | 9% | 12% | 4.3M |
| GOOGL | 14% | 15% | 16% | 3% | 12% | 39% | 10.0M |

Volume divided by sigma², a crude fee-to-adverse-selection ratio, is highest
overnight and lowest at the open. Whether the overnight flow is bot volume
was not checked.

### 3.2 Empirical band survival

Hypothetical centred bands were opened every 15 minutes in the tick history
and timed until first exit (24-hour cap, gaps over 15 minutes discarded).
Median survival in minutes:

| Book | Opened | w10 | w20 | w40 | w80 | w160 |
|---|---|---:|---:|---:|---:|---:|
| NVDA | 13:30–15 UTC | 4 | 11 | 36 | 266 | 1440 |
| NVDA | 08–13:30 UTC | 22 | 49 | 97 | 243 | 1440 |
| NVDA | 20–24 UTC | 71 | 220 | 489 | 941 | 1440 |
| AAPL | 13:30–15 UTC | 4 | 13 | 78 | 1374 | 1440 |
| AAPL | 08–13:30 UTC | 36 | 94 | 125 | 275 | 1440 |
| AAPL | 20–24 UTC | 65 | 143 | 616 | 885 | 1440 |
| GOOGL | 13:30–15 UTC | 4 | 12 | 32 | 252 | 1440 |
| GOOGL | 08–13:30 UTC | 32 | 67 | 152 | 438 | 1440 |
| GOOGL | 20–24 UTC | 60 | 119 | 512 | 707 | 1440 |

Bands opened pre-market die far sooner than the same width opened after
hours because the open crosses them. That motivated an extra cut: the
horizon never extends past the next 13:30 UTC weekday open. Means run
1.5–3 times medians, so the distribution is heavy-tailed.

At open-hour sigma the formula gives 21–52 minutes for width 40; measured
medians were 32–78. The formula is the right order of magnitude.

## 4. Residence-cap sweep

`scripts/adaptive-residence-cap-sim.mjs` rebuilds each pool book from Mint,
Burn and SetFeeProtocol events at the first checkpoint, warms the forecast
for 75 minutes exactly as the runner does, then drives the deployed
`AdaptiveLpReplay.step` through every checkpoint with `policy.horizonMs`
replaced by `min(cap, time to next 13:30 UTC weekday open)`. Entries,
recenters, fills, fee accrual and marks all run through the release's
compiled code. Chain health gates are not applied.

Window: 2026-09-08 02:00 UTC to 2026-09-17 14:05 UTC. Checkpoint history
starts 2026-09-08 00:00 UTC with two gaps on 2026-09-10 (17:51–18:14 and
18:57–19:18). AAPL and GOOGL checkpoints only begin 2026-09-13, so those
books cover 4.2 days against NVDA's 9.5. Each book starts at 1,000 USDG.

Variants: the 10-minute horizon as control (this is the deployed ranker, not
the live run, which entered under the previous build), caps of 60, 120 and
240 minutes with the open cut, and 120 minutes without the cut.

Outputs: `cap-10.json`, `cap-60.json`, `cap-120.json`, `cap-240.json`,
`cap-120-nocut.json`; `compare.py` reproduces the tables.

### 4.1 Per book

| Book | Horizon | NAV mark | Fees | Gas | Swap | Recenters | In range | Widths used |
|---|---|---:|---:|---:|---:|---:|---:|---|
| NVDA | 10 min | 985.89 | 74.59 | 3.48 | 3.82 | 15 | 40% | 10×8, 20×5, 40, 80, 160 |
| NVDA | 60 min | 978.60 | 72.74 | 6.57 | 6.68 | 29 | 85% | 10×11, 20×8, 40×7, 80×2, 160×2 |
| NVDA | 120 min | 946.61 | 48.62 | 5.91 | 6.13 | 26 | 95% | 10, 20×10, 40×6, 80×4, 160×6 |
| NVDA | 240 min | 944.90 | 54.22 | 7.67 | 7.46 | 34 | 97% | 10×2, 20×12, 40×14, 80, 160×6 |
| NVDA | 120 min, no cut | 944.34 | 50.46 | 6.79 | 6.92 | 30 | 95% | 10, 20×13, 40×7, 80×4, 160×6 |
| AAPL | 10 min | 1051.55 | 70.83 | 4.01 | 4.14 | 17 | 29% | 10×14, 20, 40×2, 80 |
| AAPL | 60 min | 1019.56 | 24.45 | 0.63 | 0.80 | 2 | 99% | 20, 80, 160 |
| AAPL | 120 min | 1018.79 | 20.97 | 0.40 | 0.52 | 1 | 100% | 20, 160 |
| AAPL | 240 min | 1020.02 | 28.79 | 1.30 | 1.49 | 5 | 99% | 10, 40×3, 80, 160 |
| GOOGL | 10 min | 1011.79 | 7.97 | 0.18 | 0.26 | 0 | 48% | 160 |
| GOOGL | 60 min | 1010.51 | 35.91 | 3.94 | 4.17 | 17 | 89% | 10×7, 20×4, 40×5, 80, 160 |
| GOOGL | 120 min | 1017.27 | 31.21 | 2.83 | 3.19 | 12 | 98% | 10, 20×4, 40×4, 80×2, 160×2 |
| GOOGL | 240 min | 1014.33 | 21.56 | 1.73 | 1.99 | 7 | 99% | 20×2, 40×2, 80×2, 160×2 |

### 4.2 Combined, three books from 3,000 USDG

| Horizon | NAV | Fees | Gas + swap | Gate accepted / scored |
|---|---:|---:|---:|---|
| 10 min | 3049.23 | 153.39 | 15.89 | 40 / 25,875 |
| 60 min | 3008.67 | 133.10 | 22.79 | 56 / 4,780 |
| 120 min | 2982.67 | 100.80 | 18.98 | 44 / 1,458 |
| 240 min | 2979.25 | 104.58 | 21.64 | 53 / 966 |
| 120 min, no cut | 2980.40 | 102.63 | 20.66 | 47 / 1,400 |

### 4.3 Directional versus residual

Directional P&L is approximated from 15-minute marks as the sum of
`exposure × NAV × price return`; the residual is fees minus costs minus
in-band inventory effects.

| Book | Horizon | Total ΔNAV | Directional | Residual | Avg exposure |
|---|---|---:|---:|---:|---:|
| NVDA | 10 min | −14.11 | −57.23 | +43.12 | 47% |
| NVDA | 60 min | −21.40 | −41.07 | +19.67 | 44% |
| NVDA | 120 min | −53.39 | −62.31 | +8.91 | 42% |
| NVDA | 240 min | −55.11 | −57.11 | +2.01 | 54% |
| AAPL | 10 min | +48.36 | +7.49 | +40.87 | 41% |
| AAPL | 60 min | +17.01 | +4.08 | +12.93 | 65% |
| AAPL | 120 min | +16.22 | +3.61 | +12.61 | 41% |
| AAPL | 240 min | +16.10 | +4.07 | +12.03 | 65% |
| GOOGL | 10 min | +11.79 | +10.96 | +0.83 | 19% |
| GOOGL | 60 min | +9.23 | +0.84 | +8.39 | 51% |
| GOOGL | 120 min | +16.24 | +10.62 | +5.62 | 50% |
| GOOGL | 240 min | +12.98 | +9.37 | +3.61 | 57% |

NVDA moved 233 → 219 over the window. Its daily NAV swings of 10–25 USDG
per variant are directional; the recenter cost the gate is built around is
0.5 USDG.

Day-by-day, the 120-minute cap beat the 10-minute control on 1 of 10 NVDA
days, 1 of 5 AAPL days and 3 of 5 GOOGL days. The open cut changed one NVDA
day (2026-09-08) by about +2.4 USDG and nothing else.

## 5. Interpretation

- The residence cap does what it was designed to do mechanically: recenters
  are accepted, in-range time rises to 85–100%, wider bands are chosen.
- It does not improve income. Fee density scales with 1/width, and the
  narrow bands the 10-minute horizon chose during active hours earned more
  than wide bands that stayed in range all day. Out-of-range time was
  roughly free in this sample.
- The caps do not separate from each other. Differences of 3–30 USDG
  combined are within one day's directional swing on one book.
- The open cut is not worth its complexity on this evidence.
- The dominant loss is inventory left after a band is crossed on the
  downside: the book then holds 100% of the asset until something recenters
  it, and at 1,000 USDG the gate rarely does.

## 6. Limitations

- One price path. AAPL and GOOGL have four days of history.
- Chain health gates are not applied, so the simulation decides at
  timestamps the live runner would skip.
- The paper model credits fees at full liquidity share and fills at quoted
  prices. The 250 USDG live pilot earned 7.40 USDG of fees against a
  3.22 USDG swap shortfall, so real capture is lower than modelled.
- The directional split uses 15-minute marks and is approximate.
- The `covered` flag in the checkpoint query flips to false for every row
  when the indexer cursor briefly reads back an old block (observed once in
  four probes). The simulation retries; the live runner filters on the same
  flag and would silently drop those checkpoints.

## 7. Next steps

1. Inventory handling after a band is left: simulate an exit-to-USDG rule
   on the downside crossing (exit cost 0.12) with re-entry through the
   existing gate, using the same harness. This targets the −57 USDG
   directional term directly.
2. Keep the 10-minute horizon and the occupancy ranker. Test fee-density
   timing instead: no entry in the first 30 minutes after the open, where
   volume/sigma² is worst, and narrow bands only when the trailing fee rate
   is above a threshold.
3. Calibrate paper fee capture against the live pilot's realised fees before
   trusting any residual number.
4. Investigate the indexer cursor flake and count how many live decisions it
   cost; it may explain part of the `blocked` tallies.
5. Rerun the sweep as history accumulates; treat any ranking as tentative
   until several weeks and more pools are covered.
6. Leave the three live paper sessions running as the forward control for
   the occupancy release.

## 8. Reproduction

```bash
R=/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf
$R/bin/node scripts/adaptive-width-replay.mjs data/adaptive-paper-60m-2026-09-16/state.pre-occupancy-runtime-migration-2026-09-17.json out.json
SIM_START=2026-09-08T02:00:00Z SIM_END=2026-09-17T14:05:00Z $R/bin/node scripts/adaptive-residence-cap-sim.mjs 120 cap-120.json
SIM_START=2026-09-08T02:00:00Z SIM_END=2026-09-17T14:05:00Z $R/bin/node scripts/adaptive-residence-cap-sim.mjs 10 cap-10.json --no-open-cut
python3 notes/adaptive-residence-cap-sweep-2026-09-17/compare.py
```

Both scripts read the local database directly and import the compiled
strategy from the release directory (`CONC_LIQ_RELEASE` overrides the path).
They never write to the database or the live session state.
