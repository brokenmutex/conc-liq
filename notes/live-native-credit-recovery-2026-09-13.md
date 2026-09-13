# Native ETH credit reconciliation and recovery

The September 12 cash exit halted because a canonical incoming transfer increased native ETH by 8,505,303,167,004 wei. See `live-overnight-check-2026-09-13.md` for the incident and exact transaction. Capital, token balances and historical costs must not be reset to recover it.

## Reconciliation

`proveNativeCredit` accepts only successful, direct, empty-calldata transfers to the dedicated undelegated EOA on chain 4663. It checks both snapshot anchors and each transaction's canonical receipt, excludes transfers outside the snapshot interval, rejects duplicate hashes, and requires the sum to explain the native balance difference exactly. Own-transaction gas is added back only in receipt reconciliation. Unexplained residuals, debits, token/nonce/NFT/allowance changes remain blocking.

Automatic discovery scans at most 512 blocks, in batches of eight. Longer gaps require explicit receipt hashes through the repair command; internal transfers remain unsupported. The proof is saved with an external-funding ledger entry and cumulative `externalNativeCreditsWei`. It changes neither initial capital nor reserved USDG nor fees nor gas costs. Receipt-time credits are included in the existing atomic action reconciliation record. Strict pre-signing and unresolved-signature checks remain in place: an unsigned action can be cancelled and requoted after credit reconciliation; signed actions must reconcile their actual receipt.

`recover-native-credit ENV CONFIG HASH [HASH ...]` requires the specific wallet-continuity halt, no pending action, cash inventory, matching policy, canonical proof and unchanged pending nonce. It atomically records the credit and moves back to **exit**, preserving the desired mode. The controller clears residual allowances and closes; the existing ten-minute cooldown and all normal admission checks govern re-entry. Other halt classes cannot use this repair.

Use the sealed release's pinned Node and launcher, stop the live service before explicit repair, retain a pre-repair state/unit backup, then restart the same campaign. Do not edit the database state manually.

## Dashboard

Hard halts now have a red **Halted** badge, an explicit reconciliation requirement and attention-filter inclusion. Valuation age is shown independently of API/worker heartbeat. Live detail separates completed recenter mints from attempted recenter phase transitions and displays swaps separately; unavailable paper attempt counts remain unavailable.

## Validation and investigation

82 focused tests pass across native credit, live receipt/controller/signing, the prior risk-clock fix and dashboard APIs; TypeScript and dashboard JavaScript syntax checks pass. The checked-in fixture contains last night's public chain snapshots and incoming transaction/receipt, with no signer material. Tests cover exact discovery, explicit-hash long-gap repair, duplicate/old/mismatched/reverted/reorged receipts, wrong chain, delegated operator, native debits, simultaneous token/nonce/NFT/allowance changes, idempotent funding recording, retained strategy accounting and the dashboard halt state.

The recenter sequence required three successive NVDA/router approvals because the freshly solved amount increased: 0.518140479750148772, 0.521283629804395798 and 0.527923163912603738 NVDA. Exact allowances make this possible even though each approval succeeds. A bounded approval buffer could reduce repeats, but needs a separate tested execution change; this deployment retains existing allowance sizing.

RPC health samples show lag of 35, 134 and 176 blocks at 20:39:08, 20:39:18 and 20:39:28 UTC, followed by zero lag with recovery hysteresis at 20:39:38. The private node reported syncing during the interruption. The node is remote; a read-only SSH attempt could not verify a known host key, so host-level root cause is not established. No node configuration or lag tolerance is changed by this repair.

## Deployed and recovered

Live worker and dashboard now use sealed release `ff6b9c3ec1aaa8f83e4d70e07d5d5bda118fab50094a96038f926d0d3de4f614`, source commit `8cd87c1b39029dc2afe65774d372c61b5acc13b1`. Paper service/timer configuration was not changed.

The explicit repair recorded exactly one funding proof and preserved the same campaign, policy hash, active configuration hash, initial capital and reserve. Native accounting now reconciles exactly as `initialNative + externalNativeCreditsWei - gasSpentWei = saved native balance`.

Residual allowance cleanup confirmed in transaction `0x19df6b645ca97e290929019b6f85411bb59f37e84ffafd4b31594ebd55844bca`, costing 0.009300 USDG in recorded gas. The campaign closed at **05:33:26.786 UTC** with all four allowances zero, no NVDA and no active LP. Desired mode remains running; normal re-entry becomes eligible at **05:43:26.786 UTC / 08:43:26.786 Vilnius**, subject to fresh admission checks. Re-entry itself has not yet been observed at this checkpoint.

Post-cleanup net NAV is **246.283659 USDG**. The incoming ETH credit is excluded from strategy profit. Dashboard APIs respond successfully, including the one-week view; live counts show zero completed recenters and one attempted recenter. Paper 61 remains open.

Evidence and before/after unit files: `data/live-native-credit-deployment-2026-09-13/`. `verification.json` contains the accounting/configuration assertions, credit proof, cleanup receipt and cooldown timestamp. Restore the saved service unit to roll back software if necessary; retain the recovered journal and funding record. Never recreate the campaign or reverse the external-credit accounting during a software rollback.
