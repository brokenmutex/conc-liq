# September 27 review implementation: sealed release evidence

Status: candidate blocked by conversion acceptance; production replacement has
not been performed. A narrow maintenance-ordering follow-up is being prepared.
This follows the [implementation review](implementation-review-2026-09-27.md)
and the operator's instruction to commit and proceed. The source implementation
is committed; canonical acceptance remains a separate gate.

## Exact candidate

- Source: `7c7f60b12fe9682a10e3428fe26224089dda2a82`.
- Clean detached checkout: `/root/conc-liq-worktrees/review-release-7c7f60b`.
- Sealed build: `656364f30e0c6c48affd811bdeaa45e065b336bac9e1c6268bf01e3338743463`.
- Artifact: `/root/conc-liq/data/releases/656364f30e0c6c48affd811bdeaa45e065b336bac9e1c6268bf01e3338743463`.
- Pinned runtime: Node `v24.20.0`; artifact verification passed with its bundled
  Node and `launch.mjs --verify`.
- Private evidence directory: `/root/conc-liq/data/static-paper-review-7c7f60b`.

The clean checkout excludes the preserved unrelated hybrid/adaptive changes,
manifest-validator changes and older review edits. Ignored research inputs were
made available through child symlinks inside ignored directories. The first
clean check identified missing local research inputs; no validation rule or
source file was changed to resolve that availability issue.

## Validation

| Gate | Exact-candidate result |
| --- | --- |
| Clean `npm run check` | Passed: validators, typecheck, 893/893 tests in 85 suites. The shared checkout's earlier 897 tests include four unrelated hybrid tests. |
| Artifact verification | Passed. |
| Canonical browser setup/open/pause/resume/retain | Passed; campaign `03cfabbc-d3fd-499d-a1d9-5d6dff2a787f`, desktop/mobile captures retained. Actual sealed command and worker processes, signer unloaded, zero broadcasts. |
| Canonical ordinary conversion | Both first attempt and bounded unchanged retry timed out waiting for persisted fee carry/accounting through the latest mark. No conversion acceptance was submitted. |
| Economic conversion interruption/restart and canonical restore | Pending ordinary conversion gate. |
| Changed-anchor rejection after restart | Pending ordinary conversion gate. |
| Staged service syntax | Passed `systemd-analyze verify`; an unrelated installed snapd unit emitted its existing `RestartMode` warning. |

Clean-check log: `/tmp/conc-liq-clean-release-7c7f60b-check.log`. Build,
verification, retain and conversion logs are in the private evidence directory.
Earlier integration/browser/process checks remain recorded against the shared
source checkout in the implementation review; they are not relabeled as sealed
canonical acceptance.

The conversion tests use a separate disposable database,
`conc_liq_sealed_review_7c7f60b`, because worker advisory locks span a database.
Five canonical replay tables are exposed there with PostgreSQL foreign tables;
the test role has SELECT only, and the remote source session forces
`default_transaction_read_only=on`. All campaign/operation/accounting writes
remain in disposable schemas. No production fixture schema was created.

First conversion campaign: `e5605221-c2c4-4f68-970a-638eaf19280d`. Open succeeded
in one attempt; no conversion acceptance was submitted. The final diagnostic
found replay complete through block `74019961` while the latest mark used block
`74020414`; fee evidence and accounting reached the preceding mark at block
`74019946`. The final interval rejected with `Paper fee replay coverage
unavailable`. During the run the tail guard paused on RPC health, then recovered;
HyperSync HTTP 429 responses also delayed replay. This records an unmet coverage
gate, not a conversion bookkeeping result. A retry was started only after the
cursor resumed advancing; timeouts and evidence checks were unchanged.

The retry campaign `b988c874-6f7d-4ba3-a319-3e1023725a7f` reproduced the same
boundary. Final replay coverage was block `74025317`, latest mark `74025551`,
and fee/accounting through `74025185`. Open again succeeded in one attempt;
conversion acceptance count remained zero. Both fixture schemas were removed
by their cleanup paths. Provider diagnostics recorded 38 HTTP 429 responses
between 14:40 UTC and the diagnostic capture around 14:54 UTC.

Source inspection found a liveness issue as well as external replay lag:
`maintainCanonicalPaperScenario` samples a new valuation before projecting
existing marks, while conversion correctly requires accounting through the
latest mark. Repeated maintenance can therefore advance the admission target
while replay is catching up. The scoped follow-up is to project existing work
first and give a completed catch-up pass a readiness window before appending
another valuation. Latest-mark, canonical-source and freshness requirements
remain unchanged. That change requires a new source commit and artifact; this
candidate's retain result must not be relabeled as acceptance of the follow-up.

## Production snapshot and staged replacement

At preparation time, production database `conc_liq` had contiguous schema
versions 1–11, zero deployment campaigns/operations/marks, one market profile,
and no nonterminal operation. The dashboard's historical position list is a
separate legacy data surface. All three target services were active.

Only these installed fragments are proposed for replacement:

| Unit | Current build | Candidate configuration |
| --- | --- | --- |
| `conc-liq-deployment-command.service` | `ddc543b9…` | Same private operator environment, candidate build |
| `conc-liq-dashboard.service` | `ddc543b9…` | Same private dashboard environment, candidate build |
| `conc-liq-paper-operation-worker.service` | `d507e6de…` | Candidate build and inactive reviewed worker environment |

The candidate worker environment is
`/root/conc-liq/data/static-paper-mvp-runtime-review-2026-09-27.env`, mode 0600,
SHA-256 `865c81ab5e49afbe5b1a610ceabac1ffc13f67ca90a6a05373211540a9495f3d`.
Its only difference from the active worker file is removal of the unused
`ADAPTIVE_PAPER_STATE_PATH`. The active file remains unchanged. Candidate runtime
config hash: `1b68c65d679558d713aa29ec35f234d1917ddda39b242a4dcb13339c4f0b9969`.

The evidence directory contains `units/`, preserved `original-units/`,
`unit-manifest.json` with original/candidate fragment hashes, and
`config-identities.json` with environment file/config hashes. The existing
service arguments and other directives are preserved. This candidate adds no
DDL, profile registration, timer change, tail/RPC-health replacement, or new
live/RangeKeeper capability.

A read-only full database backup completed:

- File: `production-before-cutover.dump` in the private evidence directory.
- Size: `1366883679` bytes; mode 0600.
- SHA-256: `8222caf514bd77ae82b542702d995cbfa9503c74a15a024a1366c3331ed8b675`.
- `pg_restore --list` succeeded; listing retained as `backup-contents.txt`.

An archive listing is not a restore rehearsal, and this snapshot must be
reassessed if production activity occurs before a later cutover.

## Remaining release sequence

1. Complete applicable canonical conversion, economic restart/restore and
   changed-anchor gates against this exact artifact; preserve any failed runs.
2. Recheck production campaign/operation counts, worker ownership, original
   unit/environment hashes and backup applicability. An active campaign blocks
   changing its accounting runtime under the current continuity contract.
3. Review the concrete three-unit replacement with the operator. No service
   installation, restart, migration, profile write or real campaign opening has
   been performed under this preparation record.
4. After authorization, stop command ingress, drain/recheck operations, then
   stop the worker/dashboard. Install only the three staged fragments, reload
   systemd, start the worker and verify its actual PostgreSQL readiness lease,
   then start command/dashboard and verify the operator, catalog and positions.
5. Preserve the prior fragments, releases and environment files. Roll back only
   while there is no new accepted campaign/operation; after acceptance, preserve
   journal history and runtime ownership rather than switching accounting
   identity or restoring an older database over new evidence.

The next product milestone remains a human-operated AAPL/USDG paper campaign
through retain-close. Harness acceptance does not satisfy that milestone or
authorize live execution.
