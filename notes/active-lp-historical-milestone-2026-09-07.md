# First bounded active-LP research milestone — 2026-09-07

Status: crossing-aware observed fee accounting reconciles exactly, and the first
bounded range/churn screen is complete. No candidate has verified net returns or
has been selected for paper execution. The proposed independent-reference
tolerance is **±5%**, inclusive; its pure guard rejects missing or expired
reference evidence. No runtime policy, service, schema or funded position was
changed by this milestone.

## What was implemented

- `src/research/swap.ts` reconstructs v3 swap steps using exact integer math,
  including exact-input/output rounding, bitmap word boundaries, initialized
  tick crossings, price limits and traversal through zero liquidity. Each
  observed swap must reproduce both token amounts, final sqrt price, tick and
  active liquidity exactly. Event logs omit the original amount specification
  and price limit; the accepted interpretation reproduces observed cashflows
  and state, without claiming recovery of original calldata.
- `src/research/fee-replay.ts` uses the existing operational replay state inside
  an isolated research instance. It reconstructs global/outside/inside fee
  growth, mint/burn fee settlement, collection, protocol fee changes and flash
  payments. The operational replay and its database tables are unchanged.
- `src/research/reference.ts` implements the exact inclusive ±5% comparison
  with freshness, canonicality and quality gates. It is not wired into the
  running paper policy.
- `src/research/range-screen.ts` compares fixed ranges, edge recentering,
  immediate 70% triggers, and persistent 70% triggers with a ten-minute
  cooldown. It uses one-minute observations and a sixty-second delay before
  applying a frozen proposed range. A range that no longer contains price is
  rejected. These are geometric action proxies; token swaps, inventory limits,
  execution costs and hypothetical fee income are not simulated.
- `scripts/lp-research.mjs`, available as `npm run research:lp`, captures a
  read-only database snapshot, reconciles fees, verifies a bounded event set
  through HyperSync, and runs the structural screen. Large immutable inputs
  remain under ignored `data/`; checked-in reports identify their SHA-256 hashes.

## Observed fee-accounting proof

The frozen source contains **1,605,367 events** from both pools' initialization
through saved accounting run 1, block **53,589,223**. All reads were sequential
on one PostgreSQL repeatable-read, read-only transaction; network enrichment
ran after that transaction closed.

| Pool | Events | Swaps | Swaps crossing initialized ticks | Tick snapshots checked | Positions checked |
| --- | ---: | ---: | ---: | ---: | ---: |
| NVDA 0.05% | 1,585,288 | 1,539,336 | 28,882 | 430 | 4,883 |
| NVDA 0.30% | 20,079 | 14,945 | 557 | 46 | 404 |

Both pools matched the saved chain sqrt price, tick, liquidity and both global
fee-growth counters. Every captured tick matched liquidity gross/net and both
outside fee-growth counters. Every captured position matched liquidity, both
last-inside fee-growth counters and both tokens-owed balances. **No mismatches.**
The 0.05% replay includes six Flash events, which also contribute to fee growth.

The first implementation stopped on transaction
`0x1aadfb1ce133da12601b50cbd1807f1599dd146ca21d0882885288e89d6b8093`
at block 15,682,168. It consumed the remaining active liquidity and continued
to `MIN_SQRT_RATIO + 1` with no additional cashflow. Replaying only the amount
reported as consumed prematurely stopped at the last liquidity boundary.
Accounting now handles an unspent amount in the price-limited interpretation;
the recorded prestate/event is a regression fixture. No amount or fee tolerance
was introduced to accept it.

Evidence: [fee reconciliation](active-lp-research-2026-09-07/fee-reconciliation.json).
This validates observed-chain accounting, not unchanged-flow counterfactual
returns. The accounting audit crosses later dates only to reach the saved
checkpoint; it does not fit or score strategies on validation or holdout dates.

## Bounded historical coverage

The first development window is block **15,511,376–17,511,376**, inclusive:
**July 21 11:02:06–July 23 18:42:22 UTC**, approximately 55.67 hours. The interval
was fixed before candidate results were inspected. It lies entirely within
the proposal's development split.

HyperSync matched all **69,013 raw logs** against the frozen database source:
address, block hash, transaction hash, transaction/log order, topics and data.
It supplied **53,741 timestamp headers**, including interval endpoints. Every
event used in the screen has a matching block hash and historical timestamp.
No constant block-time estimate or event-ingestion timestamp was used.

Evidence: [coverage verification](active-lp-research-2026-09-07/coverage-verification.json).
This is an exact event-set comparison for the bounded interval. It does not
extend that independent completeness claim to all 1.61 million audit events.

## Range/churn comparison

There are 3,341 one-minute observations per pool. The initial plan covers 32
combinations: two pools, four requested half-widths and four range policies.
Four 0.30%/±0.5% combinations are excluded because no valid range fits the
initial inward-rounded tick grid. The other 28 produce structural results.
Requested widths are rounded inward; actual tick bounds are saved.

Selected 0.05% results:

| Requested half-width | Fixed-range sampled time outside | Immediate 70% range changes | Persistent 70% range changes | Persistent sampled time outside |
| --- | ---: | ---: | ---: | ---: |
| ±0.5% | 60.25% | 98 | 61 | 2.72% |
| ±1% | 48.46% | 24 | 17 | 0.51% |
| ±2% | 39.54% | 3 | 3 | 0.00% |
| ±4% | 1.77% | 1 | 1 | 0.00% |

Persistence reduces range changes for the narrower settings in this window,
with greater sampled time outside the range. This does not show that either
policy earns more after costs. Occupancy is sampled; separate interval-extrema
counts retain excursions between observations. A zero sampled outside value
alone is not proof of continuous activity.

The capacity check is a material limitation. At the initial 0.05% state, an
800 USDG position in a requested ±2% range would account for approximately
**86.52%** of combined active liquidity after adding itself. Across the tested
widths that share is approximately **76.56–96.60%**. An unchanged historical
trade/price path cannot credibly price that hypothetical deployment. These
values use the existing bigint budget-sizing helper as a capacity screen,
not an executable mint quote or authorization to deploy.

Evidence: [frozen screen specification](active-lp-research-2026-09-07/range-screen-v1.json.manifest.json)
and [all candidates](active-lp-research-2026-09-07/range-screen-v1.json).
An initial run stopped on the infeasible 0.30% tick grid before writing results;
the correction records only those combinations as excluded. Window boundaries,
policy settings and treatment of other candidates were unchanged.

## Remaining economic gates

The snapshot's synchronized reference/checkpoint collection begins September 5,
after this July window. The **actual proposed ±5% reference gate is unavailable
and rejects entry** here. The range screen is explicitly an unguarded geometric
diagnostic, and never treats pool price as independent “true price”. Historical
independent rounds and issuer/corporate-action evidence require targeted
enrichment before a reference-aware policy comparison can run.

No policy rank, net alpha, execution cost or hypothetical fee-income value is
reported. Further work must:

1. Select another bounded development window with adequate capacity for the
   research notional, using liquidity/data coverage rather than strategy
   results. Preserve the validation and holdout boundaries.
2. Supply causal independent reference and issuer-state history, then exercise
   the ±5% gate and withdrawal/inventory behavior. Missing inputs remain
   unavailable; the band is not relaxed.
3. Extend observed fee accounting to the hypothetical continuous portfolio,
   with explicit liquidity dilution and changed-flow assumptions. Add the
   matched reserve/holding controls and inventory-preserving redeployment.
4. Establish the concrete rebalance path and cost/scenario manifest before
   selecting an adaptive candidate or beginning forward paper execution.

## Validation and reproduction

`npm run check` passes: TypeScript plus **219 tests**. The new suite includes
217 independently generated Solidity swap-step vectors, the historical empty-
liquidity regression, fee settlement/protocol/Flash checks, exact ±5% boundary
and stale-reference cases, inward tick rounding, delayed decisions and
between-observation crossing detection.

The swap-step vectors were generated by executing official
[Uniswap SwapMath](https://github.com/Uniswap/v3-core/blob/d0831dc6b8a318df3872b6d68f6de135c9f3ec29/contracts/libraries/SwapMath.sol)
with Solidity 0.7.6 on an isolated local EVM, using `eth_call` and a code override.
The source commit, compiler and resulting vectors are saved in the fixture.
They cover both directions, exact-in/out, fee tiers, small/large liquidity,
rounding and the uint256-overflow fallback. Source equations also use
[SqrtPriceMath](https://github.com/Uniswap/v3-core/blob/d0831dc6b8a318df3872b6d68f6de135c9f3ec29/contracts/libraries/SqrtPriceMath.sol)
and [TickBitmap](https://github.com/Uniswap/v3-core/blob/d0831dc6b8a318df3872b6d68f6de135c9f3ec29/contracts/libraries/TickBitmap.sol).

See the [research evidence README](active-lp-research-2026-09-07/README.md)
for exact commands, artifacts and fixture regeneration.
