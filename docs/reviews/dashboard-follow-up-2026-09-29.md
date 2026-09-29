# Dashboard follow-up — September 29, 2026

This batch addresses findings 7–12 of the [test report](dashboard-test-report-2026-09-29.md)
and prepares the finding 6 index change. Three Luna agents owned economics,
Positions, and Research delivery; the coordinator reviewed their integration
and added the scaling/soak harness. The [plan](../plans/dashboard-follow-up-2026-09-29.md)
defines the acceptance boundary. The original report remains the baseline.

## Changes

- Research defaults to 250 USDG and accepts 1–100,000 USDG with six-decimal
  precision, matching the setup controls. Cached canonical bucket inputs are
  repriced using exact integer V3 sizing and diluted fee share, preserving
  snapshot identity. Capital changes can change net ranking. These are modeled
  historical estimates, not execution authorization or paid economics.
- `/api/research` now returns a compact summary. The selected pool's detail
  endpoint requires matching snapshot, capital, window and width identifiers;
  a rollover returns 409. Four cached capital variants bound retained work.
  Response source age advances even when the underlying economics are cached.
- Research refreshes while visible, on return, by tab activation and by an
  explicit control. Failed refreshes retain visibly stale data. Request identity
  guards discard old responses; repeated detail mismatch cannot form a retry
  loop. Successful summaries also recover the setup pool registry. Handoff
  preserves an existing review, saved draft or pending request.
- Native allocation suggestions add rounded-up 20% headroom to open cost plus
  the greater of close cost or exit reserve. Fresh preview and admission limits
  remain authoritative; the cushion does not cover arbitrary gas repricing.
- Either aged/invalid source timestamps or server stale reasons degrade the
  current position's condition, age, detail warning and aggregate labels.
  Recorded values remain visible. Empty portfolios show unavailable totals and
  a setup link, distinct from filter misses and empty history.

## Verification and evidence boundary

Repository checks, typecheck and 948 unit tests passed. Browser acceptance,
sealed identity and duration-qualified results will be recorded below after the
candidate completes verification. Private evidence is under
`data/dashboard-follow-up-2026-09-29/`.

The scaling fixture uses real PostgreSQL projections, HTTP and Chromium with
50 synthetic paper campaigns and 168 hours of persisted accounting per campaign.
Writes stay in a disposable schema. Retained legacy summaries may be read and
are filtered out of fixture responses. The concurrent worker calls the actual
operation worker's idle polling path; it does not execute economic operations or
maintenance. Database timings are client wall time, not server CPU usage.

Short smoke runs have passed but do not qualify R2 or P6. The duration gate
requires actual elapsed time of at least 120 minutes and both qualification
flags, plus memory/listener/DOM bounds and cleanup. Production has not moved to
this candidate, and no production DDL is part of this batch.

## Index candidate and remaining limits

The reviewable [partial index and rollback](../../scripts/maintenance/dashboard-research-index-candidate.sql)
target only `SetFeeProtocol`. The [isolated benchmark](../../scripts/maintenance/benchmark-dashboard-research-index.mjs)
uses a session-local temporary table containing 250,000 Swaps and 16 matching
events. Its measured scan changed from 34.43 ms / 4,546 local reads to 0.23 ms /
one local read and one hit. These synthetic numbers establish selectivity and
plan shape; they are not production timing or I/O predictions. The production
cold-build bottleneck remains until a separately authorized index is applied and
measured.

A synthetic 15-pool / 672-bucket / 1,500-depth-point payload changed from
3,726,291 bytes to 99,553 bytes for summary plus selected 24-hour detail (97.3%
reduction). This is projection evidence, not a new production slow-4G benchmark.

The portfolio refresh still loses text selection and SVG chart focus; setup
inputs and focus survive. Those render-state issues and the original report's
other backlog remain outside this batch. Idle-worker footprint evidence cannot
establish active economic execution isolation. A future production cutover must
also review current campaign/runtime identity compatibility; the old empty-state
cutover assumption must not be reused.
