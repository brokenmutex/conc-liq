# Swap and gas optimization — first measured milestone

Bounded swap approvals and comparing v3 routes both show measurable improvements on the recorded 250-USDG campaign. **No live execution behavior was changed.** The new code is a research harness: it imports no signer, writes no live database state, and sends transactions only to owned Anvil processes behind a proxy that permits pinned upstream reads.

This extends the [performance audit](../live-performance-2026-09-14/README.md) and [capital/routing investigation](../live-performance-2026-09-14/capital-routing-and-gas.md). Its fixed input is the campaign's **181 mined actions through 2026-09-14 06:49:17 UTC**, not a claim about transactions after that cutoff. Capital, LP asset, range width and management trigger were held fixed.

| Experiment | Result | Evidence class |
|---|---|---|
| Replay bounded swap approvals across all recorded actions | 112 approvals → 80; 32 omitted, including 28 in recenter phases | Fixed-trade ledger counterfactual |
| Original gas attached to the omitted approvals | 0.309987 USDG | Observed charges on transactions the counterfactual omits; not total predicted savings |
| Exact-source v3 swap comparison, including swap gas | Six of 14 recenter swaps prefer fee 3000; combined advantage 0.297204 USDG | Canonical same-input calls and Nitro gas estimates |
| Re-solve each alternate swap and execute through mint | All six remain better; combined final-inventory advantage **0.284298 USDG after estimated gas** | 12 successful owned-fork swap/mint branches |
| Four repeated-approval batches, including final revocation | 25 transactions → 8; combined estimated saving **0.161197 USDG** | Eight successful owned-fork approval branches; subset of the ledger experiment |

These rows overlap and are not additive. The approval replay does not model how removing waits changes future trading. The routing cases are independent snapshots; they do not propagate alternate inventories into later historical decisions. None of these experiments proves positive whole-campaign P&L.

The bounded approval candidate is deliberately limited: when existing router allowance is insufficient, approve no more than the token's **currently available managed inventory**, rather than the exact latest swap quote. For USDG, that excludes the **49.927111 USDG reserve**; for NVDA, it is the owned wallet amount. The swap itself still spends only its selected net amount. Adequate allowance is reused. Manager approvals retain the existing amount policy. Recorded cash-exit boundaries clear every shadow allowance; any newly required revocation is recorded as an extra cost with unavailable valuation. No additional boundary revocations arose in this dataset. The ongoing campaign still has outstanding allowances, so a future exit remains outside the savings estimate.

This policy is implemented only in `src/research/live-execution-cost.ts` and exercised by research scripts/tests. The controller does not import it. Wider residual allowances change authorization exposure even when bounded, so a production implementation must retain independent spending/recipient checks and reconcile the actual allowance after every receipt. Current live allowance-continuity logic cannot simply consume a shadow replay state.

The 32 omitted approvals carried **0.309987 USDG** of actual receipt-valued gas. That is a smaller target than deleting the entire 1.379909-USDG approval bill. Retained approvals can have different storage costs, and future revocation costs remain relevant. Four batches were therefore checked on matching forks, ending both branches with zero allowance:

| Recorded request nonces | Exact approvals + revoke | Bounded approval + revoke | Exact estimated gas, USDG | Bounded estimated gas, USDG | Saving |
|---|---:|---:|---:|---:|---:|
| 139–147, NVDA | 10 transactions | 2 transactions | 0.096387 | 0.019299 | 0.077088 |
| 115–118, NVDA | 5 | 2 | 0.048170 | 0.019285 | 0.028885 |
| 130–133, USDG | 5 | 2 | 0.044053 | 0.017638 | 0.026415 |
| 167–170, NVDA | 5 | 2 | 0.048042 | 0.019233 | 0.028809 |

Every original request remained fundable, token balances and reserve stayed unchanged, native balance change equalled local receipt gas, and both branches ended with zero router allowance. These are approval-only tests with fixed inventory, not simulations of the intervening historical price movement. The worst batch's approximately **80% reduction** applies to that approval batch, not to the whole recenter or campaign. A per-batch initial state also differs from carrying a bounded allowance across earlier operations, so its transaction count need not equal the whole-ledger omission count.

The route experiment first reproduced the recorded 500-tier output at each of the 14 recenter source blocks. It evaluated direct fees 100, 500, 3000 and 10000 against the same tokens, wallet, input and source. Missing/reverting quotes remain unavailable. Baseline and alternative `eth_call` executions and complete `eth_estimateGas` values used the actual source wallet/allowances. Gas was valued using source-block ETH/USDG oracle reads; output comparisons used the same policy-accepted independent stock reference, whose retained risk snapshot was at most 180 seconds behind the source. This is reference-quality evidence for research, not a reconstructed authorization to trade at those historical blocks.

The six promising fee-3000 cases then used separate owned forks at identical source hashes. The harness re-solved the net inventory trade for the saved **40-tick LP range**. Crucially, a swap in another pool leaves the LP destination pool's price unchanged; the other pool's quoted sqrt price is not substituted into the LP inventory solver. Both branches executed the necessary swap, any extra router approval, both manager approvals when needed, and a real position-manager mint. Fresh mint minimums retained the existing 50-bps tolerance. Both principal and idle wallet balances were included in terminal value.

| Original swap nonce | Advantage after swap, required approvals and mint gas, USDG |
|---|---:|
| 84 | +0.041889 |
| 90 | +0.055573 |
| 96 | +0.041587 |
| 110 | +0.035646 |
| 134 | +0.007812 |
| 155 | +0.101791 |
| **Total across independent cases** | **+0.284298** |

Nonce 84 illustrates why gross quotes are insufficient: the alternative needed slightly more NVDA than the existing router allowance covered, so it required an extra approval. The harness charged that approval and still found an advantage. Nonce 134's sub-cent margin is thin; this milestone does not choose a deployable minimum-improvement threshold or assume such a quote survives network/confirmation delays.

All 12 route branches verified swap token deltas, mint amount/liquidity agreement with the integer model, NFT ownership, reserve preservation and native-gas reconciliation. Final inventory used NFT principal plus remaining wallet tokens at one reference. The common preceding withdrawal and already-completed approvals are outside the incremental starting state. No intervening market flow, future fees, terminal exit or the actual multi-minute management delays were simulated.

Gas estimates use the existing local-prestate/Nitro comparison: local calls must return the same result as upstream calls under the traced prestate. Before routing trials, both upstream `eth_call` and `eth_estimateGas` were checked with reverting router code; both rejected it. Thus an ignored override cannot silently qualify the calculation. The full Nitro estimate is used once, with the parent component reported separately; parent gas was zero for these particular route calls. Local EVM receipts are independently reconciled and are not relabeled as production receipts.

An initial harness attempt used `evm_snapshot`/`evm_revert`. Anvil's revert attempted a fetch rejected by the pinned read proxy. Those six cases produced no successful branch and remain in `data/live-recenter-route-fork-2026-09-14/`. The successful version creates a fresh fork for each branch at the same canonical block. Both fork CLIs return failure when a case is incomplete; the upstream read restrictions were not relaxed.

Validation: **492 unit tests pass**, including seven new allowance/valuation tests, and TypeScript checking passes. The new tests cover insufficient inventory/reserve protection, a rising allowance requirement, receipt and nonce discontinuity, reverted approvals, missing gas, mandatory extra revocation, canonical/reference mismatch and a gross-output winner losing after gas. The owned-fork checks comprise the **12 route branches and eight approval branches** above. The complete results, compact checks and input/source hashes are in [summary.json](summary.json) and [artifacts.json](artifacts.json).

The next production candidate is bounded approval planning, because it removes demonstrated repeated transactions and waiting. Before activation it needs integration with the persistent live planner/journal, recovery and cleanup tests, and a new sealed release. Route selection should then use final post-mint value after incremental costs, keep the current route as a fallback, and preserve source/reference freshness and a conservative benefit threshold. Kyber v4 routes remain at the quote-only stage established in the earlier investigation; this milestone validates direct v3 alternatives. Atomic whole-recenter execution and default Kyber Zap migration were not implemented or assumed to save gas. No capital-size study was pursued.

Reproduction from the repository root, with a private runtime environment and the retained audit ledger:

```bash
.tools/node/bin/node --import tsx scripts/live-execution-cost-audit.mjs \
  data/live-pilot-runtime.env data/live-performance-2026-09-14/ledger.json NEW_AUDIT_DIR
.tools/node/bin/node --import tsx scripts/live-recenter-route-fork.mjs \
  data/live-pilot-runtime.env data/live-performance-2026-09-14/ledger.json NEW_AUDIT_DIR/audit.json NEW_ROUTE_FORK_DIR
.tools/node/bin/node --import tsx scripts/live-approval-batch-fork.mjs \
  data/live-pilot-runtime.env data/live-performance-2026-09-14/ledger.json NEW_APPROVAL_FORK_DIR
PATH=/root/conc-liq/.tools/node/bin:$PATH npm run check
```

The audit reads PostgreSQL with `default_transaction_read_only=on`; all upstream requests retain the runtime bulk-health gate. Forks impersonate only the recorded operator inside an owned local process and use its actual historical balances, without funding injections. The live key is not loaded by a signer. Full raw evidence is retained in the ignored directories named in `artifacts.json`; the compact report does not include private environment values.

Follow-up: [persistent allowances for both spenders](../persistent-allowance-investigation-2026-09-14/README.md) reduce the latest uninterrupted session from 62 approvals to four grants with finite budgets, and identify token-specific maximum-allowance behavior plus additional exit revocations.
