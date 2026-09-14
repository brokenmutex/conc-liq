# Live persistent-allowance deployment — 2026-09-14

The user authorized activation after reviewing the stock-agnostic implementation and the required cash-exit/adoption/re-entry procedure. This deployment enables explicit finite per-token/per-spender budgets on the existing USDG/NVDA live pilot. It does not change the traded stock, range, price/reference policy, reserve or initial-capital accounting.

New sealed release: `11be421b9e15d23235951d99548573e0e1b98e4bcaa92dee5c127bd681821ddf`, source `6dcfd3798392ee05d7948811ff901557433347b2`, installed under `/root/conc-liq-releases/`. The prior release was `ea156df3f87e8538d6e13b7367589f590b6d97f9622f413a100abce0113ee079`. The implementation passed 484 tests in an isolated checkout and four signed-controller owned-fork scenarios before activation; see [implementation and validation](../stock-agnostic-allowances-2026-09-14/README.md).

The active configuration supplies 2,500 USDG (2,500,000,000 raw units) for each of the router and manager, and 10 NVDA (10,000,000,000,000,000,000 raw units) for each spender. Grants are lazy: a pair is approved only when an operation first needs it or its remaining allowance becomes insufficient. Token/spender authorization is configurable; the reusable engine has no stock symbol or decimals assumption. These are allowance budgets, not new deposits.

Before changing runtime state, the deployment copied and verified the sealed candidate, validated the proposed active config, retained the old unit/config, and matched deployed router/manager/token runtime hashes against the fork evidence. EIP-1967 implementation slots and any referenced implementation code were also compared against the proof source. The normal chain/factory/token-decimal checks and exact saved wallet continuity passed. This is a deployment identity check, not a new contract security audit.

The previous worker was instructed to stop through its normal controller. The first request collided with the worker's wallet lock and made no state change; the second succeeded. Six transactions, nonces 209–214, withdrew NFT 1162743, approved and sold remaining NVDA, and revoked residual permissions. All six confirmed. The campaign closed at **2026-09-14 08:38:35.935 UTC**, nonce **215**, with:

- 296.079785 wallet USDG, including the unchanged 49.927111-USDG reserve;
- zero NVDA, no active position and zero allowances;
- 0.002421779224839004 native ETH;
- 24 owned retired NFTs independently verified with zero liquidity and zero owed tokens.

Exit gas was **0.098143 USDG**, valued from canonical receipt gas valuations, or 0.000038908611772 native ETH. This is gas only; swap fees and price movement are not presented as gas savings or excluded from the campaign's continuing inventory accounting.

At closed custody the old service was stopped. The active configuration and service unit were replaced with their reviewed candidates. `adopt-allowance-policy` atomically saved the canonical policy and corresponding configuration; campaign ID, nonce, balances, fees, gas totals and retired NFT accounting were preserved. The new controller was resumed and `conc-liq-live-pilot.service` started on the new release. The existing ten-minute cooldown was retained, permitting re-entry from 08:48:35.935 UTC. There was no direct approval transaction, action replay, balance adjustment or reset of performance accounting outside the normal controller.

The private deployment evidence and old config/unit backups are in `data/allowance-live-deployment-2026-09-14/`. No keys or signed raw transactions are copied into this note. The old release alone is not an active-session rollback plan: persistent permissions and the saved policy must first be reconciled through the new controller. If reverting the policy, complete its normal exit and clear permissions before changing saved policy at closed custody.

## Confirmed re-entry

The first new-policy approval was submitted after the unchanged cooldown. Re-entry completed with **NFT 1162908**, campaign phase `holding`, desired state `running`, nonce **220**, and no pending action or halt. At verification (2026-09-14T08:52:01.392Z), the NFT was owned by the operator and in range at block 62679633; the fresh wallet/NFT/allowance snapshot matched the saved campaign.

Five re-entry transactions confirmed: USDG/router grant, balancing swap, USDG/manager grant, NVDA/manager grant, and mint. The NVDA/router pair remains at zero until first needed. Remaining permissions after the actual swap and mint were 2,386.994958 USDG for the router, 2,368.995133 USDG for the manager, and 9.469152350723031246 NVDA for the manager. Both large finite permissions decreased by the actual token amounts spent, matching live receipt reconciliation.

One unsigned mint preflight failed its price-slippage minimum. The normal journal cancelled that prepared action and requoted the mint at the same unused nonce. It did not repeat the completed swap or approvals, and no gas was spent by that unsigned attempt. The subsequent mint confirmed successfully.

All **11 mined deployment transactions** (nonces 209–219) were independently checked against canonical receipts: **zero on-chain reverts**. Native gas and receipt-valued quote gas exactly match both wallet deltas and the campaign's accounting increments. Re-entry gas was **0.144181 USDG**, giving **0.242324 USDG total exit-plus-entry gas**. Swap fees and market movement are separate from this gas total.

The final wallet held 52.069876 USDG, including the unchanged 49.927111-USDG reserve, 20 raw NVDA units, and 0.002364619147947004 native ETH; the remaining managed inventory is in the owned LP NFT. Service verification showed the new release active with no automatic restarts. The first production recenter after activation had not yet occurred at this verification boundary, so later recenter savings remain to be measured. [summary.json](summary.json) contains receipt hashes, canonical blocks, remaining allowances and artifact hashes.
