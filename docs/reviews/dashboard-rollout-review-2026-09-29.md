# Dashboard rollout review — September 29, 2026

The follow-up candidate passes its implementation and two-hour acceptance gates,
but **the direct production cutover is blocked by the existing campaign's pinned
runtime identity**. Preserve the running campaign and its original accounting;
do not run the previous empty-state cutover script or rewrite identity fields.

This review follows the user's instruction to proceed with the index and campaign
compatibility review after the [sealed acceptance checkpoint](dashboard-follow-up-2026-09-29.md).
Three Luna agents independently reviewed database delivery, persisted accounting,
and service/API compatibility. No production DDL, campaign mutation or service
restart was performed.

## Verified runtime boundary

At 14:41 UTC, campaign `b512d219-3171-4e9d-9f31-a66fcd590111` was an active
static/manual paper campaign, outside its range, at revision 1. Its only
operation was a succeeded open; there were no pending operations in that
snapshot. Its runtime was pinned to production build
`463e2eef44ff5ab5d29fc0ed864013e8a16a0a751758701c0344f797af9ba22b`, with
Node `v24.20.0` and configuration hash
`efd838c07c244bfd827909093ca3333e82dc928d4aa4a1a88c453d652f19e1c4`.
A subsequent read-only snapshot at 14:47 UTC counted 102 marks and 101
conversion V2 accounting records. The latest V2 record (ID 256, source mark 128)
retains the same old runtime. Its stored hash `1903b686…` matches a fresh
`contentHash(snapshot)` computation. Candidate configuration hash and Node
version match; the build ID alone differs. These are dated observations and
must be refreshed before an eventual cutover.

Candidate build `ec686132c49fe1cef8ef0ce31dfb16e23ba6e3159ea3d5886ed8c60868ba7274`
comes from source `aa64bd9`. Both manifests verify. The store, operation worker,
maintenance module and worker entrypoint are byte-identical between releases;
the runtime identity still changes because the build ID is part of it.

The incompatibility is enforced in existing source:

- `maintainCanonicalPaperScenario()` advances conversion V2 accounting as part
  of normal maintenance (`src/deployments/paper-maintenance.ts`).
- The V2 append path requires the campaign runtime to equal the running runtime
  and requires the predecessor snapshot runtime to equal it too
  (`src/deployments/store.ts`, `paper_accounting_runtime_mismatch` and
  `paper_accounting_prior_runtime_mismatch`).
- Close-convert admission binds prior accounting to the command service's current
  runtime. Completion separately requires campaign and worker runtime equality
  (`paper_close_convert_v3_prior_accounting_unavailable` and
  `paper_close_convert_v3_runtime_mismatch`).

Changing only the campaign's runtime field would leave immutable predecessor
snapshots bound to the old identity. Rewriting snapshots and hashes would destroy
their original provenance. Keeping only the worker on the old build does not
solve the command-side admission gate. The existing `upgradePaperRuntime()` is
for legacy `paper_sessions`, not `deployment_campaigns`, and cannot be reused as
a deployment-campaign migration.

A dashboard-only cutover is also unsuitable. Funnel serves `/api/*` from the
command service, whose old API rejects the new capital query and lacks the
selected-pool detail route. The candidate UI and command read adapter must move
together, while the campaign identity currently prevents that safe cutover.

Replacement units have been prepared by changing only release paths and passed
`systemd-analyze verify`. The verifier also emitted an unrelated installed snapd
`RestartMode` warning. Installed unit and environment hashes were captured for
rollback review. No candidate unit was installed.

## Index review

The [candidate DDL and concurrent rollback](../../scripts/maintenance/dashboard-research-index-candidate.sql)
match `readProtocolFees()`: equality on `stream_key`, the exact partial predicate
`event_name = 'SetFeeProtocol'`, `lower(pool_address)` for `DISTINCT ON`, and
block/transaction/log descending order. `event_args` carries the selected fields.
The CREATE index name is unqualified because PostgreSQL places it in the target
table's schema; the table and DROP target explicitly use `public`.

The configured command connection was verified to see the same unique live
review session and database as the local review connection. Thus the catalog
and planner evidence concerns the configured production database, not a separate
benchmark database. The candidate index is absent. The relation heap is 7,551,246,336 bytes
(about 7.0 GiB), with 11,678,867,456 total bytes including indexes, and about
6.26 million estimated rows. The review role `root` owns the table; ordinary
DML permission alone would not suffice for index creation. Existing indexes do not cover
this predicate and expression ordering; a planner-only EXPLAIN still chooses a
parallel sequential scan and sort. No full-table execution was run in this review.

Concurrent creation remains a separate production maintenance action. It allows
ordinary DML but scans the heap, takes brief locks, can wait on older transactions,
and adds I/O and WAL pressure. The synthetic benchmark from the earlier report
is not a production latency prediction. Before applying, refresh target/schema,
index definition/state, free space, WAL/replication conditions and concurrent DDL.
Use a dedicated connection with bounded lock and statement timeouts, and monitor
its backend and `pg_stat_progress_create_index`. Do not use IF NOT EXISTS to hide
a same-named incompatible or invalid index.

After creation, require valid/ready catalog flags and the exact index definition.
Run planner-only EXPLAIN first; only execute one bounded EXPLAIN ANALYZE after it
selects the partial index. Preserve before/after timings and buffers. If creation
fails, inspect any invalid remnant before a separately controlled concurrent
DROP/retry. The included standalone concurrent DROP is the rollback.

## Ordered next work

1. **Index maintenance:** apply the reviewed concurrent index under production DDL
   authorization, then measure the exact query and one cold Research build.
   This can be scheduled independently of the application cutover. Stop on lock,
   resource or planner-gate failure; do not retry an expensive build blindly.
2. **Campaign runtime transition:** implement and test an explicit, append-only
   deployment-campaign transition if this active campaign must continue across
   the release. Bind from/to sealed identities, unchanged configuration and
   economic module identity, campaign/revision, the exact predecessor mark,
   accounting/fee-carry hashes, and canonical source anchors. Preserve campaign
   ID, inventory, limits, counters, ledger, and every historical proof byte.
   A narrowly validated transition boundary must allow the old predecessor and
   new subsequent runtime without weakening unrelated identity checks.
3. **Acceptance before migration:** test uninterrupted continuation, worker
   interruption/restart, retry/idempotency, stale or changed boundary rejection,
   retained-history parity, fresh close-retain and close-convert, and restore
   with the original proofs. Neither raw SQL identity replacement nor a claim
   of byte-identical execution modules is a substitute for these gates.
4. **Coordinated release:** quiesce command admission, ensure no in-flight
   operation/preparation, stop the worker, capture and recheck the transition
   boundary, perform only the proven migration, and start the matching worker
   before both web services. Verify readiness, persisted continuity, fresh
   maintenance and the 27-comparison private/public asset gate. Review rollback
   at the accounting boundary; once new-runtime records exist, blindly restoring
   old units is not an adequate rollback.

If the campaign is allowed to finish on its original release instead, re-review
terminal accounting and maintenance compatibility before cutover. This review
does not authorize closing it merely to simplify deployment.

Private evidence and prepared unit files are retained in
`data/dashboard-rollout-review-2026-09-29/`, including `compatibility.json`,
`index-review.json`, `database-target-verification.json`, `release-comparison.json`
and prepared unit files. Final comparison confirmed unchanged service PIDs,
status, installed unit bytes and environment file hashes. The production index and service
rollout remain unapplied at this review checkpoint.
