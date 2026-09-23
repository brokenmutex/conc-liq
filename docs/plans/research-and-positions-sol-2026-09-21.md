# Research and Positions — Sol implementation plan

Prepared: 2026-09-21. Status: implementation in progress; W1/W2 incomplete.
Initial source review: `b38c839`. Progress review: 2026-09-22 at `af4724d`.
Recheck HEAD and working-tree changes before starting. Sol should resume with
[the review follow-up and next actions](#10-review-follow-up-and-sol-next-actions).

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
  independent references. The HTTP candidate has no net economics or operation
  identity and cannot be accepted. A bounded selector now reads
  six fresh pool/path/size/share/range-specific exact-call gas profiles for a
  provisional static/manual open and retain-close expense and bound. It cannot
  fall back to older versions or unrelated AAPL allowances. No profile is
  validated; absent scoped evidence leaves costs unavailable.
  RangeKeeper mint math is neutral to the retired research module. Paper
  execution, calibration validation and UI flows remain. An owned-fork
  static/manual no-swap collector now records exact-call Nitro estimates for
  six stages without a signer or upstream write. The first AAPL/USDG synthetic
  probe is retained in `research/calibration/` and described in
  `docs/research/paper-static-gas-calibration-2026-09-22.md`; it is one
  provisional point, not a paper fill or validation. A separate importer
  canonically replays a candidate and atomically versions all six provisional
  gas profiles in an isolated database; no persistent profile was registered.
  An internal paper-open model now freezes the confirmed source,
  independent reference proof, exact mint candidate and scoped provisional
  gas estimate. A claimed operation can recheck that model and atomically write
  initial capital entries plus one inventory mark; retries return the same
  mark. The mark leaves paid costs and net economics unavailable. This path is
  exercised only in an isolated schema: HTTP acceptance and continuous paper
  operation remain disabled until close/recovery, valuation and dashboard
  parity are implemented and tested.
  An isolated retain-close can now replay the later confirmed pool state,
  independent reference and current provisional gas profile. It records a
  modeled principal lower bound, closes the campaign and appends capital-out
  entries with null amounts because earned fees and paid gas are unobserved.
  Retrying the close reuses its mark. This is an accounting-incomplete paper
  lifecycle rehearsal; fee-capture marks, a conversion close and dashboard
  parity still gate operator use.
  A later confirmed-source paper mark now records exact modeled principal and
  idle tokens at eligible independent references, plus a fixed-token passive
  value. Native balance, fee capture, paid gas, net NAV and alpha stay null.
  The canonical frame reader rechecks the previous chain anchor, and the
  store requires increasing source blocks. Identical retries reuse the prior
  mark, while conflicting same-block evidence fails.
  Retain-close follows the latest valuation mark and rejects a stale close
  preview. A read-only state adapter now loads the persisted open and latest
  anchor for a canonical sampler; the commit rechecks the anchor under a row
  lock. These paths remain internal and exercised only in isolated schemas.
  The read-only Positions adapter now exposes new paper and live deployment
  campaigns from the first recorded action through closure, using the same
  chart periods, range view, session table and activity controls. It reads
  recorded pool and independent-reference prices, token inventory and
  principal-only marks. Missing fee capture, paid gas, native balance, net NAV
  and alpha remain unavailable. No source gap is filled. The current browser
  view and HTTP routes are checked against an isolated ledger and a disposable
  desktop/mobile fixture. A sealed release, real runtime history and the full
  deployment parity acceptance matrix remain separate gates.
  A bounded, asset-neutral fee replay reader now reconstructs indexed pool
  events using the profile's actual fee tier and tick spacing, verifies the
  endpoint pool state and fee-growth counters, and models hypothetical LP fee
  dilution. It reports fixed-path integer allocation bounds for partial virtual segments
  and fails on coverage, target-set or source-hash mismatches. The canonical
  reader verifies the pool profile at both endpoints, pins fee-growth and pool
  state reads to each source block, matches the saved paper snapshots, and
  rechecks both hashes after indexed replay. A read-only Q128 carry requires
  verified adjacent intervals with the same pool, range, liquidity, stream and
  target set; it preserves fractional credits and rejects gaps and repeats.
  An append-only v5 table now stores that verified interval proof and continuous
  carry against adjacent paper marks. The isolated v4-to-v5 migration and
  idempotent write were tested; no production schema was migrated. The record
  is separate from earned-fee ledger entries and leaves mark fee income and NAV
  null. An internal one-interval sampler now loads the next adjacent mark pair,
  uses the canonical chain/indexer reader and appends the proof. The accepted
  retain-close model permits a final interval through its block-level snapshot:
  the hypothetical position is present for observed events through that block,
  then the modeled exit occurs after the snapshot. Its closing carry is still
  hypothetical; final retained balances and fees remain unavailable. The sampler
  returns no work when caught up, and no service schedules it yet. Calibrated
  fee capture and the earned paper fee ledger/marks remain unfinished. The
  modeled credit is not booked as earned fees or net P&L.
- R1 status follow-up, `5319e92`: deployment positions now distinguish active
  outside range, actual management pause, blocked recovery and unknown range
  state. The dashboard shows the persisted blocked-operation reason and retains
  stale-source context; normal static/manual outside hold no longer counts as
  needing attention. The repository check passed 678 tests during this change.
  After the final query refinement, focused dashboard tests, typechecking and
  the isolated-PostgreSQL deployment integration test passed. Disposable
  Chromium fixtures showed badges, reason and attention count at 1280px and
  390px without horizontal overflow. No sealed release or production deployment
  was checked.
- R2 first slice, development checkout: a v6 append-only journal now projects
  the static/manual no-swap paper open, adjacent valuations and retain-close
  into one versioned **provisional fixed-flow scenario**. It uses the lower
  integer fee allocation from each verified carry, scoped fork gas estimates
  and independent references. Each snapshot pins its source mark, model and
  profile IDs, fee evidence, token and native balances, modeled flows, NAV,
  fixed-inventory passive value and alpha. The original marks and paid-cost
  ledger stay unchanged. The Positions API and dashboard display modeled
  values with provisional labels; an absent or invalid journal leaves economics
  unavailable. Isolated-DB lifecycle and migration tests, dashboard label
  tests, and the repository check passed. No production schema was migrated.
  This is a scenario under observed fixed flow, not earned fee evidence or a
  paid-cost record. Execution delay and failures remain unmodeled. No worker
  schedules the journal projection yet, and close-convert and RangeKeeper
  accounting are still unsupported.
- R2 journal integrity follow-up: projection now replays each saved interval
  from the prior carry and registered indexer stream/target set before it can
  add a snapshot. An isolated test injects self-consistently rehashed but
  semantically invalid fee rows; each fails without a journal write. Pending
  valuation projection resumes after recreating the store, and two concurrent
  close projections produce one snapshot. The operation still has no scheduled
  worker or read-time canonical recheck; those remain gates before operator use.
- R2 canonical append follow-up: the accounting append now requires a chain
  verifier. The read-only wrapper checks chain ID and the saved open, prior and
  current mark block hashes and timestamps inside the append transaction, then
  rechecks those anchors before commit. An isolated PostgreSQL test rejects a
  changed current hash and a reorg during verification without inserting a
  snapshot; restart and concurrent close projection still pass. This covers
  canonicality when a snapshot is written. A durable worker and read-time
  revocation of already written scenarios are still outstanding.
- R2 projection pass follow-up: a bounded one-campaign helper now advances at
  most 100 unprojected journal marks using the canonical append path. It
  reports whether it caught up, propagates missing fee evidence and invalid
  anchors, and resumes from persisted rows after store recreation. The
  isolated deployment test covers its budget, missing-interval stop, restart
  and concurrent close projection. It does not sample missing intervals,
  schedule itself, audit older anchors after projection, or enable HTTP paper
  acceptance; those remain worker and monitor gates.
- R2 fee-to-journal step follow-up: a one-mark internal step now tries the
  canonical accounting append, samples exactly the next adjacent fee interval
  only when that append reports missing fee evidence, and retries the append
  once. Other integrity and canonicality errors propagate without sampling.
  Its production adapter uses the existing canonical chain/indexer fee reader;
  it has no signer or scheduler. The isolated test injects a verified fee proof
  to exercise persisted sequencing: a missing sample leaves no snapshot,
  concurrent restarted calls create one interval and one snapshot, and a
  corrupt prior proof cannot start a sampler. This test does not itself replay
  RPC for the production adapter. The dashboard now checks four adjacent marks
  and a three-interval carry in this fixture. Supervision, current-history
  revocation and both unsupported close/strategy paths remain open.
- R2 current-history revocation follow-up: append-only v7 invalidations now
  fail closed when a stable two-pass canonical audit finds that a projected
  source hash or timestamp changed. The first changed snapshot and every
  dependent later snapshot retain their original journal bytes but no longer
  supply dashboard NAV, fees, gas or passive comparison. Further projection
  rejects after a revocation. RPC failures and a chain change during the audit
  leave history untouched. The isolated v3/v4/v6-to-v7 migrations, stable audit,
  transient-reorg rejection, descendant revocation, restart idempotency and
  dashboard fail-close passed. No audit worker schedules this check yet, no
  production schema was migrated, and close-convert plus RangeKeeper paper
  accounting remain open.
- 2026-09-23 parallel foundation slice: a separate `paper_fixed_flow_convert_v1`
  scenario model and canonical projection path now specify a fee-aware terminal
  input, block-pinned Quoter output, scoped conversion gas, slippage floor and
  modeled capital-out balances. The original v1 journal policy remains the
  dashboard selection. No trusted close-convert mark producer or operator
  acceptance path exists, and the v2 scenario has not passed lifecycle or
  dashboard parity gates. A read-only RangeKeeper paper-open adapter now
  requires the full frozen kernel policy and reports missing scoped paper cost
  evidence as unavailable; it records no fill. These are internal foundations,
  not completion of R2 or W2.
- W3: planned Research work remains outstanding. The existing page still has
  no deployable candidate flow or saved-candidate UI. The page now lists pools
  from the indexer registry and shows stale, inactive, unverified and missing
  checkpoint state. It offers a 15-minute slot with exact checkpoint coverage,
  freshness and gap diagnostics, while swaps, volume, fees, price change and
  candidate economics stay unavailable: persisted swap events lack their own
  canonical block timestamps, and chunk-end timestamps cannot establish an
  exact 900-second flow interval. The 1h–7d windows remain bucket-based.
- W4/W5: new deployment live adapters and active-management integration remain
  outstanding. Existing predecessor RangeKeeper execution is reusable evidence,
  not completion of these new workflow packages.
- W6: partial groundwork. The common deployment Positions projection described
  above is implemented; full accounting, portfolio exposure, calibration
  reporting, legacy dependency removal and complete parity acceptance remain.
- W7: outstanding. No production migration, service cutover, funding, signing
  or new campaign was performed by this implementation work.
- Verification on the development checkout: `npm run check` passed 676 tests;
  `npm run test:integration` passed in isolated PostgreSQL schemas using the
  explicit local test database. The HTTP Positions route was also exercised
  against that isolated ledger; a disposable Chromium check covered current
  and closed deployment cards, chart controls, activity and desktop/mobile
  width without browser exceptions. These validate the current foundation only.
- 2026-09-23 parallel slice verification: the shared checkout passed
  `npm run typecheck`, `git diff --check` and the Research UI JavaScript syntax
  check after integration review. No tests, database migrations, owned-fork
  rehearsals, browser acceptance checks or sealed-release checks were run for
  this slice; its new paths remain gated.
- Prior review baseline: 35 focused dashboard tests passed at `b38c839`; these
  establish existing behavior only and do not satisfy the new acceptance matrix.

## 10. Review follow-up and Sol next actions

Review date: 2026-09-22. Source: `af4724d`. This is the next implementation
sequence within the accepted scope, not a replacement for the W0–W7 gates.
The persistence and internal static/manual paper foundations are substantial,
but the first usable paper workflow is incomplete. Prioritize connecting and
finishing that workflow before expanding unrelated Research features.

The initial review reran `npm run check` with the pinned Node: repository checks,
typechecking and all 676 tests passed. Integration and browser results in
section 9 are prior implementation evidence; that review did not rerun them
(`TEST_DATABASE_URL` was unset), inspect the deployed release, or perform a
fresh production/custody audit. Rerun the relevant acceptance checks against
the implementation being handed off; do not present earlier results as fresh.

### R1 — Correct misleading deployment status labels (implemented in `5319e92`; release check pending)

At review source `af4724d`, `deploymentPosition()` mapped an
active outside-range position and a blocked campaign to `status: 'paused'`.
`dashboard/app.js` then labels both “Management paused.” Static/manual holding
outside its range is normal strategy behavior; blocked recovery is a separate
condition. The secondary explanation does not correct the misleading badge.

- Keep lifecycle, range state and operation state distinct in the projection,
  badges, filters and attention counts. Reserve “Management paused” for actual
  paused management; show outside/manual-hold and blocked/recovery explicitly.
- Preserve the existing predecessor position views and keep stale-source
  information visible alongside the underlying state.
- Acceptance: adapter and browser checks cover active-inside, active-outside
  static/manual, genuinely paused, blocked, opening, closing and closed cases.
  Active-outside must not imply a pause or pending recenter; blocked must show
  the recovery reason. Check desktop and mobile rendering.

### R2 — Finish provisional paper accounting end to end

At the review baseline, open/valuation/retain-close models and hypothetical fee
intervals were internal evidence primitives. Fee credits were not yet booked as
modeled income; native spending, net NAV and final retained token balances were
incomplete.
Do not mark a usable paper lifecycle complete merely because an internal close
sets the campaign lifecycle to `closed`.

The first static/manual retain-close journal slice and store-level evidence
replay/restart checks are implemented as described in section 9. Finish the
following acceptance gates before declaring R2 complete: add explicit
conversion-close costs and proceeds, reconcile its capital-out flows, support
the same accounting contract for RangeKeeper paper, and verify canonical
rechecks and journal projection under worker restart, stale evidence and all
supported exit boundaries. Then run the complete desktop/mobile dashboard
parity matrix against the persisted journal. Keep HTTP paper acceptance gated
until R3 connects and verifies the durable worker.

- Define and implement a versioned, explicitly provisional accounting policy
  for converting eligible fee-interval evidence into modeled paper accrual.
  Preserve the original interval proof, dilution and rounding bounds, continuous
  carry, source anchors and counterfactual limitations. Document how any point
  estimate or scenario is selected; missing coverage stays unavailable.
- Book modeled fees and modeled execution expenses exactly once, reconcile
  native balance and final retained inventory, and derive reference-valued NAV,
  absolute P&L and matched fixed-inventory passive performance. Include opening,
  closing, approvals/cleanup and supported conversion costs. Keep reserves and
  admission bounds separate from expenses, and keep paper estimates distinct
  from canonical paid live expenses.
- Pin model/profile versions and evidence to fills and marks. Preserve earlier
  incomplete marks; any retrospective recalculation is a separately labeled
  result. Unmodeled delay/failure components and stress assumptions stay explicit.
- Acceptance: isolated-DB lifecycle tests reconcile token and native balances,
  capital flows, modeled fees/costs and both exit modes; duplicate/restarted
  writes cannot double book. Test gaps, stale profiles, interval repeats and
  close-boundary carry. Dashboard values must match the persisted ledger.

Calibration sample sufficiency is a gate on a **validated** claim, not a
requirement to finish or run an explicitly provisional paper scenario. Preserve
the frozen validation thresholds and build the comparison pipeline without
waiting for 30 observations or creating live trades to obtain samples. Where
even provisional inputs are absent, leave the relevant economics incomplete.

### R3 — Connect durable execution and the operator paper flow

- Wire fresh previews, command acceptance, the paper execution adapter and
  bounded valuation/fee samplers into a supervised worker. Complete lifecycle
  transitions, claim recovery and blocked-operation handling. A browser
  disconnect must not stop an accepted operation or its reconciliation.
- Keep the current HTTP operation gate and capability flags truthful until
  each exposed path has fresh admission, execution, reconciliation and dashboard
  evidence. Enable supported paths deliberately; unavailable paths must reject.
- Deliver the basic Research candidate/draft link and Positions controls for
  open, monitoring, pause/resume and close without config edits or restarts.
  Preserve safety monitoring during pause and close precedence over new work.
- Complete the RangeKeeper paper adapter using the shared frozen strategy
  kernel. Static/manual success alone does not complete W2. Support both close
  modes and preserve each strategy's semantics and modeled execution evidence.
- Acceptance: both strategies complete the paper flow through the real HTTP
  boundary and desktop/mobile UI, including stale/duplicate requests, concurrent
  claims, worker restart, browser disconnect and blocked recovery. Verify no
  signer/broadcast path and no legacy snapshots required. Common Positions
  list, charts, costs and history must cover first action through closure.

After R1–R3, finish the remaining W3 Research scope (registry-backed pool list,
all five exact windows, variable capital/range, bounded replay and calibration
reports), then continue W4–W7 with their existing gates. Basic draft creation
and dashboard parity are part of the first paper milestone and cannot be
deferred until the broader Research or product packages are complete.

For each follow-up, record scoped commits, evidence and remaining limitations
in section 9. Preserve unrelated dirty hybrid/adaptive work. Implementation
readiness, sealed-release deployment and live validation remain distinct;
this review adds no production migration, service activation or funding authority.

### September 23 parallel development slice (R2, R3, W3)

- R2 static/manual conversion close now has an internal pending terminal mark,
  an adjacent fee-evidence boundary, a separately versioned v2 accounting
  replay, canonical quote recheck, and a finalizer that records provisional
  capital-out details before marking the paper campaign closed. The v1 policy
  remains the retain-close view. An internal bounded maintenance pass audits
  both policies and advances the appropriate projection. No supervised worker
  invokes that pass yet. Paid amounts remain unavailable.
- R3 RangeKeeper has a read-only open preview built from its persisted,
  hash-checked draft and a selector for exact candidate-scoped provisional
  fork gas profiles. The store now offers a bounded read by pool, path and
  size band. There is no trusted producer for those profiles, no accepting
  command, and no RangeKeeper exit or lifecycle accounting yet.
- W3 Research has checked migration 8 for canonical event-block timestamps
  and contiguous scan bounds. The indexer verifies event headers against log
  hashes and truncates coverage on rewind. The dashboard exposes exact
  trailing 900-second swap counts only with current, internally consistent
  coverage. A zero count requires that coverage; volume, fees, and candidate
  economics remain unavailable. Migration 8 and historical rescan have not
  been run on a production database.
- Integration checks on this development tree: pinned `npm run typecheck`,
  `git diff --check`, and Research JavaScript syntax passed. No tests,
  database migration, browser checks, fork rehearsal, or sealed-release
  validation were run for this slice.

Next ordered work: (1) produce and register complete scoped conversion and
RangeKeeper gas evidence, including any approval and reset stages; (2) wire
the internal static/manual paper sequence and both accounting audits into a
durable bounded worker, then expose supported HTTP commands only after their
acceptance checks; (3) implement RangeKeeper close modes and the shared paper
accounting contract; (4) add v2 dashboard selection and Research-to-draft
controls, then run the R2/R3 desktop and mobile parity matrix; (5) apply the
checked Research migration through an authorized release and perform a bounded
canonical rescan before treating exact-window counts as available. W4-W7 and
the remaining W3 windows, variable sizing, replay, and calibration retain
their existing gates.

### September 23 follow-on slices and current gates

- W3 Research now reports exact canonical swap counts across 15-minute,
  1-hour, 6-hour, 24-hour and 7-day trailing windows. Each count has its own
  as-of time and coverage status; existing bucket-based volume and fee fields
  keep their separate limitations. Counts remain unavailable until migration 8
  and a bounded canonical rescan establish complete coverage in the target DB.
- R3 exposes a read-only RangeKeeper paper open preview through the existing
  preview path and a one-campaign bounded manual maintenance CLI for paper
  accounting. Both remain internal development controls. HTTP operation
  acceptance stays gated; no supervised worker or RangeKeeper command path is
  connected.
- R2 has a separate seven-stage static/manual conversion gas replay and
  verifier, including an independently owned-fork post-withdraw quote check.
  The v1 four-stage retain-close contract remains frozen. The v2 profile has
  no atomic store registration or trusted selector yet, so this evidence
  cannot authorize paper close completion.
- RangeKeeper has a read-only exit preview foundation requiring later
  canonical source marks, recomputed inventory/kernel state, wallet principal
  reconciliation and source-pinned exit profiles. It has no trusted persisted
  context loader, exit-profile producer, accepting command or lifecycle
  accounting. Both preview paths report actions unavailable.
- The shared Positions projection selects hash-checked v2 accounting only for
  a converted-close mark and v1 for other paper marks. A missing, invalid or
  revoked v2 snapshot leaves converted-close economics unavailable while
  retaining the exit point in history. The UI labels conversion output,
  costs and capital-out as provisional modeled values, never paid values.

Next ordered gates: (1) persist and atomically register verified conversion
gas evidence, then complete the static/manual conversion-close audit and
recovery path; (2) produce and persist RangeKeeper open/exit evidence and
trusted campaign context, implement its retain/convert close accounting and
recovery; (3) connect bounded operation claims and paper maintenance to a
supervised worker, then enable each HTTP command only after fresh admission,
reconciliation and restart evidence; (4) finish Research-to-draft controls,
variable capital/range and bounded replay/calibration; (5) run the isolated DB,
HTTP, desktop/mobile and sealed-release acceptance gates for both strategies.
Migration 8 and a bounded historical rescan are separate release operations.
No migration, rescan, fork rehearsal, browser check, test suite or release
validation was run in these follow-on development slices.
