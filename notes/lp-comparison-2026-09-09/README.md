# Four-candidate learning cohort — 9 September 2026

This cohort implements the bounded comparison in the [improvement plan](../lp-improvement-plan-2026-09-09.md), after the risk-refresh, anchor and runner-recovery fixes. It is a new modeled cohort, separate from the transaction-paper campaign and its accumulated losses. No old invalid experiment is resumed.

| Candidate | Initial paper budget | Half-width | Management |
|---|---:|---:|---|
| A | 1,000 USDG | ±20 raw ticks | Exit/reentry |
| B | 1,000 USDG | ±30 raw ticks | Exit/reentry |
| C | 1,000 USDG | ±20 raw ticks | Recenter at 40% of directional half-width after one observation |
| D | 1,000 USDG | ±30 raw ticks | Same recenter rule |

Both active arms retain the ten-minute recenter cooldown and the 60% reference-valued inventory exit, which takes priority over recentering. All four retain the ±5% independent reference band, held-session reference rules, 80% target allocation, 1% initial liquidity-share limit and 50-bps swap bound. Widths and management are the only differences between these four candidates.

Every placement requires a quote no older than 90 seconds, movement of at most five raw ticks since the quote, and at least 72% of current portfolio value actually placed in LP. The complete modeled remove/swap/mint path is previewed before acceptance; a rejected placement leaves the accepted balances and costs intact. Required safety exits bypass entry admission caps. Counters record quote age, drift, allocation rejection, cooldown, persistence and inventory preemption.

## What the historical screen established

The [calibration](calibration.json) replays the frozen September 5–8 source across 13 six-hour windows, using eight for development and five for validation. It compares only the four proposed early rules: 40%/50% distance and one/two observations, at both widths with matching fixed controls. [Selection](selection.json) fixes the cohort parameters and review times.

Development coverage was thin: only two qualifying width/window pairs, both within one six-hour window. The 40%/one-observation rule was the only rule with a development recenter (one), and its median paired alpha difference was zero. It is selected to exercise the management hypothesis, not because profitability or an optimum was established.

In validation it executed **17 recenters** across the two widths and had median paired alpha **0.750886 USDG worse** than the matching fixed controls. Its median active alpha was **−9.050451 USDG** per qualifying cell. The other early rules also underperformed their controls. These negative results are retained; active recentering is not promoted to the transaction-paper worker.

The cohort also tests a **1.25 USDG round-trip scenario-gas cap**. At 2× the frozen gas inputs it admits no LP entries, so there is no invested stress-validation result to rank. Staying in cash under that cap is not evidence of a profitable LP strategy. Historical current-risk fallback admissibility is unavailable; the historical screen uses checkpoint reference evidence and the earlier capture-plus-30-second decision clock. Forward observations now use actual worker time and current-risk evidence.

## Cost boundary and review

The gas inputs remain the canonical, frozen fork estimates from session 6. Entry, swap, remove, mint, exit and revoke charges are all debited, but **fresh transaction-specific gas quotes and the proposed six-hour rolling-median gas-admission gate are not implemented by this comparison**. The fixed scenario cap must not be described as that fresh-cost gate. The selection file records `missingFreshCostGate=true`. This is a limitation for profitability/adoption, not a hidden zero cost.

The transaction-paper worker remains on its existing width and entry-policy settings with the deployed reliability fixes; the experimental entry-quality and recenter hypotheses run only in the four modeled arms. Comparing their P&L directly with the worker requires reconciling capital, decision timing, hypothetical liquidity dilution and actual fork gas. The worker continues its conserved cash campaign; each modeled candidate starts independently at 1,000.

Status includes marked NAV and a separate hypothetical liquidation NAV/alpha: the latter includes a current modeled inventory-sale quote and reserved frozen gas, against the common marked holding benchmark. An unavailable liquidation quote produces an unavailable liquidation result. These remain modeled values, not actual cash settlements or fresh measured gas.

The runner saves immutable local review artifacts on its first poll after **24 and 72 hours**, including portfolio state, source/evidence history, data-pause coverage and whether each active arm has at least ten recenters. Reviews never automatically select a winner or retune a policy. A terminally stopped worker remains visibly failed; it cannot produce later scheduled reviews until separately audited. At least two overnight windows and a separate new weekend observation are still required. The 72-hour review is a decision point, not a promise of optimal parameters.

Runtime activation and the first accepted observations are recorded below after verification. The previous version-1 comparison remains archived at its original path and invalid status.

Validation before activation: TypeScript and all **282 unit tests** pass. The new checks exercise earlier recentering with inventory priority, allocation/age/drift/scenario-cost rejection without ledger changes, liquidation execution drag, immutable scheduled reviews, and pause recovery. A real CLI subprocess check confirms terminal status 2 survives the process lock wrapper and can be handled by `RestartPreventExitStatus=2`.
