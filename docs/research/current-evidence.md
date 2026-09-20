# Current active-LP evidence

Status: paper research only. This document does not authorize execution or a
policy change.

## What is established

### Fee accounting

The September 18 calibration compared 43 live holding segments from the 250
USDG NVDA pilot. The diluted model matched realized fee accounting closely;
the observed fill haircut was negligible at that size and liquidity share.
This validates the accounting method for that bounded sample. It does not prove
that recorded pool flow remains available to a larger position.

The completed live campaign earned about 7.38 USDG in fees and incurred about
12.78 USDG in action costs. The economic deficit is therefore not explained by
fee-model optimism alone.

### One-sided residual liquidity

A residual range placed with one-sided inventory improved modeled net fees in
the two tested historical windows. The ranker nevertheless selected the
narrowest candidate mechanically, while that candidate had the weakest
reported return. The restart pins the wider `w20` residual choice as a paper
hypothesis. The sample contains a sustained decline and no sustained recovery,
which can flatter the covered-call-like mechanism.

### Forecast and session schedule

The selected paper hypothesis uses a six-hour flat-volatility window and a
fifteen-minute fee half-life. An opening blackout reduced modeled net fees and
was rejected. These are conditional results from one path, not universal
session effects.

### Pool universe

MSFT fee-3000 passed the bounded universe screen and is included at 1,000 USDG.
Its action costs are borrowed from NVDA fee-500 and therefore remain a scenario,
not execution evidence. GLD was removed because no acceptable independent
oracle was available. QQQ fee-500 is the 1,000 USDG holdout and must not select
the policy.

### Execution and data defects

The entry bound now uses liquidity rather than unstable per-token amounts. The
coverage cursor now preserves the true covered-through boundary. HyperSync tail
traffic fits the shared quota when run alone, but hourly action-cost collection
does not fit beside it. Retry and reset-aware backoff improve failure behavior;
they do not create more provider capacity.

The fee-tier route selector is pure and tested but is not connected to live
execution. Legacy provider mode remains unsuitable where two-provider
agreement is required.

## Current paper campaign

The guarded restart has four books:

| Book | Budget | Role |
| --- | ---: | --- |
| NVDA fee-500 | 2,500 USDG | selected strategy |
| GOOGL fee-500 | 2,500 USDG | selected strategy |
| MSFT fee-3000 | 1,000 USDG | exploratory, borrowed costs |
| QQQ fee-500 | 1,000 USDG | untouched holdout |

The runtime persists `executionEligible=false` and
`broadcastsEnabled=false`. Early P&L versus cash is operational evidence only.
The source tree now derives a fixed-token passive benchmark from each book's
exact post-entry inventory and shared entry cost. It excludes older sidecar
marks that reported the initial cash budget as holding NAV. The currently
deployed sealed paper release predates this change, and independent-reference
valuation remains unavailable, so current reported return still cannot be
called LP alpha.

## Open gates

- Complete the three-week, two-weekend paper observation period.
- Keep QQQ excluded from selection.
- Deploy the fixed-token passive benchmark through the guarded runtime migration
  and collect provenance-bearing marks.
- Implement the independent-reference valuation series.
- Probe MSFT-specific entry, recenter and exit costs.
- Separate tail and action-cost provider budgets without weakening quorum.
- Persist complete decision-frame provenance.
- Replace growing monolithic state arrays with bounded snapshots and an
  append-only decision/mark store.

The immutable source set and code hashes for this work are registered in
`research/manifests/strategy-redesign-2026-09-18.json`.
