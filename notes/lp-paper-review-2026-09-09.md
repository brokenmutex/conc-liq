# LP backtesting papers: evidence and implications

Reviewed 9 September 2026. The user ended the four-arm comparison and retained the transaction-paper campaign. No new parameter sweep, learned model, strategy policy or execution change was started. The [comparison end record](lp-comparison-2026-09-09/ended.json) preserves its losses and open-position marks. This review is an input to a later research decision.

## Sources and version boundary

The original article is [Backtesting framework for concentrated liquidity market makers on Uniswap V3 decentralized exchange](https://doi.org/10.1016/j.bcra.2024.100256). ScienceDirect direct access returned 403; the [authors' full preprint](https://arxiv.org/html/2410.09983v1) was reviewed. Its fitted liquidity profiles reproduce aggregate historical fees; the sub-1% result is calibration over the fitted period, and monthly mismatches remain. It demonstrates useful simulation machinery, without establishing an independently profitable active strategy. Its gas assumptions are fixed Ethereum scenarios. [Sections 4–6](https://arxiv.org/html/2410.09983v1#S4)

The follow-up initially appeared as [Liquidity provision with τ-reset strategies: a dynamic historical liquidity approach, v1](https://arxiv.org/html/2505.15338v1). It trains allocation models from retrospective fee-maximizing labels, with fixed capital per training epoch, and tests September 2024 after training on April 2023–June 2024. It uses a fitted liquidity approximation for retrospective evaluation. Its fee-only study omits holding as a benchmark. [Sections 2.4 and 4](https://arxiv.org/html/2505.15338v1#S2.SS4)

The [current revision, v2, dated 30 March 2026](https://arxiv.org/abs/2505.15338v2), is titled **Dynamic Liquidity Provision in Decentralized Markets: Strategy Optimization and Performance Evaluation in Concentrated Liquidity AMMs**. Earlier comments about v1 must not be generalized to every section of v2.

## What the revision adds

The fee-optimization target remains, but a separate capital-management experiment adds holding, reinvested fees and final wealth. In its September 2024 example, 1m USDC becomes 809.8k under the ordinary τ=5 rule, versus holding at 1,035.5k. A downward empty-buffer variant at η=20 ends at 1,054.4k, with nine reset epochs versus 55. The buffer permits time outside earning liquidity before resetting. These are one-month modeled outcomes; annualized figures are not year-long observations. [Section 5.5, Tables 3–4](https://arxiv.org/html/2505.15338v2#S5.SS5)

My interpretation: separately controlling earning width and reset distance merits consideration. This example does not select our tick width, capital size or guard settings. Choosing a buffer after viewing the same evaluation month needs a new untouched test.

## Static check of the public implementation

I inspected one [USDC/ETH 0.3%, τ=5 notebook](https://github.com/AndreyUrus/Uniswap-v3-LP-dynamic-tau-strategies-research/blob/69a5b753cb5c36cdb3a71807e27172a3b03b0608/USDC_ETH_03/tau_5/p1_case3_t5.ipynb) at commit `69a5b753cb5c36cdb3a71807e27172a3b03b0608`. It was read as text, never executed; no models or pickle files were loaded. [Source identity](lp-paper-review-2026-09-09/source-audit.json) pins its hash and zero-based cell numbers. This is a 2025 implementation snapshot, not a reproduction of v2's new buffer experiment.

| Location | Confirmed implementation | Implication for reuse |
|---|---|---|
| Cells 13, 17, 31 | Nearest-time selection includes the selected bar's close | Can select a future timestamp; audit completed-bar availability. Actual affected-event count is unmeasured. |
| Cell 23 | Neural/tree learners use shuffled folds and retain the best fold model | Internal validation is not chronological. |
| Cells 25–26 | Ensemble fitting randomly splits predictions from models already fitted on portions of those rows | Validation contamination risk; rebuild with out-of-fold predictions. This alone does not prove September contamination. |
| Cell 7 | Explicit deletion list includes September evaluation timestamps | Require provenance for exclusions and quantify sensitivity. |
| Cell 38 | Fixed gas arithmetic covers every modeled bucket at epoch boundaries | Reconcile operation costs with actual actions. |

No reported return, training run or runtime speedup was independently reproduced. The pinned repository tree contains no separately named buffer/asymmetric implementation; that naming check does not prove such logic is absent from every notebook.

## Implications for conc-liq

Our [market replay](../src/experiment/market.ts) already reconstructs Swap, Mint, Burn, Flash and fee-protocol events, and checks price, liquidity and global fee growth against checkpoints. Our [portfolio model](../src/experiment/portfolio.ts) carries actual modeled inventory through actions. Preserving those checks is central to evaluating a narrow position. Replacing that observed history with a fitted average-liquidity curve would introduce a new approximation requiring independent validation.

Our current risk and execution constraints also matter. The 60% reference-valued NVDA guard can force an exit before a proposed waiting zone is reached. Waiting outside a range can retain concentrated risky inventory while earning no fees. A hypothetical buffer would therefore need inventory-aware evaluation; it does not justify relaxing that guard. The independent ±5% true-price band and held-session reference rules remain unchanged.

The research decision should distinguish three questions:

- **Accounting:** Can modeled fills, fees, action costs and liquidation reconcile to the transaction-paper baseline? Fresh transaction-specific gas and the proposed rolling-median admission gate remain unfinished.
- **Management:** Which actions improve subsequent net alpha from the inventory actually held, including the opportunity cost of waiting and all costs of changing position?
- **Prediction:** Do features available before the decision identify when a management rule works on later data? Fit transformations on training data; use chronological folds and completed observations. A hindsight label can be a training target, but must never be an input available at the original decision.

These are questions for the next design discussion, not a selected experiment grid. Keep absolute wealth, a common passive-holding comparator, fees and execution drag separate. Any learned allocation must be tested against simpler rules under the same capital, timing and reference constraints. Retain adverse and unavailable-data episodes with explicit provenance. A separate unseen weekend remains necessary for a weekend-specific conclusion.

The useful research direction is to examine when management adds value before choosing a larger parameter search or ML stack. The paper trade continues collecting operational evidence while the comparison remains ended.
