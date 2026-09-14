# Stock-agnostic persistent finite allowances

The production allowance engine is now independent of stock symbols, token decimals, USDG, NVDA, pools and chain deployment constants. It accepts token/spender addresses and raw integer amounts. The existing live-pilot adapter supplies its verified USDG/NVDA/router/manager pairs; the same engine can be used by another market adapter without changing its implementation. This change does not generalize the rest of the live pilot's NFT, pricing or inventory model, or onboard another stock to live execution.

Implementation: [`src/execution/allowance-policy.ts`](../../src/execution/allowance-policy.ts). The engine validates finite budgets, rejects duplicate/missing/extra configured pairs against an adapter's allowlist, reuses sufficient on-chain allowance, and replenishes an insufficient allowance to the configured amount. Budgets are raw token units, not USD valuations or capital allocations. The engine has no default amount for any stock. A required active-operation amount above the configured budget fails closed; a large allowance never relaxes actual managed-inventory checks.

Configuration is optional at `execution.allowancePolicy`. Omission retains `exact_v1`, including for existing saved campaigns without the new state field. To configure persistence, the operator provides all verified token/spender combinations:

```ts
{
  kind: 'persistent_finite_v1',
  grants: verifiedPairs.map(({token, spender}) => ({
    token,
    spender,
    amountRaw: configuredBudgetByPair[`${token.toLowerCase()}:${spender.toLowerCase()}`]
  }))
}
```

The amount is a positive decimal integer string below the uint256 maximum sentinel. Address checksum normalization and canonical pair ordering make configuration identity independent of presentation order. No unlimited-token special case is accepted. Token support still requires checking deployed transfer/allowance behavior: the engine's stock independence is not a claim that every token contract is compatible.

The live adapter now uses the engine for both router and manager approvals. Each campaign persists its canonical allowance policy. Planning, transaction authorization through the controller, retries and recovery must agree with that saved policy; editing a config cannot silently change a running campaign or reinterpret an existing signed action. The exact journaled approval amount remains in the signed calldata, and receipt reconciliation still requires the observed allowance to decrease by actual spending. No allowance cache is substituted for chain snapshots.

All existing swap/mint funding, reserve, recipient, slippage, NFT and nonce checks remain in force. During a real exit, the planner reuses existing permission; if a new authorization is necessary, it covers only the actual unwind inventory using the prior exact-approval rule. Thus an active-session budget cannot prevent an exit simply because current inventory exceeds it. Every residual allowance is revoked before closing.

## Adoption and release boundary

`adopt-allowance-policy` explicitly updates a saved campaign at a stopped, closed cash boundary. It requires no pending action, zero prior and current allowances, no position, canonical previous state, verified current chain identities, exact wallet/nonce continuity and the same strategy hash. It atomically journals the new state and updates only the allowance policy in saved configuration. It does not sign or broadcast, clear action history, reset performance accounting, change custody or alter completed-swap recovery.

For an existing campaign, complete the normal cash exit under its current saved policy first. A new candidate configuration can then be adopted with the command above, followed by normal resume/re-entry. A config mismatch intentionally refuses ordinary execution, so editing the running config before finishing that exit is not the migration procedure. Active-position adoption is not implemented.

No runtime configuration, live allowance, service or wallet was changed for this work. The checked-in pilot configuration retains the legacy exact policy. Persistent allowances remain an explicit operator-configured option. A larger standing approval can authorize balance beyond the managed allocation at the same wallet; the existing reserve protection is in trade authorization/accounting, not an ERC-20 reserve partition.

## Validation

The workspace check passes 519 tests, including 22 new tests covering arbitrary token/spender identities and raw scales, budget exhaustion, insufficient managed inventory, legacy configuration, exact finite grants, changed-config rejection, actual recorded swap/mint allowance deltas, exit cleanup and adoption failure conditions. Tests use separate token identifiers; the generic engine imports no market constants.

Signed owned-fork controller tests use random temporary test keys, disposable PostgreSQL schemas, isolated Anvil processes and a pinned upstream read proxy. They exercise real token/router/manager contracts and the actual persistent journal/controller:

- `persistent`: durable-boundary restarts, lost acknowledgement, confirmation/reorg waits, two recenter directions, no repeated persistent grants, full cleanup, stopped policy adoption, and re-entry with a reconstructed controller.
- `persistent-mint-retry`: a real manager mint slippage revert followed by normal recovery, with no repeated completed swap, then cleanup/adoption/re-entry.
- `persistent-replenish`: smaller finite budgets force replenishment through the actual journal, followed by cleanup/adoption/re-entry.
- `persistent-retry-approval`: rejected publishing followed by the identical signed approval hash/nonce, then entry, exact exit funding, cleanup/adoption/re-entry.

The publisher-retry test initially expected one revocation per positive grant. An exact exit grant is fully consumed by the exit swap and needs no revocation; the corrected assertion distinguishes persistent grants from exact exit funding. This was a test expectation failure, not a failed production receipt reconciliation. The initial persistent proof recorded only first-session actions alongside post-re-entry state; the updated harness includes all actions and verifies full nonce coverage through re-entry.

All tests preserve the 50-USDG synthetic fixture reserve and reconcile native gas. Counterparty/funding fixtures exist only on the owned forks. Fork tests validate execution/custody; their gas is not a new profitability estimate. [summary.json](summary.json) records the completed cases and exact artifact hashes.

```bash
.tools/node/bin/node --import tsx test/integration/live-pilot-controller.mjs \
  data/live-pilot-runtime.env NEW_OUTPUT.json persistent
# Other supported test modes: persistent-mint-retry, persistent-replenish,
# persistent-retry-approval.
PATH=/root/conc-liq/.tools/node/bin:$PATH npm run check
```

The isolated clean checkout at source commit `6dcfd3798392ee05d7948811ff901557433347b2` passes **484 tracked tests in 62 suites**. The workspace total of 519 includes unrelated uncommitted research tests. A sealed, unactivated release was built at `/root/conc-liq/data/stock-agnostic-allowance-releases/11be421b9e15d23235951d99548573e0e1b98e4bcaa92dee5c127bd681821ddf`, build ID `11be421b9e15d23235951d99548573e0e1b98e4bcaa92dee5c127bd681821ddf`. Its manifest integrity and compiled generic allowance engine were verified. The packaged pilot configuration remains broadcast-disabled and uses the legacy exact policy. This release candidate is ready for review; no service was switched to it.
