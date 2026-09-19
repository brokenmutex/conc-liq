# Active LP strategy proposal — 2026-09-07

Status: research proposal, revised after review on September 7. The user clarified **±10, ±20, ±30, ±40 and ±50 raw ticks around the price** in the fee-500 pool: total lower-to-upper widths are 20, 40, 60, 80 and 100 ticks. The earlier assumption of 10–50 total ticks is superseded. The user-selected tolerance remains ±5% around the independent reference price. This document does not activate a runtime policy or change a service. Earlier width experiments remain historical baselines. Guarded strategy net performance remains unmeasured.

September 8 implementation update: the [self-financing portfolio replay](active-lp-portfolio-replay-2026-09-08.md) now accounts for actual token balances, crossed-range fee allocation, delayed routine/risk actions, historical-depth inventory sales and paid terminal removal. It compares all seven budgets at the five corrected half-widths across weekday and weekend windows, with explicit transaction-cost and fee-income sensitivities. These are modeled economics; measured path costs and complete historical issuer/sequencer evidence remain unavailable. The first weekend sample favors fixed narrow ranges with risk intervention over routine recentering. No live optimum has been selected.

## Recommendation

Develop a 24/7, volatility-adaptive LP policy that manages inventory and pays to recenter only when the expected improvement justifies it. Separate moving liquidity from swapping tokens. Optimize net LP alpha against a fixed passive-holding benchmark, alongside absolute NAV, drawdown and inventory exposure. Remaining in range or collecting the most fees is not the objective by itself.

Start with one active NVDA/USDG position and a cash reserve. Compare NVDA's 0.05% and 0.30% pools in research before assuming the current venue is optimal. Avoid adding hedges, many simultaneous positions or automatic cross-pool rotation before the simplest active policy demonstrates value.

Accept pool-price deviations of up to **±5% around the selected independent reference price**, subject to valid reference evidence and inventory limits. This is the user's price tolerance, not a fitted volatility forecast, a requirement to deploy throughout the band, or a guarantee of maximum loss.

## What the current evidence establishes

The existing paper policy is a lifecycle baseline: approximately ±2% fixed range, roughly 1,000 USDG budget, a six-hour maximum holding period, and entry/exit transaction simulations. It does not recenter or rebalance. Crossing its range currently invalidates accounting with `range_crossed_fee_coverage_incomplete`. That is an accounting limitation, not a desirable trading response. See [engine](../src/paper/engine.ts) and [transaction engine](../src/paper/transaction-engine.ts).

Session 4 closed after about 79 minutes following `paper_current_risk_evidence_unavailable`. Its estimated fees were 0.134903 USDG versus 1.183336 USDG estimated gas charged. Final NAV was 996.580017 USDG and alpha versus its passive benchmark was −1.290882 USDG. Gas was 8.77 times fee income. This short observation demonstrates cost sensitivity; it does not establish the expected profitability of NVDA liquidity provision. The session is closed, not an ongoing active position.

The database is the principal research asset. A read-only, repeatable-read snapshot at **2026-09-07 12:19:54 UTC** found:

| Coverage | Confirmed contents |
| --- | --- |
| All 15 enabled pools, seven symbols | 3,723,322 events; 3,610,653 swaps |
| NVDA 0.05% | 2,025,098 events; 1,974,806 swaps; first block 15,511,376 on July 21 |
| NVDA 0.30% | 20,741 events; 15,390 swaps; first block 7,923,871 on July 12 |
| Initialization | One Initialize event for each enabled pool; each first event block equals its recorded creation block |
| Replay | 3,723,320 events applied through block 56,829,001; an independently advancing worker, not a completeness proof |
| Stored indexer headers | 2,897 sparse timestamp anchors, July 3–September 7 |

Creation dates above are bracketed by stored headers. NVDA 0.05%'s first event lies between July 21 10:30:14 and 11:12:03 UTC; these are not its exact block timestamp. The oldest event in another pool precedes the earliest stored header. Event `observed_at` is ingestion time and must never be treated as historical market time.

Separately, the inspected synchronized NVDA checkpoint sample contains 618 canonical observations over 47.52 hours, September 5–7. Its sampled price span is 1.04%, with 12 gaps over 15 minutes. These discrete observations miss intrainterval extremes. This narrow checkpoint sample must not be confused with the much larger historical event collection.

Fourteen observed transactions touching the NVDA 0.05% pool were classified as rebalance bundles. Median whole-transaction gas cost was 0.000400727194784 ETH; p90 was 0.001991896357932 ETH. These are useful cost calibration observations, not quotes for our unimplemented rebalance transaction. They may contain other actions and pools. Historical USDG conversion requires contemporaneous gas-token pricing.

Evidence: [historical coverage](active-lp-research-2026-09-07/history-coverage.json), [checkpoint/session/cost observations](active-lp-research-2026-09-07/observations.json), [descriptive calculations](active-lp-research-2026-09-07/summary.json), [reproduction script](active-lp-research-2026-09-07/analyze.py).

## Research implications

Uniswap positions stop earning fees outside their range and become one-sided. They can become active again if price returns; crossing does not itself require closing. Accurate accounting must follow fees through tick crossings. [Uniswap concentrated liquidity](https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity), [v3 whitepaper, section 6](https://app.uniswap.org/whitepaper-v3.pdf).

LPs also incur adverse-selection losses when informed traders trade against stale pool prices. High volume and high fee APR can therefore coexist with poor economic performance. Hedging directional exposure does not eliminate this loss. [Milionis et al., Automated Market Making and Loss-Versus-Rebalancing](https://arxiv.org/abs/2208.06046).

Research on dynamic concentration supports selecting widths and asymmetry using fee opportunity, volatility, inventory effects and repositioning costs. However, continuous adjustment, simplified gas and absent market impact are material modeling assumptions. Results on ETH/USDC do not validate parameters for Robinhood tokenized equities. Our proposal below is a set of testable hypotheses, not a transplant of claimed returns. [Cartea, Drissi and Monga, sections 4–6](https://arxiv.org/html/2309.08431v3).

## Candidate policy

### Reference price and the ±5% tolerance

Use “true price” to mean the best available, quality-passing independent estimate of the NVDA token's value in USDG. It remains an estimate. Chainlink's multiplier-adjusted token feed is the primary reference; any independent fallback must have a predeclared source hierarchy, normalization and freshness rules. The pool's spot price and its own TWAP cannot supply this independent anchor. Apply the same reference selection to both fee tiers and the benchmark at each observation.

For positive reference price `P_ref`, the acceptable price interval is **`[0.95 × P_ref, 1.05 × P_ref]`**, inclusive. For example, a reference of 230 USDG/NVDA gives bounds of **218.50–241.50 USDG/NVDA**. Compute the comparison with exact integers: `abs(P_pool − P_ref) × 100 <= P_ref × 5`, using the same price scale. Refresh the bounds only when a new reference passes its quality checks; never move the anchor to the pool merely to admit a trade.

| Parameter | Meaning | Candidate setting |
| --- | --- | --- |
| Independent-reference tolerance | Allowed pool-price deviation from the selected reference | ±5%; fixed for this research proposal |
| LP tick half-width | Raw ticks on each side of the price, with a feasible grid center | Test ±10, ±20, ±30, ±40 and ±50 in fee 500; total widths 20–100 ticks, approximately 0.20%–1.01% full price span, subject to reference bounds |
| Swap slippage ceiling | Protection on the output of a concrete swap | Existing 50 bps ceiling; actual costs must still justify the action |

Use current executable pool state to check the tolerance; a filtered price used for centering must not conceal a current breach. New positions and recentered ranges must fit within the reference bounds after tick rounding inward in human-readable price terms. Reject an empty or infeasible rounded range, and record the actual width/asymmetry when clipping changes the requested range. NVDA's token ordering makes raw tick direction inverse to USDG/NVDA price direction.

Recheck existing positions when an accepted reference changes. A pool-price breach or a deployed range extending outside the accepted bounds requires the risk handling below, bypassing routine persistence and cooldown. Price jumps and transaction delay can still carry an existing position beyond the band before withdrawal completes; record the duration, inventory and loss during that interval. The ±5% tolerance does not imply a 5% drawdown cap or authorize expanding the band after a breach.

### Range selection and recentering

Evaluate a small menu: keep the current position; recenter with existing tokens; recenter with a minimal swap; widen/reduce liquidity; remove liquidity and hold inventory. Evaluate liquidation separately when risk or the experiment's terminal accounting requires it.

Use a filtered recent pool price to locate executable liquidity, recent realized volatility and fee income per unit of active liquidity to select width, and independent references to constrain exposure. The pool's own TWAP is not independent confirmation of fair value. Focus the optimization on **±10, ±20, ±30, ±40 and ±50 raw ticks around the price**, as clarified by the user. Fee 500 has spacing 10, giving one to five grid intervals on each side and total widths **20, 40, 60, 80 and 100 ticks**. Fee 3000 has spacing 60 and cannot express the complete grid. Earlier percent-width experiments and the initial total-10–50-tick interpretation are historical baselines. A ±10-tick position is approximately ±0.10% around its grid center, with a full price span of approximately 0.20%.

The [corrected tick-half-width screen](active-lp-tick-half-width-screen-2026-09-07.md) uses the nearest feasible grid midpoint while requiring the signal price inside the range. The grid center can differ from the exact current price, so record actual token composition and distance to each boundary; do not assume exact 50/50 or symmetric percentage bounds. Keep the width grid fixed while comparing net fees, inventory loss, execution costs and capacity. Range occupancy or the fewest range changes alone cannot select the optimum.

Seed a routine recenter trigger at 70% of the distance from the actual range center to its boundary, persisting for two fresh observations, with a ten-minute cooldown. Check the ±5% reference bounds, mandatory inventory intervention threshold and an actual range exit at every available decision observation, without routine persistence or cooldown. Persistence and cooldown reduce churn during oscillation; they must reflect actual observation cadence and execution latency. The recenter settings are experimental, not fitted recommendations.

Start the comparison with one decision opportunity per minute, matching the [checkpoint schedule](../ops/conc-liq-strategy-checkpoint.timer), and require distinct fresh source observations for persistence. Process all events for accounting between decisions, but do not grant an action opportunity on every swap. Preserve signal time, data availability, order constraints and later execution time; fees before a simulated mint belong to the liquidity actually deployed at that point. Model confirmation/data delay separately from execution delay, allow only one pending portfolio action, and do not backdate decisions through missing observations. Use historical block time plus the declared availability model for old events; their ingestion timestamps do not describe historical decision availability.

When price exits, accrue only fees actually earned, maintain the one-sided inventory, and evaluate waiting versus redeployment. A transient excursion may reverse before a costly recenter pays for itself. Missing event coverage should still make the affected result unavailable; an ordinary crossing should not.

### Inventory management

For the first candidate, test 80% maximum deployed capital with 20% idle USDG. A near-symmetric initial LP then starts with approximately 40% of total NAV exposed to NVDA. Test a soft NVDA exposure band of 30–50% of total strategy NAV and a mandatory intervention threshold of 60%. Include wallet tokens, LP principal and claimable fees in exposure, valued using the common independent reference. The lower soft bound is a deployment preference, not a requirement to buy during unsafe conditions. Cash is an allowed outcome.

Choose deployment, range width and intervention settings jointly. As an illustrative v3 calculation with pool and reference prices moving together, 800 USDG deployed in a symmetric ±2% range plus 200 USDG idle reaches 60% NVDA exposure after approximately a 1.02% price fall, before the 1.4% fall that reaches the routine 70% recenter trigger. At that routine trigger, exposure would already be approximately 67.6%. These calculations exclude fees and tick rounding; with a held or divergent reference, recompute exposure using that reference. Thus the initial settings can make risk-driven sales dominate routine recentering. Compare deployment levels under the same 60% intervention rule before choosing the combination; do not silently raise the threshold to make recentering results look better.

The 60% setting is an action threshold, not a guaranteed maximum between observations or during a jump, outage or failed transaction. Track maximum exposure, time above the threshold and exposure until an action completes. Evaluate the inventory reachable across the deployed range and under jump/delay scenarios at entry and every redeployment; accepting the ±5% price band does not by itself establish acceptable inventory risk.

Prefer feasible redeployment using existing tokens and idle balances. If a swap is justified, trade the smallest amount that restores the chosen feasible allocation or returns exposure to the nearest soft boundary. Do not restore 50/50 mechanically. Mandatory inventory intervention can require reducing risk even when the fee-based profitability test fails; record such actions separately. Withdrawal stops further LP-driven conversion once it completes, but does not remove NVDA already held; reducing that inventory requires a separately permitted swap.

As USDG/NVDA rises, an LP sells NVDA; on a fall, it accumulates NVDA. Repeatedly forcing a symmetric position after breakouts can buy back higher or sell lower. Recentring does not reverse those losses.

An inventory-heavy position can sometimes sell passively through a range above the current human-readable USDG/NVDA price; cash can similarly buy below it. Such orders may never fill, so they cannot enforce mandatory inventory intervention. Any such range must also fit inside the ±5% reference bounds. Defer a second dedicated position until its incremental benefit covers its gas. Use exact token math to solve feasibility: NVDA is token1 in the current pool, so human price direction is inverse to the raw tick direction.

### Cost-sensitive action selection

Compare the projected terminal NAV of an action with leaving the current portfolio in place over the same horizon:

`incremental benefit = expected NAV after action − expected NAV after holding`

Both paths must include accrued fees, inventory changes, idle cash and all execution cashflows. Require a positive conservative margin after uncertainty and risk limits. Do not subtract a separate IL/LVR number again if those losses are already represented in the inventory ledger. Before predictive errors are calibrated, use explicit scenarios rather than a spurious statistical confidence bound.

Make this rule deterministic before validation. The first scorer uses the **minimum incremental terminal NAV across a frozen set of scenarios**, rather than assigning unmeasured probabilities and calling the result an expectation. A routine action must exceed a predeclared positive margin in USDG after all costs in every included scenario. Select the highest qualifying score and hold when no action qualifies; break equal qualifying scores by lower swap notional, then lower execution cost, then a stable action order. Mandatory risk actions follow the risk rules separately.

The run manifest must fix the evaluation horizon, trailing volatility and fee windows, minimum input coverage, scenario price/fee paths, conservative cost basis, required margin, reference transitions and terminal valuation. Apply the same scenarios and horizon to the action and hold paths, including any subsequent risk interventions. Select these assumptions using development data only, and freeze them before validation; missing scorer fields make economic action selection unavailable. Scenario results remain modeled sensitivities. The evaluation horizon is separate from the experiment stop and does not require closing the LP when that horizon elapses.

An own-rebalance quote must cover withdrawal, collection, optional swap, redeployment, approvals when needed, gas and residual balances. Apply the actual execution path, including partial completion and retry costs if it is not atomic. The current 50 bps slippage ceiling is a safety maximum, not an acceptable loss budget for every action.

Historical receipts are real observations of other transactions; current fork results execute our proposed contract calls but remain simulations. Neither supplies an exact future mainnet cost. Use observed numbers where available, disclose their scope, and leave missing verified economics unavailable. Labeled cost sensitivity runs may screen hypotheses; they must not become execution-eligible profit claims.

Remove the arbitrary six-hour economic exit in the candidate. Reassess periodically and retain a predetermined experiment stop. Collect/compound while already transacting unless a standalone operation pays for itself.

### Overnight and closed markets

Remain eligible to provide liquidity 24/7. Test regular hours, extended hours, weekends and reopenings separately. Their profitability is an empirical question: neither closing every night nor assuming every overnight opportunity is profitable is justified.

Chainlink tokenized-equity feeds already incorporate Robinhood's multiplier and may hold a value when underlying markets are unavailable. An unchanged off-hours value is different from a broken feed; it is also not proof of current fair value. [Chainlink Robinhood feed documentation](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood).

Nasdaq or another timestamped equity feed can supply the underlying reference, provided the quote type, age, corporate actions, token multiplier and USDG conversion are correct. Do not multiply an already adjusted token feed again. A last-trade webpage is not an executable quote. Hyperliquid is an optional corroborating signal with its own basis and funding effects, not a mandatory anchor.

Treat held references as greater uncertainty: compare wider ranges within the ±5% bounds, less deployed capital and tighter inventory intervention settings. The candidate's ±5% tolerance replaces the earlier paper policy's ±3% reference bound; it does not extend any reference's permitted age. Do not blindly recenter to an old closing mark. Preserve explicit source/session expiry rules, and do not renew a held reference's timestamp simply because another read returned the same round. Keep issuer pauses and corporate-action ambiguity as distinct risk states.

Leaving liquidity deployed can increase NVDA inventory through other traders' swaps without any action by this bot. Therefore blocking new bot orders alone cannot freeze exposure. Apply the following proposed behavior to existing positions as well as new orders:

| Risk state | Existing position and permitted actions |
| --- | --- |
| Valid fresh or explicitly permitted held reference; price/range inside ±5%; inventory below intervention threshold | Retain the position or evaluate a qualifying action. Held references retain their declared expiry and uncertainty treatment. |
| Risk refresh pending while the last successful evidence remains valid | Defer new deployment and recenter orders. Retain existing liquidity only under the still-valid evidence and ongoing price/inventory checks; record passive inventory changes. A pending refresh alone does not mandate a sale. |
| Evidence expires or no acceptable independent reference remains | Cancel pending exposure-increasing intents and request withdrawal/collection through the permitted risk-reduction path. Hold the resulting tokens; do not substitute pool spot as “true price” or fabricate a safe liquidation quote. |
| Pool price leaves ±5%, the deployed range no longer fits the bounds, or NVDA reaches the intervention threshold | Cancel incompatible intents and prioritize withdrawal/reduction of the offending liquidity. Use a separately validated, risk-reducing swap when needed and executable; an out-of-band price does not prohibit withdrawing or safely reducing risk. Redeployment must pass the full reference, inventory and cost checks. |
| Confirmed issuer pause, corporate-action ambiguity, or chain/execution failure | Block ordinary orders. Attempt withdrawal only if that operation is permitted and independently executable; otherwise retain the actual portfolio in a blocked/pending state and report the exposure. Do not assume a successful withdrawal or perform a blind sale. |

Withdrawal requests take effect only when the execution path succeeds. Until then, continue accounting for active liquidity and inventory changes, or mark the affected accounting unavailable if coverage is missing. Separate withdrawal, token liquidation and reference recovery in the action ledger; none implies that the others completed.

## Historical experiments: the next milestone

Use the existing database now. Build a bounded NVDA comparison on the existing event replay and exact bigint accounting, rather than another ingestion platform or general backtesting framework.

### User-selected portfolio-size experiment

Test total starting portfolios of **250, 500, 1,000, 2,000, 3,000, 4,000 and 5,000 USDG**. These amounts include the cash reserve. For this first size comparison, keep the maximum LP deployment at **80%** and the idle USDG reserve target at **20%**:

| Total starting portfolio (USDG) | LP allocation ceiling (USDG) | Idle USDG reserve target |
| --- | ---: | ---: |
| 250 | 200 | 50 |
| 500 | 400 | 100 |
| 1,000 | 800 | 200 |
| 2,000 | 1,600 | 400 |
| 3,000 | 2,400 | 600 |
| 4,000 | 3,200 | 800 |
| 5,000 | 4,000 | 1,000 |

These are starting allocations before execution costs and exact sizing residuals; the portfolio ledger must fund all costs within its declared capital. Hold the **±5% independent-reference tolerance**, range policy, inventory intervention rules, observation/execution timing, market dates and valuation convention fixed within each size comparison. Each size gets a matched fixed-range control and a passive benchmark scaled to that same starting capital. Compare deployment fractions separately after the nominal-size experiment.

Use a later development window selected for liquidity and reference coverage before inspecting strategy outcomes. Record each position's share of active liquidity at entry, at redeployment and across relevant price segments. Assess transaction costs, swap impact, liquidity dilution and feasible mint amounts separately for every size; do not scale the 1,000 USDG result linearly. Report net alpha in both USDG and percentage terms where economics are available, together with drawdown, inventory exposure, turnover and capacity failures. Retain unavailable results for sizes or periods that cannot support a credible comparison.

The completed July 21–23 screen remains a historical 1,000 USDG capacity/geometry diagnostic. Its saved manifest and results are not results for this seven-size experiment. The size grid is for research and paper evaluation; it does not change funded deployment amounts.

The [August 10–12 seven-size capacity sweep](active-lp-size-sweep-2026-09-07.md) is now complete: 196 valid size/policy/width combinations and 28 tick-grid exclusions. With ±2% LP half-width and persistent-70% geometry, fee-500 peak combined-liquidity share rises from 0.1906% at 250 USDG total capital to 3.6794% at 5,000; fee-3000 rises from 4.2047% to 46.7481%. This later window materially improves the fee-500 capacity picture relative to July. These are constant-budget placement probes, not self-financing portfolio returns. Continuous quality-passing reference/risk evidence and size-specific execution economics remain incomplete, so no size or policy has a net-profit ranking and the ±5% true-price guard has not been validated by this sweep.

### Controlled comparisons and evidence

| Hypothesis | Controlled comparison | Primary evidence |
| --- | --- | --- |
| Persistence avoids churn | Immediate edge recenter versus persistent trigger/cooldown | Turnover, costs, net alpha, delayed-reentry losses |
| Inventory preservation beats forced balancing | Every recenter resets to 50/50 versus minimal-swap redeployment | Swap volume/NAV, exposure, drawdown, net alpha |
| Adaptive widths improve risk-adjusted economics | Fixed widths versus volatility/fee-aware selection | Net alpha, worst periods, time outside range |
| A viable deployment size covers costs without excessive market impact | The seven user-selected total portfolio sizes, each at 80% maximum deployment and with a matching fixed-range control | Net alpha in USDG and percent, fees/costs, active-liquidity share, swap impact and capacity failures |
| Deployment and intervention settings support the intended policy | Deployment levels under the same 60% intervention rule, evaluated separately from recenter changes | Risk-driven sales, threshold overshoot/duration, costs and net alpha |
| Overnight liquidity is worthwhile | Same policy by market session, including reopenings | Net contribution after costs and subsequent inventory losses |
| The current fee tier is appropriate | NVDA 0.05% versus 0.30% over overlapping dates | Executable capacity, fee share, cost and net alpha |

First establish a fixed manifest of pools and block intervals, initialization/state validation, canonical coverage, reference availability and receipt coverage. Include the ±5% reference rule, exact initial portfolios, controls, decision/availability/execution clocks, scorer inputs and terminal accounting convention. Enrich missing block timestamps through HyperSync. Do not infer event time from ingestion timestamps or constant block times. A blanket archival RPC dependency is unnecessary for these event-history experiments; identify any specific historical state call that cannot be reconstructed before deciding how to obtain it.

Stream events in block, transaction and log order. Reuse [replay state](../src/replay/state.ts) for tick/liquidity reconstruction and [accounting math](../src/accounting/math.ts), extending the latter's use to hypothetical positions that cross ticks. Reconstruct swap steps and protocol fee changes, then reconcile fee attribution to captured chain fee-growth checkpoints and known positions before trusting economic results. Post-swap price alone is insufficient for assigning all fees across a crossed range. Missing inputs remain explicit.

Use three evidence layers without delaying all useful work until every field exists:

1. Full-history price, range, inventory and turnover screening. This can reject badly behaved policies without claiming verified net profitability.
2. Economic replay where fee reconstruction is validated, using matched historical costs where applicable and separately labeled conservative cost scenarios elsewhere. Reference-aware variants use only periods with adequate reference evidence. Historical on-chain rounds may need targeted enrichment; the newer perp/reference tables do not automatically cover July.
3. Forward paper execution of the selected policy using current pool state and its actual proposed transaction sequence. This validates executable sizing, gas, slippage and lifecycle behavior beyond event replay.

For NVDA 0.05%, a provisional split is July 21–August 16 development, August 17–30 rolling validation, and August 31–September 6 untouched final holdout. Freeze these boundaries before strategy result inspection; change them only for documented data defects. Use trailing-only estimates, causal reference joins and an embargo at least as long as the longest forward outcome label around scored split boundaries. Historical lookback may warm up from the past; future outcomes cannot enter fitting. Other pools can test transferability later. Seven weeks still cannot prove robustness across all market regimes.

Keep the existing six-hour paper policy as an operational baseline, and add a fixed-range control with the same initial inventory, 20% idle cash, experiment start/stop, reference/risk rules and terminal accounting as the active candidates. The control makes no discretionary recenter, width or swap changes; mandatory risk actions still apply and are recorded. Use the same deployment fraction within each controlled comparison. Test reserve changes and removal of the six-hour exit as separate comparisons so those benefits cannot be attributed to active range management.

Compare that matched fixed-range control, naive edge recenter with forced balancing, inventory-preserving recenter, and the combined adaptive cost-sensitive candidate. Vary one feature at a time before assessing the combined policy. Use identical initial capital and a predeclared common passive benchmark with fixed token quantities; charge any policy-specific conversions. Keep that benchmark unchanged through all rebalances. Report absolute NAV and alpha separately, with a cash benchmark as context.

Value every policy, fee tier and benchmark at the **same timestamped independent reference in USDG** at each scored observation. The [current paper ledger](../src/paper/transaction-engine.ts) uses its own pool spot; do not carry that convention into cross-pool economic ranking. Pool execution state still determines LP token amounts and swap feasibility. Where a valid common mark is missing, retain inventory/turnover screening and labeled pool-mark sensitivities, but make reference-valued NAV/alpha unavailable. An accepted held reference produces an explicitly held-reference mark, not a current executable valuation.

Predeclare terminal treatment. Report common-reference portfolio NAV separately from executable liquidation proceeds. For any comparison scored on liquidation, apply the same liquidation convention to every strategy and the passive benchmark, including each portfolio's actual conversions, gas and slippage. Missing liquidation evidence makes that metric unavailable; do not compare one strategy's cash proceeds against another's uncharged inventory mark as though both were liquidation results.

Historical market flow is counterfactual once we add liquidity. Include our liquidity in the fee-share denominator for each active segment and stress dilution, price impact and strategy capacity. An unchanged historical price path remains an approximation even after this correction. Keep current size small in execution research; larger notional sensitivity is not authorization to increase funds.

Stress 2× gas, 50% lower fee income, 30/60/120-second execution delay in addition to observation/confirmation delay, reference outages, partial transaction failures and 2–5% jumps. Include reference moves and jumps just beyond both ±5% bounds to check breach handling; a tolerated band cannot prevent the market from crossing it. These are scenarios, not estimated probabilities. Measure net alpha, absolute drawdown, worst session/day, inventory exposure, threshold overshoot/duration, fees versus costs, time out of range, turnover and action reasons. Attribute mandatory risk-action costs separately from discretionary recenter costs. Avoid selecting a policy whose apparent edge comes from a few lucky intervals or disappears under modest costs. If none beats the benchmark credibly, investigate a different fee tier, pool or strategy rather than relaxing accounting or the user's ±5% tolerance.

## Implementation sequence and dashboard

1. Produce the bounded historical comparison above, beginning with coverage/timestamps and crossing-aware accounting. Preserve raw inputs and a run manifest containing the matched controls, common valuation, decision timing and complete scenario scorer. Freeze these definitions before validation. Do not refactor unrelated services to do this.
2. Select one or two candidates on validation data, freeze parameters, and evaluate the untouched holdout. Publish verified results separately from modeled sensitivity and unavailable metrics.
3. Add the selected policy as a pure decision module shared by replay and paper. Extend the execution adapter with the concrete rebalance and risk-withdrawal paths and preserve a continuous portfolio ledger across positions. Differentially check inventory/fees against contract execution, including crossings, expired references, ±5% breaches, threshold overshoot and partial failures.
4. Run forward paper for 7–14 days spanning opens, overnight and a weekend, with enough naturally occurring recenter/rebalance actions to inspect. Supplement rare failure paths with deterministic fixtures rather than forcing unnecessary trades. Paper remains signer-free.

The dashboard should show total NAV, fixed-benchmark alpha, inventory exposure, idle cash, current range/price, net fees after execution costs, reference regime/age/expiry, latest valid accounting coverage, last action and the reason for the next proposed action. Display the selected independent reference, its **−5%/+5% bounds**, current deviation and any band/60% inventory-threshold breach with its duration. Distinguish pending withdrawal from completed withdrawal and from token liquidation. Label the valuation basis and separate common-reference NAV from executable liquidation value. Separate measured receipt costs, fork estimates and historical cost scenarios. Show backtest and paper series distinctly. An out-of-range position should display its actual inventory and zero inactive fee accrual, not disappear into an invalid session.

This keeps the next work focused on the unanswered economic question: does active management improve this pool's net outcome enough to pay for its added trading?
