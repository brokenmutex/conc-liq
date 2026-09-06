# Project review — 2026-09-06

Follow-up: the user narrowed the next milestone to one position's execution
lifecycle. The [implemented canary slice](nvda-canary-lifecycle-2026-09-06.md)
fixes the timestamp defect, scopes NVDA risk, and records a successful local
entry/exit rehearsal. This review below retains its original observation window.

The project is on the right architectural track. Canonical discovery, deterministic
state reconstruction, exact accounting, independent reference data, and disabled
execution are substantial progress. The current milestone is an operational
research platform with an unproven strategy. The next milestone should be a
reproducible, fully costed NVDA/USDG policy comparison that can support a decision
to proceed or stop.

Review scope: commit `f301903`, repository documentation and selected implementation
paths, the live dashboard at 08:01 UTC, and read-only PostgreSQL transactions at
08:07–08:09 UTC. The working tree was clean at the start. Current figures below
come from this review, not the initial September 3 planning notes. No runtime
configuration, services, trading permissions, or application code were changed.

## Verified progress

| Area | Evidence | Assessment |
| --- | --- | --- |
| Event collection and replay | 15 pools; 3,481,513 indexed events; indexer and replay agree at block 55,818,965 and the same hash | Working foundation |
| Position accounting | Latest dashboard accounting run 38 covers 15 pools, 1,480 initialized ticks, and 10,325 core positions at block 55,746,418 | Useful fee and inventory truth; core positions are not individual NFTs |
| Node protection | Latest DB sample healthy, 2 blocks / 0 seconds behind references; 5 ms private latency | Working at the observation boundary |
| NVDA strategy checkpoints | 217 checkpoints from September 5 12:32:48 to September 6 08:08:37 UTC; all excluded by strict RWA feed freshness, 216 also by quote-feed freshness | Collection works; there is no usable strict-primary replay window yet |
| Perpetual reference | 213 quality-passing snapshots; all scheduled internal-weekend mode | Useful research input, not an independent cash-equity mark |
| Joined pool/reference observations | 168 passing rows covering 163 distinct checkpoints, plus 8 rejected rows; no primary or external-session passing observations | Less than a complete weekend; not enough regime coverage |
| Measured costs | One NVDA/500 model: entry 2.966159 USDG; rebalance and exit unavailable | Entry evidence only |
| Policy results | No stored oracle-marked replay; no stored joined replay; no stored canary plan | Recent features are implemented but not demonstrated end to end on real data |
| Validation | `npm run check` passes type checking and all 28 test files | Good unit coverage; a separate realistic timestamp reproduction fails |

The last 24-hour health sample mix was 8,297 healthy, 154 half-open, 166 open,
and 5 degraded. About 96.2% of samples were healthy. This is a sample ratio,
not a wall-clock uptime guarantee. The database occupied approximately 6.6 GB.

The dashboard's older pool-spot replay used six accounting checkpoints and
illustrative 1 USDG entry/rebalance costs. Its best completed candidate reported
2.382371 USDG alpha on a 1,000 USDG scenario. That is a short, idealized screening
result, not demonstrated profit. The dashboard currently does not expose the
newer checkpoint, reference-join, measured-cost, or joined-replay status.

## Findings requiring action

### 1. The sequencer-feed dependency needs an explicit replacement design

The live risk gate reports `sequencer_feed_unavailable` and stale prices.
Chainlink's current [sequencer-feed documentation](https://docs.chain.link/data-feeds/l2-sequencer-feeds)
does not list Robinhood and states that expansion to additional networks has
stopped. Waiting for more checkpoints cannot resolve this dependency.

Specify a Robinhood-specific chain-health and recovery policy before building a
broadcast wrapper. Evaluate available L1/L2 evidence, head progress, quorum
agreement, outage detection, and recovery grace periods. Document the residual
assumptions. The existing RPC quorum circuit protects reads; it does not itself
establish oracle freshness or replace all sequencer-feed guarantees. Keep the
current execution denial until the replacement is designed and tested.

Future eligibility should be scoped to the target pool and proposed action.
An unavailable unrelated GLD feed should not determine an NVDA-only decision.
Separately specify how new exposure, rebalancing, fee collection, and risk-reducing
liquidity removal behave during stale-reference or degraded-service conditions.

### 2. Canary preflight crashes on ordinary millisecond timestamps

In [the timestamp conversion](../src/canary-plan/evaluate.ts), line 48 calls
`BigInt(milliseconds / 1_000)`. The CLI supplies `new Date().toISOString()`.
A timestamp with nonzero milliseconds therefore throws `RangeError` before the
plan can be persisted. Existing canary fixtures use whole seconds.

Reproduction: copy the existing canary test to `/tmp`, preserve its imports,
and replace `2026-09-05T12:00:02.000Z` with
`2026-09-05T12:00:02.123Z`. Two of four tests fail at the timestamp conversion:

```text
RangeError: The number 1788609602.123 cannot be converted to a BigInt because it is not an integer
```

Use integer milliseconds before integer division, or explicitly floor validated
epoch seconds. Add a regression covering the actual CLI timestamp format.
This is a reproduced defect; it was not fixed as part of this review.

### 3. Joined replay does not yet model information availability

[The loader](../src/joined-policy/store.ts) chooses quality-passing references by
smallest absolute source skew, maps them onto the pool checkpoint, and runs the
policy at that checkpoint's pool state. The replay input does not retain when
the perp information actually became available.

All 168 passing joins in the review snapshot use a perp observation after the
paired pool block, by 6.509–346.696 seconds. That is acceptable for an explicitly
asynchronous comparison, but treating the resulting policy as executable at the
earlier pool block introduces timing bias. Confirmation delay and checkpoint
capture time also matter, even with Chainlink marks.

Retain source availability and decision timestamps. Apply an action only at a
subsequent executable state after its information was available, with a stated
latency model. For historical joins, avoid selecting a later source using
knowledge unavailable to the policy at the modeled decision time.

The loader filters rejected joins before constructing intervals. The rejection
histogram is useful, but the policy does not model what it would do through a
rejected-reference interval. The current passing series has eight gaps longer
than ten minutes, with a maximum gap of 10m30s. Preserve the complete observation
timeline and specify hold, stop, or exit behavior during unavailable marks.
Do not silently connect arbitrarily distant passing observations.

### 4. The replay window limit conflicts with the collection cadence

[The CLI](../src/joined-policy/config.ts), lines 104–108, caps the selected latest
passing checkpoints at 256. At a five-minute cadence that covers about 21h15m.
The README's 60-checkpoint example covers about 4h55m, while requiring 48 hours.
Gaps can stretch elapsed time, but successful continuous collection should not
make the intended study impossible.

Add explicit start/end checkpoint or time boundaries, then load a bounded full
window through pagination or deterministic aggregation. Retain all swap-path
evidence and source gaps. At five-minute cadence a continuous 48-hour interval
needs approximately 577 checkpoint endpoints.

### 5. Joined replay omits the existing canonicality check at load time

The basis collector verifies canonicality when creating its immutable row.
However, [joined replay loading](../src/joined-policy/store.ts) does not join or
check the current stored canonicality proof, unlike `assertCanonical` in
[oracle-policy loading](../src/oracle-policy/store.ts).

If a previously passing checkpoint is later invalidated, a historical passing
basis row can remain selectable. Restore the matching block-number/hash proof
check and define reorg invalidation for dependent research artifacts. Add a
database-backed test for a formerly valid checkpoint whose proof changes.
No invalid current proofs were observed among the 168 passing rows; this finding
is a missing protection, not evidence that current history is corrupted.

### 6. Complete cost models cannot currently be produced

[The resolver](../src/cost-model/evaluate.ts), lines 59–63, always returns null
rebalance and exit costs and never emits `complete`. The joined loader requires
`complete`, so more sampling alone will not enable it without implementation.

The observed 2.966159 USDG entry model consists of a 2.850024 USDG mint P90 from
three samples, 0.059480 USDG NVDA approval from one sample, and 0.056655 USDG USDG
approval P90 from five samples. These are gas/setup observations. They do not
cover acquiring the required starting inventory, swap fees, slippage, or impact.

Define the exact intended lifecycle and collect comparable whole-transaction
evidence, including inner calldata for any multicalls. Fork simulation can prove
the call sequence and estimate gas without broadcasting; keep estimates distinct
from observed costs. A simpler fully costed mint/hold/decrease/collect baseline
can precede active swap/remint modeling. An explicitly static policy need not
depend on an unavailable rebalance cost for an action it never takes.

## What remains unproven economically

The [oracle policy engine](../src/oracle-policy/replay.ts) values inventory against
a separate mark, which is the right direction. However, it stops a candidate
when an interval crosses its range and recomposes inventory at ideal pool spot
when rebalancing. It omits swap execution fees, market impact, self-dilution of
fees, and actual inclusion latency. Its drawdown is checkpoint drawdown.

These are clearly disclosed research assumptions, but they prevent choosing a
production budget or range. In particular, range crossings are central to the
strategy being evaluated. Report their frequency and economic consequences;
do not compare only the candidates or windows that survive the certificate.

Keep both the existing post-entry matched-inventory comparator and a same-starting-
wealth benchmark. The former deliberately removes entry costs from both sides;
a deployment decision must additionally account for setup, inventory acquisition,
and liquidation on comparable terms. Include a static LP baseline so active
rebalancing has to justify its added costs. NAV marked at an endpoint is not a
realized cash exit.

The stored 120-day perp-candle assessment contains 17 nominally complete weekends.
Median absolute first-hour reopening correction is 0.4981%; P90 is 0.8969%; maximum
is 1.2453%. These are same-perp candle comparisons, not independent cash-equity
forecast verification and not LP returns. [trade[XYZ]'s documentation](https://docs.trade.xyz/perp-mechanics/external-price)
confirms that internal pricing evolves while the last external price is fixed.

The current session classifier uses Friday/Sunday clock rules and does not
classify holidays. September 7 is Labor Day on the official
[NYSE calendar](https://www.nyse.com/trade/hours-calendars). Verify the actual
perp operator and underlying-reference holiday schedule; a Sunday clock change
alone does not prove that external pricing resumed. Holiday-aware classification
is needed before treating historical sessions as verified reopenings.

## Recommended sequence and acceptance criteria

1. **Repair the research path.** Fix millisecond conversion, retain information
   availability, recheck canonicality, preserve rejected intervals, and support
   explicit multi-day windows. Add focused regression and PostgreSQL integration
   tests for these boundaries. Produce a reproducible report even when strategy
   evaluation is unavailable, with exact blockers and coverage.
2. **Resolve execution policy while collection continues.** Specify supported
   chain-health evidence, recovery behavior, pool-scoped eligibility, freshness
   by reference type, holidays, and separate exit behavior. Preserve shadow-only
   perp use until independent evidence supports a different policy.
3. **Complete the smallest economic lifecycle.** Start with a fully costed static
   NVDA/500 LP benchmark and exact fork-tested entry/removal/collection. Extend
   to swap/remint only with comparable costs and an execution model. Keep
   estimated, observed, and unavailable costs separate.
4. **Run a fixed research matrix on sufficient data.** Collect at least a complete
   trading week and two full weekends as an initial review target, including
   verified reopenings and stale-source episodes. More regimes may be necessary.
   Compare passive inventory, static LP, and active policies on matched capital;
   report net alpha, absolute P&L, drawdown, turnover, range crossings, coverage,
   and sensitivity to conservative costs/latency/size. Reserve later windows
   for evaluation after selecting parameters. Do not interpret a 48-hour minimum
   as evidence of a durable edge.
5. **Consider a manually approved tiny canary only after those gates.** Require an
   explicit loss budget, a tested removal path, exact plan binding and expiry,
   receipt/NFT accounting, and an operator stop procedure. The present task does
   not authorize a signer, funding, broadcast, or deployment.

Keep the universe focused on NVDA/USDG during this work. Additional strategy
variants or a larger dashboard are lower priority than completing one trustworthy
comparison. Add concise visibility for the current blockers and data coverage;
schedule database retention and backup work before expanding collection.

Raw review evidence and the read-only SQL used to collect it are stored in
[the evidence directory](review-evidence-2026-09-06/).
