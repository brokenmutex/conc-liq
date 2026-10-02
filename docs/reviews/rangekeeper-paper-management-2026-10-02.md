# RangeKeeper paper management — October 2, 2026

Status: deployed on October 2 from source `e4a7e7c`, sealed build `0a2a395...`.
Both canonical close lifecycles passed after automatic recentering, including
numeric mark IDs above 999. Production adoption preserved all prior marks;
public desktop/mobile controls and service readiness passed. Production
automatic-recenter monitoring is recorded below. Earlier checkpoints are
retained as historical evidence.

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

## Validation history

Repository boundary, script registry and research artifact checks passed.
The latest full repository check passed 1,079 tests in 90 suites, with no failures.
The PostgreSQL deployment integration suite passed on an isolated database,
including legacy-shape preservation and append-only initial cost normalization.
At that initial checkpoint, canonical lifecycle validation remained required
before deployment.

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

The corrected artifact is
`762c22c4af8f2e7ead3258ea0b9233400d3943b94e436ffcbf4138d9e30ec613`,
sealed from clean source `aaa1ec8d357f4214334814a66c4c6dfbe46beb0b` with
Node v24.20.0. Its first two parallel lifecycle attempts verified both release
manifests, predecessor observation and append-only adoption, but did not reach
recenter acceptance. Conversion timed out at the 600-second recenter gate;
the retain attempt was stopped after repeated failures. Both copies remain
active at epoch zero, and all owned processes stopped. The failed logs are
`/tmp/rk-final-sealed-{retain,convert}-aaa1ec8-20261002.log`.

Those attempts reported HTTP/RPC error classes during canonical reads and
source verification, plus `construction_unproven` decisions. They did not
capture numeric HTTP/RPC error codes, so the cause is unconfirmed. A bounded
read-only probe subsequently passed canonical frame and pinned-quote reads,
and could read all four historical block headers selected from the failed
logs. Source and sealed configurations resolve to the same archive endpoint.
The probe is recorded in `/tmp/rk-readonly-rpc-diagnostic-20261002.log`.
Fresh sequential lifecycle tests retain the same artifact, policy, freshness,
readiness and release-integrity gates. Successful endpoint probes alone do not
qualify the artifact for deployment.

The sequential sealed conversion lifecycle then passed without requeue or
manual recovery on `conc_liq_rk_seq_convert_20261002`. Automatic operation
`980a123d-4743-49e8-bb4b-d5436b59d96b` appended recenter mark 879 at epoch 1
and source 78116296. Restart preserved opening mark 206, the recenter
fingerprint and all prior history. The real browser accepted Exit close as
`e0876c38-564a-47e4-861b-c7e9bc71800e`; its first worker attempt appended
terminal mark 882 at source 78117117. The campaign is closed, its position is
null, and modeled inventory is USDG `250165588` raw and AAPL `0` raw. The
current adopted build registered all seven terminal gas stages with one
replay and version. Desktop/mobile 24-hour history, exit activity and browser
health passed; final custody and economic values remain unavailable. All
owned conversion test processes stopped. Evidence:
`/tmp/rk-seq-sealed-convert-aaa1ec8-20261002.log`.

The sequential retain run independently completed automatic recenter operation
`6918f47a-8bdb-4119-b331-a0d89bee94ca`, mark 879 at epoch 1 and source
78122164, then passed worker restart and history continuity. Browser navigation
timed out before close acceptance: the test helper checked for an active row
before the initial Positions response rendered, immediately switched to
History, and then waited for the active campaign there. The copied campaign
remains active at observation 883 with only the opening and succeeded recenter
operations. Owned processes stopped. This browser-harness failure does not
establish a retain-close failure; its completion gate is still outstanding.
Evidence: `/tmp/rk-seq-sealed-retain-aaa1ec8-20261002.log`.

After the helper waited for a successful Positions overview, the same sealed
retain copy completed browser acceptance and worker close without a requeue.
Operation `cae55634-5a66-4d72-8e32-86b8a729c6ec` succeeded on attempt 1,
appending terminal mark 885 at epoch 1 with no position. Its retained principal
lower bounds are USDG `144201329` raw and AAPL `319887930342712218` raw.
Read-only checks verified all five gas stages shared one candidate, replay and
version, the effective adopted runtime matched the artifact/environment, and
opening/recenter fingerprints remained unchanged. Desktop/mobile history passed
and all owned processes stopped. The original navigation failure is preserved;
this is a browser-checkpoint continuation, not an uninterrupted harness run.
Evidence: `/tmp/rk-seq-sealed-retain-browser-continuation-aaa1ec8-20261002.log`.

The subsequent production rollout stopped the three paper/dashboard services
and made a consistent private backup. Runtime adoption rejected the latest-mark
check before appending anything. Diagnosis identified a numeric-ordering bug:
`SELECT id::text ... ORDER BY id DESC` sorts the output alias as text, selecting
mark 999 ahead of actual latest mark 1020. The existing sealed tests had stayed
below this digit boundary. Production's previous services were restarted with
their original units and environment; no adoption or release installation was
applied. Artifact `762c22...` is therefore not approved for deployment. A
qualified numeric ordering fix and SQL/canonical regressions crossing the
boundary are required before a new artifact can be adopted.

The numeric-order correction qualifies the underlying bigint mark column in
adoption, recenter lineage/acceptance/completion, and exit acceptance/completion
queries. The SQL fixture now uses opening 999 and observations 1000/1001,
then exercises adoption, epoch lookup and retained close. It fails on pre-fix
source `aaa1ec8` with the exact production adoption error and passes after the
fix. The temporary pre-fix worktree edit was restored. Full repository checks
again pass 1,079/1,079 tests in 90 suites. New sealed clone runs additionally
set the disposable mark sequence so predecessor observation begins at 1000;
this does not alter historical marks or production sequences.

The corrected clean release is
`0a2a39512709e68556157120e23e3fc53262567d2197ec9801f618b1482d304b`
from source `e4a7e7c75751a1d63f1d65e8193cf32f144fabad`. Its numeric-boundary
conversion run adopted at mark 1000, autonomously recentered at mark 1026
(source 78137628, epoch 1), and passed restart continuity. Browser close
`3a2293d3-4a4a-4294-8be2-31448dfdb39d` completed terminal mark 1029; the
numeric latest mark is also 1029. All seven gas stages, desktop/mobile history,
and unavailable final economics passed. Evidence:
`/tmp/rk-numeric-sealed-convert-20261002.log`. The equivalent retain gate and
production rollout remain pending at this checkpoint. The production campaign
policy's existing `maxRecenters: 4` and all cost/reserve limits are preserved.

The corrected retain run also passed without harness retry or operation
requeue. It adopted at mark 1000, recentered at 1026 (source 78143515,
operation `a7c8b797-3520-4181-8aa5-20aa497c90e6`), and passed worker restart.
Retain close `58217587-a182-4229-85e2-d2a0d838131a` succeeded on attempt 1
with terminal/latest mark 1029. Retained principal lower bounds are USDG
`128801756` raw and AAPL `366790629299208652` raw. All five terminal gas
stages and desktop/mobile history passed. Both numeric clone workers released
their readiness leases and all owned test processes stopped.

## Production rollout

After both corrected release gates passed, the three existing units were
stopped and a fresh consistent backup was made in
`data/backups/rangekeeper-paper-numeric-rollout-20261002-ITlF9X/`.
Adoption `28bc40d3f5ef3aba74e8bbcbeb59b9d789918e0c37704523c145dfa6085c48e9`
bound latest mark 1049 and appended an attribution boundary; the entire prior
mark fingerprint stayed unchanged. The environment, Node v24.20.0, opening
mark 206 and campaign revision 1 were preserved. No DDL migration was needed.

Only `conc-liq-dashboard.service`, `conc-liq-deployment-command.service` and
`conc-liq-paper-operation-worker.service` changed to the new pinned release.
Both health endpoints and the actual worker lease became ready in 6,423 ms,
within the unchanged 30-second gate. Process executable and launcher paths
matched the sealed artifact. Public `/operator` passed active-campaign,
enabled retain/convert review controls, 24-hour charts, activity, unavailable
economics and desktop/mobile layout checks. The browser submitted only the
session handshake. There were no browser exceptions or unexpected application
HTTP failures; the implicit missing favicon request was recorded separately.

The existing production paper campaign remains open. Its adopted worker
appended initial modeled-cost normalization at 1050 and its first recenter
confirmation at 1051. No close operation was submitted to production.

Production automatically accepted recenter
`d1f1568d-acc2-4353-bdcf-4e9ad2e61208` after two confirmations and completed
it on attempt 1. Mark 1053 at source 78147730 records epoch 1; subsequent
observation 1054 retained that epoch. The campaign remains active and inside
range. A final read-only check verified opening mark 206 and the fingerprint
of every pre-adoption mark through 1049 are unchanged, the effective runtime
is the new release, the worker is ready, and there are zero production close
operations. The public desktop/mobile check passed again after recentering.

The passed sealed lifecycle logs, full check, before/after numeric SQL
regression, release build and production browser/state proofs are archived
with SHA-256 hashes in
`data/backups/rangekeeper-paper-numeric-rollout-20261002-ITlF9X/evidence/manifest.json`.
The same private directory contains original unit/environment bytes, the
stopped-service database dump and successful adoption/install/start logs.
All three services remain active with zero restarts. Retain keeps both tokens;
Exit close converts AAPL into USDG. Costs remain provisional and unavailable
economic values remain unavailable. No live funding, signing or broadcast was
performed.
