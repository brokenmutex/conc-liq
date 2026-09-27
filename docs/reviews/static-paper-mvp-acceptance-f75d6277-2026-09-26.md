# Static/manual paper MVP candidate — f75d6277 — September 26, 2026

The operator resumed development with parallel Luna agents after the prior
checkpoint. Scope remains the static/manual paper MVP in implementation-plan
section 12. RangeKeeper and new live execution remain deferred.

**Result:** the static/manual paper release candidate has passing canonical
lifecycle, economic recovery, rejection and restore evidence on one clean
sealed runtime. Retain uses the composite evidence described below because its
original command failed during teardown. An additional screenshot-only attempt
was rejected during setup preflight; its uncharacterized availability failure
is recorded below. Production cutover remains unexecuted.

## Reviewed change and identity

- Runtime source: `5b22ce526a239f24f04262ac128f668aa4c27645`.
- Build: `f75d6277772d9beb19e633fb70a53b4d28d9b7884a487508754abe91514f483d`.
- Artifact: `/tmp/conc-liq-static-mvp-releases-20260926/` plus that build ID.
- Clean source worktree: `/tmp/conc-liq-static-mvp-runtime-20260926`.
- Bundled Node: `v24.20.0`.
- First external acceptance harness: the same source commit; follow-up harness
  `3af131b6bcf65571a46fe69d2ec552cc2ef906b1`. Both run from the shared checkout
  with pre-existing unrelated research changes preserved. The follow-up changes
  test code only; the runtime artifact remains the one recorded above. Restore
  helper commit `6ba12dc` additionally preserves PostgreSQL numeric text.
  Final ordinary conversion/restore harness: `2279e86`, including bounded
  Chromium shutdown and failure-safe fixture cleanup.

Only `launch.mjs` and `release-files.mjs` differ from the previously reviewed
`b78c3f22…` artifact. The launcher awaits complete inventory verification with
at most eight concurrent file reads before importing the application. Every
file digest, the exact inventory, manifest identity and symlink containment
remain checked. The synchronous verifier is retained for existing callers.
There is no trust cache, skipped file class, timeout extension or cache priming.

Production dependency pruning was investigated and discarded: an isolated
copy lost only 123 files and roughly 15 MB. Local warm verification timings
were inconclusive. The implementation alone does not establish a startup
performance improvement; actual restart evidence is required.

## Evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| Focused integrity checks | Passed sync/async inventory parity, contained symlink, changed/added/deleted files, altered manifest and escaping symlink rejection | Included in the clean check below |
| Clean source check | Passed repository checks, typecheck, 877/877 tests in 85 suites | `/tmp/conc-liq-static-mvp-check-5b22ce5-20260926.log` |
| Sealed build | Passed; clean source and bundled runtime recorded | `/tmp/conc-liq-static-mvp-build-5b22ce5-20260926.log` |
| Offline artifact and units | Full 14,486-entry inventory and bundled launcher verified; 13 units rendered and verified, not installed | `/tmp/conc-liq-review-evidence/static-mvp-offline-f75d627-20260926.json` |
| First canonical conversion interruption and restore attempt | Failed before restart: setup/open/later valuation passed, but acceptance returned HTTP 500 `command_failed`; no conversion operation was saved | `/tmp/conc-liq-review-evidence/canonical-convert-recovery-restore-sealed-5b22ce5.log` |
| Canonical economic recovery with harness `3af131b` | Passed restart, same-key expiry replay, exactly-once V3 completion, inventory/ledger and desktop/mobile parity; subsequent restore failed, so the combined command exited 1 | `/tmp/conc-liq-review-evidence/canonical-convert-recovery-restore-sealed-3af131b.log` |
| Canonical campaign restore | Passed on actual completed canonical conversion campaign using harness `2279e86`; the earlier unsafe-number failure remains recorded | `/tmp/conc-liq-review-evidence/static-paper-convert-browser-restore-sealed-2279e86-20260926.log` |
| Changed-anchor rejection | Passed, exit 0; blocked conversion with no terminal mark, ledger or V3 accounting rows | `/tmp/conc-liq-review-evidence/canonical-convert-recovery-negative-sealed-3af131b.log` |
| Ordinary retain on this artifact | Setup/open/pause/resume/retain and desktop/mobile parity passed; command exited 1 in subsequent browser-profile cleanup (`ENOTEMPTY`) | `/tmp/conc-liq-review-evidence/canonical-retain-browser-sealed-3af131b.log` |
| Ordinary conversion on this artifact | Passed with canonical restore and cleanup, exit 0; desktop 1440/mobile 390, one terminal mark, three modeled capital-out rows, zero paid gas | `/tmp/conc-liq-review-evidence/static-paper-convert-browser-restore-sealed-2279e86-20260926.log` |
| Additional screenshot-only attempt | Exit 1 before draft/open: setup preflight unavailable, `paper_cost_initial_preview_source_mismatch`; cause not established | `/tmp/conc-liq-review-evidence/static-paper-convert-browser-restore-sealed-2279e86-screenshots-20260926.log` |

The offline evidence JSON summarizes captured tool results; raw stdout was
not retained. `systemd-analyze verify` exited zero with the existing host
`snapd.service` warning about `RestartMode`.

The first attempt's initial worker readiness took 3.989 seconds with zero
physical read bytes. It did not reach interrupted restart, so this is no
evidence of fixing the previous restart timeout. The acceptance failure's
cause remains unconfirmed; the harness now quiesces tagged runtime transactions
before suspending the worker. The generic HTTP error does not establish cause.

Source review found a fixture race: maintenance audits lock the campaign row
while awaiting canonical reads, before attempting the preparation lease.
Unconditionally suspending that process can retain a row lock needed by HTTP
acceptance. This is a plausible explanation for the first attempt, not a
retrospective determination of its missing database diagnostics.

Harness `3af131b` tags only the child command/worker database sessions and
checks their state after suspension. It resumes/retries if a statement or
transaction remains open, retains the existing absolute five-second bound,
and preserves safe failure samples. A disposable PostgreSQL/child-process
proof detected an active transaction, resumed it, and retained suspension
only after two idle samples with the readiness lease still held. Evidence:
`/tmp/quiescent-worker-helper-proof-20260926.json`. This proves helper
mechanics, not canonical economic recovery.

The follow-up recovered campaign `56bef12a-73ec-428c-bf38-4ce46a1c9a00`
and original conversion operation `18824edb-80e6-4c86-b614-66a5860b8b2e`.
After natural preview expiry, the browser replay returned HTTP 202 and the
same operation with `replayed:true` while worker readiness was false. The
unchanged runtime environment restarted in **16.085 seconds** within the
existing 30-second bound, reading **236,650,496 physical bytes**. Initial
startup was 3.271 seconds with no physical reads. This clears the observed
restart gate in this run; it is not a controlled cold-cache benchmark or
a production startup SLA.

Before restore, the harness verified one succeeded conversion at
`paper_close_convert_v3_reconciled`, one terminal mark, one bound V3 snapshot,
three exact modeled capital-out records, zero paid gas, final inventory and
desktop/mobile closed history. Restore then failed at its evidence comparison;
that later failure must not be reported as a passing combined command.

The negative run changed exactly the saved accepted-model anchor in a test RPC
response. It was fault injection, not an observed chain reorganization. Restart
took **18.853 seconds** with **244,310,016 physical read bytes**. The original
operation blocked at `paper_recovery_required` with reason
`paper_operation_canonical_or_evidence_invalid`; no terminal conversion mark,
operation ledger row or V3 accounting row was written.

Restore helper `6ba12dc` hashes PostgreSQL `to_jsonb(row)::text` before JavaScript
can parse large numerics. A disposable dump/restore preserved exact values above
`MAX_SAFE_INTEGER` and detected a one-unit difference; unsafe parsed numbers
still fail closed. The existing restore integration passed separately with all
eight append-only guards, 88 constraints, 35 indexes and five sequences. Evidence:
`/tmp/static-paper-restore-lossless-numeric-proof-20260926.json`. These are helper
proofs, separate from the canonical campaign result below.

The retain run completed all operation/accounting/browser assertions before
`ENOTEMPTY` interrupted its finalizer. Its owned leftover schema/profile were
subsequently removed, with no runtime session/process remaining. Harness
`2279e86` waits for Chromium shutdown, retries profile deletion boundedly and
attempts remaining database cleanup even after a browser cleanup error. Three
actual Chromium start/close/profile-delete checks passed; their captured log is
`/tmp/conc-liq-review-evidence/chromium-close-cleanup-proof-3af131b.log` (the
filename predates the fix commit and does not identify the tested revision).
The retain result is composite evidence, not a relabeled exit-zero command.

Harness `2279e86` completed ordinary conversion and restore with exit zero for
campaign `0602cf45-8c8a-487b-a2a1-551fa8c92041`, conversion operation
`6fd31785-bb5a-4e8f-bb3d-85d636b9c038`. The canonical restore compared two
operations, three marks, six total ledger rows, five accounting rows and 18
model identity rows, plus 88 constraints, 35 indexes and five sequences. All
eight append-only triggers were enabled; mutation was rejected for seven
nonempty protected tables. The empty invalidations table was skipped in this
canonical fixture and covered by the separate synthetic restore test. The
source remained intact through rehearsal; the restore database and archive
were removed. This is actual canonical campaign restore evidence, not a
synthetic fixture substituted for it.

## Browser evidence

Desktop/mobile captures for this exact runtime are retained at:

- Retain: `/tmp/conc-liq-review-evidence/browser-retain-3af131b/` (campaign subdirectory).
- Successful recovered conversion: `/tmp/conc-liq-review-evidence/browser-recovery-positive-3af131b/56bef12a-73ec-428c-bf38-4ce46a1c9a00/desktop.png` and `mobile.png`.
- Blocked conversion: `/tmp/conc-liq-review-evidence/browser-recovery-negative-3af131b/b0e595be-7cfd-4c59-a2c5-6d4ebd861cd8/desktop.png` and `mobile.png`.

The final ordinary conversion/restore run asserted actual desktop/mobile
parity but omitted `TEST_BROWSER_EVIDENCE_DIR`, so it saved no PNGs. Its JSON
assertions and the same-build successful recovery captures are separate
evidence; do not attribute those captures to the ordinary campaign.

## Setup availability caveat

An additional screenshot-enabled attempt was already running when the
coordinator instructed that no repeat was needed. It exited 1 at
`createDraftAndAcceptOpen` before saving a draft or accepting open, with
`paper_cost_initial_preview_source_mismatch`. The runtime guard rejects an
initial rebuilt preview with a missing or different source; the log does not
establish which condition or upstream cause occurred. No new ordinary
conversion or restore result came from that attempt, and it does not replace
the preceding completed exit-zero campaign.

This is a fail-closed setup availability failure, not evidence of incorrect
economic booking. Its frequency and cause remain uncharacterized. Before
claiming consistently available setup, inspect the initial preview result and
its source binding using redacted diagnostics. Do not loosen the identity
check or run repeated campaigns simply to obtain a green result.

## Known operator limitation

In the changed-anchor case the activity list correctly shows the blocked
`paper_recovery_required` operation and the campaign never becomes closed.
The primary card still says `EXITING` / `Close in progress`. This proves
persisted blocked-outcome visibility, not clear blocked-state headline parity.
A narrow headline correction is follow-up UX work; no economic success is
inferred from the headline.

## Cleanup

After both final attempts, the runner verified no `static_convert_browser_%`
schemas, `conc_liq_restore_%` databases or `paper-mvp-%` database sessions
remained, and the recorded command/worker PIDs were absent. No owned runtime
or restore temporary directories or Chromium process remained. Root separately
confirmed the successful campaign schema and restore database were absent and
there were zero worker-readiness leases. An older browser profile of uncertain
ownership was left untouched.

## Delivery boundary

The process results above are automated real-browser candidate demonstrations
on the exact reviewed build. They establish the bounded static/manual paper
candidate, not production ownership, custody or schema compatibility. The
retain assertions plus cleanup proof and the final same-helper conversion
exit-zero run form explicitly composite evidence. Paper costs/conversion
remain provisional; unavailable economics remain unavailable. The supported
conversion sampler has a 1% candidate liquidity-share bound.

No production migration, profile registration, service installation,
activation, signer use or broadcast is included in this work. The existing
[cutover proposal](static-paper-mvp-cutover-inventory-2026-09-26.md) retains its
production ownership, compatibility, backup and authorization requirements.


## September 27 follow-up

The setup diagnostic masking is repaired in `5905b47`; candidate `d507e6d…`
passed clean checks and one canonical setup-to-convert browser run. See the
[follow-up record](static-paper-setup-preflight-reasons-2026-09-27.md). The
historical unavailable condition remains unrecoverable from this attempt's
log. All recovery, restore and rejection evidence above retains its original
`f75d6277…` identity.
