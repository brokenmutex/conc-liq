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

Repository checks, typecheck and 948 unit tests passed. Source commit
`aa64bd9779113c0d7da52a70896e5bed240cb1d2` produced sealed build
`ec686132c49fe1cef8ef0ce31dfb16e23ba6e3159ea3d5886ed8c60868ba7274`.
The manifest verifies; its private dashboard/command route gate passed all 17
asset comparisons. Against the sealed compiled modules and assets, risk
integration, 46 usability checks, 42 reliability checks and nine populated
Research browser cases passed with no browser exceptions. Fault-injection
503/409 responses are intentional; favicon 404s remain incidental.

The native-preview fixture holds its cost-dominated reserve, saved allocation
and admission limits fixed: +10% gas stays actionable, +30% is rejected without
an operation, and returning to baseline permits a new preview. This is a bounded
fixture result, not a promise about every reserve/gas configuration.

Harness copies replace only source TypeScript and dashboard JavaScript imports
with sealed artifact URLs. Original/derived hashes are recorded with the release
path. Private logs and preparation provenance are under
`data/dashboard-follow-up-2026-09-29/`.

The scaling fixture uses real PostgreSQL projections, HTTP and Chromium with
50 synthetic paper campaigns and 168 hours of persisted accounting per campaign.
Writes stay in a disposable schema. Retained legacy summaries may be read and
are filtered out of fixture responses. The concurrent worker calls the actual
operation worker's idle polling path; it does not execute economic operations or
maintenance. Database timings are client wall time, not server CPU usage.

The sealed run started at 12:13:10 UTC and finished at 14:14:54 UTC on
September 29. After fixture preparation, worker baseline and scaling, the actual
soak lasted **120.003 minutes**, with 121 samples, including 30 hidden-tab
samples. Both `r2Qualified` and `p6DurationQualified` are true; the process exited
0 with no recorded failures. The sealed manifest still verifies after the run.
Short smoke runs were not counted toward these duration gates.

After the first ten minutes, retained JS heap ranged from 1.32–1.85 MiB and
ended at 1.43 MiB (baseline 1.33 MiB). DOM nodes ranged from 2,544–4,614 and
ended at 2,544; listeners ranged from 86–90 and ended at 86. Every sample passed
the declared baseline-relative limits: 34,945,348 heap bytes, 4,935 nodes and
208 listeners. This is bounded two-hour evidence, not a claim that leaks are
impossible.

| Active fixture campaigns | Overview p95 | Detail p95 | Initial render | Minimum detail marks |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 51 ms | 198 ms | 766 ms | 168 |
| 10 | 37 ms | 354 ms | 763 ms | 168 |
| 50 | 67 ms | 375 ms | 602 ms | 168 |

Each overview distribution has five calls; detail distributions have one call
per campaign. At 50 campaigns, the slowest detail was 404 ms. Desktop and 390px
mobile pages had no horizontal overflow. A measured eleven-second polling
interval used three layouts / four style recalculations (12.7 ms layout,
4.7 ms style and 55.6 ms total task time). Scroll position and expanded setup
limits survived. Chart focus and selected text did not; setup capital `375` and
its input focus did survive the separate input-preservation check.

The soak made 1,479 dashboard reads: 1,151 while visible and 328 while hidden.
Their server-side response p95s were 91 ms and 83 ms respectively. Positions
continues polling while hidden—roughly eleven reads per minute in this fixture.
That cost remains an optimization opportunity; no hidden-tab pause is claimed.
Across the soak, instrumented dashboard connections executed 17,657 statements,
with 74.4 seconds aggregate statement wall time and 100.5 seconds aggregate
connection-held time, zero database errors and at most two checked-out clients.
These are summed client-side timings, not PostgreSQL CPU utilization.

There were 3,593 concurrent idle-worker polls. Poll latency p95 was 2.96 ms
against 4.79 ms across 31 baseline polls; maximum latency increased from
12.2 ms to 277.2 ms. The instrumented worker pool had zero errors and at most
one checked-out client. These results do not establish latency under active
operation execution.

The fixture schema was removed, and a separate catalog check found no matching
soak/risk/browser fixture schemas. Public campaign count was 1 before and after
(the existing campaign was not a fixture). The dashboard, command service and
paper worker remain active with zero automatic restarts on the prior production
build `463e2eef…`. No production cutover or production DDL occurred.

Raw evidence: `sealed-soak/report.json`, `samples.jsonl`, `requests.json`,
`worker.json`, `heap-before.heapsnapshot`, `heap-after.heapsnapshot`,
`cleanup.json`, and the derived `summary.json` under the private evidence root.
The harness is reproducible with `TEST_DATABASE_URL` and
`npm run test:integration:dashboard-scale-soak`; acceptance requires both
qualification flags, not merely process success.

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


## Subsequent production deployment

After the user explicitly authorized campaign cleanup, the backed-up paper
campaign was removed and the accepted candidate was deployed to dashboard,
command and worker together. See the [cleanup/deployment record](dashboard-clean-deploy-2026-09-29.md)
for the fresh production acceptance. This resolves the earlier nonempty-state
cutover blocker without rewriting historical runtime identities. The index
remains unapplied.
