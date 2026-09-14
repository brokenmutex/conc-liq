# Persistent allowance investigation — 2026-09-14

**Persistent finite allowances could have removed every repeated approval after four initial grants in the latest uninterrupted audited session.** Unlimited approvals are unnecessary for that result. This is a research result against the retained ledger, not a deployed change or a forecast of future turnover.

This extends the [execution-cost investigation](../live-execution-optimization-2026-09-14/README.md). The evidence remains the 181 mined actions through 2026-09-14 06:49:17 UTC. The latest uninterrupted session begins at nonce 77, created 2026-09-13 05:43:46 UTC, after the seventh completed cash exit at nonce 76. It contains 62 approvals. Capital and actual historical trade amounts remain unchanged.

## Counts, including cleanup

Allowances are cumulative authorization per token and spender, not additional capital. Both USDG and NVDA are used by the swap router and position manager: four combinations. ERC-20 supports repeated spending within an approved amount; permission is separate from the wallet's balance. [ERC-20 specification](https://eips.ethereum.org/EIPS/eip-20). The spender addresses match the official [Uniswap chain-4663 deployment list](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md); the fork evidence also records runtime code hashes and verifies router identity/factory bindings.

| Policy, per spender | Latest session: 62 approvals | Whole recorded history: 112 approvals, preserving cash-exit cleanup |
|---|---:|---:|
| Finite: 250 USDG / 1 NVDA | 30 | 83 |
| Finite: 1,250 USDG / 5 NVDA | 6 | 58 |
| Finite: 2,500 USDG / 10 NVDA | **4** | **56** |
| Maximum uint256 allowance | **4** | **56** |

These are illustrative token-unit budgets, not calibrated production limits. Approve only when the current permission cannot cover a recorded request. A grant replaces the remaining allowance with the configured budget. Refill remains necessary when cumulative spending exhausts a finite budget.

For the 2,500/10 case, the latest session needs grants at nonces 77, 79, 80 and 83. All later approval requests can be omitted; the grant at 83 is the first authorization of NVDA for the router. The 58 omitted transactions originally cost **0.553621 USDG**. This is an observed receipt-cost target, **not net predicted savings**: larger retained grants, different token storage costs and eventual cleanup must also be priced. The ongoing session has no terminal cash exit in this input, so cleanup of its four currently nonzero permissions is outside the count.

The whole-history count of 56 comprises **30 grants + 17 retained revocations + nine additional revocations**. The original history sometimes consumed an allowance completely, leaving nothing to revoke. Persistent authorization leaves a remainder, so those exits require new cleanup transactions. Every recorded closed boundary is enforced with zero allowance. Original charges on the 65 omitted transactions total 0.629105 USDG, before the nine new revocations and changed retained costs. It would be wrong to present 112 → 47 by forgetting those nine.

For comparison only, retaining permissions across all seven cash exits gives **112 → 5** with the finite 2,500/10 budget, or **112 → 4** with maximum allowances. Those scenarios deliberately remove the existing cash-exit cleanup rule. They are not the same operational policy and are not recommended by this investigation. Zero total grants from an initially unapproved wallet is unavailable with the current approval-based execution path.

Latest-session cumulative spending explains why modest inventory-sized approvals are insufficient even with the same 250-USDG portfolio:

| Spender | USDG spent | NVDA spent |
|---|---:|---:|
| Router | 475.566667 | 4.200036 |
| Position manager | 1,639.822945 | 7.506217 |

Withdrawals return tokens to the wallet without restoring spent permission. The same inventory can therefore consume many times its value in allowance over successive mints. The finite 2,500/10 case ends with approximately 860.18 USDG and 2.4938 NVDA of manager allowance remaining, so it cannot eliminate replenishment indefinitely.

## Deployed-token behavior and gas

Six owned-fork branches compared exact, finite and maximum allowances at source blocks for swaps 84 and 134, covering both swap directions. Each branch uses the actual historical operator balances without funding injections, the same fee-500 route, saved 40-tick range and net swap amount, then mints an actual owned NFT. Existing allowances are first normalized to zero, with that common preparation cost recorded separately. Persistent branches establish all four permissions before the operation. Every branch ends by revoking all residual permissions.

| Token | Finite allowance after actual transfer | Maximum allowance after actual transfer |
|---|---|---|
| USDG | Decreases by the amount spent | **Decreases by the amount spent** |
| NVDA | Decreases by the amount spent | **Remains maximum** |

Both behaviors were observed for both spenders. The offline replay derives its maximum-allowance rules from the complete fork proof, checks the source against the ledger, and rejects missing pairs or inconsistent observations. It does not infer token semantics from the ERC-20 label.

This is a concrete compatibility issue: `src/live-pilot/reconcile.ts` currently expects `old allowance − actual spend` for both tokens. Maximum NVDA permission would fail that check after a successful swap or mint. Finite budgets preserve the observed subtraction behavior. Both policies currently fail `authorizePilotPlan` when the grant exceeds managed inventory, so neither can be enabled simply by changing the planner's requested amount.

| Source swap | Exact: swap + mint + required approvals | Finite: swap + mint with permissions established | Finite setup | Exact final cleanup | Finite final cleanup |
|---|---:|---:|---:|---:|---:|
| 84 | 0.169295 USDG | 0.129488 USDG | 0.052936 USDG | 0.010107 USDG | 0.037990 USDG |
| 134 | 0.166423 USDG | 0.128149 USDG | 0.052504 USDG | 0.010025 USDG | 0.037682 USDG |

The operation itself changes from five transactions to two and saves **0.039807 / 0.038274 USDG** in these snapshots. This excludes the preceding common LP withdrawal. Finite allowances slightly increase mint gas versus exact amounts here; that difference is included, not assumed away.

For just one operation followed immediately by cleanup, persistent allowances are **more expensive**: finite setup + operation + cleanup is 0.220414 / 0.218335 USDG versus exact 0.179402 / 0.176448 USDG. Their benefit requires reuse across operations. Maximum allowances save only another 0.001431 / 0.000704 USDG on the operation relative to finite permissions in these two samples; they do not remove any additional approval transactions in the latest-session replay.

All six branches preserve identical final token inventory and liquidity across modes, NFT ownership, the 49.927111-USDG reserve, zero ending allowances and exact local native-gas reconciliation. Mint calls with intentionally impossible minima revert with unchanged balances and allowances. Those are call-level rollback checks, not tests of the live persistent journal or recovery workflow. Full gas estimates use the existing validated local-prestate/Nitro comparison and full `eth_estimateGas`, with parent fees not counted twice. Reverting-code controls passed. These are estimates at pinned states, not production receipts or a replay of intervening price movement.

The first fork run had a harness assertion error in the exact branches: it compared native balance before and after intervening manager approvals when checking the failed mint call. The successful v2 run takes that comparison immediately before the failed call. Failed evidence remains separately retained and is not included in successful counts.

## Implementation implication

The supported next candidate is **finite persistent permissions for both spenders throughout an active session, retaining revocation on a real cash exit**. The user asked for investigation; live code, configuration, service and wallet permissions were not changed.

A production implementation would need a versioned, persisted per-token/per-spender allowance budget in the authorization policy, while retaining independent swap/mint amount limits, reserve checks and fixed recipients. The planner already reuses sufficient allowances. Actual remaining allowances must continue to come from snapshots and receipts, never from an optimistic in-memory counter. Finite replenishment should remain journaled and revalidated after confirmation; it should not change the completed-swap recovery rule. The existing exit planner scans and revokes every nonzero allowance, which handles the additional cleanup identified above. Restart continuity and cash-exit/re-entry behavior need tests with nonzero retained permissions, including signed approvals and recovered mint failures, before any sealed deployment.

Larger permissions extend beyond managed inventory to other token balance held at the same address, including the USDG reserve and later deposits. Normal planned trades in the fork still preserve that reserve, but the token allowance itself does not enforce the reserve distinction. Contract-enforced reserve isolation would require separate custody. This investigation verifies execution behavior and records historical runtime hashes; it is not an audit of spender or token upgrade authority. Fresh identity/implementation validation remains necessary for an actual release.

## Reproduction and evidence

The offline helper reconciles the original receipt/nonce/allowance chain before each counterfactual. Five new tests cover cumulative spend, replenishment, additional exit revocations, explicit maximum behavior, reversions, invalid receipt continuity and unavailable omitted gas. Full repository validation: 497 tests pass and TypeScript checking passes. Six complete owned-fork branches passed separately.

```bash
.tools/node/bin/node --import tsx scripts/live-persistent-allowance-fork.mjs \
  data/live-pilot-runtime.env data/live-performance-2026-09-14/ledger.json \
  data/live-execution-cost-audit-2026-09-14-v2/audit.json NEW_FORK_DIR
.tools/node/bin/node --import tsx scripts/live-persistent-allowance-audit.mjs \
  data/live-performance-2026-09-14/ledger.json NEW_FORK_DIR/results.json NEW_AUDIT_DIR
PATH=/root/conc-liq/.tools/node/bin:$PATH npm run check
```

[summary.json](summary.json) contains compact results; [artifacts.json](artifacts.json) pins full evidence and research code. Raw evidence is retained in the ignored `data/` directories. The audit needs no RPC or environment. The fork harness imports no signer, uses the runtime bulk-read health gate and only sends transactions to owned local Anvil processes behind the pinned read proxy.
