# One-position NVDA lifecycle

The entry/exit contract flow now passes a local rehearsal against recent
Robinhood mainnet state. This is the next operational milestone; it does not
establish strategy returns or authorize a mainnet transaction. No archive
provider is required. Full historical accounting remains disabled.

## Verified result

The final rehearsal completed at **14:50:33 UTC**, using block **56,059,710**
(`0x3c70a36a5898c440d83e5486052b5dbba0a77af99712ddf84f24ff70abf7feca`).
The explicit fixture budget was **1 USDG**, with 20 tick spacings per side and
50 bps token minimum haircuts. These are mechanical test inputs, not a selected
live budget/range. The operator was an unfunded test address on mainnet.

- Simulated funding came from a different NVDA pool account impersonated only
  inside the owned local Anvil instance. The entry pool's state was forked.
- Both token approvals, mint, NFT ownership/position reads, observation over
  three mined blocks, atomic decrease/collect, and approval cleanup succeeded.
- Simulated NFT **1056248** ended with zero liquidity and zero tokens owed.
  This ID and all rehearsal receipts refer to the local fork, not our ownership
  or transactions on mainnet.
- Collection increased the test wallet balances by the exact simulated exit
  amounts. With no swaps during the observation interval, each final token
  balance was one raw unit below its initial balance. No fee-accrual or
  adverse-selection claim follows from this no-swap experiment.
- Operator ETH delta reconciled exactly with the six operator transaction
  receipts. The local EVM total was `1028633524334403` wei. This excludes
  Robinhood L1 data fees and is not a live gas-cost estimate.
- The private node served **120 reads**: 26 preflight/canonicality reads and
  94 fork state/metadata reads. The proxy rejected Anvil's unsupported
  `eth_gasPrice` and `eth_getAccountInfo` shortcuts; Anvil used its fallbacks.
  No archive endpoint was used. No transaction method was forwarded upstream.

The [complete local evidence](canary-evidence-2026-09-06/local-lifecycle.json)
contains source identity, calldata, simulated receipts, position state, balance
reconciliation, live rejection reasons, and explicit evidence limits.

## Entry policy and remaining blockers

The canary reads NVDA's asset risk from the latest risk attempt; unrelated GLD,
SPY, or other asset failures no longer determine the NVDA decision. Snapshot
freshness, canonicality, source coverage, and latest-attempt checks remain.

The missing sequencer-feed reason can be replaced only by the explicit
`robinhood_quorum_recovery_regular_session_v1` canary policy. It requires five
continuous minutes of healthy observations, at most 20-second sample gaps,
advancing heads, fresh block timestamps, the private node plus two reference
probes agreeing on anchors at least 64 blocks behind their heads, and a source
block no later than the latest quorum anchor. Readiness expires after 20 seconds.
All other asset/quote risk reasons remain blockers. The global risk collector
continues to record the sequencer feed as unavailable.

This is an application liveness/recovery policy. It does not reproduce
Chainlink's L1-relayed outage record or establish L1 finality; RPCs can share
failure modes. [Chainlink's supported-network documentation](https://docs.chain.link/data-feeds/l2-sequencer-feeds)
does not provide a Robinhood sequencer feed. Restrict this policy to the small
manually reviewed canary until operational evidence supports any expansion.

Entry is limited to the regular US cash session, with five-minute opening and
closing buffers. The checked-in 2026 calendar handles weekends, listed holidays,
and early closes and rejects unsupported years. It is a schedule, not a real-time
halt feed: Robinhood asset/trading flags, `oraclePaused`, corporate-action state,
and current oracle validity remain necessary.
[Calendar source](https://www.nyse.com/trade/hours-calendars).

The final rehearsal correctly retained live-entry rejection: closed Sunday
session, stale NVDA/USDG oracle evidence, an interrupted recovery window,
stale/mismatched checkpoints, and the test wallet's absent balances/allowances.
An earlier rehearsal observed a passing recovery window; the later failure
demonstrates that the policy does not retain eligibility across degradation.
Neither result overrides the closed session or missing fresh marks. The existing
five-minute price-age ceiling remains conservative, including for USDG.

## Reproduce

Use the local Node and Foundry binaries, source the existing ignored environment,
and point `RH_INDEXER_RPC_URL` at the private read endpoint:

```bash
npm run canary:rehearse -- \
  --operator 0x000000000000000000000000000000000000c0DE \
  --budget-usdg 1 --budget-cap-usdg 1 \
  --half-width-spacings 20 --slippage-bps 50 \
  --max-oracle-deviation-ppm 5000 --max-liquidity-share-ppm 10000 \
  --ttl-seconds 1800
```

The command starts its own loopback Anvil process through a read-only proxy.
Fork state calls are pinned to one recent block, paced at 100 ms, and capped at
600; preflight reads are separate and bounded by the single-pool reader. Anvil
identity and fork block/hash are verified before local mutations. The proxy
never forwards transaction, signing, or unpinned state methods. Local processes
and connections are closed after success or failure. Output is written to
ignored `data/canary-rehearsal.json`.

## Next operator step

Supply the intended wallet and capital cap, then generate a fresh operator-specific
plan during an eligible session. Confirm balances, approvals, current marks,
entry/exit simulations, and a bounded holding/exit plan before approving any
live action. There is still no mainnet signing/broadcast wrapper; local Anvil
transactions cannot be reused as live authorization. Weekend policy research,
archive infrastructure, and automatic rebalancing remain deferred.

Validation: `npm run check` passes type checking and **168 tests**, including
millisecond timestamps, scoped risk policy, recovery/session failures, preserved
price/pause blockers, and ownership/minimum/collection checks for the exit.
