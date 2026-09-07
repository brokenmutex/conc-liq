# Active LP strategy proposal — 2026-09-07

Status: research proposal; no policy or service changes. Historical strategy performance has not yet been backtested. The next milestone is a bounded comparison using the existing database, followed by transaction-faithful forward paper trading of the selected policy.

## Recommendation

Develop a 24/7, volatility-adaptive LP policy that manages inventory and pays to recenter only when the expected improvement justifies it. Separate moving liquidity from swapping tokens. Optimize net LP alpha against a fixed passive-holding benchmark, alongside absolute NAV, drawdown and inventory exposure. Remaining in range or collecting the most fees is not the objective by itself.

Start with one active NVDA/USDG position and a cash reserve. Compare NVDA's 0.05% and 0.30% pools in research before assuming the current venue is optimal. Avoid adding hedges, many simultaneous positions or automatic cross-pool rotation before the simplest active policy demonstrates value.

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

### Range selection and recentering

Evaluate a small menu: keep the current position; recenter with existing tokens; recenter with a minimal swap; widen/reduce liquidity; remove liquidity and hold inventory. Evaluate liquidation separately when risk or the experiment's terminal accounting requires it.

Use a filtered recent pool price to locate executable liquidity, recent realized volatility and fee income per unit of active liquidity to select width, and independent references to constrain exposure. The pool's own TWAP is not independent confirmation of fair value. Initially test half-widths of 0.5%, 1%, 2% and 4%, with exchange tick rounding. High volatility generally favors wider ranges or less deployed capital; low volatility alone does not justify concentration without enough fee flow.

Seed a routine recenter trigger at 70% of the distance from the range center to its boundary, persisting for two fresh observations, with a ten-minute cooldown. Check hard inventory limits and an actual range exit immediately. Persistence and cooldown reduce churn during oscillation; they must reflect actual observation cadence and execution latency. All these numbers are experimental settings, not fitted recommendations.

When price exits, accrue only fees actually earned, maintain the one-sided inventory, and evaluate waiting versus redeployment. A transient excursion may reverse before a costly recenter pays for itself. Missing event coverage should still make the affected result unavailable; an ordinary crossing should not.

### Inventory management

For the first candidate, test 80% maximum deployed capital with 20% idle USDG. A near-symmetric initial LP then starts with approximately 40% of total NAV exposed to NVDA. Test a soft NVDA exposure band of 30–50% of total strategy NAV and a hard maximum of 60%. Include wallet tokens, LP principal and claimable fees in exposure. The lower soft bound is a deployment preference, not a requirement to buy during unsafe conditions. Cash is an allowed outcome.

Prefer feasible redeployment using existing tokens and idle balances. If a swap is justified, trade the smallest amount that restores the chosen feasible allocation or returns exposure to the nearest soft boundary. Do not restore 50/50 mechanically. A hard exposure limit can require reducing risk even when the fee-based profitability test fails; record such actions separately.

As USDG/NVDA rises, an LP sells NVDA; on a fall, it accumulates NVDA. Repeatedly forcing a symmetric position after breakouts can buy back higher or sell lower. Recentring does not reverse those losses.

An inventory-heavy position can sometimes sell passively through a range above the current human-readable USDG/NVDA price; cash can similarly buy below it. Such orders may never fill, so they cannot enforce hard limits. Defer a second dedicated position until its incremental benefit covers its gas. Use exact token math to solve feasibility: NVDA is token1 in the current pool, so human price direction is inverse to the raw tick direction.

### Cost-sensitive action selection

Compare the projected terminal NAV of an action with leaving the current portfolio in place over the same horizon:

`incremental benefit = expected NAV after action − expected NAV after holding`

Both paths must include accrued fees, inventory changes, idle cash and all execution cashflows. Require a positive conservative margin after uncertainty and risk limits. Do not subtract a separate IL/LVR number again if those losses are already represented in the inventory ledger. Before predictive errors are calibrated, use explicit scenarios rather than a spurious statistical confidence bound.

An own-rebalance quote must cover withdrawal, collection, optional swap, redeployment, approvals when needed, gas and residual balances. Apply the actual execution path, including partial completion and retry costs if it is not atomic. The current 50 bps slippage ceiling is a safety maximum, not an acceptable loss budget for every action.

Historical receipts are real observations of other transactions; current fork results execute our proposed contract calls but remain simulations. Neither supplies an exact future mainnet cost. Use observed numbers where available, disclose their scope, and leave missing verified economics unavailable. Labeled cost sensitivity runs may screen hypotheses; they must not become execution-eligible profit claims.

Remove the arbitrary six-hour economic exit in the candidate. Reassess periodically and retain a predetermined experiment stop. Collect/compound while already transacting unless a standalone operation pays for itself.

### Overnight and closed markets

Remain eligible to provide liquidity 24/7. Test regular hours, extended hours, weekends and reopenings separately. Their profitability is an empirical question: neither closing every night nor assuming every overnight opportunity is profitable is justified.

Chainlink tokenized-equity feeds already incorporate Robinhood's multiplier and may hold a value when underlying markets are unavailable. An unchanged off-hours value is different from a broken feed; it is also not proof of current fair value. [Chainlink Robinhood feed documentation](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood).

Nasdaq or another timestamped equity feed can supply the underlying reference, provided the quote type, age, corporate actions, token multiplier and USDG conversion are correct. Do not multiply an already adjusted token feed again. A last-trade webpage is not an executable quote. Hyperliquid is an optional corroborating signal with its own basis and funding effects, not a mandatory anchor.

Treat held references as greater uncertainty: compare wider ranges, less deployed capital and tighter exposure ceilings. Do not blindly recenter to an old closing mark or automatically enforce a fixed ±3% band forever. Keep issuer pauses and corporate-action ambiguity as distinct risk states. A temporarily pending risk refresh should block increased exposure, while the last successful evidence is usable only within its explicit expiry. It should not masquerade as a confirmed issuer failure and force an unnecessary sale.

## Historical experiments: the next milestone

Use the existing database now. Build a bounded NVDA comparison on the existing event replay and exact bigint accounting, rather than another ingestion platform or general backtesting framework.

| Hypothesis | Controlled comparison | Primary evidence |
| --- | --- | --- |
| Persistence avoids churn | Immediate edge recenter versus persistent trigger/cooldown | Turnover, costs, net alpha, delayed-reentry losses |
| Inventory preservation beats forced balancing | Every recenter resets to 50/50 versus minimal-swap redeployment | Swap volume/NAV, exposure, drawdown, net alpha |
| Adaptive widths improve risk-adjusted economics | Fixed widths versus volatility/fee-aware selection | Net alpha, worst periods, time outside range |
| Overnight liquidity is worthwhile | Same policy by market session, including reopenings | Net contribution after costs and subsequent inventory losses |
| The current fee tier is appropriate | NVDA 0.05% versus 0.30% over overlapping dates | Executable capacity, fee share, cost and net alpha |

First establish a fixed manifest of pools and block intervals, initialization/state validation, canonical coverage, reference availability and receipt coverage. Enrich missing block timestamps through HyperSync. Do not infer event time from ingestion timestamps or constant block times. A blanket archival RPC dependency is unnecessary for these event-history experiments; identify any specific historical state call that cannot be reconstructed before deciding how to obtain it.

Stream events in block, transaction and log order. Reuse [replay state](../src/replay/state.ts) for tick/liquidity reconstruction and [accounting math](../src/accounting/math.ts), extending the latter's use to hypothetical positions that cross ticks. Reconstruct swap steps and protocol fee changes, then reconcile fee attribution to captured chain fee-growth checkpoints and known positions before trusting economic results. Post-swap price alone is insufficient for assigning all fees across a crossed range. Missing inputs remain explicit.

Use three evidence layers without delaying all useful work until every field exists:

1. Full-history price, range, inventory and turnover screening. This can reject badly behaved policies without claiming verified net profitability.
2. Economic replay where fee reconstruction is validated, using matched historical costs where applicable and separately labeled conservative cost scenarios elsewhere. Reference-aware variants use only periods with adequate reference evidence. Historical on-chain rounds may need targeted enrichment; the newer perp/reference tables do not automatically cover July.
3. Forward paper execution of the selected policy using current pool state and its actual proposed transaction sequence. This validates executable sizing, gas, slippage and lifecycle behavior beyond event replay.

For NVDA 0.05%, a provisional split is July 21–August 16 development, August 17–30 rolling validation, and August 31–September 6 untouched final holdout. Freeze these boundaries before strategy result inspection; change them only for documented data defects. Use trailing-only estimates, causal reference joins and an embargo at least as long as the longest forward outcome label around scored split boundaries. Historical lookback may warm up from the past; future outcomes cannot enter fitting. Other pools can test transferability later. Seven weeks still cannot prove robustness across all market regimes.

Compare the fixed-range baseline, naive edge recenter with forced balancing, inventory-preserving recenter, and the combined adaptive cost-sensitive candidate. Use identical initial capital and a predeclared common passive benchmark; charge any policy-specific conversions. Keep that benchmark unchanged through all rebalances. Report absolute NAV and alpha separately, with a cash benchmark as context.

Historical market flow is counterfactual once we add liquidity. Include our liquidity in the fee-share denominator for each active segment and stress dilution, price impact and strategy capacity. An unchanged historical price path remains an approximation even after this correction. Keep current size small in execution research; larger notional sensitivity is not authorization to increase funds.

Stress 2× gas, 50% lower fee income, 30/60/120-second execution delay, reference outages, partial transaction failures and 2–5% jumps. These are scenarios, not estimated probabilities. Measure net alpha, absolute drawdown, worst session/day, inventory exposure, fees versus costs, time out of range, turnover and action reasons. Avoid selecting a policy whose apparent edge comes from a few lucky intervals or disappears under modest costs. If none beats the benchmark credibly, investigate a different fee tier, pool or strategy rather than relaxing accounting.

## Implementation sequence and dashboard

1. Produce the bounded historical comparison above, beginning with coverage/timestamps and crossing-aware accounting. Preserve raw inputs and a run manifest. Do not refactor unrelated services to do this.
2. Select one or two candidates on validation data, freeze parameters, and evaluate the untouched holdout. Publish verified results separately from modeled sensitivity and unavailable metrics.
3. Add the selected policy as a pure decision module shared by replay and paper. Extend the execution adapter with the concrete rebalance path and preserve a continuous portfolio ledger across positions. Differentially check inventory/fees against contract execution, including crossings and partial failures.
4. Run forward paper for 7–14 days spanning opens, overnight and a weekend, with enough naturally occurring recenter/rebalance actions to inspect. Supplement rare failure paths with deterministic fixtures rather than forcing unnecessary trades. Paper remains signer-free.

The dashboard should show total NAV, fixed-benchmark alpha, inventory exposure, idle cash, current range/price, net fees after execution costs, reference regime/age, latest valid accounting coverage, last action and the reason for the next proposed action. Separate measured receipt costs, fork estimates and historical cost scenarios. Show backtest and paper series distinctly. An out-of-range position should display its actual inventory and zero inactive fee accrual, not disappear into an invalid session.

This keeps the next work focused on the unanswered economic question: does active management improve this pool's net outcome enough to pay for its added trading?
