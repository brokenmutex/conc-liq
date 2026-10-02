# RangeKeeper paper management — October 2, 2026

Status: implementation and isolated validation in progress. Production still runs
its previously sealed observation-only release. This record is not a deployment
or canonical lifecycle acceptance claim.

The requested behavior is retain-close (withdraw and keep AAPL plus USDG), Exit
close (withdraw and convert AAPL into USDG), and automatic RangeKeeper recentering.
The user explicitly confirmed the conversion behavior. Tests must preserve the
current campaign's opening baseline and history.

## Confirmed operator defect

The deployed retain-close preview returned a trusted, actionable
`rangekeeper_paper_exit_model`, but the frontend acceptance predicate only
recognized the static/manual `close_retain` model discriminator. The corrected
predicate recognizes the RangeKeeper response while keeping its digest,
revision, expiration and worker-readiness checks.

## Implementation boundaries

- A recenter appends a position epoch in the same campaign. The opening mark
  and initial capital remain unchanged.
- Canonical observations preserve outside-range persistence and the separate
  first/second confirmation. The 90-second observation guard remains intact.
- An owned local fork executes withdrawal, collection, a required balancing
  swap, mint and allowance cleanup. A further retained exit measures the
  reserve. Actual resulting position and wallet balances must match the model.
- Recenter and conversion completion require an in-process capability issued
  only after a fresh owned-fork replay of the accepted operation.
- Closing uses the current epoch's position and idle inventory. The original
  opening remains the performance baseline.
- Runtime adoption is an explicit append-only attribution boundary in the
  existing ledger. It binds predecessor release, environment, Node version,
  policy, profile, opening model and latest canonical mark. It adds no schema
  migration and rewrites no historical mark.
- Gas and swap costs remain modeled/provisional. Missing earned fees and final
  economic results remain unavailable.

## Validation record

Repository boundary, script registry and research artifact checks passed.
The latest full repository check passed 1,079 tests in 90 suites, with no failures.
The PostgreSQL deployment integration suite passed on an isolated database,
including legacy-shape preservation and append-only initial cost normalization.
Canonical lifecycle validation remains required before deployment.

Two disposable local databases were restored from a consistent data-only dump
of deployment tables and pool profiles. The source-only harness explicitly
uses a test identity and does not qualify as sealed-launch validation. It
checks adoption, real automatic recenter, worker restart, browser acceptance
and terminal history for each close mode. Production has not been closed or
modified by these tests.

Source validation recorded the initial modeled opening cost exactly once,
observed five minutes outside the range and completed two canonical
confirmations. On the retain copy, the worker autonomously booked recenter
mark 906 (epoch 1, source 78067281), then restart preserved the original open
mark 206 and the recenter row fingerprint. Subsequent browser exit checks
exposed and resolved the compatibility defects recorded below.

On the conversion copy, accepted recenter operation
`85489d5d-12a1-4677-a33a-98b240d69fa8` initially blocked on an evidence assertion.
A separate exact-source owned-fork replay matched its saved simulation hash.
After an explicit test-only requeue of that same operation, the default worker
completed mark 905 at epoch 1. Its frozen preview was unchanged. This establishes
replay and completion recovery, not an uninterrupted source lifecycle.

Upstream RPC failures also interrupted earlier attempts. Fresh sealed-launch
lifecycle checks remain outstanding.

The source browser checks exposed additional compatibility defects before
acceptance: strict exit-context parsing omitted candidate fields supplied by
the store; terminal probe identity validation used an undefined opening model
and an unserialized bigint candidate; gas registration compared against the
original runtime instead of the validated adoption chain. These checks were
repaired with focused regressions. Legacy epoch-zero exit context now
anchors position origin to the immutable opening while retaining the latest
observation as the previous mark; its PostgreSQL regression passed.

The shared dashboard projection recognizes RangeKeeper conversion-close marks,
preserves the terminal epoch, and counts modeled recenter and swap activity.
Final earned-fee, paid-cost and performance figures remain unavailable.

On the conversion source copy, the browser accepted Exit close with HTTP 202.
Operation `c3e8906b-c5d9-4c5c-94de-9692c622be4b` succeeded on its first worker
attempt and appended terminal mark 914. It retains epoch 1, has no position,
and records USDG `250244613` raw with AAPL `0` raw. The history helper was
corrected to explicitly select 24 hours instead of assuming the closed-position
default. A separate read-only browser run then passed desktop/mobile history,
exit activity, unavailable final NAV, and zero browser/asset errors. This
completes source conversion-close validation after the previously described
recenter recovery; it is not an uninterrupted sealed-release lifecycle gate.

The retain source copy accepted operation
`f659796b-3d1d-4657-b4d3-11a859b43258`, then blocked at completion because the
store still compared the current candidate with the immutable opening candidate.
The completion check now binds those identities separately. An exact-ID,
exact-reason test-only requeue completed terminal mark 913 with the accepted
preview unchanged. The mark retains epoch 1, has no position, and records
USDG `158519826` raw plus AAPL `276836248285330071` raw as principal lower
bounds. Read-only desktop/mobile history then passed with exit activity,
unavailable final NAV, and no browser/asset errors. This is recovery evidence;
it does not claim an uninterrupted close.

Release `0075588fed2d105abdb9105591751441e7721afe3d167fca3312958468aa44fe`
from source `1ba851d` was built and its two sealed clone runs were stopped when
the retain completion defect was found. Both stopped at epoch zero before any
recenter or close acceptance. Their copied historical marks remain preserved.
Fresh final clones were restored from the original dump for the corrected
artifact. Production still runs its predecessor release.
