# Focused 10–50 tick width screen

**Superseded interpretation:** the user subsequently clarified **±10 through ±50 ticks around the price**, giving total widths of 20–100 ticks. Use the [corrected half-width results](active-lp-tick-half-width-screen-2026-09-07.md) for the current experiment.

This historical screen used **10, 20, 30, 40 and 50 raw ticks** as the **total distance between lower and upper ticks**. That initial assumption remains recorded in its immutable selection manifest. This is fee 500 (0.05%), whose tick spacing is 10.

All seven portfolio sizes were screened at 80% nominal deployment and 20% reserve, with the ±5% independent-reference tolerance retained in the specification. This remains a geometric/capacity diagnostic; the guard, swaps, inventory interventions, fee income and funded rebalances are not simulated here. No net-optimal width has been selected.

The August 10–12 development window and verified source are unchanged from the seven-size screen. It contains 2,877 one-minute observations per pool and does not cover a weekend. Five widths × seven budgets × four controls (fixed, edge, immediate70, persistent70) produced **140 combinations**, with no tick-grid exclusions.

## Persistent-70% result at 1,000 USDG

The rule requires two one-minute observations, a ten-minute cooldown and a further 60-second delay. A range is frozen at signal time and discarded if price no longer lies inside it at the action observation. These are hypothetical range changes; failed/expired placements are not charged as actual reverted transactions.

| Total raw ticks | Full price span, approximately | Range changes | Expired changes | Minute observations outside range | Peak overlapping swap-segment liquidity share |
|---:|---:|---:|---:|---:|---:|
| 10 | 0.1000% | 180 | 51 | 40.2502% | 22.8436% |
| 20 | 0.2002% | 139 | 14 | 19.2909% | 12.8952% |
| 30 | 0.3004% | 104 | 3 | 11.6788% | 8.9845% |
| 40 | 0.4008% | 80 | 1 | 7.8554% | 6.8935% |
| 50 | 0.5012% | 71 | 1 | 4.6923% | 5.5979% |

The upper-price/lower-price ratio is 1.0001 raised to the total tick width; token ordering reverses tick/price direction. Position sizes are independently calculated with bigint math. Shares include our hypothetical liquidity in the denominator and retain the unchanged historical price-path approximation. At these concentrations, that approximation is materially limited.

The grid also changes starting inventory. At these exact initial prices, modeled NVDA exposure as a fraction of total spot-valued portfolio capital is approximately 13.68%, 46.84%, 31.23%, 43.42% and 34.74% for widths 10 through 50 respectively. A narrower range does not imply a balanced starting position. This is initial spot-valued composition, not reference-valued exposure over time.

The results establish much higher churn and concentration than the earlier ±2% example. They do not establish that 50 ticks has better net economics than 10 ticks: narrower positions may earn more fees while active, and portfolio swaps, inventory losses and costs are not yet included. The next economic comparison must use this narrow grid, matched starting inventory/benchmarks, session-aware references and the proposed 60% inventory intervention rule.

## Reproduction and checks

- [Frozen focused selection](active-lp-research-2026-09-07/tick-width-selection.json)
- [Run manifest](active-lp-research-2026-09-07/tick-width-screen-v1.json.manifest.json)
- [All 140 results, balances, placements and capacity distributions](active-lp-research-2026-09-07/tick-width-screen-v1.json)

Use a new output file:

```bash
.tools/node/bin/node --import tsx scripts/lp-research.mjs ticks \
  --input data/lp-research-2026-09-07/source.jsonl.gz \
  --timestamps data/lp-research-2026-09-07/size-sweep-timestamps.json \
  --selection notes/active-lp-research-2026-09-07/tick-width-selection.json \
  --output data/lp-research-2026-09-07/tick-width-repeat.json
```

Raw-tick unit tests cover every grid phase, negative ticks, unsupported widths, price containment and a stationary price exactly on a range boundary. The boundary test caught the need to avoid a zero-distance recenter trigger. All research execution eligibility remains false, and fee/cost/net-alpha rankings remain unavailable.
