# RangeKeeper operational cost reduction

Campaign `31802d63-9ec8-423c-bc1b-f781f8b44f92` (AAPL/USDG 500, 2026-09-22 09:33 to
2026-09-23 16:24 EEST) earned **$1.856** in fees and paid **$2.048** in gas, swap fees and
reference shortfall. Net was **-$1.178** on $276.27 of capital. The strategy was not
unprofitable because it failed to earn: it earned at **301% APR while in range**. It was
unprofitable because its cost stack exceeded its fee stack.

This note assumes the two crash classes from that session are fixed
(`978338d` for the withdrawal gas bound, `295ce91` for candidate construction latency,
recorded in `docs/operations/rangekeeper-withdraw-gas-bound-2026-09-23.md` and
`docs/operations/rangekeeper-stale-recenter-recovery-2026-09-22.md`) and asks only how the
remaining operational cost can be reduced. It deliberately avoids any change whose
justification is specific to AAPL.

## Cost baseline

| Component | Gas | Swap fee | Shortfall | Total | Nature |
|---|---:|---:|---:|---:|---|
| Entry | $0.125 | $0.054 | $0.094 | $0.272 | once per campaign |
| Exit | $0.046 | $0.063 | $0.201 | $0.310 | once per campaign |
| Four recenters | $0.657 | $0.278 | $0.446 | $1.380 | variable |
| Holding revocations | $0.085 | — | — | $0.085 | variable |
| Total | $0.913 | $0.394 | $0.741 | $2.048 | |

**Sixty-seven percent of controllable cost is recenter cost and scales linearly with
recenter count.** Entry and exit amortise away on longer campaigns. Cadence is therefore the
dominant lever, and it is a policy parameter rather than an engineering problem.

## Measurement basis

Effective gas price on this chain is the base fee: the controller sets
`maxPriorityFeePerGas` to zero and `maxFeePerGas` to 1.25x market (`cost.ts:41`). True gas
units are therefore 1.25x the naive `gasWei / maxFeePerGas`. This scaling was validated
against the two withdrawal figures measured independently during the gas-bound incident:

| Withdrawal | Derived x1.25 | Incident doc |
|---|---:|---:|
| nonce 356 | 204,664 | 204,804 |
| nonce 365 | 203,945 | 204,517 |

The campaign consumed **6.22M gas units across 54 transactions** at **$1.467e-7 per unit**.
All dollar figures below use that measured rate.

One consequence bears on the gas bound rather than on cost. The live estimator predicted
about 264,200 units for the withdrawal that halted the worker while actual consumption was
about 204,000, an over-prediction of roughly 29%. Because `assertRangeKeeperStageGas` checks
the padded estimate rather than realised usage, estimator accuracy, not ceiling headroom,
is what prevents false halts.

## Range width and recenter trigger

`planner.ts:14-22` always builds a symmetric range around spot at
`anchor +/- (fullWidthSpacings / 2) * spacing`. With `fullWidthSpacings: 4` and
`tickSpacing: 10` the live half-width is **two spacings, twenty ticks, about +/-0.20%**. The
recenter trigger at `planner.ts:206` is purely geometric: the tick sits outside the range for
300 seconds. **No expected-value test exists anywhere in the planner.** The only cost gate is
the absolute budget comparison at `planner.ts:218`, which never bound; the campaign spent
$1.31 of a $15 ceiling.

At the measured $0.345 per recenter against $0.0949 per in-range hour, a recenter requires
**3.6 subsequent in-range hours** to break even. Nothing in the controller knows this.

`v3_range_policy_replay_runs` id 1 swept half-widths on **NVDA/500**, which shares this tick
spacing:

| Half-width (spacings) | Status | Rebalances | Fee value | LP alpha |
|---:|---|---:|---:|---:|
| 1, 2, 5 | excluded, `observed_tick_path_crossed_range` | — | — | — |
| 10 | complete, rank 1 | 1 | $5.63 | $2.38 |
| 20 | complete, rank 2 | 0 | $2.82 | $1.85 |
| 50 | complete, rank 3 | 0 | $1.14 | $0.75 |

The live configuration runs at half-width two, inside the band this replay excluded as
unsurvivable. The ranked winner was five times wider. The ranking also shows a genuine
interior optimum, since narrower candidates earned more fees while rebalancing more often;
this is an optimisation, not an argument for maximum width.

This evidence is suggestive, not decisive. The run covers five intervals on one pool, and its
`assumptions` field states that operator-supplied costs are illustrative: both
`entry_cost_quote` and `rebalance_cost_quote` were set to $1.00. The measured stack
(`$0.345` per recenter, `$0.272` entry, `$0.310` exit) has never been fed to this tool.

`trigger_percent` already exists as a column on that table, ranges 1 to 100, and is **not**
a live parameter. The live controller is hardwired to the equivalent of trigger_percent 100,
recentering at the range edge. Sweeping `half_width_spacings` against `trigger_percent` is
supported today.

## Swap-free recentering

All five recenters swapped, because they must. `planner.ts:116` rejects any candidate whose
post-swap price is not strictly inside the range, and `rangeKeeperRange` always straddles
spot, so every recenter forces an approximately balanced rebalance.

When the tick exits above the range the withdrawn inventory is essentially all token0, and a
range placed entirely above spot requires only token0. Such a placement needs no swap, and so
incurs neither swap fee nor shortfall. This is a geometric property of Uniswap v3 rather than
a property of this asset, so it transfers by construction.

The trade-off is real: one-sided ranges are directional and earn nothing until price returns,
so `maxExposurePpm` (currently 950,000) would have to bind meaningfully. This is the
highest-uncertainty lever in this note. It is listed because it attacks shortfall, the single
largest cost line at $0.741.

## The 99.8% deployment floor

`planner.ts:72` computes `sizingFloor = max(floor, maxDeploymentValue * 998_000 / PPM)`. That
hardcoded `998_000` silently overrides the configured `minDeploymentPpm: 980000` whenever the
configured value is lower, requiring every mint to deploy at least 99.8% of the $250 cap. The
constant is undocumented and tighter than stated policy.

Its consequences are visible in the session. It forces a precisely sized swap on every
recenter, which is what drives the bounded 400-quote search and the 1m48s construction
latency that `295ce91` had to parallelise. It produced `inventory_deployment_unfeasible`
twice and `construction_unproven` once between 16:03 and 16:06 on 09-23, the sequence that
ended the campaign. A larger required swap also produces proportionally larger shortfall.

Relaxing the floor to roughly 90% would idle about 8% of inventory, costing on the order of
$0.15 of fee income over a 31-hour window, against $1.14 of combined swap fee and shortfall
exposure. That asymmetry is worth measuring. Resolving the discrepancy between the constant
and the configured policy is worthwhile independently of any cost finding.

## Persistent capped allowances

Thirty-seven of fifty-four transactions were approvals, 29.4% of all gas. Decoded calldata
for one recenter cycle:

```
grant   USDG -> positionManager   267,476,069
grant   AAPL -> positionManager   736,937,207,084,201,555
grant   USDG -> router            267,476,069
... withdraw, swap, mint ...
revoke  USDG -> router            0
revoke  USDG -> positionManager   0
revoke  AAPL -> positionManager   0
```

The grants are full wallet balance. The zero-at-rest invariant therefore bounds exposure in
time, for roughly five minutes per cycle, and not in amount.

`data/live-persistent-allowance-2026-09-14-audit-v2/results.json` already replayed an **NVDA**
campaign under counterfactual capped policies. Its latest uninterrupted session scope:

| Policy | Approval txs | Omitted | Gas saved |
|---|---:|---:|---:|
| observed zero-at-rest | 62 | — | — |
| `finite_250` (1x cap) | 30 | 32 | 302,598 |
| `finite_1250` (5x cap) | 6 | 56 | 531,406 |
| `finite_2500` (10x cap) | 4 | 58 | 553,621 |
| `maximum` | 4 | 58 | 553,621 |

**A 5x cap captures 96% of the infinite-allowance benefit while remaining finite.** The same
file records why the shape is not linear: USDG decrements on transfer, so finite caps deplete
and need periodic re-grants, whereas the stock token treats `type(uint256).max` as
non-decrementing.

This transfers to AAPL by proof rather than analogy. The audit's recorded code hashes are
byte-identical to the live AAPL configuration for all three relevant contracts:

| Contract | Code hash | Result |
|---|---|---|
| USDG | `0x864cc9ad...234f36a6` | match |
| stock token (NVDA audit vs AAPL live) | `0x6c1fdd40...acd65630` | match |
| positionManager | `0x0a493d1a...cd6ead4f` | match |

NVDA and AAPL are the same token implementation. The cap should be expressed as a multiple of
`maxDeploymentValue`, never as a per-asset constant. Note that the audit records
`executionEligible: false`; it is replay evidence and does not by itself authorise a live
policy change.

## EIP-7821 batching

The operator wallet is EIP-7702-delegated to `0x63c0c19a282a1b52b07dd5a65b58948a07dae32b`.
`wallet-code.ts` only verifies that delegate; nothing uses it. Its deployed bytecode is 11,185
bytes and contains, among others:

```
0xe9ae5c53  execute(bytes32,bytes)    EIP-7821 batch execution
0x19822f7c  validateUserOp            ERC-4337
0x1626ba7e  isValidSignature          ERC-1271
0x150b7a02  onERC721Received
```

**The batch entrypoint is already deployed and already pinned by the config's
`delegateCodeHash`.** Nine top-level transactions per recenter cycle could be one. Selector
presence establishes that the function exists; it does not establish which execution modes the
delegate accepts, which a fork simulation must prove before anything signs.

Direct gas saving is modest: approximately 145,500 units per cycle, 13%, worth about $0.085
across the campaign, plus roughly $0.015 as revocations become warm intra-transaction stores.
The value is elsewhere.

Atomicity removes inter-transaction price drift, the mechanism behind much of the $0.741
shortfall, since the controller currently swaps at one price and mints at another minutes
later. It would have prevented the forced exit: the swap confirmed at 16:12:26, seven
`repriced_mint_wait` observations followed, and `live-controller.ts:53-54` abandoned the
redeployment at 16:17:06 because the mint could not be priced within 300 seconds of the swap.
That single non-atomicity cost **$0.31** to unwind, at 15.9 bps of shortfall on a swap that
should never have happened. It also eliminates the `RangeKeeperStaleCandidateError` class
outright; the 1.7-hour outage on 09-22 was a stale candidate between withdraw and swap.

Observed cycle wall-times were 9m49s, 25m37s and 11m46s. A batched cycle is one confirmation,
roughly 35 seconds.

Batching also makes zero-at-rest strictly stronger than it is today, since an allowance would
never survive a block boundary, while costing less. That dissolves the tension between this
lever and capped allowances.

## Fee tier selection

`tickSpacingForFee` maps 500 to 10, 3000 to 60 and 10000 to 200. The same `fullWidthSpacings`
on the 3000 tier yields a six times wider range and structurally fewer recenters, at six times
the fee per unit volume on materially lower volume. All three AAPL tiers are already indexed
(`0xAae0d815` at 500, `0x783C9bbB` at 3000, `0x3714aa81` at 10000), as are three tiers each
for GLD, NVDA, QQQ, SPY and GOOGL. This has never been swept and is testable entirely offline.

## Not worth pursuing

Gas limit padding costs nothing, because consumption rather than limit is charged. The 20%
submission margin should stay. Priority fee is already zero and effective price is the base
fee, so there is nothing to recover there.

Hand-tuning `fullWidthSpacings` for AAPL is the overfitting trap this note exists to avoid.

## Avoiding overfitting

Fit rules rather than constants. Width should be a function of realised tick volatility and
spacing; the allowance cap should be a multiple of `maxDeploymentValue`. A rule requiring a
per-symbol constant is overfitted by definition.

Hold out both symbols and time. Seven symbols across fifteen indexed pools and three fee tiers
are available. Fit on a subset and validate on held-out symbols and a held-out window. Require
a candidate rule to win on at least five of seven symbols rather than on the average, because
the mean is dominated by NVDA's 3.16M swaps.

Feed the measured cost stack in place of the $1.00 placeholder, and re-derive it under
whichever levers are adopted, since batching and capped allowances both change it.

Correct the replay's optimistic assumptions. The existing run assumes zero impact and no
self-dilution. The session measured 9.4 bps of average shortfall, which should be injected. At
7,228 ppm of pool liquidity against the 20,000 ppm cap, the self-dilution assumption is
defensible; the zero-impact assumption is not.

Report cost-to-fee ratio per symbol alongside net result. The session's diagnostic signal was
$2.048 of cost against $1.856 of fees; a ratio above one is a failure regardless of the sign of
P&L.

## Sequencing

Capped persistent allowances first, because the cross-asset evidence already exists, the code
hashes match, the saving is about $0.24, and the blast radius is small.

EIP-7821 batching second. The delegate is deployed and pinned, and the existing fork simulator
and pinned-fork gas methodology can prove a batched call before it signs. It removes two
outage classes and the forced-exit path.

The policy replay sweep third, across all fifteen pools with measured costs and a
`trigger_percent` dimension. This is where the $1.38 sits, and it risks no capital.

One-sided recentering and the `998_000` floor last. Both change the candidate constructor's
core invariant and want the replay harness in place first.

Levers one, four and five together plausibly move the controllable stack from $2.048 to about
$1.20 on a comparable window. Adding the deployment floor and one-sided recentering could
approach $0.80, which would make this session's fee income profitable before counting any
recovered uptime. These are extrapolations from a single 31-hour campaign and one five-interval
replay; none of them is a measured result.

## What this note does not establish

It does not establish that any configuration change is safe to deploy. It does not establish
the profitability of the strategy at any width, since the only width evidence is a
five-interval NVDA replay with illustrative costs. It does not establish that the delegate
accepts any particular EIP-7821 execution mode. It uses one campaign's cost measurements,
taken during a session that spent 6.7 of its 30.9 hours in crash loops, so the recenter sample
is four events.
