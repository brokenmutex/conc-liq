# Adaptive width: agility comparison, September 14, 2026

Retrospective comparison of eight predeclared variants on AAPL, GOOGL, and NVDA, August 30–September 11 19:30 UTC, with 1,000 USDG per asset and three cost/failure scenarios. Each of the 72 portfolios retains inventory continuously. No deployment setting changed.

At base costs, the 30-minute rolling estimator improved alpha on 3/3 assets and the 60-minute estimator on 3/3. Their combined changes versus the six-hour baseline were 252.51 and 296.34 USDG, respectively. These are historical sample outcomes, not evidence of a universally correct window. Compare the cost stresses and risk table before choosing a candidate for prospective evaluation.

**Next research candidate: 60-minute rolling estimates, retaining the existing economic gate and out-of-range trigger.** It improved eight asset/scenario cells and tied the ninth. The 30-minute variant also improved eight cells, but in stressed NVDA it reduced alpha by 26.27 USDG and turned absolute P&L negative; the 60-minute variant matched the baseline with no recenters in that case. The 60-minute model still increased base-cost drawdown on AAPL and GOOGL, so it is a candidate for a newly frozen prospective comparison, not a production recommendation. Keep six hours as the control and 30 minutes as a challenger. Earlier in-range decisions had no outcome effect on AAPL or NVDA under these thresholds; gains from changing the estimator were more broadly observed.

## What changed

- **30m/60m rolling:** both variance and fee income use the shorter window.
- **15m/30m volatility half-life:** recent squared tick changes receive exponentially more weight; fee income retains the six-hour trailing estimate. These half-lives specify weighting, not a hard cutoff.
- **Fee blend:** the 30m volatility variant additionally blends 50% of a 60m-half-life fee estimate with 50% of the six-hour trailing fee rate.
- **Early decisions:** separately added to the baseline and 30m volatility variant. Evaluate while inside the range after two eligible observations beyond 70% of the distance from center to boundary, with a ten-minute cooldown after a successful move. In-range narrowing also requires ten minutes of persistent proposed width. Wider proposals do not have that extra delay. The original out-of-range rule, economic gate and fill-time gate remain unchanged.

All arms retain the same four candidate half-widths (20/40/80/160 ticks), 30-second minimum decision interval, ten-minute forecast horizon, 90-second quote TTL and 50-bps slippage check. Forecast weights are time-based; missing timestamps are never inserted as quiet observations.

## Base-cost outcomes

Net LP alpha is terminal executable cash minus the common passive stock/cash benchmark, after acquisition, rebalance and liquidation costs. Positive alpha does not imply positive absolute P&L. Amounts below are USDG. The combined column represents three separate 1,000-USDG portfolios.

| Variant | AAPL alpha | GOOGL alpha | NVDA alpha | Combined alpha | Change vs 6h |
| --- | ---: | ---: | ---: | ---: | ---: |
| 6h baseline | 167.37 | 128.94 | 6.82 | 303.13 | 0.00 |
| 30m rolling | 218.70 | 252.94 | 84.01 | 555.64 | 252.51 |
| 60m rolling | 311.21 | 229.63 | 58.63 | 599.47 | 296.34 |
| 15m volatility half-life | 222.01 | 128.10 | 35.06 | 385.17 | 82.04 |
| 30m volatility half-life | 207.06 | 144.24 | 32.53 | 383.84 | 80.71 |
| 30m volatility + fee blend | 256.77 | 150.63 | 14.16 | 421.56 | 118.43 |
| 6h + early decisions | 167.37 | 163.89 | 6.82 | 338.08 | 34.95 |
| 30m volatility + early decisions | 207.06 | 159.28 | 32.53 | 398.88 | 95.75 |

## Cost and failure sensitivity

Changes in combined net alpha relative to the corresponding six-hour baseline in each scenario. Wins count positive changes across the three assets; they are descriptive, not independent statistical trials.

| Variant | Base delta | Double gas / half fees delta | Every fifth recenter mint fails delta | Positive asset/scenario cells |
| --- | ---: | ---: | ---: | ---: |
| 6h baseline | 0.00 | 0.00 | 0.00 | 0/9 |
| 30m rolling | 252.51 | 16.48 | 305.00 | 8/9 |
| 60m rolling | 296.34 | 29.36 | 209.66 | 8/9 |
| 15m volatility half-life | 82.04 | -15.15 | 76.92 | 5/9 |
| 30m volatility half-life | 80.71 | -17.79 | 105.34 | 7/9 |
| 30m volatility + fee blend | 118.43 | -9.62 | 83.04 | 7/9 |
| 6h + early decisions | 34.95 | 0.00 | 118.07 | 2/9 |
| 30m volatility + early decisions | 95.75 | -17.79 | 102.74 | 7/9 |

## Risk and trading activity at base costs

Drawdown is the largest observed decline from marked NAV peak, excluding final liquidation. Outside time is a share of time with an LP position. All transaction amounts are frozen fork-based cost estimates, not historical receipts.

| Asset | Variant | Absolute P&L | Drawdown | Outside time | Recenters (early) | Gas including exit |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| AAPL | 6h baseline | 186.35 | 1.97% | 71.29% | 44 (0) | 10.20 |
| AAPL | 30m rolling | 237.68 | 1.57% | 26.52% | 72 (0) | 16.51 |
| AAPL | 60m rolling | 330.20 | 2.67% | 56.13% | 69 (0) | 15.83 |
| AAPL | 15m volatility half-life | 240.99 | 2.71% | 39.15% | 37 (0) | 8.63 |
| AAPL | 30m volatility half-life | 226.04 | 1.97% | 51.32% | 37 (0) | 8.63 |
| AAPL | 30m volatility + fee blend | 275.75 | 1.97% | 51.67% | 49 (0) | 11.33 |
| AAPL | 6h + early decisions | 186.35 | 1.97% | 71.29% | 44 (0) | 10.20 |
| AAPL | 30m volatility + early decisions | 226.04 | 1.97% | 51.32% | 37 (0) | 8.63 |
| GOOGL | 6h baseline | 117.54 | 1.89% | 11.28% | 5 (0) | 1.40 |
| GOOGL | 30m rolling | 241.54 | 3.16% | 33.87% | 29 (0) | 6.71 |
| GOOGL | 60m rolling | 218.22 | 3.33% | 36.17% | 19 (0) | 4.50 |
| GOOGL | 15m volatility half-life | 116.70 | 2.75% | 60.00% | 18 (0) | 4.28 |
| GOOGL | 30m volatility half-life | 132.84 | 2.44% | 22.73% | 12 (0) | 2.95 |
| GOOGL | 30m volatility + fee blend | 139.23 | 2.56% | 10.69% | 12 (0) | 2.95 |
| GOOGL | 6h + early decisions | 152.49 | 1.98% | 15.91% | 13 (3) | 3.17 |
| GOOGL | 30m volatility + early decisions | 147.88 | 2.75% | 61.24% | 17 (3) | 4.06 |
| NVDA | 6h baseline | 5.66 | 4.79% | 83.43% | 7 (0) | 1.84 |
| NVDA | 30m rolling | 82.85 | 1.91% | 49.20% | 33 (0) | 7.57 |
| NVDA | 60m rolling | 57.47 | 2.56% | 60.36% | 18 (0) | 4.26 |
| NVDA | 15m volatility half-life | 33.90 | 3.04% | 64.98% | 14 (0) | 3.38 |
| NVDA | 30m volatility half-life | 31.37 | 3.02% | 75.91% | 21 (0) | 4.92 |
| NVDA | 30m volatility + fee blend | 13.00 | 3.63% | 63.91% | 12 (0) | 2.94 |
| NVDA | 6h + early decisions | 5.66 | 4.79% | 83.43% | 7 (0) | 1.84 |
| NVDA | 30m volatility + early decisions | 31.37 | 3.02% | 75.91% | 21 (0) | 4.92 |

Peak modeled position liquidity relative to existing active liquidity, across all arms/scenarios: AAPL 55.72%; GOOGL 85.64%; NVDA 0.97%. The model adjusts fee dilution, but holds the historical market path and other participants’ behavior fixed. These shares limit how directly modeled earnings can be transferred to deployment.

## Availability and interpretation

The main ablation requires the **intersection of all variants’ available forecasts at every observation**. This gives all arms the same data admission, first benchmark acquisition and starting budget, isolating estimate and trigger effects. The experiment therefore does not measure faster cold starts or recovery from missing data. The shorter estimators themselves permit 20/40 minutes and 20/40 observations, respectively; their independent availability counts are in summary.json.

The six-hour baseline is the original frozen implementation. The new early-decision subclass delegates all out-of-range decisions, fills, partial failures and balance accounting to it. The earlier historical reports have different portfolio start boundaries; their monetary results are not reused as controls here.

The three-scenario zero-drift forecast remains a hypothesis. A faster volatility response does not validate its fee predictions, terminal NAV forecast, or economic gate. This study does not reconstruct historical independent-reference eligibility, issuer state, actual execution receipts, staged transaction delays, future competing liquidity or flow response to our position. Capacity dilution and hypothetical swap price impact use the existing recorded-market-path model. See per-row maximum liquidity share before interpreting modeled income as deployable capacity. The 1,000 USDG is initial LP capital; gas is booked as a USDG-valued liability funded by separately modeled native balances. No finite live gas reserve or native-token price path is replayed.

These dates and assets were previously inspected. Any preferred variant now needs newly frozen prospective shadow evaluation; none is execution-eligible or promotion-eligible.

## Verification and reproduction

Verified 72 rows and 1475 actions. The action-driven audit does not rerun policy decisions: it reconstructs balances from canonical events, requotes swaps, remints exact token amounts, and reconciles fee tokens, gas, range occupancy and terminal liquidation. It shares the existing exact swap/position/fee primitives. The full source replay also reconciles the previously captured canonical ending state. Inputs, original and new code, plan and outputs are hash-bound. Integer tick memoization and empty-depth shortcuts use the existing conformance certificate.

The initial runner allowed the scenario name to overwrite the arm label in the summary. The report restores arm labels from the frozen scenario-by-arm array order; original raw results and hashes remain intact. The [metadata amendment](provenance/name-amendment.json) binds the archived original runner and the one-field correction. `policy.name` is used only for the summary label in the hash-verified original replay; trading decisions and economics are unaffected. Reported rows retain `storedName` for traceability.

[Typecheck and all 526 tests passed](checks.json), including estimator identity, shock response, missing-data rejection, early confirmation/cooldown, narrowing persistence and fill-time gate checks.

```bash
PATH="$PWD/.tools/node/bin:$PATH" node --import tsx --import ./scripts/lp-tick-memo-hook.mjs \
  --import ./scripts/lp-empty-quote-hook.mjs scripts/agile-lp-study.mjs AAPL data/agility-reproduction
# Repeat with GOOGL and NVDA, using the same output root.
python3 scripts/report-agile-lp.py data/agility-reproduction
```

Artifacts: [plan](plan.json), [summary and provenance](summary.json), [all 72 results](results.csv), [comparison chart](agility-comparison.png), [PDF chart](agility-comparison.pdf). CSV monetary fields ending in `Quote` are integer micro-USDG; percentage fields are in percent. Large canonical event slices and action ledgers remain under `data/adaptive-lp-agility-2026-09-14/`.
