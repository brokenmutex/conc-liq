# LP portfolio replay — September 8, 2026

The ledger and first economic sensitivity are implemented. These are self-financing **modeled** returns on an unchanged historical price path. Measured strategy profitability remains unavailable; execution is disabled. The five half-widths are ±10, ±20, ±30, ±40 and ±50 raw ticks, aligned to the pool's 10-tick grid, with total widths 20–100. Grid alignment means actual distances from the current price can differ between the two sides.

The weekend sample favors a fixed range with mandatory risk intervention over routine recentering. This is an exploratory comparison of one weekday window and one weekend, not a validated optimum. A fixed range here may still be withdrawn or traded under the same reference and inventory safeguards as the active policy.

## Results at 1,000 USDG

Net alpha versus holding the identical opening tokens, in USDG, assuming 0.05 USDG per successful operation and 100% of modeled allocated fee income:

| Half-width | Weekday fixed | Weekday active | Weekend fixed | Weekend active |
| --- | ---: | ---: | ---: | ---: |
| ±10 | 0.01 | 10.48 | 37.71 | -1.38 |
| ±20 | -1.02 | 12.85 | 33.09 | -0.85 |
| ±30 | -0.69 | 14.02 | 23.48 | 14.78 |
| ±40 | -2.93 | -1.39 | 22.59 | 18.02 |
| ±50 | -1.43 | -1.42 | 19.20 | 17.66 |

Weekday: August 10 00:28:17–August 12 00:24:22 UTC. Weekend: August 14 18:26:52–August 16 21:59:00 UTC, ending before the assumed reopening. The weekday active ±10/20/30 runs have no position at roughly 84–88% of observations: their positive alpha largely reflects changing inventory exposure during a falling reference market, and must not be interpreted as continuous productive LP deployment. The weekday active ±10 run has negative absolute P&L despite positive alpha.

The weekend active ±10 and ±20 policies lose relative to passive holding in this cost scenario. Repeated recentering progressively consumes available NVDA; eventually there may be too little to fund a new two-sided range. This policy deliberately does not buy NVDA just to restore a 50/50 split. The geometry-only screen concealed this funding constraint by resizing from a constant budget.

## Seven deployment sizes

The highest modeled weekend alpha within each tested mode at 0.05 USDG/operation and full allocated fee income is shown below. These are sample maxima, not deployment recommendations. Peak share is our hypothetical liquidity divided by historical plus our liquidity, across mint and earning segments.

| Budget USDG | Fixed half-width / alpha USDG | Fixed peak share | Active half-width / alpha USDG | Active peak share |
| --- | ---: | ---: | ---: | ---: |
| 250 | ±10 / 9.63 | 3.70% | ±40 / 4.42 | 1.16% |
| 500 | ±10 / 19.24 | 7.13% | ±40 / 8.97 | 2.29% |
| 1000 | ±10 / 37.71 | 13.31% | ±40 / 18.02 | 4.47% |
| 2000 | ±10 / 71.93 | 23.49% | ±40 / 35.34 | 8.56% |
| 3000 | ±10 / 102.99 | 31.53% | ±40 / 56.71 | 12.31% |
| 4000 | ±10 / 131.34 | 38.04% | ±40 / 74.02 | 15.77% |
| 5000 | ±10 / 157.35 | 43.43% | ±40 / 90.50 | 18.96% |

Increasing size can make the unchanged-price-path assumption materially less credible. A higher dollar result at a large share of the pool is not evidence that the same result is executable.

## Cost and fee sensitivity at 1,000 USDG

Weekend net alpha in USDG. The 50% column setting halves allocated income while preserving the historical price path and inventory effects; it does not simulate a different stream of orders.

| Cost per operation USDG | Allocated fee income | Fixed ±10 | Fixed ±20 | Active ±40 |
| --- | ---: | ---: | ---: | ---: |
| 0.01 | 100% | 37.92 | 33.30 | 18.30 |
| 0.01 | 50% | 18.48 | 16.33 | 8.79 |
| 0.05 | 100% | 37.71 | 33.09 | 18.02 |
| 0.05 | 50% | 18.28 | 16.12 | 8.51 |
| 0.25 | 100% | 36.69 | 32.07 | 16.62 |
| 0.25 | 50% | 17.27 | 15.11 | 7.10 |
| 1.00 | 100% | 32.86 | 28.24 | 11.35 |
| 1.00 | 50% | 13.47 | 11.32 | 1.85 |

## Frozen policy and accounting

- Every candidate and its passive comparator starts with the same pre-held, preapproved inventory: 40% NVDA and 60% USDG at the opening independent reference. Acquisition, approval and funding costs are outside this endowed-inventory experiment.
- Each mint uses actual balances, deploys at most 80% of current reference NAV and leaves at least 20% USDG cash at mint. It can deploy less when one token is scarce. No capital reset or free token conversion occurs.
- An initial or resumed placement is immediate at an eligible minute observation. Routine recentering requires price to travel 70% toward a boundary for two observations, a 10-minute cooldown, and a 60-second pending delay. Its proposed bounds are frozen until execution and expire if price leaves them.
- A reference/price/token violation schedules withdrawal with a 60-second delay. A sampled NVDA exposure at or above 60% overrides routine timing, removes the LP and attempts an exact-depth sale toward 50%. Exposure can overshoot 60%; that number is an intervention threshold, not a hard cap. Recovery before execution cancels the pending risk action.
- Risk sales include pool fees and impact, reject more than 50 bps of shortfall from pre-trade pool spot, and check the post-trade ±5% independent-price band. Each successful mint, remove/collect bundle and swap separately deducts a hypothetical transaction cost. Costs are scenarios, not receipt measurements or ETH-to-USDG conversions.
- Mint funding rounds up; burn principal rounds down. Historical swap fees are clipped to the position range, reduced by protocol fees, diluted by added LP liquidity and accrued through crossings. Terminal removal pays its cost, and remaining NVDA is marked at the common independent reference. This is NAV, not cash liquidation proceeds.

## Freshness and weekend evidence

The research scenario uses the mapped 86,400-second heartbeat for each active feed. The NVDA close anchor is accepted only if valid at closure; USDG stays independently age-gated throughout. Operational 300-second settings are unchanged.

The explicit calendar assumption is Friday 17:00 ET–Sunday 18:00 ET closed, matching the mapped US_Equities_24/5 category in [Chainlink's market-hours documentation](https://docs.chain.link/data-feeds/selecting-data-feeds#market-hours). This is a research use of a held close reference; it does not establish a tradable weekend fair value or provider endorsement of using the feed outside its market hours.

Archive verification found **0 new NVDA rounds and 2 USDG rounds** over the captured Friday–Sunday window. All 3093 pre-reopening decision marks pass the experimental price-reference rule, including 2939 held-anchor marks. The 100 observations after the assumed reopening have **0 passing references**; a fresh NVDA publication is required and none appears by August 16 23:40 UTC. No final post-reopening net-alpha claim is made.

Token code/pause/multiplier checks use the latest available archive snapshot: 29 weekday snapshots, four weekend snapshots. Forward-filling between them is an explicit assumption. Historical issuer registry status and sequencer continuity remain unverified. The weekend oracle log census is restricted to proxies and aggregators; it is not a complete token-log census.

## Validation and remaining work

1120 action ledgers reconcile every raw wallet balance and charged operation. The 160 1,000 USDG scenarios reproduce exactly when included in the seven-size runs. TypeScript and all 244 tests pass, including 14 new tests for conservation, costs, fee allocation, quote direction/impact, delayed interventions and session expiry.

The replay preserves historical market prices, swaps and other LP actions while adding hypothetical liquidity. Fee allocation at our added boundaries is modeled, and induced arbitrage, changed routing/volume and other LP responses are omitted. Following our hypothetical inventory sale, immediate remint uses the quoted price/depth, then canonical observations return to the historical path. The scorer is suitable for identifying hypotheses and failure modes, not proving live profitability.

Next: freeze fixed ±10 and ±20 as narrow-range candidates and retain active ±40 as a control; validate across additional independent weekends and overnight windows with an explicit capacity cutoff. Add an inventory-restoration purchase variant as a separate costed policy before claiming routine recentering has been optimized. Compare actual transaction/fork paths and gas valuation with the scenario breakpoints, then use forward paper evidence. The untouched holdout and live execution remain unused.

Evidence: [replay runner](../scripts/lp-portfolio-replay.mjs), [report generator and independent balance audit](../scripts/lp-portfolio-report.mjs), [portfolio ledger](../src/research/portfolio.ts), [math](../src/research/portfolio-math.ts), [session reference](../src/research/session-reference.ts), and [tests](../test/lp-portfolio.test.ts). The full compact-report JSON was pruned after byte-identical regeneration; recovery, exact input hashes, and its replay receipt are in `research/manifests/active-lp-portfolio-report-2026-09-08/pruned-artifacts.json`. Full action/mark series remain under ignored local `data/lp-portfolio-2026-09-08/`.
