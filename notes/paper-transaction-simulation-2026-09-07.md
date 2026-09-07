# Paper transaction simulation — September 7, 2026

The paper worker now prices intended swaps and LP calls using current-state
contract execution and Robinhood Nitro gas estimates. It no longer needs fixed
entry/exit charges or a slippage haircut. The implementation remains signer-free:
all account funding and transactions terminate at an owned local Anvil process;
the upstream transport accepts only an explicit list of pinned reads.

This completes the missing execution-mechanics step from the earlier
[cost correction](paper-execution-realism-2026-09-07.md). It does **not** establish
strategy profitability or exact counterfactual LP income.

## Verified execution evidence

The accepted [1,000 USDG round trip](paper-execution-evidence-2026-09-07/round-trip.json)
used source block **56,666,711**, hash
`0xc3e6fcd9d61c9a0cd086c05ec334bf5cc3609ce983f28a227a6af6800c2a0774`,
at 07:46:56 UTC; the run completed at 07:47:10 UTC.

| Measurement | Result |
| --- | --- |
| Starting paper token inventory | 1,000 USDG, zero NVDA |
| Calls | 10: acquisition approval/swap, two mint approvals, mint, decrease/collect, sale approval/swap, two remaining allowance revocations |
| Final token inventory | 999.484846 USDG, zero NVDA |
| Cash change before native gas | **−0.515154 USDG** |
| Estimated entry gas | 279,173,732,812,000 wei |
| Estimated immediate-exit gas | 187,355,562,804,000 wei |
| Total estimated gas | **0.000466529295616 ETH** |
| Node reads | 142 of a 400-request ceiling; two unapproved proxy requests rejected |
| Holding-period fee income | None; this is an immediate mechanics rehearsal |

The recorded quoter and router outputs match exactly. Token balances reconcile
to swap and LP return values; the NFT finishes with zero liquidity and tokens
owed; allowances finish at zero. Local native balance changes reconcile to local
receipt gas. Every priced call's local return data also matches Nitro `eth_call`
with the same touched prestate. Local receipt gas prices are Anvil prices, so
local native spend is retained as a reconciliation check, not charged as a
Robinhood gas fee.

A separate [later-exit restoration test](paper-execution-evidence-2026-09-07/restored-exit.json)
restored the original **3,295,130,462,471,501** liquidity units at newer block
**56,667,325**. It withdrew and sold the position in five measured calls using
128 node reads. The test explicitly supplied synthetic fee claims of 1,234 raw
USDG and 1,000,000,000,000 raw NVDA. Contract collection returned exactly those
claims; estimated exit gas was **0.000183555463788 ETH**. These inputs test
restoration correctness and must never be interpreted as earned income.

## Execution path and gas accounting

The router deployment is taken from Uniswap's official
[chain 4663 deployments](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md).
Its address is `0xcaf681a66d020601342297493863e78c959e5cb2`; runtime hash
`0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc`
is checked, along with factory, pool and token identities. This deployment uses
`factory()`; its v3 `exactInputSingle` tuple has no deadline field, so the call
uses the router's deadline-bearing multicall. See
[IV3SwapRouter](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/interfaces/IV3SwapRouter.sol).

For each action, the local prestate tracer supplies only touched account
balances, nonces and storage differences. The node retains deployed bytecode.
The pipeline then performs matching local/Nitro calls and invokes native
`eth_estimateGas(transaction, pinnedBlock, stateOverrides)`. The full estimate
is multiplied by the node's contemporaneous base fee. `NodeInterface`'s
`gasEstimateL1Component` supplies the independently reported parent component.
The full gas estimate already includes parent data; it is **not added again**.
The parent estimate was measured as zero in these runs, not hardcoded to zero.
See [NodeInterface](https://github.com/OffchainLabs/nitro-contracts/blob/main/src/node-interface/NodeInterface.sol)
and the [official gas-estimation example](https://github.com/OffchainLabs/arbitrum-tutorials/blob/master/packages/gas-estimation/scripts/exec.ts).

The combined `gasEstimateComponents` method reverted on the funded swap with
our overrides even though direct Nitro execution succeeded. The native estimate
method above worked on approvals, swaps, mint, decrease/collect and revocations.
No fallback converts a failed estimate into a flat or zero charge. Native
estimates in this rehearsal exceeded local receipt gas units, including the
refund-sensitive exit calls. Both are saved for subsequent calibration against
comparable real receipts; no exact mainnet fee is claimed.

At entry, an executable quote fixes swap amount, minimum output and range before
a later checkpoint can fill it. Only USDG is seeded on the local account; the
actual swap acquires NVDA. A full immediate exit is simulated for preflight and
the exit reserve, but the paper ledger retains the post-mint inventory and
charges only entry actions. At a later exit, fresh chain state is used. The
original liquidity, idle balances, allowances and estimated fee claims are
restored locally; mint-rounding excess is removed before the priced exit.
Getter traces identify and validate position mapping slots. Old pool state is
not carried from the entry fork into the later market state.

Gas is kept in an ETH ledger. USDG cost conversion requires same-block, fresh,
complete ETH/USD and USDG/USD oracle rounds; their feed metadata, code hashes,
round identities and directory provenance are saved. Missing valuation evidence
prevents a fill. The 1 ETH local funding is a technical gas float, excluded from
the 1,000 USDG LP allocation; a separate native spending cap prevents overdraft.
Each action's converted gas reduces LP NAV. The later exit removes the old
reserve and charges the new estimate once. Passive holding shares the purchased
inventory and its acquisition gas; additional LP operations reduce LP alpha.

## Persistence, operating boundaries and current session

Execution attempts are stored in `paper_execution_runs`, bound to session,
policy hash, checkpoint block/hash and action. Quote, entry, failed exit and
successful exit are separate records. The session update and journal commit in
one database transaction. Retrying an already processed checkpoint makes no
new RPC requests. Stored evidence must retain canonicality and session/policy
identity; revocation hides economic results without rewriting the journal.

The fork has a 400-read cap, 100 ms pacing, a 150-second deadline and a health
check before each read. The service has a three-minute timeout; fork children
are terminated on cleanup. Normal marks use the existing database and
HyperSync event coverage. There is no full-history scan, archival provider
requirement, new wallet, signing capability or upstream broadcast path.

At **08:05:09 UTC**, session **2** was closed before entry, preserving its policy
hash and five observations. Session **3** started with the immutable guarded
`nitro_fork_v1` policy and hash
`32ec0e0acfd86de2f35c2599fdbc93480bbc315b12636b4f9b0cbf91af762924`.
See [activation evidence](paper-execution-evidence-2026-09-07/activation.json).
The installed 15-second paper timer and dashboard were refreshed. The tail and
historical-data architecture remain in place.

The activation snapshot has no position or P&L. The equity entry window is
closed, five-minute healthy chain recovery is unproven, and risk/reference
inputs are stale or unavailable. Session 3 waits for a checkpoint captured
after its creation and for the actual entry checks to pass. No research-mode
live session or synthetic successful health sample was installed.

## Validation and remaining limits

Validation: TypeScript checking and **197 tests**; an
[isolated PostgreSQL lifecycle audit](paper-execution-evidence-2026-09-07/store-audit.json)
covering quote persistence, restart, idempotency, entry balances/gas, failed exit,
retry, reserve replacement, and cost/canonicality revocation; two real-source
fork diagnostics described above; and
[desktop/mobile browser checks](paper-execution-evidence-2026-09-07/live-snapshot.json)
for truthful status, dated rehearsal evidence, action rows, reset behavior and
page overflow. Database/browser fixture results are separate from forward
performance. The temporary database schema was removed.

The next useful evidence is a complete guarded **forward** paper lifecycle.
Open NAV uses pool spot marks; fee income uses observed growth while the full
covered swap path stays within range. It remains a zero-impact estimate: our
additional liquidity would dilute fee sharing and may alter the path. A range
crossing or missed coverage invalidates the session. Closed simulated cash P&L
still includes those estimated fee claims; it is not realized mainnet income.

Checkpoint spacing is currently about five minutes. Calls within each action
sequence have no intervening third-party transactions. The worker does not yet
model inclusion queues, MEV, post-submission reverts or retry spend. Preflight
failures cost no gas because no submission would occur. These are material
paper-versus-live differences; the gas estimate itself is also not a receipt.
Use forward evidence to decide whether cadence, fee allocation and submission
scenarios need refinement before any funded-wallet trial. Avoid interpreting
the successful round-trip rehearsal as proof that the LP strategy earns money.
