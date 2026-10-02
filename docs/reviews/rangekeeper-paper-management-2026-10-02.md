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
The full repository check passed 1,071 tests in 90 suites, with no failures.
The PostgreSQL deployment integration suite passed on an isolated database,
including legacy-shape preservation and append-only initial cost normalization.
Canonical lifecycle validation remains required before deployment.

Two disposable local databases were restored from a consistent data-only dump
of deployment tables and pool profiles. The source-only harness explicitly
uses a test identity and does not qualify as sealed-launch validation. It
checks adoption, real automatic recenter, worker restart, browser acceptance
and terminal history for each close mode. Production has not been closed or
modified by these tests.

The first source run recorded the initial modeled opening cost exactly once,
observed five minutes outside the range and completed a real owned-fork first
confirmation. A later fork-restoration failure and upstream RPC failures
stopped the runs before a recenter was booked. These runs establish neither
automatic recenter completion nor terminal-close acceptance; both are being
rerun on isolated copies with current source.
