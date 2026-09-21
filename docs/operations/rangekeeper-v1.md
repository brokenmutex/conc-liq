# RangeKeeper v1.0.0: policy and launch preparation

Prepared September 21, 2026. Machine policy ID `rangekeeper_v1`; configuration
and state schema version 1. The implementation in this checkout is **read-only
and broadcast-disabled**. This page records a proposed AAPL/USDG campaign, not
an instruction to fund or start it.

## Frozen decision rule

On a canonical observation, reconcile pending custody before making another
decision. An initial entry may be considered immediately. An active position
within `[tickLower, tickUpper)` is held; the lower boundary is inside and the
upper boundary outside. On the first observed exit, store the block, hash, market
time, NFT, and range. Only consecutive outside observations no more than 90
seconds apart preserve the timer. A return, gap, reorg, or new NFT resets it.
After 300 seconds, evaluate at most every 30 seconds. A rejected proposal does
not reset the exit timer.

The sole ordinary range is centered on the floor-aligned current tick, using a
fixed, positive even full span. Size the exact no-swap mint first. If it cannot
meet the deployment floor, quote the minimum feasible raw input in the token
left idle by the no-swap mint. Recheck quote-source identity, price movement,
raw-input and shortfall caps, exact mint math, independent price band, exposure,
action/rolling/campaign costs, and the current complete-exit native reserve.
The same raw proposal must survive two distinct eligible observations within
90 seconds, followed by exact calldata simulation. No fee forecast, volatility
forecast, payback estimate, or old-policy comparison enters the decision.
Safety exits bypass the ordinary timer and confirmation.

Value reporting uses 18-decimal USD units. Token and native balances remain raw
integers. The strategy allocation, native allocation, and all probe costs share
one 250 USD-equivalent campaign cap, with no automatic refill. An existing
wallet's prior funds are reserved in raw units at activation and excluded from
campaign P&L. A later outside transfer requires separate receipt-backed credit
attribution before the campaign can continue.

## Proposed first profile and limits

The selected pool is Robinhood Chain 4663 AAPL/USDG, V3 fee 500 and tick
spacing 10. The official [Uniswap deployment registry](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md)
lists the factory, position manager, router, and QuoterV2 used here. The
[disabled AAPL profile](../../config/rangekeeper-v1-aapl-disabled.json) freezes
their addresses, pool/token bytecode hashes, ordering, decimals, independent
reference identities, and all numeric limits. The
[disabled NVDA profile](../../config/rangekeeper-v1-nvda-disabled.json) exercises
the same policy with a second verified pool. Symbols never authorize a contract.

The proposed full width is 20 spacings, or 200 ticks. Maximum deployment is
200 USD, the minimum is 40% of that cap, the optional swap input is at most
100 USD and 50% of available input inventory, and swap shortfall is at most
2 USD. Slippage is at most 50 bps. The proposed action, rolling 24-hour, and
campaign cost ceilings are 3, 6, and 8 USD; maximum risky-token exposure is
95%, loss 20 USD, drawdown 10%, and ordinary recenter count four. The configured
0.001 ETH floor for exit reserve exceeds the pinned-fork complete-exit spend
of 0.000579020730127933 ETH. It is still a fork estimate rather than a live
guarantee: the planner also requires a fresh, higher current estimate when needed.
These are bounded operating choices, not tuned profitability results.

Read-only chain verification at block 68,638,898, hash
`0x526aad262956c46aeb954fb4bb3e4a502e53d58f6f61688d41b074dd2d373dfe`,
confirmed factory/pool/periphery links, token order, 6/18 decimals, fee,
spacing, and configured code hashes for AAPL and NVDA. At block 68,638,103,
an AAPL pool quote for 100 USDG output 298026471145608693 raw AAPL and left
the post-swap price inside `[218060,218260)`. Exact integer mint math on that
quote used 84068172 raw USDG and 298026471145608693 raw AAPL, leaving 15931828
raw USDG idle. This is mechanical feasibility from a quote; it is not an
exact-calldata fork simulation or a current fill guarantee. The USD cost of
that quote was not computed from a same-block independent reference.

The [pinned-fork rehearsal](../../test/integration/rangekeeper-fork.mjs) at
block 68,644,757 exercised approvals, a 100 USDG direct swap, mint, full
withdrawal and core Collect proof, AAPL sale, and allowance cleanup using the
existing wallet as an impersonated fork account. It created NFT 1253122 and
finished with zero liquidity, zero tokens owed, zero AAPL, and zero allowance
on all four configured token/spender pairs. Its 12 local transactions used
0.001420469509860124 ETH at fork gas prices: 0.000841448779732191 ETH for
entry and 0.000579020730127933 ETH for exit/cleanup, or about 2.242 and
1.542 USD at the independent ETH mark above. These are **fork estimates**,
not canonical live receipts; the fork topped up native gas locally and did not
prove that the current wallet balance funds the complete lifecycle. Run with:

```sh
/root/conc-liq/.tools/node/bin/node --import tsx \
  test/integration/rangekeeper-fork.mjs \
  data/live-pilot-runtime.env config/rangekeeper-v1-aapl-disabled.json 68644757
```

The optional `force-mint-revert` argument mined a reverted mint after the
completed entry swap, charged its 267003520485415 wei fork gas once, retained
the same token balances, then completed the mint and full exit without a second
entry swap. This checks a concrete failure boundary in the calldata path; a
durable live controller must still prove the same behavior across a restart.

## Reusing the former pilot wallet

The proposed operator is `0xdCC9348Ade9cA0A13249a44a63Db5411A8e72D52`.
The former NVDA live-pilot service was inactive and its saved campaign was
closed/stopped on September 15. At confirmed block 68,642,776, hash
`0x285ebadd0b4bcaa2e254f881b99f6f63db6dc1bdb52534f611eab9758945dd54`,
the wallet owned 43 NFTs, exactly matching the former campaign's retired-ID
list. Every ID was still owned by the operator with zero liquidity and zero
owed tokens. USDG was 295170862 raw, AAPL and NVDA were zero, native ETH was
1113588596335004 wei, the four USDG/AAPL router/manager allowances were zero,
and the confirmed and pending nonce were both 302. This supports reuse without
adopting a legacy NFT. Repeat the full check at launch; the saved September 15
state is historical evidence, not a substitute for a fresh canonical read.

At the independent references observed at block 68,644,757, 240 USD-equivalent
would allocate at most 240002056 raw USDG from that wallet, leaving 55168806
raw USDG outside the campaign. The wallet's then-current ETH valued about
2.9665 USD, below the 10 USD gas allocation ceiling and below the fork's
complete lifecycle gas spend. Both the raw allocation
and its reference must be frozen again at the activation block. Existing funds
count toward the 250 total cap; they are not free extra capital.

Run the bounded read-only inspection with the archive RPC environment file:

```sh
/root/conc-liq/.tools/node/bin/node --import tsx src/rangekeeper.ts inspect \
  config/rangekeeper-v1-aapl-disabled.json \
  0xdCC9348Ade9cA0A13249a44a63Db5411A8e72D52 \
  data/live-pilot-runtime.env
```

The inspector verifies chain identity and independent AAPL, USDG, and ETH
references at a confirmed block. The last run at block 68,644,757 reported
USDG 0.99999143 USD, AAPL 335.52982928 USD, ETH 2663.91445529 USD, and
reference eligibility. These values can change; an old mark cannot admit a
later transaction.

A sealed read-only release was built from commit
`821e60015cfbbb9cf16bceb45705ad9ba8a02b2e`. Its build ID is
`8ddb065eef95973cc4608c15b962562d032fa1ac29771885b84b311b2a4d39ac`,
at `/root/conc-liq-releases/8ddb065eef95973cc4608c15b962562d032fa1ac29771885b84b311b2a4d39ac`.
The release verifier passed, and its pinned Node launcher ran the actual
RangeKeeper inspector against the AAPL profile, which now binds the selected
operator address. The inspector's config hash was
`0x900beb36c7116dfb9585592685e689d1bb6b5ef6d50dfcb0917b8e5cff302b77`.
At its confirmed block 68,652,185, hash
`0xbaac9b3fc0398f521721e770b021c51aa7dc4b921ad3aa17585cf52195d2f885`,
the wallet still had 295170862 raw USDG,
zero AAPL, 1113588596335004 wei, 43 NFTs, nonce 302, and zero relevant
allowances. This release contains no live controller; verification only proves
that the sealed read-only path works.

## Launch record and remaining gates

Proposed campaign: one AAPL/USDG pool, this existing operator, at most 240 USD
of strategy inventory plus 10 USD of native gas value, with no separate probe
budget. Existing signer reference is an environment-file key at
`/root/conc-liq/.env` under `WALLET_PRIVATE_KEY`; no key bytes belong in this
record. Proposed initial scope is 12 hours, at most one entry and one ordinary
recenter, plus the necessary guarded exit/cleanup. The four-recenter config
ceiling is an outer safety cap; the first campaign would have the tighter
two-action scope. At expiry, request guarded unwind and prove wallet, NFT,
allowances, nonce, and receipt costs before recording closure.

This launch record is **not yet runnable**. The generic signer/controller/store
integration, wallet-level lock across the former pilot, live per-stage cost and
exit-reserve estimator, receipt-backed custody reconciliation and accounting,
crash/revert recovery, controller-driven exact-pool fork lifecycle, live sealed
release, and service definition are still required. Existing research stage
splits are borrowed and
cannot establish these costs. The current config rejects `broadcastEnabled=true`.
No funding, approvals, transactions, service changes, or campaign state were
performed while preparing this record. Keep the old pilot stopped during any
future RangeKeeper operation on the same wallet.
