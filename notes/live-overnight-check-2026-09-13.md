# Live overnight check — 2026-09-13

Verified at 05:22:53 UTC (08:22:53 Europe/Vilnius). Read-only investigation; no controller state, policy, or deployment changes and no transactions sent.

## Outcome

Campaign `f8affe19-4d89-4132-b214-d67e5ad81331` is halted with `unexplained_wallet_or_nft_change`, despite its service continuing to update the heartbeat. Paper campaign 60 → 61 remains open. Current node health has recovered (zero reported lag).

The post-fix live sequence, in UTC on September 12:

- 20:37:03: holding → recenter because price left the range, without a guard exit reason. NFT 1146954 was withdrawn, followed by approvals and a partial inventory swap.
- 20:39:19: recenter → exit on `private_block_lag_hard`. Health sample 70406 recorded 134 blocks / 12 seconds lag; the next sample reached 176 blocks / 18 seconds. This exceeded the agreed 30-block tolerance. Lag returned to zero at 20:39:38, with recovery hysteresis active.
- Remaining NVDA was sold and USDG allowances cleared. The final NVDA/position-manager allowance cleanup (7 raw units) was prepared but never signed.
- 20:42:57: the controller halted after detecting a native ETH balance increase. The preceding prepared approval was cancelled for requoting. Its generic cancellation reason does not establish a process restart.

Post-deployment transition records contain only `private_block_lag_hard` as a nonempty exit reason. No timing-related risk exit recurred in this observation period. There was one attempted recenter and no completed replacement mint; a dashboard count of zero completed recenters does not mean no management work occurred.

## Native balance reconciliation

The saved native balance was 3,939,741,662,050,000 wei. Fresh chain reads show 3,948,246,965,217,004 wei. The difference, 8,505,303,167,004 wei, exactly matches this successful canonical incoming transfer:

- Transaction: `0x67ad9c2baed56017de48ab72aeb090aefa2b71ecb5766ebfb9b33a2e3a702eb8`
- Block: 61397092, September 12 at 20:42:35 UTC.
- Sender: `0x46420963afd627be4d6350e10e5dd4f49bae0261`
- Recipient: pilot operator `0xdCC9348Ade9cA0A13249a44a63Db5411A8e72D52`.

The transfer's purpose and sender ownership are not established. It is an external native credit, not strategy earnings. `assertPilotWalletContinuity` requires exact native-balance equality and therefore halts on incoming deposits as well as unexplained outflows. USDG, NVDA, nonce, NFT count and allowances match the saved state. All six retained NFTs were independently read and have zero liquidity and zero tokens owed.

Machine-readable fresh chain evidence: `data/live-check-2026-09-13/chain-verification.json` (ignored runtime artifact).

## Accounting

- Gross wallet USDG: 298.675351, including 49.927111 excluded reserve.
- Managed USDG before recorded native gas cost: 248.748240.
- Recorded gas cost: 2.455281 USDG.
- Net strategy NAV: **246.292959 USDG**, or **−3.707041 / −1.4828%** against the initial 250.
- Change from the deployment baseline NAV 246.918760: **−0.625801 USDG**; additional recorded gas: 0.205935 USDG.
- Fresh passive benchmark valuation: 249.217440 USDG. The dashboard's older benchmark valuation is stale.
- New confirmed management transactions after deployment: one withdrawal, two swaps, seven approvals; no mint. One additional approval was cancelled unsigned.
- Paper campaign latest observed NAV: 4976.053120 USDG against 5000, with source time 05:21:08 UTC; this is a different campaign and observation window from live.

The fresh live net NAV uses the established recorded gas valuations and excludes the external native credit from profit. Dashboard heartbeat freshness must not be confused with valuation freshness: its live source still points to last night's exit.

## Next implementation priorities

1. Add auditable reconciliation for proven incoming native transfers, preserving strict checks on unexplained debits, token balances, nonce, NFT ownership/liquidity and allowances. Record external funding separately from P&L. Use this exact incident as a regression fixture before recovering this halted campaign.
2. Inspect the private-node interruption and the recenter approval loop. Exact required swap approvals changed repeatedly as price moved; this added transaction latency before the interruption. Keep approval exposure bounded when improving it.
3. Show a distinct halted state and stale valuation age in the dashboard, plus attempted versus completed recenter activity. A running service alone is insufficient evidence of an operating strategy.

Live remains halted following this check. Paper remains running.
