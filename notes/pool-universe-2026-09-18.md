# W3: 3000-tier support and the pool universe

Date documented: 2026-09-18
Deployed release: `ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf`
Evidence directory: `notes/pool-universe-2026-09-18/`
Scripts: `scripts/pool-universe-screen.mjs`, `notes/pool-universe-2026-09-18/report.py`,
`scripts/adaptive-residual-range-sim.mjs` (with `SIM_CONFIG`)
Configs: `config/adaptive-3000-tier-probe.json`, `config/adaptive-3000-tier-price-ladder.json`
Changed: `src/research/adaptive-lp.ts`, `src/experiment/market.ts`, `src/paper/store.ts`,
`src/adaptive-paper.ts` (fee/spacing schema, per-asset budget and band ladders)
Prerequisites: [fee-calibration-2026-09-18.md](fee-calibration-2026-09-18.md),
[adaptive-residual-range-2026-09-18.md](adaptive-residual-range-2026-09-18.md)

## Summary

1. **The 3000-tier blocker was not the assertion.** Removing
   `market.fee===500 && market.tickSpacing===10` is necessary but nowhere near
   sufficient: `ExperimentMarket.source()` hardcoded `fee:500, spacing:10`, and
   `reconstructSwap` reproduces a recorded Swap event *only* with the pool's
   real fee and spacing — it throws otherwise. The checkpoint query hardcoded
   `t.fee=500` and `p.fee=500` in two places, so a 3000-tier book could not
   even be read. All three are fixed; MSFT-3000 and GLD-3000 now replay.
2. **MSFT-3000 and GLD-3000 both out-earn two of the three papered books at
   the same capital.** Over the warmed four-day window at 1,000 USDG:
   MSFT-3000 18.69 net fees / +11.36 alpha and GLD-3000 17.20 / +5.06, against
   NVDA-500's 13.85 / −0.03 and GOOGL-500's 13.30 / +7.12. Only AAPL-500
   (68.40) beats them, and AAPL-500 is the book with no capacity headroom.
3. **The 3000 tier cannot express the width the ranker actually wants.** On
   the fee-500 books the occupancy ranker chose ±10 ticks in 190 of 585 NVDA
   decisions, 362 of 552 on AAPL and 310 of 569 on GOOGL. The narrowest band
   a 60-tick grid permits is ±60 — six times wider, and fee density scales as
   1/width. Both 3000-tier books chose ±60 at **every** placement.
4. **Which makes the candidate ladder moot, and that is the useful finding.**
   The tick-scaled ladder (60/120/240/480/960, i.e. ±0.6% to ±9.6%) and a
   price-comparable ladder (60/120/180/240/360, ±0.6% to ±3.6%) produce
   byte-identical results on both books: the wide candidates are never used.
   Scaling the fee-500 ladder 6× is harmless here only because it is never
   exercised; it would put the widest candidate at ±9.6% and the ranker did
   reach for it once in a high-volatility smoke run.
5. **Capacity, and the 5% cap.** Share scales as 1/width, so it must be quoted
   with one. At the narrowest candidate each pool permits, at 1,000 USDG:
   NVDA-500 0.49%, GLD-3000 0.19%, MSFT-3000 0.91%, GOOGL-500 1.30%, QQQ-500
   2.32%, GLD-500 3.23%, SPY-500 3.59%, **AAPL-500 4.03%**. At 5,000 USDG
   AAPL-500 is 17.34% and GOOGL-500 6.20%; both breach the cap. NVDA-500
   (2.39%) and MSFT-3000 (4.37%) do not.
6. The W1 residual rule carries over to the 3000 tier: MSFT-3000 18.69 →
   27.55 net fees and +11.36 → +17.91 alpha on three residual placements.
   GLD-3000 is never stranded in this window and is unchanged, which is the
   control.

Everything here is offline. Nothing was broadcast and no unit was started.
The 3000-tier replays run the working tree's build, not the deployed release,
because the deployed release cannot replay them (§1).

## 1. What actually blocked the 3000 tier

| Site | Was | Now |
|---|---|---|
| `src/research/adaptive-lp.ts:42` | `assert(market.fee===500 && market.tickSpacing===10)` | fee and spacing asserted to be positive integers in the V3 domain; `halfWidthsTicks` must fit the market's own grid |
| `src/experiment/market.ts:29` | `source()` returned `fee:500, spacing:10` | returns the seed's own `fee`/`spacing`, defaulting to 500/10 so seeds written before this change are unaffected |
| `src/paper/store.ts` | `sourceSql` hardcoded `t.fee=500` and `p.fee=500` | `sourceSqlForFee(fee)` interpolates a validated tier; `sourceSql` is `sourceSqlForFee(500)` |
| `src/adaptive-paper.ts` | `fee: z.literal(500), tickSpacing: z.literal(10)`, `assets` exactly 3 | `z.union([500,3000])` / `z.union([10,60])` with the pairing enforced, 1–8 assets, and the per-pool query uses `sourceSqlForFee(market.fee)` |

The second of those is the one that matters and is the one the handoff's grep
would not have found. `reconstructSwap` walks the tick bitmap in units of
`source.spacing` and charges `source.fee` per step, then requires the
reconstruction to match the recorded ending price, tick, liquidity and *both*
token cashflows exactly. Fed a 3000-tier swap with `fee:500, spacing:10` it
does not produce a near-miss; it throws `Observed swap cannot be reconstructed
exactly` and invalidates the book. `marketRange` was already generic.

`ExperimentMarket` carries `fee`/`spacing` as optional seed fields so that
every existing serialized seed — including live paper session state — keeps
working and keeps meaning fee 500, spacing 10.

Tests: `test/adaptive-lp.test.ts` runs the whole entry path on a 3000/60
market, checks the chosen band is centred on the 60-tick grid, rejects a
half-width that does not fit the grid, rejects fee tiers outside the V3
domain, and round-trips `fee`/`spacing` through `ExperimentMarket.seed()`
including the legacy default.

## 2. The universe table

`scripts/pool-universe-screen.mjs` over all 15 pools in
`config/indexer-pools.json`, 2026-09-13 15:00Z → 2026-09-18 13:00Z (4.92 days,
blocks 62,046,775 → 66,244,585). Gross fees are taken from the recorded Swap
amounts — the pool charges `fee` pips of the input token — and both legs are
valued in USDG at that pool's own time-weighted mean price. Active liquidity
is time-weighted from the strategy checkpoints, which is the same book the
paper runner decides on.

Ranked on fee income per unit of pool liquidity per day, which is what a
marginal unit of our capital earns:

| Pool | gross USDG | USDG/day | swaps | mean L /1e18 | fee/L/day | share @1k | @2.5k | @5k | half-widths |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| AAPL-10000 | 7.9 | 1.6 | 23 | 0.001 | 3138.5 | 84.30% | 93.07% | 96.41% | 200 |
| **MSFT-3000** | 9,685.7 | 1,969.5 | 23,020 | 0.819 | **2405.2** | 0.91% | 2.23% | 4.37% | 60 |
| GLD-500 | 9,598.6 | 1,951.8 | 19,802 | 1.495 | 1305.5 | 3.23 / 0.83% | 7.71 / 2.05% | 14.32 / 4.01% | 10 / 40 |
| AAPL-500 | 7,454.6 | 1,515.8 | 33,041 | 1.298 | 1167.6 | **4.03** / 1.04% | 9.49 / 2.56% | 17.34 / 4.99% | 10 / 40 |
| GOOGL-3000 | 52.8 | 10.7 | 545 | 0.010 | 1046.4 | 46.35% | 68.35% | 81.20% | 60 |
| **GLD-3000** | 21,972.5 | 4,467.8 | 18,387 | 4.472 | 999.1 | 0.19% | 0.46% | 0.92% | 60 |
| NVDA-3000 | 321.2 | 65.3 | 1,105 | 0.067 | 969.1 | 14.31% | 29.46% | 45.51% | 60 |
| GOOGL-500 | 17,797.1 | 3,618.8 | 76,630 | 4.016 | 901.0 | 1.30 / 0.33% | 3.20 / 0.82% | 6.20 / 1.63% | 10 / 40 |
| AAPL-3000 | 553.5 | 112.6 | 1,079 | 0.127 | 889.6 | 6.71% | 15.24% | 26.44% | 60 |
| GLD-10000 | 42.4 | 8.6 | 88 | 0.010 | 878.3 | 20.41% | 39.07% | 56.19% | 200 |
| NVDA-500 | 51,095.0 | 10,389.5 | 236,092 | 13.762 | 755.0 | 0.49 / 0.12% | 1.21 / 0.31% | 2.39 / 0.61% | 10 / 40 |
| QQQ-3000 | 114.6 | 23.3 | 568 | 0.032 | 720.6 | 16.14% | 32.48% | 49.03% | 60 |
| SPY-3000 | 83.8 | 17.0 | 317 | 0.024 | 716.5 | 20.28% | 38.87% | 55.98% | 60 |
| QQQ-500 | 5,297.0 | 1,077.1 | 48,056 | 1.571 | 685.5 | 2.32 / 0.59% | 5.60 / 1.46% | 10.61 / 2.88% | 10 / 40 |
| SPY-500 | 2,396.6 | 487.3 | 12,597 | 0.973 | 501.0 | 3.59 / 0.92% | 8.52 / 2.28% | 15.70 / 4.45% | 10 / 40 |

Shares are quoted at two half-widths where the grid permits two: the pool's
narrowest candidate and a band near ±0.40% in price. The two collapse to one
column on the 60- and 200-tick grids, whose narrowest band already exceeds
±0.40%. **AAPL-10000 is noise** — 23 swaps and 0.001e18 of liquidity over five
days — and heads the ranking only because its denominator is nearly zero. So
are GOOGL-3000, SPY-3000, QQQ-3000 and GLD-10000 at 88–568 swaps. Read the
ranking as: MSFT-3000 first, then GLD-500 and AAPL-500, with GLD-3000 and
GOOGL-500 close behind, which is consistent with the forecast note's
observation that MSFT-3000 leads on fee per liquidity.

### Session split

Gross USDG fees by UTC session, with per-hour rates so the 1.5-hour open is
comparable to the 12-hour overnight block:

| Pool | open (13:30–15:00) | overnight (20:00–08:00) | other | weekend | open/hour | night/hour |
|---|---:|---:|---:|---:|---:|---:|
| NVDA-500 | 9,978 | 13,069 | 25,113 | 2,933 | **32,469** | 5,316 |
| GOOGL-500 | 4,221 | 4,529 | 8,601 | 445 | 13,734 | 1,842 |
| MSFT-3000 | 4,064 | 1,415 | 3,756 | 451 | 13,221 | 575 |
| AAPL-500 | 1,376 | 2,207 | 3,542 | 330 | 4,477 | 898 |
| GLD-3000 | 577 | 7,624 | 12,765 | 1,007 | 1,876 | 3,101 |
| GLD-500 | 825 | 3,451 | 4,942 | 379 | 2,684 | 1,404 |
| QQQ-500 | 537 | 1,351 | 2,665 | 744 | 1,747 | 549 |
| SPY-500 | 246 | 877 | 1,195 | 78 | 800 | 357 |

Per hour, the open is four to twenty-three times richer than overnight on
every equity book. The residence-cap sweep's volume/sigma² ratio was highest
overnight, and both are true: the open carries far more fee flow per hour and
far more variance per unit of it. GLD is the exception in both directions —
its 3000 pool earns more per hour overnight than at the open, which is what a
metals book on a 24-hour market should look like.

## 3. The two 3000-tier books under the W1+W2 winner

`scripts/adaptive-residual-range-sim.mjs` with `SIM_CONFIG` pointed at the
3000-tier probe, 1,000 USDG per book, warmed window 2026-09-13 15:00Z →
2026-09-17 14:05Z, `feePpm` 1,000,000. Run against the working tree's build
(`CONC_LIQ_RELEASE=/root/conc-liq`), because the deployed release cannot
replay a 3000-tier swap.

| Book | Arm | Net fees | Alpha | Recenters | Residuals | Earning (min) | Stranded (min) | Exposure | max share |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| MSFT-3000 | `baseline` | 18.69 | +11.36 | 1 | 0 | 3,042 | 1,446 | 53.5% | 1.11% |
| MSFT-3000 | `residual_adaptive` | **27.55** | **+17.91** | 0 | 3 | 1,970 | 2,537 | 61.4% | 2.21% |
| GLD-3000 | `baseline` | 17.20 | +5.06 | 1 | 0 | 3,995 | 347 | 29.5% | 0.30% |
| GLD-3000 | `residual_adaptive` | 17.20 | +5.06 | 1 | 0 | 3,995 | 347 | 29.5% | 0.30% |

Against the fee-500 books over exactly the same window and capital
(from the residual-range note): NVDA-500 13.85 / −0.03, AAPL-500 68.40 /
+52.47, GOOGL-500 13.30 / +7.12.

Every two-sided placement on both 3000-tier books chose ±60 — the narrowest
the grid allows. GLD-3000 entered once, sat in range 3,995 of the window's
5,705 minutes and never gave the gate or the residual rule anything to do; its
two arms are identical by construction. MSFT-3000 was stranded 1,446 minutes
under the baseline, and the residual rule converted that into 8.86 USDG of
extra net fees and 6.55 of alpha with three placements — the same direction as
the fee-500 result, on a book the study had never been able to run.

MSFT's exposure of 53–61% at 1,000 USDG is high: a ±60 band is ±0.6% in price
and it was crossed often enough to leave the baseline stranded for a quarter
of the window, and the residual rule keeps that inventory deployed by design.

## 4. What did not work

- **The candidate ladder question could not be answered on this sample.** Both
  ladders are identical because neither book ever used a candidate above ±120.
  The tick-scaled ladder's ±9.6% top candidate is not obviously safe — a
  1.5-day smoke over 2026-09-16 to 09-17 did pick it on MSFT, minting
  213,240–215,160 and taking 0.097% of pool liquidity, earning 0.80 USDG in
  38 hours. Recommending 60/120/180/240/360 on price grounds is a judgement
  call here, not a measured result.
- **The 3000 tier costs the strategy its preferred width.** This is structural
  and no configuration fixes it: the ranker picks the narrowest candidate most
  of the time on the fee-500 books, and the narrowest a 60-tick grid offers is
  six times wider. The 6× fee per swap and the 1/6 fee density cancel, as the
  forecast note said; what does not cancel is that a 6× wider band is crossed
  far less often, so the 3000-tier books sit in range and earn a lower density
  continuously rather than a higher one intermittently. On this sample that is
  a win for MSFT-3000 against NVDA-500. On a sample containing a quiet week it
  may not be.
- **The costs for both 3000-tier books are assumptions.** No fork cost probe
  exists for either pool, so NVDA-500's frozen bundle is reused unchanged.
  Mint, withdraw and swap gas are dominated by the position-manager and router
  call shapes rather than by the fee tier, but crossing more initialized ticks
  costs more gas and a 60-tick grid has fewer of them. The direction of that
  error favours the 3000 tier, which is the wrong direction for a
  recommendation. A fork probe is a prerequisite for sizing either book.
- **Neither 3000-tier book has a second window.** Their checkpoints begin
  2026-09-13 like AAPL's and GOOGL's, so the nine-day window would run them
  cold. Everything in §3 is one four-day window.

## 5. Recommended allocation

Under a 5% cap on our share of active liquidity, quoted at the narrowest band
each pool's grid permits, which is the share the ranker actually takes:

| Pool | Recommended size | Share at that size | Reason |
|---|---:|---:|---|
| NVDA-500 | 5,000 USDG | 2.39% | the deepest book by far; room to 10,000 before the cap |
| GOOGL-500 | 2,500 USDG | 3.20% | 5,000 would be 6.20%, over the cap |
| MSFT-3000 | 2,500 USDG | 2.23% | best fee per unit liquidity with real flow; 5,000 is 4.37%, inside the cap but without a fork cost probe |
| GLD-3000 | 5,000 USDG | 0.92% | deepest of the 3000-tier books, lots of headroom, and the only book whose flow is not concentrated at the US open |
| AAPL-500 | **not above 1,000 USDG** | 4.03% | at the cap already at 1,000; the handoff's own instruction |

Sizing MSFT-3000 or GLD-3000 at all needs a fork cost probe first (§4).
NVDA-500 at 5,000 USDG also moves the fee model out of the 0.103% share the
calibration note validated, into a regime where the fixed-recorded-flow
assumption is untested; that is a separate risk from the capacity cap and it is
not addressed by it.

## 6. Limitations

- 4.92 days, and the checkpoint history does not reach 30 days for any pool —
  the handoff's requested window does not exist yet. The screen reports what
  is there.
- Gross fees are aggregated in 1,000-block buckets (about 3.4 minutes at the
  observed 4.9 blocks/s) because `v3_pool_events` carries no block timestamp.
  Totals are exact; only the session split carries that quantisation.
- Share is `ours / (ours + mean active liquidity)` at a single placement price
  and a single band, and it is inversely proportional to the band. A pool that
  looks safe at ±40 can be four times over at ±10. Both are reported for
  exactly this reason.
- The screen's share for AAPL-500 at 1,000 USDG is 1.04% (±40) or 4.03% (±10),
  against the 13.09% quoted in the forecast note. The conventions differ — that
  figure predates this screen and its band and liquidity basis are not
  recorded — so the two should not be compared. The ordering is the same.
- Mean active liquidity is time-weighted over the window; it does not capture
  the depth *at our tick*, which is what actually dilutes us. A pool with deep
  liquidity far from the money and none at it would look safer than it is.
- The 3000-tier replays use a strategy build that also contains the W4.1 entry
  fix. Neither book has a gated re-entry in this window, so that fix does not
  touch these numbers, but they are not the deployed release's output.

## 7. Reproduction

```bash
export PATH="$PWD/.tools/node/bin:$PATH"
npm run build

R=/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf
E=notes/pool-universe-2026-09-18

$R/bin/node scripts/pool-universe-screen.mjs $E/universe.json
python3 $E/report.py $E/universe.json

SIM_CONFIG=$PWD/config/adaptive-3000-tier-probe.json CONC_LIQ_RELEASE=$PWD \
  SIM_START=2026-09-13T15:00:00Z SIM_END=2026-09-17T14:05:00Z \
  node scripts/adaptive-residual-range-sim.mjs $E/tier3000-tick-ladder.json --arms $E/arms.json
SIM_CONFIG=$PWD/config/adaptive-3000-tier-price-ladder.json CONC_LIQ_RELEASE=$PWD \
  SIM_START=2026-09-13T15:00:00Z SIM_END=2026-09-17T14:05:00Z \
  node scripts/adaptive-residual-range-sim.mjs $E/tier3000-price-ladder.json --arms $E/arms.json

python3 notes/adaptive-residual-range-2026-09-18/report.py \
  $E/tier3000-tick-ladder.json $E/tier3000-price-ladder.json
```

`SCREEN_SINCE` and `SCREEN_UNTIL` bound the screen's window. Both scripts open
the database read-only and never write to it or to any live session state.
