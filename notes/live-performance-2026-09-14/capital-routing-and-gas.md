# Capital, recenter routing, gas and KyberSwap — 14 September 2026

This follow-up uses the fixed live accounting cutoff in [the performance report](README.md), reads the current controller code, reproduces historical canonical quotes, and probes KyberSwap's public quote APIs. No configuration, allowance, signer, deployment or live position was changed. All API calls were quote-only GET requests.

Larger capital alone does not explain a path to absolute profit in the observed campaign. Before gas, the 250-USDG portfolio lost **2.626380 USDG**; gas then cost **5.423437 USDG**. A deliberately simple sensitivity, scaling all non-gas P&L proportionally and holding the same transaction count and gas bill fixed, gives:

| Original strategy capital | Illustrative net P&L | Illustrative net alpha vs holding |
|---|---:|---:|
| 250 USDG | −8.049817 | −6.086395 |
| 1,000 USDG | −15.928957 | −8.075269 |
| 2,500 USDG | −31.687237 | −12.053017 |
| 5,000 USDG | −57.951037 | −18.682597 |

The formula is `net_pnl(C) = -2.626380 * C/250 - 5.423437`. These are arithmetic sensitivities, not replayed returns. Larger positions change fee dilution, price impact, token ratios, pool state, possibly routing/flow and subsequent recenter decisions. Gas can also increase when swaps cross more ticks. A proper counterfactual must replace the actual small position with the larger one, not add hypothetical fee income on top of our already-present live liquidity.

The post-recovery window is closer to break-even: **−0.016504 USDG before gas in absolute terms**, and **+0.349139 USDG before gas versus the fixed passive inventory**, followed by **2.136720 USDG gas**. Under the same linear assumptions, post-recovery *alpha* crosses zero at an original-capital scale of about **1,530 USDG**. Absolute profit still does not cross zero in that approximation. This selectively shorter period, its tiny pre-gas margin, and its pool-spot valuation do not validate a deployment size or establish persistent edge.

Current recenter implementation is inventory-aware: withdraw and collect, trade the net imbalance required by the new range, then mint from retained inventory. It does not routinely liquidate the whole portfolio to USDG and buy it back. The solver incorporates the quoted swap's fee and effect on the LP pool's price. However, both quoting and execution are fixed to **NVDA/USDG Uniswap v3 fee 500**, using QuoterV2 and SwapRouter02 `exactInputSingle`. There is no venue competition, split routing or multi-hop search. See `src/live-pilot/chain.ts` and `solveRecenterSwap` in `src/paper/execution-recenter.ts`.

At the exact source blocks and exact input amounts of the **29 recorded successful swaps**, the current 500-tier quote reproduced the saved output every time. Alternative direct v3 quotes were tested at fees 100, 3000 and 10000. The 3000 tier returned more output on **six swaps**, all among the **14 recenter swaps**, despite its higher nominal fee. Combined improvement was **0.308084 USDG**, before extra gas and before recomputing the new range's inventory ratio.

| Recenter swap nonce | Better fee tier | Extra output valued in USDG | Improvement over 500-tier quote |
|---|---:|---:|---:|
| 84 | 3000 | 0.054140 | 5.612 bps |
| 90 | 3000 | 0.057698 | 5.986 bps |
| 96 | 3000 | 0.043954 | 4.152 bps |
| 110 | 3000 | 0.038259 | 4.588 bps |
| 134 | 3000 | 0.008815 | 0.824 bps |
| 155 | 3000 | 0.105218 | 7.372 bps |

The 100-tier quote succeeded at 17/29 sources and reverted at 12; the 10000 tier reverted at all 29. These unavailable quotes were not assigned invented output. The 0.308084 sum is a fixed-input opportunity diagnostic, not a realized saving or completed alternate-route recenter backtest. No historical v4/multi-hop comparison was run. An alternate venue also changes the target pool's post-trade state: its quoted sqrt price cannot simply be fed into the current solver as though it were the price of the LP destination pool.

At **07:02:19–20 UTC**, Kyber's Robinhood aggregator endpoint returned successful quotes for 100, 500 and 2,500 USDG buys and a 0.5-NVDA sale. All three buy routes selected the existing 500-tier v3 pool. The sale selected a Uniswap v4 pool and quoted **107.346609 USDG**. Our v3 quoter at the route's reported block **62,615,270** returned **107.133958 USDG** for the same input: **0.212651 USDG / 19.849 bps** less. Kyber estimated its own total gas at **$0.085023**. Those are provider quotes and estimates, not executed outputs or independently simulated calldata. Direct quotes were pinned to the advertised route block, but that does not prove all provider route state uses one exact canonical snapshot. Selection should compare final balances after all incremental gas, approvals, fees and mint effects.

KyberSwap's public [Robinhood Chain material](https://blog.kyberswap.com/what-is-the-best-place-to-provide-liquidity-on-robinhood-chain/) confirms aggregator and liquidity-tool support. Its [Zap Migrate API](https://docs.kyberswap.com/kyberswap-solutions/kyberswap-zap-as-a-service/kyberswap-zap-as-a-service-zaas-api/zaas-http-api) is relevant to bundling withdrawal, conversion and redeployment, but its economics differ from using only the swap aggregator.

A separate illustrative **same-pool/same-range migration** quote for current NFT **1162225** succeeded. This was a provider capability/fee probe, not an actual outside-range recenter or a matched comparison with the earlier median. It classified NVDA/USDG as `exotic_pair` and charged **250 pcm = 0.25%** in protocol fees: **0.153592 USDG + 0.001774903633395826 NVDA**, approximately **$0.532 by the provider's prices**, plus **$0.273970 estimated gas**. Initial NFT input value was approximately $212; idle wallet inventory was outside this probe. The returned plan sold approximately 0.708 NVDA through the aggregator and bought approximately 0.708 NVDA back through the pool. This particular plan therefore did not preserve our minimal-net-swap behavior. Its advertised final USD valuation is not accepted as a independently reconciled P&L result. No migration route was built, approved or submitted. The documented [Zap fee model](https://docs.kyberswap.com/kyberswap-solutions/kyberswap-zap-as-a-service/zap-fee-model) lists category-based protocol fees; this actual response confirms a fee applies to this migration quote.

Gas improvements should start with transaction structure. The 181-transaction audit contained **112 approvals costing 1.379909 USDG**, approximately 25% of total gas. Of the actions prepared during recenter phases, **63 approvals** accompanied **14 withdrawals, 14 swaps and 13 successful replacement mints**. The exact-input approval can become insufficient as the balancing amount changes while the controller waits; the planner then approves again. A bounded per-operation spending allowance can reduce that repetition while each swap/mint remains limited to verified managed inventory. Longer-lived bounded allowances require an explicit allowance/custody design, especially around the excluded reserve; they are not equivalent to removing spending checks.

An atomic withdrawal/net-swap/mint executor is another candidate. It can eliminate intermediate transactions and confirmation waits, although underlying pool operations still consume gas. Our manager and swap router are different contracts, so their existing per-contract multicalls do not by themselves combine the whole lifecycle. A dedicated executor or a proven migration service would change the execution architecture and needs complete accounting/recovery validation. Quote preparation to swap receipt currently averaged **9.75 seconds on the four buy recenters** and **16.6 seconds on the ten sell recenters**; full recenter completion was much longer. Faster management could also reduce stale ratios and immediate replacement churn.

Every saved intent already had **zero priority fee**. The 30% gas-limit buffer and 2× base-fee cap are bounds, not amounts automatically spent. Lowering them alone does not reduce gas used at the same effective price and could increase execution failures. The [EIP-1559 specification](https://eips.ethereum.org/EIPS/eip-1559) defines the distinction; the report uses actual receipt gas rather than the caps. Policy changes that reduce intervention frequency may save more, but they are not “exactly the same setup.”

FairFlow is a third, separate Kyber research track: a different LP pool/hook design, rather than a swap-router improvement. Kyber [documents it](https://docs.kyberswap.com/kyberswap-solutions/kyberswap-fairflow/solution-fairflow) as using restricted aggregator access and redistributing part of captured arbitrage value to LPs. Whether that improves our NVDA returns requires verified deployed pools, actual fee/reward distributions and net performance after costs. No FairFlow NVDA pool economics or compatibility were validated here.

The evidence prioritizes **quote-only routing comparison and bounded approval efficiency**, followed by an owned-fork atomic recenter comparison. Capital scaling and FairFlow belong in separately costed counterfactuals. Kyber aggregation is worth investigating; the sampled default Zap migration is not demonstrated to be a cost saving. Detailed probes and compact results are retained under `data/live-followup-2026-09-14/`; [quote summary](routing-summary.json) contains the historical and current comparisons without calldata or provider signatures.

The subsequent [execution-cost milestone](../live-execution-optimization-2026-09-14/README.md) tests bounded approvals and the alternate v3 swaps through actual forked mint execution, including their incremental gas and resulting LP inventory.
