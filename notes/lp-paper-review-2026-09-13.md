# Research paper review — 13 September 2026

The most useful next research direction is **adaptive range selection with an explicit economic test before recentering**. Use the optimal-provision paper to form candidates, the hedging paper to improve exposure diagnostics, and retain the leverage paper for a future borrowing study. These are research recommendations; this review does not establish profitable parameters.

Reviewed the full PDFs and their appendices, checked selected equations visually, and compared them with the working tree at `f1e1cdb`. Existing uncommitted research work was preserved. Project observations below refer to inspected code and dated evidence artifacts, not a new audit of running services or balances. No policy, worker, funding or execution setting was changed.

| Paper and inspected version | Authors | Priority for this project |
| --- | --- | --- |
| [Concentrated Liquidity with Leverage, 2409.12803v1](https://arxiv.org/pdf/2409.12803v1), 13 pages | Atis Elsts, Krešimir Klas | Low now; useful if borrowing becomes a separate objective |
| [Predictable Loss and Optimal Liquidity Provision, 2309.08431v3](https://arxiv.org/pdf/2309.08431v3), 36 pages | Álvaro Cartea, Fayçal Drissi, Marcello Monga | High; candidate width and profitability model |
| [Delta Hedging Liquidity Positions on Automated Market Makers, 2208.03318v3](https://arxiv.org/pdf/2208.03318v3), 11 pages | Adam Khakhar, Xi Chen | Medium for diagnostics; lower for an executable hedge |

**Project fit.** The inspected [AAPL policy](../config/paper-aapl-5000-recenter-continuous.json), [GOOGL policy](../config/paper-googl-5000-recenter-continuous.json) and [September 13 expansion record](paper-asset-expansion-2026-09-13.md) describe 5,000-USDG paper campaigns with full allocation, ±20 raw ticks, outside-range recentering, net funding swaps, continuous hours and no inventory cap. Existing reference and execution guards remain. Twenty raw ticks are about 0.20019% from the chosen center, with discrete center alignment; this is not ±2%. The separate NVDA live pilot is documented in [its controller runbook](live-pilot-controller-2026-09-12.md).

[Recenter decisions](../src/paper/recenter.ts) currently start from an outside-range condition and require a later, guarded simulation. [Fee accounting](../src/paper/diluted-fees.ts) reconstructs canonical segments and includes our added liquidity in the denominator. [Portfolio accounting](../src/paper/transaction-engine.ts) already separates NAV P&L from alpha against preserved passive inventory. These capabilities should be reused.

The older [recenter study](lp-recenter-study-2026-09-11/README.md) tested a different policy: roughly 940 USDG, 80% allocation, inventory caps and a persistent displacement trigger. At its 80% cap, net-swap recentering reduced time outside range from 9.083 hours to 5.100 minutes but increased estimated costs. The [common-gas audit](lp-cost-validity-2026-09-11/README.md) found mean net cash P&L of −1.512033 USDG for holding the range versus −2.740670 for net-swap recentering at 0.20 gwei. These were three correlated historical windows, not evidence about the current 5,000-USDG campaigns or all recenter rules. They show why range coverage alone cannot select the next policy.

**Optimal provision: use the model to generate candidates.** For zero drift, Equation 24 gives total spread `δ* = 4γ / (8π − σ²)`: π is pool fee income per pool value per unit time, σ² is return variance per matching unit time, and γ models concentration-related missed fees. The control maximizes expected log terminal wealth. Gas is outside the continuous optimization. Table 3's 0.0047% mean one-minute return excludes gas; the authors' 84.8-USD operation estimate implies about 1.8 million USD break-even capital. The empirical test sets drift to zero. [Sections 3–6](https://arxiv.org/pdf/2309.08431v3).

For our implementation, compare a small set of valid tick ranges rather than translate an analytic optimum directly into an order. Fit only on information available before a decision. Candidate inputs should include pool activity, depth across candidate ticks, position size, realized pool-price variation, session regime and independent-reference uncertainty. A held equity reference cannot establish that the underlying is quiet. Treat reopening gaps and corporate-action transitions separately from ordinary pool returns.

Start with symmetric ranges. A reference-price discrepancy can reflect stale information, token scaling or basis, so it is not automatically a directional forecast. Any later skew experiment should demonstrate predictive value after those effects and should be evaluated separately from changing width.

Use this project-specific decision rule over a fixed evaluation horizon:

`expected terminal NAV after proposed action − expected terminal NAV if we keep the present portfolio > uncertainty allowance`

Both alternatives must include their own future fees, actual token inventory, gas, swap output, residual balances and exit treatment. The present portfolio may be out of range and one-sided. Evaluate keeping it, deploying existing tokens, swapping to fund a new range, or reducing exposure. A new optimal-looking width does not itself justify paying to move there. Mandatory safety actions remain governed by their existing rules.

The expected-NAV comparison is a proposal, not a validated estimator. Initially, report the score and subsequent realized comparison offline. Establish whether it forecasts incremental net benefit before allowing it to control a paper campaign.

**Avoid duplicating economic losses.** Our replay already accounts for inventory changes through principal balances and executable swaps. Adding a theoretical predictable-loss charge to that realized NAV would count part of the loss twice. Similarly, actual missed fees while outside a range should not receive an additional concentration penalty in realized accounting. Analytical penalties can help a forecasting model; the canonical portfolio ledger remains the performance measure. Keep markout/adverse-selection diagnostics separate from LP alpha and do not label the entire alpha residual as LVR.

The current finite-size fee calculation also makes scaling important: a bigger deposit does not preserve a small-position fee rate indefinitely. Forecasts should use candidate-specific diluted fee shares. They must retain the existing caveat that adding liquidity can change subsequent routing, prices and volume, which the fixed historical path does not simulate.

**Hedging: use the distinction between return and exposure.** The paper fits option portfolios to offset an LP's terminal principal P&L using least squares with a sparsity penalty; its payoff definitions include premiums. Demonstrations use ETH and BTC options. This is a terminal-payoff fit, not a time-series validation of an actively recentered portfolio; option expiry and available depth matter. [Sections 3–6](https://arxiv.org/pdf/2208.03318v3).

Keep both existing performance measures. Absolute NAV answers whether capital grew; alpha against the same initial passive inventory answers whether managing the LP added value. A hedge changes the strategy's exposure and consumes capital, so a future comparison must include the hedge wallet, collateral and costs in the same budget, plus an exposure-matched benchmark.

The immediate addition worth investigating is a diagnostic for total risky-token exposure: tokens in the LP, idle balances and accrued token fees. Under ideal v3 mechanics with the pool tracking the valuation price P, fixed liquidity L and bounds a < P < b, direct differentiation gives:

`V(P) = L(2√P − √a − P/√b)`

`delta = dV/dP = L(1/√P − 1/√b)`

`gamma = d²V/dP² = −L/(2P^(3/2))`

Here amounts and prices use consistent human token units. Delta is the risky-token quantity in the position. Add idle and accrued risky tokens to obtain portfolio exposure. Outside the range, the principal is either all risky token or all quote token; exact boundary valuation remains piecewise. This is an analytic diagnostic, not a replacement for integer accounting. A first-order short can offset delta locally while leaving curvature and jump losses. Pool/reference divergence requires separate scenarios rather than silently assuming these prices agree.

For a stock-token hedge, establish the conversion from canonical token units into hedge-underlying units, including the current corporate-action multiplier. Do not apply a multiplier again to an already adjusted per-token oracle price. Any hedge study would need verified instruments, matched expiry/horizon, tradable sizes, bid/ask depth, settlement currency, margin, funding or borrowing charges and access during the relevant hours. That evidence has not been collected in this review. Changing an LP range also changes its payoff and can require replacing the hedge.

**A mathematical issue to avoid copying.** Appendix E.2 uses the full-range quantity `2√(κP₀)` as an intermediate initial-value denominator for CL; D.2 makes a similar full-range substitution for passive holdings. These are inconsistent with finite-range actual reserves. The generic actual-balance P&L formula is usable. [Appendices D.2/E.2, page 11](https://arxiv.org/pdf/2208.03318v3).

Independent counterexample: choose L = 1, P₀ = 1, a = 0.81, b = 1.21. Actual initial reserves are x₀ = 1/11 and y₀ = 1/10, so V₀ = 21/110, approximately 0.190909. The full-range virtual value is 2. At an unchanged price the correct principal return is zero; using the intermediate denominator would report approximately −90.4545%. This calculation checks the printed substitution, not the authors' reported empirical outputs. The [authors' v3 runner](https://raw.githubusercontent.com/adamkhakhar/lp-delta-hedge/main/src/v3_experiment_runner.py) subtracts a configured initial portfolio value, so the appendix issue alone does not establish that the experiments used that denominator. Reuse our [existing position math](../src/research/portfolio-math.ts), not the inconsistent simplification.

**Leverage: retain for a separate research branch.** The paper models margin as assets divided by debt and proves endpoint-based interval solvency checks for a fixed position/collateral/debt configuration. Its spot-manipulation argument assumes an accurate oracle and an initially matching pool price. Short-term calculations omit swap and borrowing fees. It supplies solvency machinery rather than an empirical return strategy. [Sections 2–3](https://arxiv.org/pdf/2409.12803v1).

Borrowing is not presently the missing ingredient in our range-management research. Before considering it, we would need verified lending access for the exact tokens, capacity and interest histories, enforceable liquidation mechanics and an executable unwind through adverse market and infrastructure conditions. No such venue assessment was performed here.

The useful future artifact would be a stress calculator that reports collateral, debt, equity, token exposure and liquidation headroom at each candidate price and time. It must accrue interest and model price gaps, reference lag and exit costs. An endpoint result for a fixed balance sheet cannot certify a time path containing recentering, debt changes or failed actions. Treat the paper's manipulation result as a narrowly defined valuation result, not permission to relax our reference-price guards.

**Recommended bounded experiment.** First address the historical fee-boundary coverage gap: the September 13 AAPL/GOOGL replays stopped when an initialized boundary disappeared, leaving complete-week P&L unavailable. A width search would otherwise favor ranges with convenient evidence. Support hypothetical boundaries with independently reconciled swap-step accounting, or report a clearly restricted common-coverage comparison and its exclusions. Do not turn an accounting failure into zero income or reset the campaign benchmark.

Then compare these candidates on the same captured streams and starting portfolios:

| Candidate | Width choice | Move decision | Purpose |
| --- | --- | --- | --- |
| A | Existing ±20 raw ticks | Existing outside-range rule | Current-policy baseline |
| B | Small frozen grid of wider ranges | Same outside-range rule | Determine whether simple width changes suffice |
| C | Causal adaptive width | Outside-range rule | Isolate value of width prediction |
| D | Same adaptive width | Incremental expected-NAV test | Isolate value of avoiding uneconomic moves |

A fee-forecast model should first beat a simple trailing-rate baseline out of sample. Keep its units explicit: a 500-pip fee tier is not a daily portfolio yield, and a total spread is not a half-width. Validate the square-root-price to tick conversion, token order and boundary rounding with the repo's exact math. Reject infeasible analytical candidates instead of silently clipping them into a claimed optimum.

Use contiguous development, validation and untouched test periods. Freeze lookbacks, candidate widths, decision horizons and thresholds before the test; do not consume the separately frozen September 14 validation window for tuning. Report paired per-session-regime outcomes across regular hours, premarket, after-hours, weekend and reopening when covered. Historical market data richness is distinct from usable reference and execution evidence.

Charge complete entry, recenter and exit paths at comparable gas regimes, with delay, rejected quotes, failed transactions and residual exposure. Preserve each scenario's full decision path when stressing gas, fees and gaps. Record net LP alpha, NAV P&L, drawdown, inventory, deployed capital, fees, gas, swap shortfall, range occupancy, moves and accounting/decision coverage. Keep simulated, estimated and receipt-measured costs explicitly labeled.

Promote a candidate only after usable holdout evidence shows that it improves net outcomes with acceptable exposure and execution behavior. A promising outcome supports a new bounded paper comparison; these papers alone do not authorize a live policy change, derivative position or loan.

The subsequent [108-portfolio adaptive LP study](adaptive-lp-study-2026-09-13/README.md) completed this bounded retrospective comparison. It supports further forecast research, but neither adaptive rule earns promotion. Its virtual-boundary fee accounting is explicitly conditional on recorded market flow, and the separately reserved prospective window remains excluded.

PDF SHA-256 values at retrieval:

```text
2409.12803 1904c8c0be92b9d37fdb65e0ca36973e0b6d159f753cefeeeff470142b3dc265
2309.08431 766e8ead4ff0e36c78d47b410f56dfb51fb09604bc462412b427640fb4556cd0
2208.03318 13330aa39866325870d45a7cc44239cae3a3c3b8576c01606595798df0b488c0
```
