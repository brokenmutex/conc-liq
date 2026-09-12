# Paper liquidity share and fee dilution

The authorized policy replaces the 2% active-liquidity veto with a visible warning and adjusts future estimated fees for the liquidity our position adds. The starting budget remains 5,000 USDG, range ±20 raw ticks, full token allocation, continuous 24/7 operation, no inventory limit and no routine holding timeout. Recenter only outside range, swapping only what is needed. Existing reference, canonicality, infrastructure, quote lifetime and execution-price guards still apply.

`config/paper-nvda-5000-recenter-diluted.json` adds `liquidityShareMode: warn_v1` and changes `feeAccounting` to `diluted_segments_v1`. The existing `maxLiquiditySharePpm: 20000` becomes the warning threshold for this policy. Older policies retain their original hard cap. The dashboard distinguishes our liquidity divided by existing active liquidity from our share of the total after adding ours. An out-of-range position has no active fee share. A warning is metadata, never an exit reason.

## Fee accounting

For each fully overlapping canonical swap segment or flash-fee event, after the protocol's fee deduction:

- Original hypothetical credit: `floor(fee × Q128 / existingLiquidity) × ourLiquidity`.
- Adjusted credit: `floor(fee × Q128 / (existingLiquidity + ourLiquidity)) × ourLiquidity`.

Credits retain Q128 remainders between marks and reset position remainders at recentering, as before. The calculation uses the actual liquidity and protocol fee at each event, including liquidity changes and tick crossings. Existing initialized range boundaries split the swap into complete segments; partial overlaps are rejected. Replay must reconcile price, tick, liquidity, global fee growth and the independent inside-growth proof exactly before crediting fees. Missing evidence produces a visible wait, bounded by the existing source freshness checks, without an undiluted fallback.

This is a fixed recorded-flow and price-path estimate. It does not simulate how adding our position would change future prices, order routing, volume or other LP behavior. It is not a profitability proof. All fee income and gas charges remain estimates.

The new accounting starts at an explicit source-block boundary. Earlier credited fees, balances, charged costs, original passive holdings and observations remain on their original basis. Subsequent marks carry parallel adjusted/undiluted token totals and their source proofs. The dashboard displays the transition time, amount of the adjustment and mixed fee periods in the session report. Historical P&L/APY is not silently recomputed.

## Evidence

The three recenter observations previously rejected solely by the pool-share cap now complete on isolated Anvil forks with all other protections intact:

| Observation | Our liquidity / existing | Share after deposit | Result |
|---|---:|---:|---|
| 3572 | 2.0504% | 2.0092% | Completed |
| 3578 | 2.0146% | 1.9748% | Completed |
| 3590 | 2.3209% | 2.2682% | Completed |

These are individual mechanics replays with recorded inventories, not a replay of the subsequent campaign. [Fork summary](paper-liquidity-dilution-2026-09-12/replay-summary.json).

Sixteen real fee intervals reconcile exactly: [eight recent intervals](paper-liquidity-dilution-2026-09-12/fee-audit.json) and [eight busier historical intervals](paper-liquidity-dilution-2026-09-12/fee-audit-historical.json). The recent ratio was about 0.4806% of existing liquidity, so its current adjustment is small. The historical checks include changing liquidity and reconstructed multi-segment swaps. Recent read/replay times were 6–158 ms; the older rewind checks took 150–3,193 ms. Full local fork artifacts and validation logs are under `data/paper-liquidity-dilution-2026-09-12/`.

## Session 59 boundary-read interruption

Before deployment, the previous release invalidated observation 4603 at 08:04:46 UTC with `paper_boundary_fee_continuity_unproven`. No exit or other trade occurred. Direct pinned reads at block 60949761 proved both boundaries remained initialized with unchanged gross liquidity and outside growth; the only interval burn touched different ticks. Complete event replay also matched observed fees exactly. The available evidence identifies an absent checkpoint-matched boundary proof, consistent with a checkpoint becoming available/covered between prefetch and the accounting transaction. That timing is an inference; the previous release did not journal the prefetched proof.

The worker now waits when a fresh selected checkpoint lacks its matching boundary proof. Actual boundary discontinuity still invalidates accounting. The PostgreSQL lifecycle regression deliberately returns a proof for the wrong block and verifies a retry with unchanged state and no fill.

`scripts/paper-boundary-recovery.mjs` audited and repaired this specific accounting interruption. It requires the exact invalidation shape, unchanged prior financial ledger, canonical sources, healthy recorded RPC history, valid historical/current references, initialized boundary continuity and exact event replay. The entire path must stay inside the existing range, within the original 900-second checkpoint gap; both resulting decisions must be marks with unchanged liquidity, execution history and gas. It cannot create a past trade or recover an interval that required recentering.

Observation 4603 was reconciled at its original decision time, then a fresh mark resumed the position at the 08:10:31 UTC source. The original invalid observation and recovery inputs are retained in `state.boundaryRepair` and the local audit artifact. No trades were added, no balances reset and no gas charged. The dashboard labels the accounting repair. The first apply attempts rejected incomplete source evidence and rolled back; the eventual apply required all checks to pass. Applied audit SHA256: `f3b14e4af4be4d3fa050efb7eb0ba8ff099f6bda9672982396c724419d36ef19`.

## Upgrade and validation

`paper-upgrade --session ID --from-build SHA256 --policy FILE` allows only this fee/share migration from the original recenter policy. Every other policy field must match, as must the environment configuration and Node version. Under the worker lock it preserves the open ledger, records both policy versions and execution/observation cutoffs, clears a pending quote and adopts the new sealed runtime. Old accepted executions continue to require their old policy/runtime hashes; new executions require the new ones. Broad retuning is rejected. A rollback must understand both histories and use an explicit compatible transition.

Validation covers 102 focused paper/dashboard tests, typechecking, PostgreSQL runtime/policy migration, recenter proof validation, ordinary lifecycle and boundary-race lifecycle checks. Six new unit tests cover per-event dilution/protocol fees, outside-range zero credit, missing or conflicting evidence, integer remainder/accounting preservation, soft warnings and policy-hash provenance. Browser QA checks the fee/share preview and mixed-period labels. The paper worker and dashboard must use the same compatible release before new-policy writes begin. Frozen validation capsules and timers remain unchanged.
