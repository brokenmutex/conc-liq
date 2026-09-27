# Static paper setup preflight reasons — September 27, 2026

The operator authorized the next scoped investigation with “go” after the
[September 26 candidate review](static-paper-mvp-acceptance-f75d6277-2026-09-26.md).
Three Luna agents handled runtime tracing, focused reproduction and independent
review. Scope is setup failure reporting; no RangeKeeper/live expansion or
production activation is included.

## Confirmed finding

`buildStaticPaperSetupPreflight` returns `status: unavailable`, `source: null`
and a specific `missing[0]` reason when a canonical read, reference, freshness,
profile or cost-evidence check fails. The gas-preparation helper previously
classified every absent source as an initial/prepared preview source mismatch.
The setup wrapper then replaced the original missing reason with that generic
code. A focused test composed the actual preflight builder and setup preparer:
the second canonical check failed, and the old code reported source mismatch
instead of `fresh_source_not_canonical`.

This proves diagnostic masking. It does not recover the underlying cause of the
historical screenshot-only attempt: that attempt retained only the generic
reason. RPC failure, a missing source and a genuinely unequal source cannot be
distinguished retrospectively from its log.

## Scoped correction

Preserve the first allowlisted preflight reason only for an explicitly
unavailable result whose source is exactly null. Apply this at the initial and
post-sampling rebuild boundaries. Available/malformed results with no source
and non-null unequal anchors continue to fail the original mismatch guards.
There is no new source selection, retry, timeout extension or economic fallback.

An initial unavailable rebuild stops before sampling/import. A failed final
rebuild may already have imported provisional calibration evidence; it still
creates no draft or operation and does not authorize an economic action.

## Validation and delivery

Runtime source: `5905b470999e139234a9d5ecd268ea131dde33f2`. Focused tests
passed 18/18; the reproduction failed with the generic mismatch before the fix
and passed with the original canonical reason afterward. Boundary cases call
the production setup wrapper, including unknown/malformed reasons and absent
or available-null source fields. TypeScript and `git diff --check` passed.

Clean worktree `/tmp/conc-liq-static-mvp-runtime-20260926` passed repository,
TypeScript and **882/882 tests in 85 suites**. Log:
`/tmp/conc-liq-setup-reasons-check-5905b47-20260927.log`.

Build `d507e6dedb131a883cdeb5e23cc3fc220225eacf81b009d582545636e0772645`
was created under `/tmp/conc-liq-static-mvp-releases-20260926/`. Build log:
`/tmp/conc-liq-setup-reasons-build-5905b47-20260927.log`.

The first command invocation omitted `TEST_SEALED_RELEASE_DIR` and failed the
harness argument guard before artifact verification, fixture creation or
command/worker startup. Its log is preserved at
`/tmp/conc-liq-review-evidence/canonical-convert-setup-reasons-5905b47-2026-09-27.invocation-guard.log`.
The corrected invocation supplies the exact artifact/source, diagnostics flag
and screenshot directory. Its single actual canonical attempt passed with
exit zero. Its log is
`/tmp/conc-liq-review-evidence/canonical-convert-setup-reasons-5905b47-2026-09-27.log`.

Independent bundled-launcher verification passed. The 14,486-entry inventory
has no added/removed files and exactly two changed compiled JavaScript files:
`dist/src/deployments/static-paper-gas-preparation.js` and
`dist/src/deployments/static-paper-setup-preparation.js`. Launcher, worker,
accounting and all 11 dashboard assets retain their prior hashes. Evidence:
`/tmp/conc-liq-review-evidence/static-paper-setup-release-verification-d507e6-20260927.json`.

The canonical browser created campaign `8a4d1ac6-a5bb-4e37-8f84-adc543741b72`,
opened operation `d6e896e8-783b-466c-84f4-b8f8636a30f3`, recorded later
valuation and matching fee/V2 evidence over seven intervals, and completed
conversion `d9e48a19-3faa-4ddb-aabc-2c60594d96f8` at
`paper_close_convert_v3_reconciled`. Assertions verified one terminal mark,
three modeled capital-out ledger rows, zero paid-gas rows, available V3
accounting and exact terminal inventory. The operation used authenticated
browser setup/admission and actual sealed command/worker processes; no draft
was seeded. Desktop 1440 and mobile 390 matched persisted closed history and
explicit economic gaps. Captures are under:
`/tmp/conc-liq-review-evidence/browser-setup-reasons-5905b47-2026-09-27/8a4d1ac6-a5bb-4e37-8f84-adc543741b72/{desktop,mobile}.png`.
No signer was loaded, no broadcast occurred, and deployment writes were
isolated to the disposable fixture schema.

No setup-unavailable result occurred in this attempt. The deterministic
regression proves the reason-preservation repair; this successful process run
proves the normal setup path still completes. Neither reconstructs the original
unavailable condition or establishes that all future setup attempts succeed.

Recovery, restore and changed-anchor
results from the previous build retain their original runtime identity; this
setup-only change does not relabel those earlier process runs as new-build runs.
Production configuration, compatibility, custody/ownership, backups and exact
cutover authorization remain separate pending requirements.

The next action is operator review and concrete production cutover preparation.
Do not repeat successful campaigns merely to manufacture an availability claim.
If setup legitimately becomes unavailable again, diagnose its now-preserved
reason before considering any further change. Keep RangeKeeper, new live
actions and broader infrastructure deferred.

Cleanup checks found no fixture schema, worker-readiness lease, owned runtime
directory or remaining command/worker/Chromium process. The pre-existing
browser profile of uncertain ownership was left untouched.
