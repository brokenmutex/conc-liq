# Research and Positions implementation baseline

Recorded 2026-09-22 from the checkout at `4ea72da`. This record implements W0
of [the accepted plan](research-and-positions-sol-2026-09-21.md). It is a source
and service inventory, not an activation or cutover.

## Ownership and dependencies

- The new catalog has exactly `static_manual_v1` and `rangekeeper_v1`. The
  current frozen RangeKeeper policy identifies itself as version `1.0.0` and
  state schema 1. No profitability retuning or policy rename is part of W0.
- `src/strategy/rangekeeper/planner.ts` owns the current 30-second decision,
  five-minute continuous outside timer, two-source confirmation, nearest-tick
  range, no-swap-first sizing and bounded swap search. Its
  `replayPaperMint` import from `src/research/management-audit.ts` is a legacy
  dependency to extract before a clean new Positions startup.
- `src/strategy/rangekeeper/live-store.ts` owns RangeKeeper campaign state,
  signed actions, transitions and marks in `rangekeeper_v1`. It performs DDL
  in `initialize()`. The next worker must use checked, explicit migrations and
  adapt this receipt journal; it must not silently import these rows into a
  second authoritative transaction journal.
- The old pilot and RangeKeeper stores both use advisory key
  `conc-liq-live:4663:<lowercase wallet>`. The new reservation/worker must
  acquire this key while an old worker may run. A SQL lease by itself does not
  establish custody release.
- The existing dashboard server is read-only and loopback-only. Its repository
  reads adaptive JSON, old paper state and RangeKeeper ledger. The new app's
  operational projections must start without those legacy files. The existing
  dashboard remains in place until a separately authorized cutover.
- Main database schema is checked at version 3. The new deployment schema is
  appended as migration 4; it does not edit the frozen baseline. The existing
  RangeKeeper ledger is in a separate schema and needs an explicit adoption
  preflight, preserving campaign ID, receipts and configuration identity.

## Observed runtime at inventory time

`conc-liq-rangekeeper.service`, `conc-liq-dashboard.service`,
`conc-liq-tail.service` and `conc-liq-rpc-health.service` were active.
`conc-liq-live-pilot.service` and the adaptive paper checkpoint service were
inactive. The current RangeKeeper AAPL/USDG campaign ID is
`31802d63-9ec8-423c-bc1b-f781f8b44f92`, with open NFT `1269524` at the
last documented canonical observation. See
[`rangekeeper-open-session-2026-09-22.md`](../operations/rangekeeper-open-session-2026-09-22.md)
for the sealed build, custody and dashboard evidence. Runtime custody may have
advanced since that observation; cutover needs fresh receipt and wallet checks.
No service, schema or funded state was changed for this inventory.
The read-only ledger query found this campaign in `holding` with a recent
heartbeat; its predecessor `470e5f84-ab82-4735-92f9-57e96c05b344` and
pilot `f8affe19-4d89-4132-b214-d67e5ad81331` were `closed`.

The working tree already contained edits to hybrid configuration, manifest,
validation, adaptive paper, hybrid research and its test, plus the untracked
hybrid cadence report. These are unrelated prerequisites and are preserved.

## Frozen validation policy for execution calibration v1

Calibration is component-specific: gas units, gas price, LP fees, swap output,
mint/withdraw amounts, delay and failure expense, and independent-reference
valuation have separate status. An AAPL fork stage allowance is an admission
bound, never a paid gas amount or a cross-pool paper estimate.

The following conservative defaults are fixed before scoring. They reflect
the lack of a sufficiently broad matched live sample; a profile is provisional
until it earns validation. A sample requires canonical receipt coverage, exact
starting balances and range, resolved principal/fee split and a known model
version. Related stages from one campaign count as one campaign for
independence. Reject samples with unresolved collection or reorg discrepancies.

| Criterion | Default v1 rule |
| --- | --- |
| Provisional | Fresh exact-call or owned-fork evidence, with source and path identity; no statistical accuracy claim |
| Validated | At least 30 matched observations across at least 5 campaigns and 2 distinct calendar weeks for a component/path/size band |
| Held-out check | At least 20% of campaigns, minimum 2 campaigns, later than training cutoff; freeze the model before the first held-out stage |
| Freshness | Exact-call gas inputs no older than 24 hours; fee capture and swap profiles no older than 14 days; gas-price observation no older than 15 minutes |
| Error | Gas units and raw token deltas: median absolute percentage error at most 10%, p95 at most 25%, plus zero-amount exactness; near-zero fee/cost uses raw absolute error stated in token units |
| Bound coverage | At least 95% of held-out paid cost observations inside the proposed admission bound; any underbound case invalidates a safety claim until reviewed |
| Status | `validated`, `provisional`, `stale`, `rejected` or `unavailable`; evidence class remains separate |

These are validation thresholds, not economics gates. When the denominator is
near zero, the profile must report absolute errors and mark relative error
unavailable. A sample below sufficiency remains provisional; no p95 estimate
is reported for a handful of correlated observations. Refresh drift daily and
after route, build, allowance policy or stage changes. Rescoring history must
be labeled retrospective and cannot rewrite previous paper marks.

## Migration and cutover design

Append-only migration 4 introduces market profiles, campaigns, immutable
revisions, expiring previews, idempotent operations, wallet reservations,
ledger entries, marks and calibration identities in the checked main schema.
No new request or worker may run DDL. A future adoption command reads the
predecessor schema, verifies canonical custody and pending signed actions,
then records a linked campaign identity in one transaction; it cannot take
execution ownership until the old worker has stopped at a reconciled boundary.
For rollback, the old worker remains pinned for open predecessor custody. New
signed actions require reconciliation before changing ownership.

W0 freezes contracts and defaults. W1-W7 remain gated by their acceptance
evidence in the authoritative plan; this record does not mark them complete.
