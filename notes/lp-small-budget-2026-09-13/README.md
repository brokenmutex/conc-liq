# Small-budget asset comparison — 13 September 2026

This is a bounded follow-up to the twelve-asset study: screen at our actual size, compare the previously named AAPL/QQQ shortlist with NVDA on identical dates, and replace the original atomic action with staged withdrawal/swap/mint sensitivities calibrated to live receipts. It does not choose a deployable winner from every pool that passes the screen. The live campaign and deployed policy were not changed.

**The matched evidence prioritizes AAPL for the next small-budget prospective validation.** At fixed ±80, its all-in-250 modeled P&L is +38.32 USDG versus NVDA's +3.81; under double gas and half fees it is +0.42 versus −7.19. At ±160, AAPL is +20.21 base / +1.78 stressed, versus NVDA +4.56 / −5.11. QQQ is stronger at ±80 (+50.49 / +16.88), but its current reference check fails. These are conditional model outcomes, not a recommendation to move the live wallet immediately.

The same-date comparison changes the explanation: AAPL ±80 recenters **35 times versus NVDA's 33**, and pays **7.95 versus 7.12 USDG** gas. Its advantage comes from modeled fees and inventory evolution, not fewer interventions. This corrects the impression from comparing different available historical periods in the earlier study.

AAPL's fixed-width stressed gains are thin and both ±80/±160 trail passive holding in that scenario. Its economic-gate candidate retains +8.24 absolute P&L and +3.87 versus holding under stress, but makes no recenter then; at base it spends 85.72% of its invested time outside range. NVDA's gate never recenters in any all-in scenario and spends 87.58% outside at base. Those outcomes do not validate the continuously managed LP behavior the project seeks.

The next candidate comparison should therefore use AAPL at the actual remaining capital, keep ±80/±160 and the gate as separate prospective controls, and retain the explicit gas allowance. Asset-specific execution validation and forward observed fees remain necessary before changing the live asset or choosing a width. QQQ should be reconsidered only after a fresh reference passes the existing rule. No capital increase, live configuration change or transaction was made by this experiment.

## Capacity and reference screen

At block 62159801 (2026-09-13T18:11:59+00:00), **67 pools across 55 symbols** pass independent half-budget buy and sell probes within 50 bps. All 306 V3/USDG pools in the retained September 13 catalogue were checked at that new pinned block. No ±20-width requirement is imposed. The 12 fee-500 pools from the original study remain the only compatible pools passing; 55 passing pools use fee 3000 and tick spacing 60. Their tested half-widths are rounded to 120/180 ticks. They need different fee-tier replay validation and asset-specific lifecycle evidence, and are not assigned invented returns.

The refreshed token/reference evaluation passes **25 pool rows across 18 symbols**. AAPL and NVDA pass; QQQ still fails `paper_equity_reference_age_unacceptable`. Current reference eligibility is not historical eligibility or complete live admission. BABA, MU and TTWO fee-500 pools still fail at the smaller size. Higher fee-tier pools for those names are separate markets.

The buy and sell quotes use half the allocation at the same canonical state. They are independent capacity probes, not a sequential round trip or an exact future position exit. The pinned prices, raw amounts, width/share diagnostics and all exclusions are preserved in [screen.json](screen.json), [universe.csv](universe.csv) and [references.json](references.json). The catalogue is not refreshed for pools created after its earlier September 13 anchor; current-state selection retains retrospective availability bias.

## Receipt calibration and mechanics

Fresh canonical reads verify **138 live NVDA receipts**, their log arrays, gas-used × effective-price, and recorded USDG conversions. Their total is **4.321607 USDG**, including reverted transactions. Conversion arithmetic is independently recomputed from retained receipt-block oracle proofs; this check does not independently refetch every historical oracle answer.

There are seven completed entry episodes, eight completed recenter episodes and seven closed exit phases. Median recenter cost is **0.205538 USDG** and median time from phase entry through controller completion is **150.52 seconds**. The longest completed recenter, including a halted mint recovery, took **952.63 seconds**. Interrupted episodes are retained separately in [calibration.json](calibration.json). Receipt inclusion times drive modeled stages; controller-completion durations are reported separately.

A post-calibration scope check finds that only five of those seven exit phases include a withdrawal; two start from already released inventory. The frozen mixed-phase median exit cost is 0.137496 USDG, versus 0.160402 for the five withdrawal-containing exits. The p90 exit cost is 0.313017 in either group. The base exit allowance is therefore an approximate, somewhat lower cost scenario, not a full-exit-only empirical median. Results are retained without outcome-driven retuning; changing that allowance can change both terminal cost and the gas-budget stop boundary. The higher-cost scenarios are sensitivities, not a proof that every possible exit cost is covered.

Fresh isolated forks complete 240-USDG, ±80-tick entry, restored exit and recenter for AAPL, QQQ and NVDA. The observed NVDA receipt-cost distribution sets the cost level. Each other asset is scaled by its same-block fork gas ratio to NVDA; passive buy/sell costs use the corresponding fork stage ratio. This is an explicit transfer assumption, not observed live AAPL/QQQ gas. Widths and the 250-USDG comparison reuse those 240-USDG measurements.

## Matched comparison

All 72 portfolios use **August 30 00:00–September 11 19:30 UTC**, six hours of warmup and identical forecast-availability requirements. Initial capital and inventory do not reset during the window. The three entry boundaries and last source times are in [verification.json](verification.json). There were 0 empty-liquidity event-block marks in the evaluated three-asset window.

The primary budget is **240 USDG of deployable inventory plus 10 USDG of gas purchasing power**. Before beginning another entry/recenter, the model reserves the full bundle and a full exit. If that exceeds the remaining gas allowance, it attempts liquidation and stops further entry. Missing exit capacity stays unavailable. Gas charges are deducted from NAV and the initial reserve is added back only once; it is not extra spending capital. A separate `250_plus_gas` comparison retains the old budget convention and is not a feasible all-in-250 campaign when gas exceeds the additional allowance.

The base uses median live cost estimates and a representative median-ranked episode's staged delays. The p90 scenario uses p90 gas estimates and a representative p90-ranked episode's delays, including the observed long mint recovery. The third scenario doubles median gas and halves modeled fee credits. These are sensitivity assumptions, not probability-weighted forecasts.

**All-in-250 modeled results, USDG:**

| Asset | Policy | Base P&L | Base vs holding | 2× gas / ½ fees P&L | P90 cost/delay P&L | Base recenters | Base gas incl. exit | Gas-budget stop |
|---|---|---:|---:|---:|---:|---:|---:|---|
| AAPL | fixed_20 | -0.49 | -4.98 | -9.22 | -4.58 | 41 | 9.86 | Yes |
| AAPL | fixed_80 | +38.32 | +33.84 | +0.42 | +32.56 | 35 | 7.95 | No |
| AAPL | fixed_160 | +20.21 | +15.72 | +1.78 | +17.46 | 11 | 2.73 | No |
| AAPL | adaptive_economic | +20.15 | +15.67 | +8.24 | +15.40 | 7 | 1.86 | No |
| QQQ | fixed_20 | +24.06 | +24.70 | +0.70 | +4.83 | 33 | 9.92 | Yes |
| QQQ | fixed_80 | +50.49 | +51.13 | +16.88 | +48.16 | 11 | 2.74 | No |
| QQQ | fixed_160 | +22.62 | +23.26 | +7.78 | +23.57 | 3 | 0.99 | No |
| QQQ | adaptive_economic | +51.39 | +52.03 | +3.81 | +28.75 | 11 | 3.16 | No |
| NVDA | fixed_20 | -1.23 | -0.86 | -8.93 | -3.94 | 41 | 9.85 | Yes |
| NVDA | fixed_80 | +3.81 | +4.17 | -7.19 | +2.00 | 33 | 7.12 | No |
| NVDA | fixed_160 | +4.56 | +4.93 | -5.11 | +3.68 | 8 | 1.98 | No |
| NVDA | adaptive_economic | +11.78 | +12.14 | +2.39 | +11.47 | 0 | 0.33 | No |

`fixed_80` and `fixed_160` mean approximately ±0.8% and ±1.6%; `adaptive_economic` selects among ±20/40/80/160 with the economic gate. P&L is after modeled costs versus initial capital; alpha compares with a half-stock/half-USDG passive allocation plus the same gas reserve. Cash waiting, changed inventory exposure and early gas-budget stops can change alpha independently of width-selection skill. These are unannualized conditional historical outcomes, not executable return promises.

Full results for both budget conventions, every scenario, fees, gas, failed mint attempts, liquidity participation and exit status are in [results.csv](results.csv). Parameters and selection were fixed before inspecting these new matched-window results; the period itself was already used in earlier research and is not an untouched holdout.

The base-case behavior matters when interpreting an economic-gate win:

| Asset | Policy | Time outside range while invested | Average stock / net LP component | Fees earned while ours >10% of existing liquidity |
|---|---|---:|---:|---:|
| AAPL | fixed_80 | 0.09% | 51.33% | 0.00% |
| AAPL | adaptive_economic | 85.72% | 54.83% | 0.00% |
| QQQ | fixed_80 | 0.14% | 49.87% | 0.00% |
| QQQ | adaptive_economic | 85.56% | 29.88% | 6.03% |
| NVDA | fixed_80 | 0.02% | 46.35% | 0.00% |
| NVDA | adaptive_economic | 87.58% | 22.92% | 0.00% |

The stock ratio uses the replay's deployed-inventory component after gas, excluding the separate initial gas reserve. Time outside range excludes intervals without a position. A gate can save costs by leaving a one-sided position inactive for long periods; that is not evidence of continuously productive LP management. A low liquidity-participation ratio reduces one concern about the fixed-flow assumption but is not an error bound or proof of achievable fees.

## What the revised replay fixes, and what it still assumes

- Withdrawal removes the position before the following swap and mint delays. Fees stop accruing during that interval. The swap spends actual withdrawn inventory; a failed mint preserves the resulting tokens through a ten-minute cooldown. Recovery never replays an already completed balancing swap within that attempt.
- Economic-gate decisions are rechecked before withdrawal. Every policy uses the same forecast-availability requirement. Empty canonical liquidity suppresses decisions and valuation rather than declaring capital exhausted from a boundary price; no independent historical price series is invented.
- The original ten-minute width forecast is retained and does not explicitly price in the staged completion delay. The replay subtracts the resulting missed fees from actual modeled earnings. The long p90 mint delay can outlast the forecast horizon, so this is a test of the existing decision rule under latency rather than a latency-optimized policy.
- Stage gas is charged even on rejected swap/mint preflight as an adverse attempt-cost scenario. This is not a literal count of broadcasts. Mint uses a fresh quote from current held inventory and the previously chosen range; a further quote-to-inclusion delay and real mint-minimum reverts are not fully simulated.
- Gas-budget exits and terminal exits are priced at their decision source. Their wall-clock execution delay, approval sequence and infrastructure outages are not staged. The empirical exit sample contains a long halt; this model does not claim to reproduce it.
- Native gas is modeled as fixed USDG purchasing power. ETH price changes, initial conversion to ETH and funding transactions are outside this comparison. A real next run must size from reconciled remaining capital, not assume a fresh 250 after prior losses.
- Recorded trading flow, prices and competing liquidity remain unchanged after our hypothetical position and swaps. Fee dilution is modeled, but price/routing/volume responses are not. Historical issuer, reference and infrastructure admission are unavailable. QQQ is a research-only comparison while its current reference fails.

## Verification and reproduction

Canonical reconstruction matches the saved ending state for every asset. A second action-driven replay independently checks **9047 stage actions** without rerunning width decisions: starting and ending token balances, withdrawal inventory, exact swap outputs, minted liquidity, fees and gas. This audit shares the underlying integer swap/position/fee primitives, so it checks ledger integration rather than providing an independent economic model. The new tests exercise loss of fee accrual during recentering, post-swap mint failure, gas-reserve liquidation, unavailable marks, common forecast availability and a changed economic forecast before withdrawal. The final working-tree suite passes 485 tests, and TypeScript checking passes.

Runtime evidence lives in `data/lp-small-budget-2026-09-13`. Raw ledger exports, full fork proofs and projected canonical event pages are retained there and are not all committed. [artifacts.json](artifacts.json) hashes the required evidence and owned code. Upstream operations are read-only; only isolated local forks receive transactions.

```bash
.tools/node/bin/node --import tsx scripts/lp-small-budget-capture.mjs data/live-pilot-runtime.env NEW_DIRECTORY
.tools/node/bin/node --import tsx scripts/lp-small-budget-reference.mjs data/live-pilot-runtime.env NEW_DIRECTORY
python3 scripts/lp-small-budget-calibrate.py NEW_DIRECTORY
.tools/node/bin/node --import tsx scripts/lp-small-budget-verify-receipts.mjs data/live-pilot-runtime.env NEW_DIRECTORY
# The capture also writes the pinned universe.json consumed by the fork runner.
.tools/node/bin/node --import tsx scripts/lp-small-budget-fork.mjs data/live-pilot-runtime.env NEW_DIRECTORY
.tools/node/bin/node --import tsx --import ./scripts/lp-tick-memo-hook.mjs --import ./scripts/lp-empty-quote-hook.mjs scripts/lp-small-budget-prepare.mjs NEW_DIRECTORY
# Repeat the following command for AAPL, QQQ and NVDA.
.tools/node/bin/node --import tsx --import ./scripts/lp-tick-memo-hook.mjs --import ./scripts/lp-empty-quote-hook.mjs scripts/lp-small-budget-replay.mjs NEW_DIRECTORY AAPL
python3 scripts/lp-small-budget-report.py NEW_DIRECTORY NEW_REPORT_DIRECTORY
.tools/node/bin/node --import tsx --test test/small-budget-lp.test.ts test/adaptive-lp.test.ts
```

The report narrative is hash-bound to this frozen plan; fresh captures constitute a new experiment and require a reviewed interpretation before packaging. Reproducing this report uses copies of the retained frozen inputs. The memoization hooks are the previously certified pure-integer optimizations; they do not alter strategy rules. Use new output directories, retain raw evidence, and do not overwrite frozen completed results. `executionEligible=false` and `promotionEligible=false` throughout.
