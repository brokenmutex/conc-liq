# Implementation review — static/manual paper MVP, 2026-09-27

Independent review of implementation progress, requested by the operator.
Review source: `c604cf3` with the pre-existing unrelated dirty hybrid/adaptive
files. This document records findings and recommendations only. It does not
establish MVP acceptance, authorize a campaign, a migration, a service change,
signing or live execution, and it does not supersede the delivery order in
[implementation plan section 12](../plans/research-and-positions-sol-2026-09-21.md#12-september-26-mvp-review-and-sol-delivery-order).

## Verified state

Measured during this review, not carried forward from earlier records.

| Check | Result |
| --- | --- |
| `npm run check` with pinned Node 24.20.0 | Five repository validators, typecheck and **890/890 tests in 85 suites** passed on the shared checkout, including the dirty hybrid files |
| Production services | Five active: dashboard, command API, paper operation worker, rpc-health, tail. `/healthz` returned `ok`; `/api/positions` returned 200 |
| Deployed builds | Command and read-only dashboard on `ddc543b9…` (`data/static-paper-mvp-operator.env` and `data/dashboard-live-pilot.env`); paper worker on `d507e6de…` (`data/static-paper-mvp-runtime.env`) |
| Production schema | Contiguous checksummed migration history 1–11 |
| Production records | `deployment_campaigns=0`, `deployment_operations=0`, `deployment_marks=0`, `deployment_calibration_profiles=0`, `deployment_market_profiles=1` (AAPL) |
| Funnel exposure | `/`, `/api/`, `/tabs.js`, `/operator/` proxied publicly from `https://dear-foxhound.tail106f9e.ts.net` |
| Volume | 66,055 lines `src/`, 24,868 lines tests, 7,516 docs, 7,535 notes; 345 commits since 2026-09-20 |

The controlling fact: **the MVP is deployed and has never been used once.**
Zero campaigns, zero operations, zero registered calibration profiles. Every
green result is green against a harness.

## What is established and sound

- **Fail-closed behavior is real, not decorative.** 393 distinct
  `DeploymentConflict` codes, exact `bigint` arithmetic, canonical anchors
  re-verified inside the commit transaction (`src/deployments/store.ts:4630`),
  append-only ledgers, and missing evidence that stays `null` instead of `0`.
- **The sealed-release boundary holds.** `launch.mjs` strips inherited
  application environment variables, pins `PATH` and `ANVIL_BIN` to bundled
  binaries, and hashes only the private environment file into the runtime
  config identity, so a systemd `Environment=` override genuinely cannot enable
  the worker. Anvil is bundled in the artifact and hardlink-shared across
  releases.
- **Failure evidence was preserved rather than tidied away.** The sixth-run
  restart timeout, the HTTP 500 with unconfirmed cause and the retain cleanup
  failure all retain their original build identities. That discipline is what
  makes the surrounding evidence worth anything.
- **The cutover was executed carefully:** timers stopped, sessions and advisory
  locks drained, backup identity verified, nine units installed, original unit
  copies preserved, and post-cutover verification performed independently.

## Findings

### F-1 — The MVP cannot answer the business question

The strategy contract in [`docs/strategy/active-lp.md`](../strategy/active-lp.md)
defines the objective as net LP alpha against passive ownership. What the
static/manual paper MVP produces is principal-only marks, modeled fees from a
hypothetical fixed-flow scenario, and paid gas that is permanently unavailable —
the `gas_paid` ledger was empty in every acceptance run. The number the operator
will obtain therefore cannot be compared against the stated objective.

Two real measurements already exist and point the same way:

| Campaign | Fees | Costs | Net |
| --- | ---: | ---: | ---: |
| NVDA 250 USDG live pilot | $7.38 | $12.78 | −$5.40 |
| AAPL/USDG RangeKeeper, 31h, 2026-09-22 | $1.856 | $2.048 | −$1.178 |

The strategy does not fail to earn; the AAPL campaign earned at 301% APR while
in range. It is unprofitable because the cost stack exceeds the fee stack. A
paper console that models fees and cannot observe paid gas is the wrong
instrument for that problem.

### F-2 — The operator command surface has no access control

Verified during this review: `POST /api/session` with an empty JSON body and a
matching `Origin` header returns 200 with a session cookie and CSRF token, with
no credential of any kind. `/api/` is proxied publicly by Funnel. Password
sign-in was removed at the operator's explicit request (`d7ee27f`), and both
`docs/operations/static-paper-mvp.md` and the Funnel record state the
consequence plainly: anyone who can reach the URL can use the paper controls.
The cookie, same-origin and CSRF checks are request protection, not an access
boundary — the source comment says so.

This is the operator's decision and it is documented. Recording the boundary:

- **Blast radius today** is not custody. No signer is loaded and broadcasts are
  unavailable. It is unauthenticated ability to create paper drafts, previews
  and operations, consume RPC/owned-fork and database capacity, and pollute the
  accounting series of a campaign whose purpose is evidence.
- The Funnel hostname is committed in this repository and Funnel hostnames
  appear in certificate transparency logs. It is discoverable, not secret.
- **Hard precondition:** [plan section 6](../plans/research-and-positions-sol-2026-09-21.md#6-command-api-security-and-ui)
  requires single-operator authentication before remote command exposure, and
  W4/W5 add live open/close to these same routes. Authentication must be
  restored before any live capability is enabled on this surface, and that
  dependency should be recorded as a live gate rather than rediscovered later.

### F-3 — The setup form is an engineer's form, against a 180-second window

`dashboard/index.html` asks the operator to hand-type **ten risk limits in raw
units** ("raw reference USD (X18)", "wei"), plus a wallet address and a native
allocation in wei, with no defaults — `normalizeSetupLimits` in
`dashboard/tabs.js:13` rejects any blank field. Plan section 6 specifies the
form as pool with fee tier, capital, centered half-width, strategy and mode.
This is scope creep into the one surface that most needs to be simple.

It also collides with freshness. `src/deployments/static-paper-setup-review-cache.ts:4`
sets `MAX_AGE_MS=180_000`, and expiry is
`min(sourceBlockTimestamp, gasPriceObservedAt, now) + 180s` — measured from the
**block timestamp**, not from when the operator started typing. The owned-fork
gas sample consumes part of that window before anything is displayed. The cache
is process-local, so a command-service restart voids outstanding reviews.

Predicted first-run experience is repeated review expiry. No harness covers it,
because every harness supplies its values instantly.

### F-4 — Operation latency was diagnosed, not fixed

`src/deployments-paper-worker.ts` runs a maintenance pass, then at most four
operations, then `pause(60_000)`. There is no `LISTEN`/`NOTIFY` anywhere in
`src/`. A submitted operation therefore waits for the remaining sleep plus a
maintenance pass — typically 60–120 s. The catch-all in
`src/deployments/paper-operation-worker.ts` returns `retry` on a transient error
without releasing the 120-second claim, so one transient error costs two minutes.

The MVP-2 300-second timeout was this, not a harness defect. It was addressed by
measurement and a concurrent startup verifier rather than by giving the worker a
wakeup. A `pg_notify` on operation insert plus a short poll while work is pending
would reduce this to seconds without touching lease ownership or exactly-once
completion.

### F-5 — A build or configuration change during a campaign blocks its accounting

`src/deployments/store.ts:3907` throws `paper_accounting_prior_runtime_mismatch`
when `contentHash(priorAccounting.runtimeIdentity) !== contentHash(currentRuntime)`,
where runtime identity is build ID, config hash and Node version. The same gate
appears at `:2789`, `:4620` and `:4872`.

Any build or private-environment change while a campaign is active therefore
blocks that campaign's accounting projection permanently. The README's promotion
bar is three weeks spanning two weekends. At 345 commits in eight days and three
production builds in two days, an untouched three-week campaign is not plausible.
There is no documented adoption path across runtime identities.

Related hygiene: the worker's hashed configuration still points
`ADAPTIVE_PAPER_STATE_PATH` at
`data/adaptive-paper-restart-2026-09-18/state.json`, which does not exist — that
experiment was stopped and cleared on 2026-09-20. Dead configuration is now
load-bearing, because its hash is what accounting continuity is bound to.

### F-6 — Exact schema equality forces fleet-wide lockstep

`src/storage/compatibility.ts:41` requires `max(version)` to equal
`DEPLOYMENT_SCHEMA_VERSION` exactly, and `assertSchemaReady` upper-bounds at the
build-time constant. That is why one paper feature required replacing seven
existing services plus a separate retention-guard cherry-pick, and why
schema-3-only builds are not a rollback. Every future migration repeats this
cost. A capability check — do the tables and columns this service reads exist? —
with only a lower version bound would decouple readers from writers without
weakening any guarantee.

### F-7 — Accretion in the deployments module

`src/deployments/` is 68 files and 17,789 lines, with `store.ts` at **5,159
lines** and roughly sixty public methods spanning profiles, drafts, previews,
acceptance, claims, gas registration, fee carries, accounting and both close
paths. Specifically:

- **Four coexisting paper accounting policies**: `paper_fixed_flow_lower_v1`,
  `convert_v1`, `convert_v2`, `convert_v3`.
- **Two live close-convert paths in the worker**: the V3 prestate path, which is
  what production produces, and the older
  `prepareTrustedPaperCloseConvert`/`completeTrustedPaperCloseConvert` branch.
  Two independent ways to book one conversion is a correctness surface, not only
  clutter.
- The V2 close-convert gas path (`registerPaperCloseConvertGasEvidence`,
  `src/deployments/paper-gas-source.ts:246`) requires runtime-identity equality
  with the registering process, which the current split-build production would
  fail. It is unreachable today, which is precisely why leaving it wired in is
  a hazard.
- `GET /api/strategies` returns `paper:false, live:false` hardcoded
  (`src/deployments/server.ts`), which now contradicts the shipped capability.

### F-8 — Process artifacts are outgrowing the product

15,051 lines of docs and notes against 66,055 of source. The authority document
is 2,386 lines and its own status table lags reality: MVP-5's "remaining"
configuration, compatibility, backup and authorization gates were closed by the
September 27 cutover. The README's "Current research boundary" still describes
the four-book adaptive experiment as active; it was stopped, disabled and
cleared on 2026-09-20.

The most decisive analysis in the repository,
`notes/rangekeeper-operational-cost-reduction-2026-09-27.md`, was filed into
`notes/`, which the README declares frozen historical evidence and not an
active-work surface. By the repository's own convention it belongs under
`docs/research/`.

### F-9 — Uncommitted work is on a retired strategy family

The dirty files (`src/research/hybrid-lp.ts`, `config/hybrid-lp-250-paper.json`
and their tests) implement an exit-cooldown recentering trigger for the **hybrid**
family, which plan section 2 retires and which `STRATEGY_IDS` excludes. The work
itself is sound, including correct cancel-before-withdraw semantics and four new
tests. One review note on its manifest change:
`scripts/maintenance/validate-research-manifests.mjs` now reads pinned bytes via
`git show` and skips the on-disk check entirely, so the manifest no longer
notices the working file diverging. That is defensible for `original_checkout`
mode, but the validator should still assert the on-disk file exists and record
divergence.

## Path to the MVP

One step remains, and it is not a code step.

1. **Open one real campaign.** AAPL/USDG at minimum capital, through the
   operator UI, driven to retain-close. Nothing else in the plan de-risks
   anything until a human has completed this once. Expect F-3 to bite; that is
   part of what the run establishes.
2. **Three small fixes first**, hours rather than days: seed the ten limit
   fields with defaults from the registered profile and label them in human
   units; add a `pg_notify` wakeup plus short poll to the operation worker;
   correct or remove the dead `ADAPTIVE_PAPER_STATE_PATH`.
3. **Record the upgrade-during-campaign rule** (F-5): either an explicit
   adoption path across runtime identities, or a documented freeze window.
   It is currently an undocumented trap.
4. **Then stop.** Do not start RangeKeeper paper or live work until a real
   campaign has closed and its numbers have been compared against what the
   harnesses predicted.

## Recommended improvements

Ranked by value against effort.

1. **Fix `src/strategy/rangekeeper/planner.ts:72`.**
   `sizingFloor = max(floor, maxDeploymentValue * 998_000n / PPM)` silently
   overrides the configured `minDeploymentPpm: 980000`. It is an undocumented
   constant tighter than stated policy, and it forces a precisely sized swap on
   every recenter. A standalone correctness fix; it does not require the cost
   programme below.
2. **Make paid gas observable in paper, or stop calling the output economics.**
   Until then every paper P&L is a scenario, per F-1.
3. **Retire V1/V2 convert.** Remove the second worker branch and the V2 gas
   path so one route books a conversion, then split `store.ts` along the seams
   it already has: profiles and drafts, previews and acceptance, claims,
   accounting.
4. **Report cost-to-fee ratio per symbol** alongside net P&L. A ratio above 1.0
   is a failure regardless of the sign of P&L, and it is the one number that
   would have made both prior campaigns legible on day one. Cheap to add.

### Explicitly descoped

The operational cost-reduction programme derived from
`notes/rangekeeper-operational-cost-reduction-2026-09-27.md` — capped persistent
allowances, EIP-7821 batching and the half-width against `trigger_percent`
sweep with measured costs — was reviewed and **descoped by the operator as too
complex** for the current slice. It is recorded here so a later reader does not
mistake its absence for an oversight.

Consequence: the fee-versus-cost question in F-1 stays open, and recommendations
1 and 4 now carry more of that weight than they otherwise would. Recommendation
4 in particular gives visibility into the cost stack for very little work and
should be the last thing trimmed. The analysis remains valid as a standing
reference; only its location (F-8) needs correcting.

## What this review does not establish

It ran the repository check suite, read-only production catalog, process,
endpoint and Funnel inspections, and read the source at `c604cf3`. It did not
run the integration, owned-fork, canonical browser or sealed-release gates, did
not open a campaign or submit any operation, did not migrate, install, register
or restart anything, and did not inspect any credential. The production record
counts, deployed build identities and endpoint behavior above were true at
review time and can change with any service action.

## Implementation follow-up — 2026-09-27

The operator subsequently requested implementation with Luna agents in parallel.
This follow-up records source changes separately from the independent findings
above. The shared checkout started at `9fcdd8d`; unrelated hybrid/adaptive,
manifest-validator and older review edits were preserved.

The bounded implementation covers:

- **F-3:** human-unit setup limits with editable suggestions before preflight.
  Registered profiles currently have no risk-limit fields, so suggestions are
  identified as UI defaults rather than profile policy. Exact decimal-to-integer
  conversion preserves the existing server contract and freshness window.
- **F-4:** transactional operation notifications, a listening worker with a
  two-second polling fallback, operations before due maintenance, and owned transient
  claim release with a persisted 30-second retry delay. Database claims remain authoritative; notifications are hints.
  This reduces idle-worker latency, not the duration of in-flight fork work.
- **Recommendation 1:** the RangeKeeper mint/swap search honors configured
  `minDeploymentPpm` without the additional 99.8% sizing floor. Later simulation
  and canonical rechecks still apply.
- **Recommendation 4 / F-1 visibility:** cost / fees is shown per position/symbol
  using cumulative gas plus swap costs and LP fees in the same quote units.
  Paper is explicitly modeled; missing components, invalid accounting and stale
  RangeKeeper valuation stay unavailable. Positive costs with zero fees are
  flagged, and costs above fees are highlighted independently of inventory P&L.
  This does not make paid gas observable in paper or establish net LP alpha.
- **F-7 catalog:** `/api/strategies` reports installed static/manual paper
  command support; actual readiness remains checked at admission. RangeKeeper
  paper and live remain unavailable in this catalog.
- **F-5 / F-2:** the [operator runbook](../operations/static-paper-mvp.md)
  documents freezing the accounting runtime through campaign closure and
  restoring operator authentication before any future live command capability.
  No cross-runtime accounting adoption was added.
- The unused adaptive path was removed only from an inactive private environment
  candidate documented in that runbook. The active file and runtime identity
  were preserved. The unchanged cost-reduction analysis moved to
  [docs/research](../research/rangekeeper-operational-cost-reduction-2026-09-27.md),
  with a link at its old location.

Validation on the combined shared checkout (including the preserved unrelated
edits), using pinned Node 24.20.0:

| Check | Result |
| --- | --- |
| `npm run check` | Five repository validators, typecheck, **897/897 tests in 85 suites** passed |
| `npm run test:integration` | All seven isolated PostgreSQL suites passed, including commit-only notification, idempotent replay, 30-second retry exclusion, stale-owner rejection, stage preservation and exactly-once accounting |
| `dashboard-setup-command-browser.mjs --complete-static-lifecycle` | **21 browser checks**, four operations, no browser exceptions; human defaults/custom edits, fresh native suggestion, exact stored units, open/pause/resume/retain-close, desktop/mobile |
| `npm run test:integration:paper-worker-process` | Real command/worker processes, one worker restart, released readiness lease, desktop/mobile operation activity; idle pause/resume accepted-to-terminal latency **119 ms / 115 ms** |
| `git diff --check` | Passed |

The browser and process fixtures use synthetic chain boundaries, disposable
local databases and no signer. The latency measurements are for non-economic
pause/resume operations with no chain RPC calls, not bounds on fork replay or
maintenance duration. No sealed artifact or canonical-chain acceptance was run. Both disposable test
databases, fixture schemas, browser processes and temporary fixture directories
were cleaned up. Browser stdout was retained in the tool transcript rather than
a separate log file.

The first combined unit run caught a brittle listener-cleanup query-count
assertion; final validation checks connection destruction and prompt wakeup
semantics. The first new browser persistence assertion used the wrong table;
it now joins the campaign's current revision. These test corrections did not
relax source, accounting, claim or admission gates.

Logs: `/tmp/conc-liq-review-check-20260927.log`,
`/tmp/conc-liq-review-integration-20260927.log`,
`/tmp/conc-liq-review-worker-unit-20260927.log`, and
`/tmp/conc-liq-review-worker-process-20260927.log`.

Default suggestions use capital as the deployment cap, minimum deployment of
`min(1 USD, 10% of capital)`, 95% exposure, 5% loss, 10% drawdown, and
5%/10%/15% per-action/rolling/campaign cost limits. Exit reserve is 0.001 native
units and slippage 0.5%. These are editable setup suggestions, not measured
profitability or registered profile policy. The native allocation is suggested
only after review as `open bound + max(exit reserve, retain-close bound)`;
custom edits are preserved and the server remains authoritative.

The next acceptance milestone remains a human-operated AAPL/USDG paper campaign
through retain-close, comparing recorded output with the harness expectations.
These source changes do not establish that milestone or a new sealed release.
No production migration, service replacement/restart, profile registration,
campaign opening, signing or broadcast was performed in this implementation
follow-up. Legacy accounting removal/store decomposition and schema capability
compatibility are deferred; the operator-descoped cost programme stays deferred.

The subsequent instruction to commit and proceed produced source commit
`7c7f60b`. Its [sealed candidate record](sealed-paper-review-7c7f60b-2026-09-27.md)
contains the later clean-check and canonical-gate results, artifact identity,
backup and staged replacement. Those later results supplement the source-only
validation above; preparation does not mean production replacement occurred.
