# Management decisions, accounting parity and the 60% inventory cap

Frozen evidence cutoff: **9 September 2026, 12:02:45 UTC / 15:02:45 Vilnius**. The paper campaign continues under its existing sealed runtime. The four-strategy comparison remains ended. This is a retrospective audit, with no policy change or new forward comparison.

## Conclusion and the user's inventory-limit question

**The 60% cap has not been established as an economically appropriate setting.** It conflicts with allowing a normally filled 80%-allocated LP position to become one-sided in NVDA. A legitimate portfolio exposure ceiling can still be 60%, but then allocation, intervention rules and the willingness to remain outside the earning range must be designed around that ceiling.

The entry-state sensitivity in [summary.json](summary.json) finds that **25 of 27 sessions** reach the 60% threshold before the NVDA-heavy boundary, after **6–15 additional raw ticks** from their entry ticks. It holds entry inventory, reference price, gas and reserve fixed; it is a mechanical sensitivity, not an observed future path or prediction. The two exceptions, #8 and #9, had unusually low actual LP allocation. Their NVDA-heavy boundary exposures were only **39.25% and 52.50%**. The other sessions' boundary exposures ranged from **65.31% to 80.28%**.

All **eight observed inventory-triggered exits** began while price was still inside the earning range. Thus the limit currently acts as an early trading trigger. This alone does not prove the exits were mistakes: staying invested changes subsequent exposure and losses.

The [follow-up paper's buffer](https://arxiv.org/html/2505.15338v2#S5.SS5) delays relocation beyond the earning range. Our inference is that its downside-buffer idea is mostly preempted by the present allocation/cap combination. Increasing the cap would permit more waiting, with greater NVDA exposure. The ±5% true-price band remains a separate price-consistency check; it is not a portfolio-loss limit when both market and reference prices move.

For an illustrative 1,000 USDG portfolio already holding a fixed amount of NVDA and the rest as cash:

| Starting NVDA exposure | Loss after a further 5% NVDA decline | Loss after a further 10% decline |
|---|---:|---:|
| 60% | 30 USDG | 60 USDG |
| 80% | 40 USDG | 80 USDG |

This is arithmetic for fixed holdings, excluding fees and costs, not a backtest of the LP or a recommendation to adopt 80%. The research choice is to define an acceptable dollar exposure and adverse-move loss budget, then align LP allocation and the hard cap with it. Routine recentering or partial inventory reduction should be assessed separately from a full exit. No replacement percentage is selected here, and the running 60% policy remains unchanged.

## Exact replay versus recorded paper accounting

The captured canonical stream contains **147,092 events and 1,563 checkpoints**. Replay verifies every checkpoint's price, active liquidity and both global fee-growth values. The new audit reconstructs the recorded entry swap, position-manager mint rounding, per-segment fees with carried remainders, principal inventory, exit swap and cash proceeds.

Across **27 sessions and 1,144 marked observations**, it exactly matches recorded fees, NAV, holding value and alpha. All 26 completed exits and subsequent captured reentry budgets reconcile to the micro-USDG; entry/exit swap outputs and minted amounts also match in raw token units. Gas uses the recorded source-block fork estimates, with transaction sums checked; no new fork reproduction or actual gas receipt is claimed. The entry replay starts from the saved quote's amount and range, rather than independently reselecting the original quote policy. The mint rounding follows [Uniswap's LiquidityAmounts](https://github.com/Uniswap/v3-periphery/blob/main/contracts/libraries/LiquidityAmounts.sol).

The deterministic detailed cycle is #28, the first completed session under the current captured runtime, followed by its cash-funded child #29:

| Session | Starting cash | Entry gas | Exit gas | Fees | Closed cash |
|---|---:|---:|---:|---:|---:|
| 28 | 974.985604 | 0.417158 | 0.283179 | 0.200488 | 973.985271 |
| 29 | 973.985271 | 0.413093 | 0.279529 | 0.191703 | 972.467658 |

Amounts are USDG. The original experiment model, run on those same recorded decision observations, still differs because its accounting conventions differ:

| Contribution to model minus paper closed cash | #28 | #29 |
|---|---:|---:|
| Frozen gas versus recorded fork estimates | −0.134897 | −0.142612 |
| Added-liquidity fee dilution at otherwise identical inventory | −0.000270 | −0.000276 |
| Remaining acquisition, funding and fill effects | −0.000521 | −0.000416 |
| **Total difference** | **−0.135688** | **−0.143304** |

These contributions add exactly. The last row of residual effects is explicitly grouped; it has not been independently separated into every funding and mint sub-effect. The matching replay provides accounting parity for recorded actions, not evidence that the model's fee assumptions or real execution behavior are proven.

## Performance and first-exit reasons

The 26 completed sessions lost **29.932709 USDG**, earning **11.948135 USDG** in marked fees and charging **21.886433 USDG** in fork-estimated gas. Including open #31, campaign NAV at the cutoff was **971.387563 USDG**, versus common holding **991.032586 USDG**, for alpha **−19.645023 USDG**.

| First-exit category | Sessions | Session P&L | Gas |
|---|---:|---:|---:|
| Chain/infrastructure | 10 | −6.495530 | 9.360440 |
| Inventory limit | 8 | −15.999847 | 6.241429 |
| Reference/risk evidence | 7 | −6.997735 | 5.577667 |
| Operator upgrade | 1 | −0.439597 | 0.706897 |

The mixed chain/reference case is counted under infrastructure. #27's empty saved reason list is corroborated by the [documented operator upgrade](../lp-reliability-implementation-2026-09-09.md), including its matching pending timestamp. These buckets attribute sessions to the first exit reason; their entire losses are **not** recoverable profit from removing that reason. Full per-session gas, inventory and execution-drag decomposition is retained in [session-metrics.json](session-metrics.json).

## Shared-inventory action study

The bounded diagnostic selects the last eligible open observation before each first exit signal, excluding the operator upgrade. Each of **25 cases** forks the same held inventory into waiting, one attempted recenter at the existing width, and an exit to cash. Every branch runs to the same 30-minute source horizon, with a common passive holding comparator formed from its starting inventory. All branches retain mandatory guards and delayed execution. After a cash exit, cash remains cash so subsequent reentries do not confound the intervention.

Future fees use the experiment's added-liquidity convention. Future costs use frozen session-6 estimates at 1× and 2×; sunk costs and already earned fees are preserved. Endpoints include hypothetical liquidation costs and swap proceeds, and all orders require a recorded paper decision observation. Results expose NAV, liquidation alpha, future costs, decision-observed drawdown, exposure and action counts. Hypothetical between-decision risk is not fully captured by those sampled drawdown/exposure counters.

**No recenter completed in either cost scenario.** Nine were initially blocked by the ten-minute cooldown, nine by quote funding, and seven were quoted but preempted by a required exit before delayed execution: two infrastructure, four reference/risk and one inventory. Consequently this late-decision sample cannot compare successful recentering with waiting. Rejected recenter intentions follow the same guarded path as waiting; a zero paired difference is not evidence of equivalence between actual recentering and holding.

In the three cases under the current runtime, early exit minus guarded waiting at 1× costs was **0.000000** (#28), **−0.040005** (#29) and **+0.764118 USDG** (#30). These are small, correlated, retrospective action diagnostics. Anchors were selected before known exits, so they are not a deployable signal or untouched validation; do not sum them into campaign profits. Recorded operational gates are held fixed, and immutable current-risk diagnostics were unavailable before the reliability release. No conclusion about avoidable historical infrastructure exits follows from this calculation.

## What this enables next

The recorded-action replay can now serve as an accounting control. The remaining economic evidence gap is fresh comparable action costs, especially the actual recenter path; historical fork estimates and sensitivity assumptions remain distinct.

The next strategy-design decision should first settle the allowed NVDA exposure and adverse-move loss budget. An 80% LP allocation plus a 60% hard cap describes an intervention-before-one-sidedness strategy. Allowing a waiting buffer requires compatible allocation/cap settings, or an independently costed exposure-reduction action. Successful management must be tested at earlier actionable observations, with parameter selection deferred to a specified development period and a separate unseen weekend reserved for validation. This audit does not start that experiment or establish optimal width, size, cap or profitability.

## Reproduction and validation

Large immutable captures and full branch traces are in `data/lp-management-audit-2026-09-09/`. [summary.json](summary.json) pins their hashes, code hashes, every session's reconciliation summary and each paired result. Commands below use fresh output paths so existing evidence is not overwritten:

```sh
.tools/node/bin/node --import tsx scripts/paper-performance-audit.mjs capture data/runtime-refactor.env /tmp/management-paper.json
.tools/node/bin/node --import tsx scripts/capture-management-audit.mjs data/runtime-refactor.env /tmp/management-paper.json /tmp/management-market.json
.tools/node/bin/node --import tsx scripts/management-decision-audit.mjs /tmp/management-paper.json /tmp/management-market.json /tmp/management-reconciliation.json
.tools/node/bin/node --import tsx scripts/management-counterfactual-audit.mjs /tmp/management-paper.json /tmp/management-market.json /tmp/management-counterfactuals.json
.tools/node/bin/node --import tsx --test test/management-audit.test.ts test/lp-experiment.test.ts test/paper-boundary-fees.test.ts
.tools/node/bin/node node_modules/typescript/bin/tsc --noEmit
```

For the frozen result, supply the captured paths from `summary.json`. The summary projection is generated by `scripts/summarize-management-audit.mjs DATA_DIRECTORY NOTES_DIRECTORY`, after the existing performance reporter produces `NOTES_DIRECTORY/session-metrics.json`. The projection expects the frozen raw filenames recorded here.

Validation: **27 focused tests pass**, including recorded mint fixtures, carried fee fractions, upper-boundary exclusion, rejection of incomplete segment proof and net inventory exposure. TypeScript and `git diff --check` pass. The [independent Python accounting check](accounting-confirmation.json) confirms all 27 sessions and 26 closed cash balances. Its generic exit classifier defaults empty reasons to reference/risk; that label is not used for #27, whose operator exit is separately corroborated above. The [operations check](operations-check.json) at **12:20 UTC / 15:20 Vilnius** confirms open session 31, unchanged runtime/configuration, valid campaign cash continuity, and the disabled comparison with its ledger hash unchanged.
