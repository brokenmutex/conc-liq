# Research and Positions — Sol implementation plan

Prepared: 2026-09-21. Status: accepted product scope; ready for implementation.
Source reviewed: `b38c839`. Recheck HEAD and working-tree changes before starting.

This is the authoritative implementation handoff for the accepted
[workflow proposal](research-and-position-workflow-2026-09-21.md). The user's
latest decision narrows the product to **static/manual and RangeKeeper**.

## 1. Outcome and authority

Deliver a dashboard where the operator can compare known pools, choose capital,
range and strategy, open a paper or live deployment, manage it, and close it.
Routine deployment operations must not require source edits, release builds,
manual configuration-file editing or a new handcrafted systemd unit.

The user has accepted this implementation direction. Complete the software,
tests, migration tooling, release preparation and operator documentation when
instructed to implement this plan. This document does not itself authorize new
funding, signing, broadcasts, production migrations, stopping active campaigns,
or changing an existing live strategy. Carry forward any separately established
authorization for the exact operational scope; do not ask for it again.

Prepare a concrete cutover record before requesting any missing production
authorization. Paper tests, local database migrations and owned-fork rehearsals
can proceed as part of implementation. Do not halt implementation merely because
funded activation remains a separate final step.

Optimize for net profit on allocated capital within configured risk/cost limits.
Report absolute P&L and matched passive-inventory performance separately. Neither
positive historical alpha nor a forecast is a universal admission requirement;
RangeKeeper retains its own affordability and risk rules.

## 2. Scope decisions — do not reopen during routine implementation

| Included | Excluded |
| --- | --- |
| Exactly two strategy families: static/manual and RangeKeeper | Adaptive width, hybrid/residual strategies, forecast ranking, old evaluation engines |
| Both strategies in paper and live | Compatibility features or new deployments for legacy paper/live strategies |
| Robinhood Chain, verified Uniswap V3 pools and supported references | New chains, V2/V4, arbitrary tokens or new reference providers |
| Research windows 15m, 1h, 6h, 24h, 7d | Automatic capital rotation or a strategy marketplace |
| Open, pause/resume, range change, strategy change, two exit modes | Top-ups, partial withdrawals and fee-only harvesting in v1 |
| Multiple paper campaigns; simultaneous live campaigns on distinct wallets | Multiple live campaigns sharing one wallet |
| Repeated live campaigns on a wallet after reconciled closure | Overwriting campaign history or reusing a previous campaign's budget silently |
| Portfolio exposure, operation progress and in-app alerts | Email/Slack notifications or a multi-user permission system |

Use the existing TypeScript/PostgreSQL modular monolith and dashboard assets.
Introduce boundaries needed by this workflow; do not launch a framework rewrite.
Make chain, token units and venue profiles explicit without implementing a second
chain. Retain exact bigint V3 calculations and independent-reference economics.

### Retirement of legacy/adaptive functionality

- The new catalog, pages, command API, workers and candidate evaluation expose
  only the two supported families. Unknown/retired strategy IDs reject commands.
- Remove legacy/adaptive readers from the new Positions dependency graph; the
  new app must start and work without adaptive JSON snapshots or old evaluation
  outputs. Do not port old sessions or evaluation reports into its ledger.
- Preserve historical databases, receipts, signed intents, manifests, saved
  state and referenced releases as archival evidence. No bulk deletion is needed.
- Before production cutover, inventory active old services and custody. Retire
  paper workers at an authorized cutover. Any old live custody remains managed
  and visible through its retained operational tooling until reconciled closure
  or an explicitly tested adoption. Never hide a live exposure during cutover.
- Current RangeKeeper is a supported predecessor: preserve its receipts and
  campaign identity if adopting it. Provide explicit preflight/import tooling,
  not a silent rewrite. A first release may leave an active predecessor on its
  pinned worker and show a read-only RangeKeeper projection until cutover.
- Extract reusable arithmetic/accounting from old modules when required. For
  example, RangeKeeper's `planner.ts` currently imports `replayPaperMint` from
  `research/management-audit.ts`; move this primitive behind a neutral math
  boundary with golden fixtures. Reusing arithmetic does not require supporting
  the old evaluation engine.
- Preserve unrelated dirty adaptive/hybrid work. Deleting its source or changing
  its manifests is not a prerequisite for delivering this product.

## 3. Strategy contract and exact behavior

Register `static_manual_v1` and the existing `rangekeeper_v1` family, each with
an explicit implementation version, parameter schema and capability declaration.
Keep policy version, state schema, build ID and configuration revision distinct.
Behavior changes require a new version; never relabel the existing frozen one.

### Static/manual

- User chooses price bounds, or a centered width converted to explicit bounds.
  Preview exact tick-grid rounding, full width and resulting token requirements.
- On entry, use existing inventory first; an optional bounded funding swap must
  be included in the authorized preview. Permit deliberate one-sided ranges
  when supported by exact sizing and risk limits; explain their initial exposure
  and absence of active fee earning. Never silently move requested bounds.
- Hold the selected range. Being outside does not trigger recentering or a swap.
- A manual range change is a separate operation. The old position continues
  until that operation is accepted; fees and costs remain in the same campaign.
- Mandatory safety controls still apply: source/custody checks, explicit loss,
  exposure and spending limits, gas reserve and any configured expiry. Manual
  operation does not bypass transaction admission or loss controls.

### RangeKeeper

- Preserve current reviewed rules: fixed configured full width, hold while
  inside, five minutes of continuously observed outside time, ordinary decision
  interval 30 seconds, two distinct eligible observations within the existing
  confirmation window, and current gap/reorg handling.
- Retain current nearest-usable-tick centering, exact no-swap sizing first,
  bounded minimum feasible direct swap, mint cap and floor, stage ordering,
  cost/exposure limits and no repeat of a completed swap.
- No adaptive width, fee/volatility forecast, or predicted-profit gate.
- User-requested width/strategy changes go through the lifecycle operation
  below; do not patch a hashed running config or secretly alter v1 policy.
- Freeze regression fixtures from current source/runbooks, including approved
  changes after the original RangeKeeper plan. Record any necessary policy or
  state-version increment before implementation; no profitability retuning.

The same strategy decision code receives a canonical observation frame in paper,
live and new historical candidate evaluation. Execution adapters differ. Paper
must never construct or load a live signer and cannot enable broadcasts via a
request parameter. Capability flags describe intermediate release readiness;
the final deliverable supports both modes for both families.

## 4. Domain, storage and execution ownership

Create typed application contracts; suggested module homes are `src/deployments/`,
`src/strategy/static-manual/`, `src/execution/`, and bounded dashboard projections.
Names may follow existing conventions; keep these responsibilities distinct:

| Record | Required responsibility |
| --- | --- |
| Market profile | Chain/pool/contract/token identity, decimals/order, quote/reporting units, references, supported capabilities and verification evidence |
| Strategy specification | Family/version, parameters, explicit limits and schema version |
| Campaign | Stable UUID, mode, wallet/profile, capital ownership, current revision, lifecycle and pinned runtime identity |
| Configuration revision | Immutable full configuration/hash, parent revision, activation operation/source and time |
| Preview | Exact requested action, bounded economic effects, evidence/time expiry, expected revision and content digest |
| Operation | Actor, idempotency key, request digest, accepted preview, state, stage, reason, attempts and linked execution intents |
| Ledger/marks | Token inventory and ownership, capital flows, fees, actual costs, independent valuation, passive baseline and provenance |

An operation can contain several on-chain transactions. Reuse the proven live
intent/receipt journal through an adapter; avoid two independent authoritative
records for one signed transaction. Database transaction boundaries must connect
campaign revision, operation transition and execution-intent identity.

Add append-only checked migrations through `src/storage/migrations.ts` and its
checksum/compatibility machinery. Do not edit an applied migration or execute DDL
in new worker/request startup. Dry-run migration/adoption on an isolated copy.

Allow historical campaigns per wallet, with one durable active reservation per
`(chainId, wallet)`. Wallet exclusivity must include predecessor controllers.
The existing locks use `conc-liq-live:4663:<wallet>`; do not change the namespace
while an old worker can run without a compatibility lock/cutover. A lease expiry
does not release capital while custody or a signed transaction is unresolved.

Use one pending transaction per wallet, version checks for competing commands,
and restart-safe operation claims. Reconcile persisted signed hashes before any
new economic action. An ambiguous RPC response never authorizes a new nonce.
Completed stages stay completed after crash, timeout, reorg investigation or a
later-stage failure. Reorgs invalidate affected data/decisions and block unsafe
continuation; do not pretend to roll back an external transaction in SQL.

Keep lifecycle, range and operation state separate. Suggested lifecycle states:
`draft`, `opening`, `active`, `paused`, `changing`, `closing`, `closed`, `blocked`.
Range state is `inside`, `outside`, `no_liquidity` or `unknown`. Operations expose
queued/preflighting/executing/confirming/reconciling/succeeded/rejected/blocked/
cancelled. An outside position without an accepted move is not “recentering.”

### Management semantics

- **Pause:** prevent new discretionary entry/recenter actions. Continue custody,
  pending-transaction reconciliation, valuation and safety exits. An already
  signed operation must reach a safe reconciled checkpoint; explain that pause
  is pending until then. Resume revalidates inputs and clears stale proposals.
- **Close, retain tokens:** stop re-entry, withdraw/collect, clean up allowances,
  reconcile NFT and balances, and release the allocation to available wallet
  inventory. Report final token quantities; retained exposure remains visible
  in the portfolio. Closing does not require selling these tokens.
- **Close, convert to quote:** additionally perform the bounded authorized sale;
  complete only after target balances, dust policy, allowances and receipts
  reconcile. A failed conversion stays visible and recoverable.
- **Change range:** preview complete withdrawal, optional swap, remint and costs;
  retain campaign ID, baseline, spent costs and limits. Activate the new revision
  only at a reconciled commit point. A failed replacement preserves recovered
  tokens and shows blocked/no-liquidity; recovery never repeats a completed swap.
- **Change strategy:** support switching between the two families. Preserve the
  campaign and baseline, record an attribution boundary, and reset strategy
  timers. Reuse an existing range only if valid under the target specification;
  otherwise show the required replacement operation and cost before acceptance.
- **Close precedence:** a close request prevents new discretionary work, cancels
  only safely unsent work, reconciles signed work, then exits from actual custody.
  No “cancel” endpoint may erase a signed intent or simulate reversing a fill.
- No background auto-reentry after a closed campaign. A new deployment gets a new
  ID, allocation and authorization. Clones link to their origin, not its ledger.

Native spending and all fee/slippage components are charged once. Capital
transfers are not profit. Keep unspent exit reserves separate from paid costs.
Unsupported or missing valuation/cost evidence stays unavailable. Define one
documented passive baseline convention for new campaigns; preserve provenance
and existing conventions when adopting an old RangeKeeper campaign.

### Required paper calibration loop

Amendment, 2026-09-22: provenance labels and shared strategy decisions alone do
not establish realistic paper execution. Implement a maintained calibration
pipeline for static/manual and RangeKeeper. It consumes canonical chain data,
exact-call simulations and reconciled live observations; it does not depend on
the retired adaptive/evaluation engines or require placing calibration trades.

Keep three outputs distinct: expected modeled expense, a conservative admission
bound, and actual paid expense. In particular, the stage allowances in
`src/strategy/rangekeeper/cost.ts` are AAPL fork-derived safety envelopes. They
must not become paper gas usage or generic evidence for every pool.

| Quantity | Paper input and real-world calibration target |
| --- | --- |
| Gas units | Estimate/rehearse exact stage calldata and allowance/storage state, then compare with canonical receipt `gasUsed` for that execution path |
| Gas price and total gas expense | Apply time-appropriate observed gas prices to modeled units; compare with receipt effective price and reconciled native cost, including any chain-specific fee component without double counting |
| LP fee income | Reconstruct fee growth or swap-step allocation for the actual range/liquidity and interval; compare token-by-token with reconciled earned fees, separate from withdrawn principal |
| Swap output and shortfall | Freeze the source quote and minimum output; compare receipt token deltas at inclusion, separating embedded swap fee/impact from quote-to-fill movement |
| Mint/withdraw amounts | Compare exact planned liquidity and token amounts with actual minted/burned liquidity, returned tokens, residual balances and rounding |
| Execution delay and failure expense | Observe decision, submission, inclusion and reconciliation times; model ordered stages, reverted transactions, recovery and stranded inventory instead of instantaneous atomic success |
| Reporting value | Value costs/inventory at the relevant accepted independent references; validate raw-token quantities first so valuation error is not mistaken for execution error |

**Collection and comparison:**

1. Persist a prediction record before each live stage is submitted: campaign,
   operation, strategy/build/config/model versions, pool/route, size, allowance
   state, source block/hash/time, estimates, bounds, quote and reference IDs.
   Attach eventual receipts, actual balances and timestamps to that record.
   Record rejected/reverted/blocked outcomes as well as successes.
2. Produce a matched execution comparison using the same starting inventory,
   range, liquidity and actual holding interval as the live position. Separately
   compare the forecast made before submission to realized execution, including
   delay. Never use the eventual receipt as an input to its earlier prediction.
3. For LP fees, handle self-inclusion correctly. A real position already exists
   in observed active liquidity; a newly added hypothetical position does not.
   Use the appropriate denominator, or remove the observed position before
   adding its matched replica. Do not dilute a real position twice. Track changes
   in protocol cut, liquidity, fee growth and tick crossings at event boundaries.
4. Reconcile earned fees with canonical core Collect, manager events and token
   transfers, net of released principal and opening fee balances. Include
   interim collections and closing uncollected amounts when comparing accrual.
   Unresolved collection/coverage discrepancies reject the calibration sample;
   do not “fix” them with a fee haircut. Independent increments from one campaign
   are not automatically independent observations.
5. For unmatched paper positions, use added-liquidity dilution and documented
   counterfactual limits. Historical flow does not prove that the same volume
   would occur after a materially larger LP or swap. Flag extrapolated sizes and
   liquidity shares, and restrict accuracy claims to observed/validated scope.

**Versioned profiles and validation:**

- Store profiles scoped by chain, pool/fee tier, execution path/version, stage,
  allowance state and relevant size/liquidity-share band. Include sample count,
  distinct campaigns, observation period, cost source, calibration method,
  error/bias statistics, validation results and validity/invalidation rules.
  Reuse across pools only as an explicitly borrowed sensitivity assumption.
- Validate candidate profiles on later observations or held-out campaigns. Freeze
  sample sufficiency, freshness and error tolerances in a versioned validation
  policy before scoring; choose concrete defaults in W0 and justify them from
  the available evidence. Include absolute errors for near-zero fees/costs,
  relative errors where meaningful, and interval coverage/tail errors when the
  sample supports them. Small samples remain provisional; do not invent a p95
  or a confidence claim from a handful of correlated events.
- Parameter corrections may address demonstrated execution bias, not optimize
  strategy P&L. Exact accounting mismatches are defects to resolve first. Keep
  failure-rate/delay sensitivity scenarios explicit when measured data is sparse.
- Pin the selected profile version to every paper fill/mark and research result.
  Updating calibration creates a new version and a prospective adoption boundary;
  it never rewrites previously reported paper profits. Any rescored history is a
  separately labeled result. Historical replay uses only calibration information
  available then, or explicitly declares retrospective calibration.
- Bootstrap a new pool/path with fresh exact-call estimates and owned-fork
  lifecycle probes, labeled `fork_estimated`, plus stress scenarios. If even
  these inputs are unavailable, keep economic results incomplete. Do not borrow
  an unrelated pool's expense and label the result calibrated. Paper can run as
  an explicitly provisional scenario while live observations accumulate.
- Expose component-level status: `validated`, `provisional`, `stale`, `rejected`
  or `unavailable`, and retain evidence class separately. A valid gas model does
  not imply validated fee capture, swap execution or profitability.

**Refresh and drift:** ingest comparisons after canonical receipts and completed
fee intervals; evaluate drift daily and after contract/route/stage/build changes.
Trigger invalidation on relevant execution or allowance-policy changes, stale
evidence, out-of-scope size/share, or failed validation tolerances. Keep short-term
gas-price refresh separate from gas-unit model updates. Bound collectors under
the research/provider budget so calibration cannot starve live operations.

The dashboard must show the active profile, last validation, sample scope and
modeled-versus-real errors, with a short reason for provisional/stale status.
Surface base/stress paper economics and all uncalibrated components. Invalid
calibration blocks a “validated paper” claim; it does not silently alter live
policy, force a live trade or replace the live controller's fresh safety checks.

Reuse receipt parsers and neutral fee math. The existing
`scripts/research/live-fee-calibration.mjs` is a useful historical method/reference
and regression source, but its old release/campaign dependencies must not become
dependencies of the new calibration service. Existing historical samples may
be imported with provenance and explicit applicability checks, without restoring
legacy strategy support.

## 5. Research implementation

Use `indexer_pools`/verified profiles for identity, left-joining latest state;
do not use “has a checkpoint within six hours” as the pool-list membership rule.
Show stale/inactive/unverified pools and explain why deployment is unavailable.

Build incremental canonical aggregates with bounded queries. Retain block/hash
provenance and invalidate/rebuild affected buckets on rewind. Exact trailing
windows share a documented `asOf` watermark: 900/3600/21600/86400/604800 seconds.
Use fine aggregates plus raw boundary fragments where needed. Do not equate a
partial current clock bucket to a full 15m trailing interval. Display watermark,
covered duration, gaps and freshness independently; incomplete intervals must
not turn into zero volume or inflate annualized metrics.

Core comparison: token/quote volume, swaps, LP fees net of protocol cut, active
liquidity, current depth, price change/variation, pool/reference deviation and
data availability. Account for protocol-fee changes over time; distinguish exact
fee reconstruction from approximations. Add session/weekend breakdowns using the
asset calendar. Keep APR secondary and explicitly retrospective.

Candidate inputs: pool, strategy, capital/starting inventory, range/width, time
window and limits. Recompute exact liquidity and diluted share at each amount.
Show token requirements, deployed/idle amounts, gas/exit reserve and estimated
complete costs. Costs carry pool, action, size, source, age and evidence class;
global mint/exit medians are not executable cost quotes.

Provide bounded historical candidate evaluation for **only these two strategies**:
reuse event-level math/replay primitives, not old strategy evaluation pipelines.
Return net P&L, matched-hold comparison, fees, gas/swap costs, inventory, time
outside, recenter count and rejected decisions. Enforce causal inputs, realistic
execution timing and dilution. A currently selected range evaluated in past data
is a retrospective scenario; it is not an out-of-sample strategy result. Missing
historical references/costs produce incomplete results or explicitly labeled
sensitivity cases, never invented evidence. No positive result is a launch gate.

Separate reusable pool statistics from cached candidate jobs. Persist job status
and input/source hashes; bound query duration and concurrency so sweeps cannot
starve ingestion, position updates or live quotes. Retain the current simple fee
model only as a labeled screening approximation, never “net profit.”

Create a saved draft from a candidate with its evidence snapshot. Research data
cannot authorize execution; opening always obtains fresh preflight evidence.

## 6. Command API, security and UI

Suggested routes (equivalent naming is acceptable):

- `GET /api/strategies`, `/api/pools`, `/api/research?windowSeconds=...`.
- `POST /api/research/candidates` and `GET /api/research/candidates/:id`.
- `POST /api/deployments/drafts`.
- `POST /api/deployments/:id/previews` for open/pause/resume/change/close.
- `POST /api/deployments/:id/operations` with preview ID/digest, expected
  revision and idempotency key; return `202` and durable operation identity.
- `GET /api/operations/:id`, plus campaign list/detail/history projections.

Same key plus same request returns the existing operation; same key plus a
different request is a conflict. Stale/revised previews reject before signing.
Reject unknown fields, unsupported capabilities and client-supplied shell paths,
signer material, arbitrary spender addresses or arbitrary calldata.

Keep current loopback access as the default. Add single-operator authentication
with server-side sessions, HttpOnly/SameSite cookies, explicit origin/CSRF checks,
bounded request bodies, rate limits and sanitized audit records. Configure the
bootstrap credential outside Git and browser bundles. Require TLS/Secure cookies
if later exposed remotely; do not add remote exposure as part of this scope.
Read APIs use read-only connections; commands get narrowly scoped database
access. The dashboard has no signing key access and never shells out to a CLI.

Use one deliberate confirmation for the concrete live operation, showing wallet,
pool, capital, strategy, range, permitted swap, costs and limits. Accepted limits
authorize worker-managed strategy actions within the campaign; do not require a
click for each automatic recenter. Workers still refresh execution admission.
Changing limits/range/strategy requires a new explicit operation authorization.

Positions UI uses the same list, detail charts and history for both modes:
allocated/available capital, reserves, exposure, NAV, absolute net P&L, passive
comparison, fees, paid costs, estimated exit costs, full range width and actual
bounds. An opening or failed-entry campaign appears from its first action even
without an NFT. Use typed token amounts/metadata, not fields named `nvda/usdg` or
hardcoded 6/18-decimal price conversions.

Show operation stage, elapsed time, transaction hash, last source/heartbeat,
rejection reason and allowed next action. Provide persistent in-app alerts for
stale data, outside range, cost limits, low gas and blocked recovery. External
messaging is excluded. Technical diagnostics belong in expandable details.

## 7. Ordered work packages and completion gates

Each package should end in scoped commits and an updated progress record here.
Use targeted tests during development and the required full gates before release.

| Package | Work | Required evidence before marking complete |
| --- | --- | --- |
| W0 — baseline | Inventory source/runtime boundaries, active campaigns and dirty prerequisites; freeze current RangeKeeper fixtures; finalize typed contracts, calibration validation policy and migration design | Written dependency/cutover inventory; calibration sample/freshness/error criteria frozen; no live-state mutation; supported strategy IDs fixed |
| W1 — persistence and commands | Checked schema migrations, campaign revisions, previews, operations, reservations, idempotency, auth and worker claims | Isolated-DB migration/restart/concurrency tests; unauthorized/stale/duplicate requests tested; schema startup is read-only |
| W2 — two-strategy paper flow | Static decision kernel, RangeKeeper adapter, neutral math extraction, paper ledger, versioned provisional/calibrated execution inputs; create/open/pause/resume/close UI | Both strategies complete paper lifecycles without config edits/restarts; profile IDs and evidence per modeled fill; no signer/broadcast path; legacy state absent |
| W3 — research | Persistent pool universe, five windows, canonical aggregates, variable capital/range, scoped costs, bounded two-strategy replay, calibration reports, saved draft | Boundary/reorg/gap and fee self-inclusion tests; independent valuation and correct capital dilution; held-out calibration checks; job concurrency does not block Positions |
| W4 — live open/close | Adapter to proven transaction stages, static and RangeKeeper live workers, wallet reservations, sequential campaigns, pre-submission predictions and receipt comparison collector | Owned-fork open/exit for both strategies and both exit modes; failed mint after swap and restart after signing; paired prediction/actual records; no duplicate economic action |
| W5 — active management | Range/strategy transitions, pause/close precedence, revision attribution, retained-token accounting, safe recovery UI | Both switch directions and width replacement tested, including failure after withdrawal/swap; costs/baseline preserved |
| W6 — product and retirement | Common charts/history, portfolio capital/exposure, calibration status/error reports and drift alerts, bounded history queries; remove legacy/adaptive UI/runtime dependencies | Browser checks for both modes/families, provisional/stale/blocked states; predecessor custody still visible; clean-start without legacy snapshots |
| W7 — release and cutover | Sealed build, persistent worker supervision, migration/adoption tools, runbooks and concrete cutover record | Build verification, integration gates, restore/restart rehearsal, explicit production authorization status and outstanding gates |

Suggested time budget remains 6–10 focused engineering weeks for the complete
workflow. Removing adaptive/legacy support reduces scope, but safe transitions
and execution recovery dominate uncertainty. First paper milestone is W0–W2
with a basic Research draft link, approximately 2–3 weeks. Do not treat that
intermediate milestone as completion of the entire plan.

The explicit calibration amendment adds a provisional 3–5 engineering days if
receipt collection and neutral fee primitives are reusable; revise after W0.
Collecting sufficiently varied live validation observations takes additional
elapsed time and cannot be promised by that engineering estimate. The calibration
pipeline can be complete while individual profiles remain provisional.

### Source map

- Dashboard: `src/dashboard/{server,repository,research,positions,rangekeeper-position,position-performance}.ts`, `dashboard/{app,research}.js` and HTML/CSS.
- Strategy/execution: `src/strategy/rangekeeper/{planner,domain,config,state,live-controller,live-store,live-stage,live-reconcile,live-mark,live-preflight}.ts`.
- Reuse journal/recovery invariants from `src/live-pilot/`; do not expose that old strategy in the new catalog.
- Migrations/runtime: `src/storage/{migrations,migration-checksums,compatibility}.ts`, `src/runtime/identity.ts`.
- Release: `scripts/{build-release,run-release,render-release-units}.mjs`, `ops/`, `docs/operations/rangekeeper-v1.md`.
- Tests: current dashboard and RangeKeeper suites; integration examples in `test/integration/{migrations,rangekeeper-fork,live-pilot-journal}.mjs`.

## 8. Acceptance matrix and release requirements

1. Exactly two strategy families selectable; both modes operational. Rejected
   old strategy IDs cannot be smuggled through the command API.
2. Research lists known pools even without recent checkpoints. All five windows
   use correct time boundaries. Missing coverage/reference data is visible.
3. Capital/range changes recalculate mint amounts, diluted share and costs;
   neither rankings nor deployment previews linearly scale fixed-budget results.
4. Paper and live fixtures use identical strategy decisions for identical frames;
   fills, delays and costs carry their actual measured/modeled evidence class.
5. Correct prices, units and inventory for quote-as-token0 and quote-as-token1,
   unequal decimals, asymmetric/manual ranges and aligned tick bounds.
6. Double submission, stale revision, two workers, worker death and browser
   disconnect cannot create duplicate entries or allocate a wallet twice.
7. Crash before/after signing, lost RPC acknowledgement, receipt timeout, revert
   and reorg remain recoverable without replaying completed swaps or losing NFT
   custody. Pending signed operations cannot be discarded by pause/close.
8. Width/strategy changes keep campaign performance continuous and never reset
   cost limits, initial inventory or a drawdown baseline to hide losses.
9. Close-retain and close-convert have distinct reconciled postconditions; a
   stopped process is never sufficient evidence of closure. A second campaign
   can start after releasing custody/reservations without deleting the first.
10. UI list/charts/costs/history cover both strategies and both modes from first
    action; outside/waiting differs from a pending recenter. Missing economics
    remain null rather than zero or silently substituted pool prices.
11. All runtime data is bounded or paginated. Research failure/load cannot take
    down operational views or consume reserved live/ingestion provider capacity.
12. Ordinary operations use persisted configuration on a sealed release. No
    production worker starts from the dirty checkout or reads secrets from HTTP.
13. Calibration compares frozen predictions with canonical actuals by component;
    gas limits/reserves are never booked as paid expense. Include reverts, staged
    latency, approvals/cleanup and correct LP self-inclusion. All comparisons
    have reproducible source and model identities.
14. Held-out validation, insufficient samples, drift, profile expiry and execution
    path changes produce the declared status. New profiles cannot retroactively
    improve old paper P&L or use future receipts in earlier decisions. Legacy
    evaluation services are unnecessary to collect or validate the new profiles.

Run `npm run check` with the repository's pinned Node, relevant PostgreSQL
integration tests, owned-fork lifecycle/recovery tests and desktop/mobile browser
checks. Add meaningful tests for the new boundaries above; do not merely mirror
implementation. Any pre-existing failure must be isolated and reported, not
silently waived. Preserve archival manifest invariants when retiring dependencies.

The release builder requires a clean checkout. Commit only scoped work; create a
clean worktree at the reviewed commit for release preparation if unrelated dirty
work remains. Never reset or indiscriminately stage those prerequisites.

The cutover record must name schema/build/config versions, migration/adoption
steps, old-worker ownership, rollback compatibility, exact enabled capabilities,
wallet/campaign authorization, custody checks and recovery commands. No active
campaign is automatically upgraded. Rollback cannot erase post-upgrade signed
actions; reconcile them before changing execution ownership.

Final handoff: scoped commit IDs, reproducible checks and results, screenshots,
release identity, migration/cutover commands, runbook, remaining production gates
and an explicit distinction between implemented, deployed and live-validated.

## 9. Progress record

- Planning: accepted scope captured; initial source review complete.
- W0: baseline inventory, dependency/cutover record and calibration validation
  policy recorded in `research-and-positions-w0-2026-09-22.md`. The active
  predecessor campaign was confirmed read-only in the ledger; its execution
  owner remains the sealed RangeKeeper worker.
- W1: in progress. Checked migration 4 adds the new records, and the isolated
  command store supports drafts, trusted previews, idempotent acceptance,
  predecessor wallet exclusion and restart-safe operation claims. A separate
  loopback command service has operator sessions, origin/CSRF checks, bounded
  JSON, strict draft schemas and initial routes. Verified market-profile
  registration now requires canonical contract and independent-reference proof
  plus an enabled indexer target; the authenticated catalog reports draft
  availability. Both mode capabilities report unavailable; HTTP operation
  acceptance returns 503 until fresh cost preflight and an execution adapter
  exist. Claims are mode-scoped and cannot mark an action successful without a
  reconciled completion path. Full lifecycle transitions and the worker
  adapter remain. See `research-and-positions-profile-registration-2026-09-22.md`.
- W2: in progress. Static/manual range rounding, exact no-swap sizing, hold
  semantics and safety precedence are implemented. A paper draft can now get a
  read-only indicative open candidate from a confirmed pool state and eligible
  independent references. The candidate has no complete costs, net economics
  or operation identity and cannot be accepted. A bounded selector now reads
  six fresh pool/path/size/share-specific exact-call gas profiles for a
  provisional static/manual open and retain-close expense and bound. It cannot
  fall back to older versions or unrelated AAPL allowances. There are no new
  populated or validated profiles yet; absent evidence leaves costs unavailable.
  RangeKeeper mint math is neutral to the retired research module. Paper
  execution, calibration collection/validation and UI flows remain.
- W3–W7: not started. No production migration, service cutover, funding,
  signing or new campaign was performed by this implementation work.
- Verification on the development checkout: `npm run check` passed 671 tests;
  `npm run test:integration` passed in isolated PostgreSQL schemas using the
  explicit local test database. These validate the current foundation only.
- Prior review baseline: 35 focused dashboard tests passed at `b38c839`; these
  establish existing behavior only and do not satisfy the new acceptance matrix.
