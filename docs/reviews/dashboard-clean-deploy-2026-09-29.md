# Authorized paper cleanup and dashboard deployment — September 29, 2026

After the [runtime compatibility review](dashboard-rollout-review-2026-09-29.md),
the user explicitly requested: “clean those campaigns and deploy”. The reviewed
paper campaign was backed up and erased, then the dashboard, command service and
paper worker moved together to the already tested sealed candidate. No runtime
identity was rewritten and no economic close operation was submitted.

## Cleanup scope and backup

The sole campaign was `b512d219-3171-4e9d-9f31-a66fcd590111`, a static/manual
paper campaign. Command admission stopped first, followed by the paper worker
and dashboard. After writer shutdown, fresh counts and a custom-format
PostgreSQL archive were captured. The archive includes the targeted tables and
protected profile/calibration/live/history tables needed for review and recovery.
All target table-data entries were verified in the archive listing; the entire
archive was decompressed/parsed before deletion. This is archive-integrity
verification, not a completed restore rehearsal.

Backup: `data/dashboard-clean-deploy-2026-09-29/campaign-records.dump` (private
mode 0600), SHA-256
`58aefdef7b33f1e9d2c12cf81fb4d01b893edf996796b542536227e0076f7a60`.
The directory is mode 0700. Backup, original units, environment hashes, before/
after counts, protected fingerprints and executed SQL are retained together.

The reset locked exactly the 13 deployment tables in the campaign's foreign-key
closure. It rechecked the sole exact approved ID, paper mode, no pending/claimed
operations or operation intents, inbound foreign-key coverage and all archived
row counts, then used one transactional `TRUNCATE ... CONTINUE IDENTITY RESTRICT`.
The user-authorized reset deliberately bypassed append-only row deletion guards;
no triggers were disabled, no cascading truncate was used and sequences were
not reset. An unexpected campaign, dependency or changed count would abort.

Removed records:

| Records | Count |
| --- | ---: |
| Campaigns / revisions | 1 / 1 |
| Previews / succeeded operations | 3 / 1 |
| Ledger entries / marks | 3 / 111 |
| Fee evidence / accounting snapshots | 109 / 220 |
| Reservations, intents, invalidations, RangeKeeper confirmations/producers | 0 |

All 13 target tables were empty afterward. Fourteen protected-table fingerprints
matched exactly: retained live and RangeKeeper records, market profiles,
calibration profiles and legacy paper tables. Historical calibration references
to the erased campaign remain intentionally preserved. The six research/indexer
relations were outside the mutation set and retained their OIDs and physical
relation identities. Their continuously indexed row contents were not frozen or
claimed byte-identical. No index DDL was applied.

## Deployment and validation

The deployment began at 15:30:29 UTC. Backup/reset completed before installation
at 15:30:52. The new worker acquired its readiness lease before the web services
started at 15:30:56. All three use sealed build
`ec686132c49fe1cef8ef0ce31dfb16e23ba6e3159ea3d5886ed8c60868ba7274`, source
`aa64bd9779113c0d7da52a70896e5bed240cb1d2`, and its pinned Node `v24.20.0`.
Only release paths in the three service files changed. Both private environment
file hashes and the public Funnel routing remained unchanged.

The candidate's prior acceptance includes 948 unit tests, sealed risk integration,
46 usability checks, 42 reliability checks, nine populated Research cases and
the real 120-minute soak. Those checks were not relabeled as post-deployment
runs. Fresh deployment verification passed all **27 asset comparisons** across
local dashboard, local command and the public Funnel. Process working directories
and executable paths match the new seal; all services are active with zero
automatic restarts. Worker readiness is present and campaign/operation counts
are zero. Initial new-worker journal passes are informational with no logged
warning/error events.

The public browser pass verified `/`, `/operator/` and `/healthz` return 200;
all nine fetched assets match sealed hashes. Paper campaigns, drafts and
operations are zero, and the setup-draft API is empty. All three baseline live
history IDs remain, closed histories default to All, and Research summary/detail
requests work at 250 and 1,000 USDG (15 pools, 96 selected 24-hour detail points).
The observed Research source was 2m53s old against a 90-second limit; the UI
explicitly showed stale evidence rather than reporting it fresh.

There was no page overflow at 1440px or 390px, no browser exception or network
failure, and no economic mutation. The only POST was automatic session bootstrap.
The incidental favicon 404 remains. The first browser attempt checked the history
period before the detail controls mounted; its failure artifact was retained.
After correcting that harness wait and Research activation ordering, the browser
pass completed successfully. Logs, screenshots and verifier are in the private
`public-browser/` evidence subdirectory.

Independent archive review also confirmed root ownership, mode 0600, size
9,391,608 bytes, the matching SHA-256, and exactly 27 expected archived table-data
entries (13 reset targets plus 14 protected tables), with no missing or extra
table-data entries.

## Recovery boundary

Original unit files and the campaign archive are retained. Restoring the campaign
requires its original sealed build and configuration plus a deliberate database
restore; do not load its old accounting into the new worker and bypass identity
checks. Once new campaigns are admitted on the new build, a service-only rollback
would need another compatibility review. The cutover script refuses a blind
rollback when new candidate-state campaigns have appeared.

The separately reviewed Research index remains unapplied; the cold-build query
bottleneck is still a follow-up. The text-selection/chart-focus and hidden
Positions-polling backlog from the acceptance report also remains.
