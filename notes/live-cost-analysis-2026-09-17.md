# Live NVDA/USDG campaign: where the recentering cost went — 2026-09-17

Read-only analysis of the complete 250-USDG live campaign (`f8affe19`, 2026-09-12 14:24 to 2026-09-15 05:50 UTC, 302 mined transactions, nonces 0–301). Ledger extracted read-only from `live_pilot_v1`; receipt-valued gas reconciles exactly to the campaign's 9.561928 USDG. Evidence and scripts: `data/live-cost-analysis-2026-09-17/` (`extract.mjs`, `decompose.py`, `routes.mts`, `kyber-simulate.mts`, outputs `decomposition.json`, `routes.json`, `kyber-simulation.json`). No service, policy or transaction was changed.

## Cost decomposition

Total cost 12.78 USDG = 9.56 gas + 3.22 swap shortfall, against 7.38 USDG of collected fees.

| Gas by action | n | USDG | share | avg gasUsed |
|---|---:|---:|---:|---:|
| mint (incl. 3 reverts) | 46 | 3.88 | 40.6% | 435,008 |
| swap | 58 | 2.02 | 21.2% | 156,783 |
| withdraw+collect | 43 | 1.86 | 19.4% | 212,820 |
| approve | 155 | 1.80 | 18.8% | 48,129 |

Effective gas price was 0.069–0.41 gwei (median 0.083), priority fee always zero, ETH valued at 2,470–2,590 USDG; receipts report no parent-chain gas component, so cost is proportional to `gasUsed`, not calldata size. Swap shortfall against pre-trade spot was 3.22 USDG on 6,277 USDG of swap notional (5.1 bps): 3.14 is exactly the 0.05% pool fee, only 0.08 is price impact. Median swap was 111–115 USDG.

| Phase | tx | gas | swap shortfall | all-in | share |
|---|---:|---:|---:|---:|---:|
| recenter (38 episodes) | 188 | 6.20 | 1.83 | 8.04 | 62.9% |
| entry (11) | 55 | 1.97 | 0.70 | 2.67 | 20.9% |
| exit (12) | 59 | 1.39 | 0.69 | 2.08 | 16.3% |

Eight of the twelve exits were infrastructure or evidence timeouts (`private_block_lag_hard` ×3, `paper_chain_pause_expired` ×2, `paper_risk_pause_expired` ×2, `paper_current_risk_evidence_invalid`); four were operator actions. An exit-plus-re-entry round trip cost about 0.42 USDG, so timeout-driven churn cost roughly 3.3 USDG, a quarter of the campaign's costs, before counting lost fee time. Holding time was 47.8 of 63.4 hours.

| Recenter episode | n | tx | approvals | gas | swap shortfall | all-in |
|---|---:|---:|---:|---:|---:|---:|
| before persistent allowances | 19 | 7 | 4 | 0.193 | 0.046 | 0.239 |
| after persistent allowances (from Sep 14 08:38 UTC) | 19 | 3 | 0 | 0.134 | 0.051 | 0.184 |

Post-allowance composition: mint 0.071 (39%), swap pool fee and impact 0.051 (28%), withdraw 0.034 (19%), swap gas 0.027 (15%), approvals 0.001. At 19 recenters per holding day this is about 3.5 USDG/day (1.4% of capital) against about 3.7 USDG/day of fees.

## Routing evidence

All 58 swaps were re-quoted at their source blocks through QuoterV2 for fee tiers 100/500/3000/10000 (saved fee-500 quotes reproduced exactly, 0 mismatches). The 3000 pool beat the 500 pool on 19/58 swaps, median +4.2 bps, total +0.64 USDG gross (5% of campaign cost) at the same router gas; across all 58 it was a median 7.7 bps worse, so the choice must be quoted per trade. The 100 pool is unusable (−2,800 bps median), the 10000 pool has no liquidity.

KyberSwap aggregator quotes for 100 and 250 USDG buys routed through a Uniswap v4 pool plus a second v3 pool and were 6.0–7.6 bps above the best direct v3 quote; 0.5–1.0 NVDA sells routed to a v4 pool at +6.5 bps. The built calldata was simulated with `eth_call` from the real operator wallet using a state override on USDG's allowance mapping (slot 3, found by override probing): the buys executed and returned 2.0–3.3 bps less than Kyber's quote, still 3.6–5.6 bps above direct v3. Sells could not be simulated because the wallet holds no NVDA (a balance override would be needed). Kyber's router needed 467–493k gas (0.10 USDG at campaign prices) versus 157k for SwapRouter02 (0.033), so at the campaign's typical 115-USDG swap the route gain (~0.06) does not cover the extra gas (~0.066); it becomes positive above roughly 150 USDG per swap. Kyber's own `gasUsd` (0.055–0.058) understates that cost.

## Levers, ranked by effect on recentering cost

1. Capital size. Every action cost is fixed in USDG; at 250 USDG a recenter is 7.4 bps of capital, at 1,000 USDG it is 1.8 bps. Impact was negligible at 115-USDG swaps, so size, not routing, is the first lever.
2. Recenter count. Each avoided recenter saves 0.18–0.20 USDG. This is the width/adaptive question now under paper test.
3. Timeout exits. Holding through short chain and risk-evidence pauses instead of exiting to cash removes about a quarter of campaign cost with no strategy change; the current 60 s chain / 30 s risk pause allowances are the trigger.
4. Swap-free recentering. Minting a one-sided range from held inventory removes swap gas, pool fee and router approvals: about 0.078 USDG (42%) per episode, at the price of a one-sided position. The Sep 11 recenter study's token-preserving variant did not outperform, so this needs a fresh replay with the current 24/7 policy.
5. Cheaper mint path. Mint is 39% of a recenter because each move creates a new NFT (435k gas). A minimal executor minting on the pool directly and doing withdraw, swap and mint atomically would cut gas and remove two confirmation waits; it needs a contract, audit and new reconciliation.
6. Per-trade best quote. Quote 500 and 3000 (and later v4 directly, not via Kyber's router) and take the best net of gas: about +5% on this campaign for free.

Aggregator guard: quote every candidate route with `eth_call` (QuoterV2 for v3, the v4 quoter for v4), then simulate the exact calldata from the operator with allowance/balance overrides at the source block, and accept only if simulated output net of the route's own gas beats the direct pool by a minimum margin. Reject when simulated output is below the quote by more than the slippage bound.
