# Research and Positions — Sol implementation plan

Prepared: 2026-09-21. Revised: 2026-09-27 after the scoped setup-preflight
repair. Static/manual paper remains the first operator MVP. Runtime `5905b47`,
sealed build `d507e6d…`, passes 882 clean tests and the canonical browser
setup-to-convert lifecycle with desktop/mobile captures. The diagnostic masking
behind the generic setup source-mismatch error is fixed; the earlier attempt's
underlying unavailable condition cannot be reconstructed from its log.
See the [current follow-up](../reviews/static-paper-setup-preflight-reasons-2026-09-27.md)
and [prior candidate acceptance](../reviews/static-paper-mvp-acceptance-f75d6277-2026-09-26.md).
Economic recovery, rejection and restore evidence remains attached to prior
`5b22ce5` / `f75d6277…`; the new artifact changes only two setup-preparation
modules. Production preparation is now recorded in the
[September 27 rollout package](../reviews/static-paper-rollout-package-2026-09-27.md):
the public-schema upgrade rehearsed successfully, and seven existing database
consumers require compatible builds alongside the two new paper services.
The daily retention script has a separately staged compatibility repair.
Next: review the exact migration, profile registration and coordinated service
cutover in that package; then run one operator paper workflow after approval.
No production activation is authorized or performed. Initial source review:
`b38c839`. Recheck HEAD and working-tree changes before starting.
The approved screen contract in
[section 11](#11-approved-prototype-contract-and-delivery-order) remains in force.
The ordered Sol handoff in
[section 12](#12-september-26-mvp-review-and-sol-delivery-order) supersedes older
next-action lists: finish and review static/manual paper, then RangeKeeper
paper, then guarded live operations. The two-strategy destination is unchanged.

This is the authoritative implementation handoff for the accepted
[workflow proposal](research-and-position-workflow-2026-09-21.md). The user's
latest decision narrows the product to **static/manual and RangeKeeper**.

### Prototype-first feedback checkpoint — accepted

The operator approved the revised two-tab prototype at `0e30224` on
2026-09-23. `dashboard/prototype/` is a review artifact served at `/prototype/`:
it reuses the current read-only Research and Positions dashboard views, while
its action and setup controls change browser memory only. The desktop/mobile
browser smoke check covered the Research pool table, Positions history, live
and paper demo actions, fee-tier pool choices and tick-width setup. This is UX
approval, **not** evidence of a working command API, paper accounting, signing,
live execution or custody. Do not copy its `srcdoc` embedding or demo position
state into the functional product; integrate the accepted controls into the
existing dashboard components. Follow section 11 for the product and delivery
contract. Keep all backend evidence and release gates attached to the real
capability they protect.

## 1. Outcome and authority

Deliver one dashboard with two top-level tabs, **Research** and **Positions**.
Research keeps the existing pool-comparison view. Positions keeps the existing
live and paper position information, layout, charts, filters and history; it
adds lifecycle controls to each mode and a third, bottom setup subsection for
new positions. The operator can choose a pool, capital, centered tick half-width,
strategy and mode, then open, pause/resume and close a paper or live position.
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
| The deployed Research view and its 1h, 6h, 24h, 7d controls | A new 15m UI requirement, automatic capital rotation or a strategy marketplace |
| Open, pause/resume, close-retain, close-convert | Range changes, strategy changes, top-ups, partial withdrawals and fee-only harvesting in the first functional release |
| Multiple paper campaigns; simultaneous live campaigns on distinct wallets | Multiple live campaigns sharing one wallet |
| Repeated live campaigns on a wallet after reconciled closure | Overwriting campaign history or reusing a previous campaign's budget silently |
| Existing position metrics, charts, filters, history and operation progress | New alert center, Email/Slack notifications or a multi-user permission system |

Use the existing TypeScript/PostgreSQL modular monolith and dashboard assets.
Introduce boundaries needed by this workflow; do not launch a framework rewrite.
Make chain, token units and venue profiles explicit without implementing a second
chain. Retain exact bigint V3 calculations and independent-reference economics.

### Retirement of legacy/adaptive functionality

- The new catalog, pages, command API and workers expose only the two supported
  families. Any later candidate evaluation follows the same restriction.
  Unknown/retired strategy IDs reject commands.
- New commands and setup offer no legacy/adaptive strategy. Keep existing
  historical live/paper position rows readable in the Positions view; do not
  silently discard history to remove a dependency. Separate any archival
  reader from the new campaign ledger and never let old evaluation output
  authorize a new operation.
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

- The first UI takes a **half-width in ticks around the current pool center**,
  constrained to the selected pool's tick spacing. Show the approximate percent
  in brackets. Fresh preflight resolves the actual center, aligned lower/upper
  ticks, resulting prices and token requirements for confirmation. Do not ask
  the operator to type lower and upper prices in the setup form. Explicit bounds
  may remain an internal/recovery representation, not a second setup control.
- On entry, use existing inventory first; an optional bounded funding swap must
  be included in the authorized preview. Never silently move the requested
  centered width. One-sided custom-range entry is outside the first UI scope.
- Hold the selected range. Being outside does not trigger recentering or a swap.
- Manual range changes are deferred beyond the first functional release. Keep
  the old position running until any later change operation is accepted; do not
  expose a placeholder control now.
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
- The setup may choose a supported centered half-width. Admission must check
  it against the selected RangeKeeper version and profile; a requested width
  that version cannot honor is unavailable, never silently substituted. Later
  width/strategy changes need a separate lifecycle operation and cannot patch
  a hashed running config.
- Freeze regression fixtures from current source/runbooks, including approved
  changes after the original RangeKeeper plan. Record any necessary policy or
  state-version increment before implementation; no profitability retuning.

The same strategy decision code receives a canonical observation frame in paper
and live, and in any later historical candidate evaluation. Execution adapters differ. Paper
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
- **Close, convert to USDG:** additionally perform the bounded authorized sale
  into the verified USDG quote token;
  complete only after target balances, dust policy, allowances and receipts
  reconcile. A failed conversion stays visible and recoverable.
- **Later: change range (outside first functional release):** preview complete withdrawal, optional swap, remint and costs;
  retain campaign ID, baseline, spent costs and limits. Activate the new revision
  only at a reconciled commit point. A failed replacement preserves recovered
  tokens and shows blocked/no-liquidity; recovery never repeats a completed swap.
- **Later: change strategy (outside first functional release):** support switching between the two families. Preserve the
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

The first functional product **takes over the current Research dashboard**:
`dashboard/research.html`, `dashboard/research.js`, its styles and
`GET /api/research`. Keep the existing pool comparison, selected-pool detail,
charts, sort, half-width controls and deployed 1h/6h/24h/7d windows. The
checkout contains separate 15m work, but the approved deployed view does not
show it; do not make it a new launch UI gate without operator review. Fix a confirmed
bug or evidence-label error if needed, but do not build a second research page,
new candidate ranking, historical replay or a multi-step Research-to-setup wizard
for this release. Research remains read-only and cannot authorize deployment.

The Positions setup dropdown lists registered supported pools as
`SYMBOL / USDG · <fee percent> tier`; it must distinguish same-symbol fee tiers.
The prototype reads `/api/research` for this list. The functional setup may
reuse that projection for display, but its eligibility and preview must resolve
to the verified pool/profile identity and fresh chain/reference evidence. A
stale or unverified pool remains visible in Research but cannot produce an
actionable open preview. Do not turn unavailable values into zero or infer an
independent price from pool spot.

The earlier candidate-engine design—incremental exact-window aggregates beyond
the existing view, capital/width-specific historical evaluation, saved Research
candidates, replay jobs and calibration reports—is deferred from the first
operator workflow. It can be scoped after paper and live controls work with the
existing dashboard. The canonical-evidence rules in sections 3–4 and 8 still
apply whenever that later work is proposed; this deferral never relaxes live
preflight, paper provenance or accounting requirements.

## 6. Command API, security and UI

Suggested routes (equivalent naming is acceptable):

- Reuse `GET /api/research` and `GET /api/positions` for the two existing
  views; add a supported-pool/profile read endpoint only if the setup cannot
  safely use an existing projection.
- `GET /api/strategies` for the two supported strategy families.
- `POST /api/deployments/drafts` from the bottom setup form.
- `POST /api/deployments/:id/previews` for open, pause/resume, retain-close and
  convert-close. Range/strategy changes are deferred.
- `POST /api/deployments/:id/operations` with preview ID/digest, expected
  revision and idempotency key; return `202` and durable operation identity.
- `GET /api/operations/:id`, plus campaign list/detail/history projections.

Same key plus same request returns the existing operation; same key plus a
different request is a conflict. Stale/revised previews reject before signing.
Reject unknown fields, unsupported capabilities and client-supplied shell paths,
signer material, arbitrary spender addresses or arbitrary calldata.

Keep command access loopback-only until the authenticated operator boundary is
reviewed. The existing `/prototype/` Tailscale Funnel is public and must stay
read-only/browser-demo; never route new command endpoints through it by accident.
Add single-operator authentication with server-side sessions, HttpOnly/SameSite
cookies, explicit origin/CSRF checks,
bounded request bodies, rate limits and sanitized audit records. Configure the
bootstrap credential outside Git and browser bundles. Require TLS/Secure cookies
before any later remote command exposure; do not add remote command exposure as
part of this implementation slice.
Read APIs use read-only connections; commands get narrowly scoped database
access. The dashboard has no signing key access and never shells out to a CLI.

Use one deliberate confirmation for the concrete live operation, showing wallet,
pool **and fee tier**, capital, strategy, requested tick half-width, resolved
center and exact aligned bounds, permitted swap, costs and limits. Accepted limits
authorize worker-managed strategy actions within the campaign; do not require a
click for each automatic recenter. Workers still refresh execution admission.
Any later change of limits/range/strategy requires a new explicit operation
authorization, outside the first functional UI.

The page has exactly two top-level tabs labeled **Research** and **Positions**.
Do not repeat a combined workflow label in headings or navigation. Implement
this in the existing dashboard instead of retaining the prototype's `srcdoc`
iframes. Research is the existing view. Positions keeps its current **Live
positions** and **Paper positions** subsections, layout, chart controls,
filters, activity and history; append a **Set up a position** subsection at the
bottom. Do not replace existing charts with demo lifecycle charts.

Positions UI uses the same list, detail charts and history for both modes:
allocated/available capital, reserves, exposure, NAV, absolute net P&L, passive
comparison, fees, paid costs, estimated exit costs, full range width and actual
bounds. An opening or failed-entry campaign appears from its first action even
without an NFT. Use typed token amounts/metadata, not fields named `nvda/usdg` or
hardcoded 6/18-decimal price conversions. Add pause/resume, close-retain and
close-convert to the corresponding live or paper position detail. These controls
must address a real campaign and show disabled/recovery states from the command
API; the prototype's sample positions and browser-memory state are not a data
model. Historical closed/invalid positions remain visible and have no active
operation buttons.

The bottom setup form exposes pool with fee tier, USDG capital, centered
half-width in ticks with an approximate percentage in brackets, static/manual
or RangeKeeper, and paper or live mode. The half-width choices follow the
pool's tick spacing. Do not expose lower/upper price inputs. A fresh preview
resolves the actual center, aligned bounds, token amounts, costs and eligibility;
the displayed percentage is orientation-aware guidance, not the executable
range. Only an eligible, current preview can be confirmed. Paper and live
submission use their respective guarded command paths.

Show operation stage, elapsed time, transaction hash, last source/heartbeat,
rejection reason and allowed next action. Use the existing position status and
detail surfaces to show stale data, outside range, cost limits, low gas and
blocked recovery; a new alert center is deferred. Technical diagnostics belong
in expandable details.

## 7. Ordered work packages and completion gates

Each package should end in scoped commits and an updated progress record here.
Use targeted tests during development and the required full gates before release.

| Package | Work | Required evidence before marking complete |
| --- | --- | --- |
| W0 — baseline | Inventory source/runtime boundaries, active campaigns and dirty prerequisites; freeze current RangeKeeper fixtures; finalize typed contracts, calibration validation policy and migration design | Written dependency/cutover inventory; calibration sample/freshness/error criteria frozen; no live-state mutation; supported strategy IDs fixed |
| W1 — persistence and commands | Checked schema migrations, campaign revisions, previews, operations, reservations, idempotency, auth and worker claims | Isolated-DB migration/restart/concurrency tests; unauthorized/stale/duplicate requests tested; schema startup is read-only |
| W2 — two-strategy paper flow | Complete static/manual paper first, then RangeKeeper; use the bottom setup and per-position open/pause/resume/retain-close/convert-close controls with versioned provisional/calibrated accounting | Each supported paper path completes through real HTTP, worker and shared dashboard without config edits/restarts; modeled evidence stays provisional; no signer/broadcast path |
| W3 — Research reuse and setup binding | Keep the existing Research view/windows; list verified pools with fee tiers in Positions setup, bind selected pool/profile and centered tick width to a fresh preview | Existing Research charts/filters remain intact; same-symbol tiers remain distinct; stale/unverified pools cannot open; no new candidate engine blocks first paper use |
| W4 — live open/close | Adapter to proven transaction stages, static and RangeKeeper live workers, wallet reservations, sequential campaigns, pre-submission predictions and receipt comparison collector | Owned-fork open/exit for both strategies and both exit modes; failed mint after swap and restart after signing; paired prediction/actual records; no duplicate economic action |
| W5 — lifecycle and recovery | Pause/resume, close precedence, retained-token accounting, safe recovery UI for the four supported action paths | Pending signed work reconciles before pause/close; retain and convert have distinct terminal states; failed operations stay visible and recoverable without duplicate swaps |
| W6 — dashboard parity and retirement | Put the accepted two-tab UI in the existing dashboard, preserve live/paper charts/history and historical records, show operation state and provenance, isolate retired strategies from new commands | Desktop/mobile browser checks for both modes/families from first action through closure; predecessor custody and old history stay visible; no demo records or stale economics in functional views |
| W7 — release and cutover | Sealed build, persistent worker supervision, migration/adoption tools, runbooks and concrete cutover record | Build verification, integration gates, restore/restart rehearsal, explicit production authorization status and outstanding gates |

Deliver the first real static/manual paper path through the accepted UI before
expanding Research or adding deferred range/strategy changes. Then complete
RangeKeeper paper, guarded live paths and release work in that order. Existing
backend progress is reusable only where its current tests and evidence still
pass. Do not treat a paper milestone as completion of both modes, and do not
equate provisional calibration with validated live execution economics.

### Source map

- Dashboard: `src/dashboard/{server,repository,research,positions,rangekeeper-position,position-performance}.ts`, `dashboard/{index,research}.html`, `dashboard/{app,research}.js` and their CSS. `dashboard/prototype/` is a review reference only.
- Guarded command boundary: `src/deployments/server.ts` and the deployment store/worker; keep it distinct from the public read-only dashboard route.
- Strategy/execution: `src/strategy/rangekeeper/{planner,domain,config,state,live-controller,live-store,live-stage,live-reconcile,live-mark,live-preflight}.ts`.
- Reuse journal/recovery invariants from `src/live-pilot/`; do not expose that old strategy in the new catalog.
- Migrations/runtime: `src/storage/{migrations,migration-checksums,compatibility}.ts`, `src/runtime/identity.ts`.
- Release: `scripts/{build-release,run-release,render-release-units}.mjs`, `ops/`, `docs/operations/rangekeeper-v1.md`.
- Tests: current dashboard and RangeKeeper suites; integration examples in `test/integration/{migrations,rangekeeper-fork,live-pilot-journal}.mjs`.

## 8. Acceptance matrix and release requirements

1. The only top-level tabs are Research and Positions. Exactly two strategy
   families are selectable for new positions; both modes ultimately operate.
   Rejected old strategy IDs cannot be smuggled through the command API.
2. Research preserves its deployed comparison/detail layout, charts, filters
   and 1h/6h/24h/7d windows. Missing coverage/reference data is visible; Research failure
   does not hide operational Positions.
3. Positions preserves the current live/paper information, charts, windows,
   activity and history, then adds a bottom setup subsection. Pool choices show
   fee tiers, tick half-width choices show approximate percentages, and a fresh
   preview resolves exact center/bounds, sizing and costs. No lower/upper price
   fields or unverified scaling of fixed-budget results appear.
4. Paper and live fixtures use identical strategy decisions for identical frames;
   fills, delays and costs carry their actual measured/modeled evidence class.
5. Correct prices, units and inventory for quote-as-token0 and quote-as-token1,
   unequal decimals and aligned centered tick bounds. The percentage label is
   approximate; executable prices and bounds come from exact preflight math.
6. Double submission, stale revision, two workers, worker death and browser
   disconnect cannot create duplicate entries or allocate a wallet twice.
7. Crash before/after signing, lost RPC acknowledgement, receipt timeout, revert
   and reorg remain recoverable without replaying completed swaps or losing NFT
   custody. Pending signed operations cannot be discarded by pause/close.
8. Pause/resume and both close actions exist on live and paper position details,
   reject stale or duplicate requests, preserve monitoring/reconciliation and
   never reset cost limits, initial inventory or a drawdown baseline. Width and
   strategy changes are not in the first functional UI.
9. Close-retain and close-convert have distinct reconciled postconditions; a
   stopped process is never sufficient evidence of closure. A second campaign
   can start after releasing custody/reservations without deleting the first.
10. The same existing UI list/charts/costs/history cover both strategies and
    both modes from first action; outside/waiting differs from a pending
    recenter. Closed/invalid history remains accessible. Missing economics
    remain null rather than zero or silently substituted pool prices.
11. All runtime data is bounded or paginated. Research failure/load cannot take
    down operational views or consume reserved live/ingestion provider capacity.
    The public Funnel prototype cannot submit real operations.
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

This section records earlier backend review and progress. The approved prototype
supersedes its older UI and Research-candidate delivery order; use section 11
for current product scope and next actions. Retain its confirmed safety and
accounting findings until separately resolved.

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
- Bind the bottom Positions setup to a verified pool/profile and deliver
  position controls for open, monitoring, pause/resume and both close modes
  without config edits or restarts. Keep Research's existing read-only view.
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

### September 23 parallel follow-through

- Static/manual conversion gas has an atomic seven-stage V2 registration path,
  scoped by campaign, sealed runtime identity, canonical source, route,
  allowance state, size band and complete fork sequence. The separately
  versioned `paper_fixed_flow_convert_v2` projection requires those registered
  profiles, and converted-close completion reselects and replays the exact
  snapshot before writing provisional capital-out references. The prior V1
  conversion policy remains readable but cannot complete a new converted
  close. Old campaigns without a sealed runtime identity fail closed.
- The bounded static/manual paper maintenance loop now audits V1 and both
  conversion policies, then projects the V2 terminal path. A signer-free
  worker entry point serializes passes with a DB advisory lock and limits
  campaigns and steps. It has no operation claims or release supervisor yet;
  HTTP operation acceptance remains disabled.
- Positions selects the V2 converted-close snapshot only when its content
  hash, source and persisted runtime identity match. Missing or invalid V2
  economics remain unavailable while the exit history point remains visible.
- RangeKeeper now has separate persisted-context and owned-fork gas-evidence
  verifier contracts with source rechecks and `actionAvailable:false`. It
  still needs the trusted store context reader, real owned-fork stage runner,
  atomic profile writer and paper lifecycle/accounting adapter.
- Research has an isolated, bounded exact-bigint principal sizing helper for
  an explicit USDG budget and tick-aligned range. It returns token amounts
  and liquidity only. Historical candidate replay, candidate-scoped costs,
  saved draft evidence and Research-to-draft controls remain unavailable.

Development checks: pinned TypeScript typecheck, Research JavaScript syntax
and scoped diff checks passed after integration. No tests, production migration,
historical rescan, browser run, fork rehearsal, sealed-release build or service
activation was performed. Next release gates remain isolated-DB lifecycle and
restart acceptance; a trusted RangeKeeper store/runner/adapter; fresh command
preflight and durable claims; full HTTP and desktop/mobile Positions parity;
and migration 8 plus canonical rescan before exact Research counts are shown
as available on a production database. W4-W7 retain their separate gates.

### September 23 parallel integration and verification

- R2 static/manual has an opt-in, signer-free paper operation claim pass for
  open, retain-close and converted-close. It filters claims by strategy,
  advances bounded stages, renews leases, rechecks canonical anchors at the
  append boundary, and resumes a pending converted-close mark after restart.
  PostgreSQL determines lease validity; a lost claim is left for recovery.
  Proven anchor mismatches block the operation, while RPC transport failures
  remain retryable. The operation loop defaults off, and HTTP operation
  acceptance still returns `503 operation_preflight_unavailable`.
- Isolated local PostgreSQL migration and deployment integration scripts now
  pass. They cover fresh and v3/v4/v6-to-v8 migrations, open/retain reorg
  zero-write and restart behavior, strategy-filtered claims, V2 seven-stage
  converted-close accounting, preview-expiry recovery, quote mutation
  rejection, and exact-once terminal completion. The V2 profiles in this
  test are synthetic selector fixtures; they do not establish owned-fork gas
  evidence or authorize operator acceptance. The run also found and fixed
  conversion queries that referenced a nonexistent campaign `open_mark_id`;
  those paths now derive the opening mark from persisted marks.
- R3 has a trusted persisted-context snapshot reader, an internal atomic
  RangeKeeper gas-profile registration path with canonical source and
  persisted-candidate replay checks, and a read-only retain/convert exit
  preview route. Missing saved marks or kernel context return explicit
  unavailable results; the preview remains action-unavailable. No trusted
  RangeKeeper mark/kernel producer, owned-fork stage runner, accepting command,
  terminal accounting adapter or supervised operation path is connected.
- W3 has a bounded exact-bigint static/manual candidate replay helper. It
  labels all caller-supplied inputs `unverified_scenario`, cannot save a
  draft or authorize an action, and leaves RangeKeeper recenter replay
  unavailable. A trusted profile/source reader, canonical fee and gas-row
  loading, wallet/limit pinning, and saved-draft binding remain necessary.

Scoped commits: `aa48f7f`, `1b2561c`, `9adc508`, `2b6d82c` (paper worker and
claim recovery); `431df51` (isolated DB lifecycle checks); `0e135fc`
(Research replay); `82b4c70` (RangeKeeper store and previews). Focused worker,
server, anchor and Research tests, pinned typecheck, and diff checks passed.
No production migration, historical rescan, owned-fork replay, browser parity
run, sealed-release build, service activation, funding, signing or broadcast
was performed.

Next ordered gates: (1) run and register independently verified owned-fork
gas evidence for both static conversion and RangeKeeper paths; (2) persist
RangeKeeper paper marks/kernel state and implement its retain/convert
accounting and restart recovery; (3) complete fresh admission and supervised
operator claims for each supported command before enabling HTTP acceptance;
(4) connect trusted Research candidate loading to pinned saved drafts and
finish the remaining W3 replay/calibration controls; (5) verify shared
Positions HTTP, activity/history, metrics/charts and desktop/mobile parity
from first session through closure, then complete migration 8, bounded
canonical rescan, release and restore gates under separate authorization.
W4-W7 remain open.

### September 23 progress review at `576e746`

There is substantial backend progress, but the first usable two-strategy paper
workflow remains incomplete. Static/manual provisional accounting is furthest
along; RangeKeeper execution and the operator workflow remain the main blockers.
This review updates the next-action order above while preserving the R1-R3 and
W0-W7 completion gates.

| Area | Reviewed status |
| --- | --- |
| W0 | Baseline, contracts and calibration policy recorded. Runtime inventory must be refreshed before cutover. |
| W1 | Migrations, authenticated drafts, idempotency, reservations, claims and store recovery are implemented; operation acceptance remains disabled. |
| W2 / R2 | Static/manual open, valuation, retain-close and V2 conversion-close have persisted provisional accounting and reorg protection. RangeKeeper lacks an executable paper lifecycle and terminal accounting. |
| W3 | Registry-backed pool listing and exact swap counts across five windows exist. Principal sizing and static replay helpers exist; trusted candidate loading, saved-draft binding and RangeKeeper replay remain unfinished. Exact swap counts do not establish exact-window volume, fees or candidate economics. |
| W4-W7 | Live adapters, management transitions, complete product parity and release/cutover gates remain open. Existing predecessor RangeKeeper functionality does not complete these packages. |

**Confirmed review findings:**

1. **Campaign count stops all maintenance.** In
   `src/deployments-paper-worker.ts`, `runPaperMaintenancePass()` selects active,
   paused, closing, closed and blocked static/manual campaigns, then throws if
   the result exceeds `maxCampaigns`. A focused reproduction confirmed that 21
   selected campaigns abort the default 20-campaign pass before any campaign is
   processed. Closed history therefore eventually prevents maintenance of
   current campaigns. Implement bounded, fair pagination while preserving
   historical reorg audits; raising the limit only postpones the failure.
2. **Fresh valuation marks are not scheduled.** The maintenance pass in
   `src/deployments/paper-maintenance.ts` audits and projects existing marks.
   `recordCanonicalPaperPrincipalValuation()` exists in `paper-valuation.ts`
   but has no runtime caller. An opened campaign cannot continuously update
   valuation and adjacent fee intervals through this worker alone. Connect
   canonical sampling to the lifecycle, including paused monitoring and safe
   handling of concurrent close operations.
3. **Store recovery tests do not establish worker recovery.** The deployment
   integration script exercises persistence and completion methods directly.
   `test/deployments-paper-operation-worker.test.ts` covers idle, unsupported
   strategy and expired claim cases, but no successful lifecycle through
   `processOnePaperOperation()`. Add worker-level success and interruption
   coverage before enabling commands.
4. **The full check fails on the new Research window contract.** Two assertions
   in `test/dashboard-research.test.ts` still expect four windows and at least
   four buckets in the shortest window. These conflict with the accepted
   15-minute window. Update the tests to distinguish exact event coverage from
   bucket-based chart/economic data; retain all five required windows.

The HTTP gate remains appropriate: `src/deployments/server.ts` returns
`503 operation_preflight_unavailable` for operation acceptance.
`src/deployments.ts` also reports static/manual terminal previews unavailable.
Internal accounting completion therefore does not yet deliver dashboard-driven
open or close. RangeKeeper previews remain action-unavailable, and the operation
worker claims only static/manual campaigns.

**Fresh validation on the reviewed checkout:**

- Pinned `npm run check`: repository checks and typechecking passed;
  **694 of 696 tests passed**, with the two Research assertions above failing.
  The full check is not green. These failures are separate from the preserved
  unrelated hybrid/adaptive dirty work.
- Pinned `npm run test:integration`, using
  `TEST_DATABASE_URL='postgresql://root@localhost/conc_liq?host=/var/run/postgresql'`:
  passed in isolated schemas, including migration upgrades, conversion-close
  recovery, exact-once completion and reorg rejection. Synthetic gas fixtures
  and direct store calls do not establish owned-fork or worker acceptance.
- `git diff --check` passed. No deployed release, production custody,
  owned-fork evidence or desktop/mobile browser parity was revalidated.
- The review changed no repository files or running services. This subsequent
  addition records its findings only; it does not authorize production changes.

**Ordered continuation for Sol:**

| Task | Required work | Acceptance before completion |
| --- | --- | --- |
| PR1 — Restore the check gate | Correct the Research window tests around the accepted five-window contract and coverage semantics. | Pinned `npm run check` passes; 15m/1h/6h/24h/7d remain available, and incomplete coverage cannot become zero activity or exact economics. |
| PR2 — Make paper maintenance continuous | Add fair bounded campaign pagination and canonical valuation sampling; preserve closed-history auditing and paused monitoring. | More than 20 mixed active/closed campaigns make progress across bounded passes; no campaign starves; new canonical frames produce marks and adjacent fee accounting; duplicate frames, reorgs and concurrent close cannot append invalid or duplicate evidence. |
| PR3 — Verify the actual operation worker | Exercise open, retain-close and conversion-close through the worker against isolated PostgreSQL, including interruption, renewal and takeover. | Restart after a pending conversion, expired preview recovery, lease loss/renewal, transient RPC failure, canonical mismatch and competing workers preserve exact-once accounting and terminal completion. |
| PR4 — Finish two-strategy evidence and accounting | Run/register independently verified owned-fork evidence for static conversion and RangeKeeper; persist RangeKeeper marks/kernel state and implement both exits and recovery. | Both strategies satisfy R2 with scoped provisional inputs, reproducible balances/costs and restart-safe accounting. Statistical sample sufficiency gates a validated claim, not a provisional lifecycle. |
| PR5 — Deliver the operator paper milestone | Connect fresh admission, static terminal previews, supervised claims, bottom Positions setup and position lifecycle controls. | Both strategies complete the real HTTP and desktop/mobile flow, including pause/resume, both exits, stale/duplicate requests, browser disconnect and blocked recovery; shared metrics, charts, activity and history match persisted evidence from first action through closure. Enable only paths that pass these gates. |
| PR6 — Release work; defer Research expansion | Keep the existing Research view; continue W4-W7 and scope any candidate replay separately after the operator workflow works. | Preserve each release requirement, including migration 8/rescan, sealed build, restore and cutover evidence with explicit production authorization status. Candidate replay is not a first-release dependency. |

Keep the first usable paper milestone ahead of broader Research expansion.
Do not count source implementation, isolated acceptance, sealed deployment and
live validation as interchangeable evidence. Preserve unrelated dirty work.

### September 23 implementation follow-through through `c5837b5`

- PR1 is implemented: the accepted five Research windows and incomplete swap
  coverage have matching tests. Pinned `npm run check` passed **719/719 tests**
  through `c5837b5`.
- PR2 now rotates bounded maintenance pages, samples canonical principal marks
  for active and paused static/manual campaigns, and excludes closing campaigns
  at the locked append boundary. A worker test reaches 40 active and five closed
  campaigns in three 20-row passes. The cursor is process-local, so frequent
  restarts can revisit the first page; durable cross-restart fairness remains
  open. No service rollout or production mark generation was verified.
- PR3 now exercises worker-level open, retain-close and pending conversion-close
  against isolated PostgreSQL, including competing claims, restart, expired
  preview recovery, transient RPC retry and canonical mismatch with zero writes.
  Lease renewal success/failure is covered by deterministic worker tests; a
  real timed database renewal test remains open.
- PR4 has a guarded RangeKeeper observation-mark store method and owned-fork
  open and terminal retain-exit sampler CLIs. The mark writer has isolated
  PostgreSQL replay coverage; the samplers have focused inventory tests but no
  campaign-owned fork rehearsal or registered profile. Terminal sampling loads
  persisted mark/kernel context and refuses missing or mismatched inventory;
  conversion sampling remains unavailable. The first-observation open model cannot yet
  be booked as capital-in: confirmation may resize at the second source, while
  pending-operation gas-profile registration and persisted execution proof are
  missing. Retain/convert terminal accounting and recovery remain open.
- PR5 now exposes a read-only static/manual retain estimate from the persisted
  opening candidate and a later canonical frame; retained balances are
  principal-only lower bounds. Static conversion, action-bound terminal
  previews, accepting HTTP commands, RangeKeeper paper execution and complete
  Positions desktop/mobile parity remain open.
- PR6 now has a hash-checked PostgreSQL reader for current registry-backed
  market profiles. Historical canonical frames, independent references, fee
  intervals, scoped costs, wallet/limit pinning and atomic saved-draft binding
  are absent, so candidate economics remain unavailable.

The isolated PostgreSQL `npm run test:integration` gate passed through `c5837b5`,
including the new Research registry reader and paper-worker paths. No production
migration or rescan, owned-fork rehearsal, sealed-release build, browser parity
run, funding, signing, broadcast or service activation was performed. Continue
PR4 by defining and persisting a second-observation execution envelope and
source-exact gas evidence before any RangeKeeper open booking. Then finish
terminal accounting and PR5 operator acceptance; retain the W4-W7 release gates.

### September 23 second-wave implementation through `fe916bf`

- PR2 maintenance pagination now uses bounded keyset reads and a bounded wrap
  query (`a6ea95f`), avoiding a sort of all eligible history each pass. Its
  cursor is still process-local; restart-safe fairness remains open.
- PR4 has a guarded static/manual conversion gas-sampling command (`98d29b6`)
  that binds a supplied context to a persisted converted-close endpoint and
  runs the existing seven-stage owned-fork sampler plus read-only source and
  store replay verification. It writes an unregistered report. There was no
  eligible persisted endpoint for a campaign-owned rehearsal.
- PR4 also has a read-only RangeKeeper second-observation probe/envelope
  (`fe916bf`). It replays the saved first candidate, checks both canonical
  anchors, selects second-source candidate-scoped gas profiles and requires a
  caller-supplied simulation attestation. That attestation is **not** an
  independently verified execution proof. The envelope is ephemeral and
  explicitly has `openingBooked: false` and `actionAvailable: false`; it writes
  no deployment mark, ledger entry, operation or position. Persisting it as a
  mark would make the current dashboard's latest-mark reader see an unsupported
  classification, so a durable dashboard-safe envelope store is still needed.
- PR5/PR6 can now save a static/manual paper draft from a caller-supplied range
  and allocation bound to a fresh, hash-checked registered profile (`cd392f8`).
  This is not a historically derived Research candidate. The requested window
  is not stored in the deployment revision; historical fees, costs, passive
  comparison, HTTP binding and action availability remain absent.

Final pinned `npm run check` passed **725/725 tests**, and the isolated
PostgreSQL `npm run test:integration` gate passed after these second-wave
changes. These checks do not replace a campaign-owned fork rehearsal or a
sealed-release/browser parity run.

The prototype-first feedback checkpoint is complete at `0e30224`. The
RangeKeeper confirmation envelope, campaign-owned static conversion rehearsal,
restart-safe maintenance fairness, exact-source operator claims and shared
Positions view remain real-operation work. Section 11 now sets their delivery
order. No production change or activation is implied by these commits.

## 11. Approved prototype contract and delivery order

Operator feedback on 2026-09-23 accepted the two-tab prototype at `0e30224` as
the UI target. The prototype is a visual reference, not an implementation
shortcut or proof of executable actions. Use the existing dashboard code and
read APIs for the functional product; keep the prototype's public Funnel page
as a browser-only review surface.

**Screen contract:**

1. The only top-level navigation tabs are **Research** and **Positions**.
   Research is today's dashboard Research section, including its pool table,
   selected-pool charts, window controls and evidence labels. No new candidate
   wizard, ranking screen or repeated combined workflow label is needed.
2. Positions starts with today's **Live positions** and **Paper positions**
   sections. Preserve their information hierarchy, table/detail layout,
   value/passive, price/range and inventory charts, windows, filters, activity
   and history. Add pause/resume, close-retain and close-convert for an eligible
   selected campaign in each mode. Show pending/blocked/recovery state in the
   same section; closed and invalid history remains read-only.
3. A third **Set up a position** subsection sits below live and paper. Its
   inputs are pool (`SYMBOL / USDG` plus fee tier), USDG capital, centered
   half-width in ticks (approximate percentage in brackets), static/manual or
   RangeKeeper, and paper or live. Choices follow the pool's tick spacing.
   There are no lower/upper price fields. Fresh preflight must display the
   actual center, aligned ticks/prices, token requirements, costs and limits
   before an actionable confirmation; the percentage label alone cannot be
   used for execution.

**Implement in this order; each step ends with a scoped commit and an updated
evidence/status note. Section 12 brings the applicable F5 review forward after
F2 so the static/manual paper MVP can be reviewed before F3/F4. The full F5 and
W0-W7 requirements remain attached to their respective capabilities:**

| Step | Work | Acceptance |
| --- | --- | --- |
| F1 — Integrate the approved UI | Add the two tabs and bottom setup to the existing dashboard. Reuse its Research and Positions rendering/assets; bind the form to registered pool/profile data. Show real actions as unavailable until their command path passes F2/F3/F4. | Desktop/mobile comparison against the current dashboard shows the same Research table/charts and live/paper rows, charts, filters, activity and history. Pool tiers and tick percentages are correct; closed/invalid positions have no active buttons; no prototype fixture or `srcdoc` state enters production. |
| F2 — First working paper slice | Finish W1/R2/R3 prerequisites for static/manual: fresh centered-width preview, authenticated/idempotent acceptance, durable worker, canonical paper marks, pause/resume and both terminal exits. Put the accepted operation and its stage/history in Positions from the first action. | Isolated PostgreSQL plus browser run: set up, review, open, pause, resume, retain-close, and a separate convert-close complete without source/config edits or restart. Repeat/stale requests, browser disconnect, reorg and worker restart do not duplicate an action. Modeled economics stay provisional or unavailable, never paid/validated by implication. |
| F3 — RangeKeeper paper | Persist and verify the second-observation execution envelope, campaign-owned costs and kernel state; run the same paper lifecycle and both exits through the shared UI. | Owned-fork/source-exact evidence and isolated worker recovery pass; both strategies render the same Positions metrics/charts/activity/history through closure. Unsupported widths or missing proofs block admission instead of silently changing the requested range. |
| F4 — Guarded live paths | Bind static/manual and RangeKeeper live opens, pause/resume and both exits to the proven intent/receipt journal, reservations and custody recovery. Keep command access loopback-only until a separately reviewed authenticated remote boundary exists. | Owned-fork stage/recovery tests and explicit wallet/custody preflight pass; no duplicate signed action after interruption; retain and convert reconcile different final inventories. No funded activation follows from code completion. |
| F5 — Release and operator review | Run full checks, production-like desktop/mobile browser parity, migration/restore rehearsal and sealed-release review. Record remaining capability gates and show the operator the functional paper flow before any live cutover decision. | Section 8 and W7 evidence is attached to exact commits/builds; prototype, isolated paper success, sealed deployment and live validation are reported separately. |

**F1 status, 2026-09-23:** `ed0c3a5`, `1b0ff8b` and `4b4f9fb` put the
approved tabs and bottom setup into the source dashboard. Setup reads registered
pools and fee tiers, offers tick-spacing-aligned centered widths, and shows a
read-only selection summary. Existing Research and live/paper Positions renderers,
charts and history remain in place. Lifecycle controls are visibly unavailable;
the command API still rejects operation acceptance. Focused dashboard tests
(42), typechecking, and disposable Chromium checks of both live and paper
history charts, setup review, and 1440px/390px layouts passed. This is source
checkout evidence, not a sealed release or the public prototype deployment.

**F2 status, 2026-09-23:** `7145bc5` keeps HTTP previews non-actionable, and
`27ef89d` resolves a static/manual centered tick range from a fresh preview
tick. `e575750` persists a costed static/manual paper-open model only after a
canonical source recheck and binds it to the draft revision and short expiry.
`1beb214` adds an authenticated, read-only loopback setup preflight for a
registered profile, USDG budget and centered half-width. It uses a fresh
confirmed frame, independent references and round-up mint amounts; a complete
exact-range gas profile is required for an available result. It creates no
draft or operation. The dashboard still cannot submit this call through its
public read-only origin, and the result does not prove wallet funding or
admission limits. Draft creation from the reviewed setup, the supervised
worker, full paper lifecycle and browser acceptance matrix remain gates. HTTP
acceptance stays 503, and no operator action is enabled. Typecheck, 730 unit
tests, isolated deployment integration and repository checks passed for this
foundation; the final added successful-cost assertion passed in focused tests.
`282138b` adds internal static/manual paper pause and resume through the
existing journal and worker. The claim-bound transition is revision and
lifecycle checked, survives lease expiry, and writes no economic mark or
ledger entry. Isolated integration and typecheck passed. No HTTP operation
acceptance or dashboard action was enabled. `097c3c8` adds the matching
authenticated pause/resume preview producer: it locks and checks the current
paper campaign state, revision and pending operation before saving a 60-second
no-economics proposal. Invalid state writes no preview. Focused server and
isolated integration tests passed; acceptance remains 503.

**September 24 source checkpoint:** `76eaa25` and `888a8f9` show the latest
persisted operation kind/status/stage in Positions, including a queued open
before its first mark, while preserving unavailable economics. `44a7141` and
`555eacd` serve the accepted UI plus Research/Positions read models on the
loopback command origin; the public dashboard remains read-only. `6e94dc1`
binds the bottom setup to authenticated, verified pool/profile data and a
read-only static/manual paper sizing preflight. It shows aligned bounds,
integer token requirements and provisional scoped costs. It creates no draft:
the accepted form has no wallet identity, and sizing has not established
funding or admission limits. `4726764` and `fd56774` add a registered,
disposable Chromium check: 16 public/operator desktop/mobile checks passed,
with two setup preflight POSTs, zero draft/operation POSTs and zero browser
errors against mock read/command responses.

`9d38b8a` persists a source-pinned static/manual retain-close preview and
adds a specialized HTTP acceptance path that verifies its campaign, revision,
open/prior/terminal anchors and saved model before queueing. Isolated tests
exercise authenticated HTTP acceptance, idempotent replay, forged-evidence
and reorg rejection, worker restart and terminal completion. Runtime sets
`paperRetainWorkerReady: false`, so previews remain non-actionable and HTTP
acceptance returns 503 until worker readiness and cost revalidation pass.
Static open, pause/resume and convert-close are not yet connected end to end
through the operator page.

**F3 source checkpoint:** `6923842` adds migration 9 for append-only,
hash-checked RangeKeeper second-observation confirmation envelopes with
canonical anchor rechecks. `c3dee73` and `7bd9c55` add a restart-safe,
read-only context that replays candidate inventory, scoped provisional costs
and kernel identity; invalid mint/proof inputs fail unavailable. Simulation
remains caller-supplied and unverified, opening is not booked, and actions
remain unavailable. An owned-fork producer, worker consumer, both exits and
shared dashboard lifecycle parity remain F3 gates. No production migration,
service restart, signing, broadcast or sealed release occurred.

On this checkpoint, the pinned `npm run check` passed 736/736 tests and the
isolated PostgreSQL `npm run test:integration` gate passed through migration 9.
The Chromium run used mock responses, not real chain/profile availability or
the full paper lifecycle. These source checks do not satisfy F2/F3 browser,
worker-supervision or sealed-release acceptance.

**September 24 continuation (source, before final integrated gates):**
`5892d75` replaces the hard-disabled retain readiness flag with a dedicated
PostgreSQL session lease held only when the paper operation worker is explicitly
enabled. Command acceptance probes that lease and replays current profile,
configuration, scoped gas and terminal-model evidence; loss or probe failure
fails closed. `536d095`, `6368fc1` and `1df97be` add loopback-only retain,
pause and resume preview/accept controls and specialized pause/resume admission.
The browser smoke exercises these controls with mock command responses. It does
not establish that a real worker has processed a browser-submitted operation.
Static open and convert-close are still unavailable at the HTTP boundary, and
the bottom setup still creates no draft. The paper operation worker remains
opt-in; this source work has not enabled a production service.

`17e0a23` and `4a6f664` add source/candidate/stage-bound owned-fork evidence
for the RangeKeeper second observation and verify its structure on persistence
and restore. The persistence boundary can still receive caller-supplied
evidence, so provenance remains explicitly unverified. Neither the envelope
nor its context books opening inventory or enables an action. Trusted producer
wiring, admission, worker claim/replay and both exits remain F3 gates. These
commits received focused typecheck and isolated deployment integration checks;
rerun the full pinned repository, database and browser gates after the next
integration slice before treating the combined source as tested.

**Later September 24 continuation:** `34930d5` adds a read-only operator
review of wallet syntax, exact paper allocation, native reserve and labeled
static/manual limits. It still submits no draft. `2f4f777` adds a specialized
static/manual paper-open endpoint: saved preview identity, fresh source and the
paper worker lease gate actionability, while acceptance replays the allocation,
profile, configuration, candidate, cost model and canonical source. The
isolated PostgreSQL integration exercised authenticated loopback acceptance,
lease loss, stale/repeated requests and worker restart. A saved draft from the
bottom setup remains missing, so this is not the complete F2 browser path.
`c76920b` records an inert V2 close-convert preflight contract, but runtime
still returns unavailable: its exact pre-acceptance owned-fork sampler,
persisted fee carry, worker replay and HTTP route are missing.

`a43b526`, `b1a6612`, `76bdf01` and `bfd5b52` add a campaign-only
RangeKeeper confirmation producer source, a non-booking completion projection,
and an adapter that can replay a later mark from the confirmed second source.
The producer is not connected to the command runtime or demonstrated against a
real owned fork, and these artifacts do not create an open operation or book
capital. Readers and a worker still need verified confirmation lineage,
operation-scoped replay and isolated database lifecycle tests before F3 actions
can be enabled.

**September 24 integration checkpoint:** `25f6259` adds authenticated,
idempotent static/manual paper draft admission from a reviewed setup. It
rechecks canonical sizing, registered profile, independent references,
provisional stage costs, allocation, native reserve and limits before an atomic
draft insert. `7c5e7c1` makes an invalid store outcome reconciliation-required.
The operator form has not yet completed the saved-draft browser path.
`2ab1d0b` adds an inert owned-fork close-convert prestate sampler; persisted fee
carry, worker replay and HTTP acceptance still gate convert-close. `40b2899`
verifies persisted RangeKeeper confirmed-open lineage before later mark/exit
reads, while `8e0bae1` makes unsupported RangeKeeper worker claims fail closed.
Server-owned confirmation provenance, operation-scoped replay and atomic
booking remain F3 gates. The combined isolated PostgreSQL migration, deployment
and paper lifecycle integration suite passed through migration 9 on this source
checkpoint. This does not establish the browser or supervised worker lifecycle.

**September 24 working-dashboard continuation:** `3ca1717`, `75861c9` and
`d5d7399` connect the operator setup to authenticated, idempotent static/manual
paper draft creation and a bounded saved-draft recovery list. A reviewed source
is pinned for admission; a reopened draft requires a fresh preview. Pending
draft and open keys survive reload and reauthentication, and an ambiguous open
keeps its key if worker readiness later fails. The disposable Chromium run
passed 39 public/operator desktop/mobile checks with repeated request IDs and
no browser exceptions. `953c5fe` reconciles an already accepted open,
retain-close, pause or resume before checking a now-missing worker lease; a
fresh key remains blocked. Its HTTP tests and isolated PostgreSQL deployment
integration passed, including lease-loss replay, conflicting-key rejection and
zero additional acceptance. The combined repository check passed 766/766
tests. This does not yet prove a browser-submitted operation completed under a
supervised worker.

`67dbdc6`, `69d7f4c` and `7635b56` add persisted static paper fee-carry
lineage, in-memory adjacent replay to a close-convert sample frame, and a
seven-stage owned-fork prospective gas report. These values remain
`fork_estimated`; no terminal mark or earned-fee booking is implied. Profile
import, accepted convert-close preview/command, worker replay and browser
completion still gate F2. `c2fd24d` and `6d307f7` bind a RangeKeeper producer
receipt to a completed in-process owned fork and add a source-exact replay
verifier for saved confirmation evidence. The verifier is non-booking; atomic
operation completion, restart proof, both exits and UI parity still gate F3.
`3a9f593` renders source templates for the command API and opt-in paper worker
from one sealed release. No unit was installed or started and no release was
built from this combined source, so F5 supervision and cutover remain open.

**September 24 real-boundary continuation:** `1140c65` corrects the setup
quote-token index and adds a browser run against authenticated command HTTP
and isolated PostgreSQL: seven assertions passed for profile load, reviewed
draft admission, saved-list reload, fresh persisted open preview and same-key
retry after worker-readiness 503. Canonical chain observation was mocked; no
worker or signer ran and no operation was accepted. `2513ef1` and `eb8f318`
exercise real command and paper-worker child processes through pause/resume,
one SIGTERM/restart and worker lease loss/reacquisition. The actual Positions
API/browser showed both succeeded stages and unavailable economics at desktop
and mobile widths, with no marks or ledger writes. Open and retain completion
still require source-exact RPC evidence beyond this process harness.

`99159b8` proves the distinct close-convert prestate profile import in an
isolated PostgreSQL schema: seven provisional inserts, exact same-report
idempotency and rollback on a forced partial insert. `24d7cc4` binds an
adjacent candidate-source fee interval and advanced modeled carry into the
terminal preview. `eddbfd7` selects only those exact provisional prestate gas
rows and adds a specialized same-key-reconciling HTTP route, which stays 503
without V3 accounting/acceptance. Existing V2 terminal cost/history semantics
are not reinterpreted. `5e59427` and `1244e84` require operation-bound
RangeKeeper owned-fork replay before an atomic provisional open mark and three
capital-in entries; the isolated database test proves forged replay writes
nothing. A positive two-fork replay and successful booking/restart run remain
F3 gates, so RangeKeeper paper action stays unavailable. `de98c87` adds a
read-only legacy intent/receipt journal diagnostic for the two supported live
strategies; it always reports current live readiness unavailable. No live
signing, custody mutation, broadcast, unit activation or production migration
was performed.

**September 24 parallel implementation checkpoint:** `65a7d13` adds the
dedicated migration 11 Position Manager Transfer index with bounded canonical
scan, persisted cursors/checkpoints and reorg rewind. `63f7b04` binds the
read-only replay to persisted canonical source/event checkpoints, then checks
the operator's reconstructed NFT set against pinned-source `balanceOf` and
`ownerOf`. The isolated migration, PostgreSQL rewind and owner-reconciliation
fixtures passed after the final cursor-consistency guard; the live preflight
composer still reports `actionAvailable:false` and `executionEligible:false`.
Complete custody/recovery and owned-fork live operations remain F4 gates.

`17648d3` and `7c87fd4` add the static/manual convert-close review control
with a persisted same-key retry after an unknown acceptance outcome. It only
accepts a saved, actionable V3 provisional preview; the server still withholds
that action while V3 acceptance/completion are under test. `42aed58` reads
verified V3 converted-close accounting in the shared Positions projection,
and `bf72f97` admits a booked RangeKeeper paper open mark into range/activity
history while leaving unvalidated economics unavailable. `24b5de2` advances
the deployment integration to migration 11; its existing 44 gates passed,
including static paper lifecycle, V2 convert, reorg and restart cases. A
positive V3 booking-to-dashboard fixture and a positive RangeKeeper
producer-to-worker booking/restart fixture still gate F2/F3. The owned-fork
RangeKeeper confirmation replay matched all ten stages; `3f2b04a` and
`dc00bd8` narrowly reconcile external proof fetch timestamps while preserving
the exact saved URL, raw response hash, oracle rounds, model and full booked
proof hash. These are source/replay checks, not HTTP action enablement.

**September 26 continuation checkpoint:** three Luna agents continue in
parallel at high reasoning effort, with independent ownership of static/manual
V3 conversion, RangeKeeper paper booking, and setup/release evidence. Root
coordinates shared PostgreSQL runs and dashboard integration.

`a022824` adds distinct V3 provisional converted-close accounting, exact
prestate gas/profile bindings, admission, worker replay and atomic terminal
booking. `875a21c` adds a separate canonical audit and maintenance path; V2
records retain their existing semantics. These implementations do not enable
the HTTP acceptance callback. Positive V3 booking, restart/reorg and shared
Positions evidence remain required before admission is enabled.

`2b6ae06` and `9d92c8f` add canonical runtime identity and independent-reference
checks to read-only live preflight. Live action and execution remain false.
`a3c3941` extends the Chromium dashboard regression with conversion review,
unknown-result same-key recovery, remount/retry and disabled-preview checks.
The September 26 browser run passed all 42 checks with no browser exceptions
or horizontal overflow in its desktop/mobile cases. Its command boundary is
mocked; it is not an accepted-operation or chain-economics proof.

The September 26 full isolated PostgreSQL integration suite passed migrations,
Research candidate storage, all 44 existing deployment gates, prospective
conversion gas import, legacy paper lifecycle and reference-evidence checks.
The suite includes the migration-11 fixture correction in `1e522f8`; it does
not include positive V3 or RangeKeeper booking. `c6e8d3b` adds an opt-in sealed
release mode to the real command/worker process harness. Source mode passed
authenticated profile/Positions reads, pause/resume, lease loss and worker
restart, with no chain RPC, economic marks, ledger entries or signer. Sealed
build/process verification is the next F5 gate and does not authorize unit
installation or production cutover.

`0ca3707` fixes an observed browser failure where detail refreshes discarded
pending action reviews. Matching campaign/revision/lifecycle/authentication
widgets retain their state; changed or ineligible identities drop it.
`7a13283` fixes terminal builders that rejected centered-width drafts, and
`55351c0` proves retain and convert use the frozen saved-open geometry with
both supported static/manual parameter forms. `cc9d6b6` adds the opt-in
`test:integration:dashboard-paper-lifecycle-browser` command: its September 26
run passed 14 assertions through actual authenticated HTTP, PostgreSQL, and
bounded paper-worker passes for draft/open/pause/resume/retain-close, followed
by closed-history desktop/mobile views. It recorded four operations and two
marks, left pause/resume economic rows unchanged, and found no duplicate work
after restart. Chain frames and anchors were synthetic; no signer loaded.
The separate Chromium dashboard regression passed 43 checks after the
conversion recovery fix in `76cf6c9`. These results do not prove canonical-RPC
economics or the still-gated V3 convert-close and RangeKeeper paths.

`382e24c` records the sealed review build and exact source identity in
`docs/reviews/sealed-paper-command-review-2026-09-26.md`. Build
`2b1b0c9a7c12b118a95a2037c17afc4aaa84e61da83a3ca28a8824bdacb015fe`
from `fd86568de891c51654954881dc4e3bd7430653cb` passed manifest verification,
rendered-unit validation and the opt-in sealed command/worker process harness.
This verified pause/resume, lease loss and restart, real Positions reads and
desktop/mobile stages with zero RPC calls, economic marks or ledger writes.
The review record pins the ignored research inputs required for the clean
806-test check. Later source changes are not included in this review artifact;
it is not a production cutover or full economic-lifecycle release gate.

The RangeKeeper positive fixture's measured failure was preview expiry:
first-report replay took 38 seconds, while repeated full reference-frame
reads during second-observation polling consumed the remaining budget.
Polling confirmed headers instead obtained the required 30-second source gap
in 30 seconds in an RPC-only diagnostic. The optimized booking/restart fixture
must still pass with the original freshness, canonical-source and expiry
rules. Do not relax those rules to admit expired evidence.

**September 26 recovery and timing follow-up:** `c06c070` persists the exact
pending retain-close and pause/resume acceptance payload before sending it.
Unknown acceptance outcomes survive remounts and retry with the same key;
known worker-unavailable and conflict responses clear that pending request.
Its four focused recovery checks passed. `eb9e004` keeps predecessor positions
without deployment metadata renderable in both public and operator views;
eight focused dashboard checks passed. The prior combined workspace check
passed 823 unit tests, repository checks and typecheck, but included unrelated
dirty research prerequisites and predates these latest changes.

`cb78a5e` and `41c263d` bound request-local RangeKeeper quote reuse to the exact
profile, client, source block/hash/timestamp, token, amount and reference prices.
Every cache hit still rechecks the canonical header; owned-fork simulation
does not use the quote cache. `de10b09` adds opt-in read diagnostics without
changing the serialized gas-report read-budget shape. One actual RPC-only
ten-stage confirmation run took 52.7 seconds and found 176 unique upstream
read signatures, including 144 immutable state reads, with no duplicate
immutable reads. Its one repeated header remains uncached. The positive
booking/restart fixture has not passed; no fork-value cache or relaxed expiry
follows from this diagnostic. Confirmation production, accepted worker replay,
both exits and shared UI parity remain F3 gates.

`e69208f` adds the opt-in `test:integration:static-paper-canonical-flow`
fixture. Its September 26 run passed canonical market-profile verification,
actual six-stage owned-fork gas sampling and replay-attested profile import,
authenticated loopback HTTP open admission, a spawned actual paper worker,
a later principal-only valuation in Positions, and retain-close completion.
The terminal stages were `paper_open_recorded` and
`paper_close_retain_recorded`; `gas_paid` rows remained zero, while fee capture
and paid gas remained unavailable. Deployment writes used a disposable schema.
The draft was seeded directly; this is not a single canonical setup-to-browser
flow, complete fee accounting, conversion proof or sealed economic-process gate.

`e443151` adds a sealed-mode continuation of this canonical open→retain harness.
It passed against verified artifact `eaa73f6` (build
`a78b2dc0137197afd86ae23ff180d3f8e8b51137b07f86cedbcb5f1de197b6b8`): source
profile verification, six-stage owned-fork gas sampling and provisional-profile
import ran in the test process, while the sealed `launch.mjs deployments` and
`deployments-paper-worker` processes served authenticated preview/admission and
Positions reads. Open, later principal-only valuation, and retain-close reached
`paper_open_recorded` and `paper_close_retain_recorded`; Positions showed closed
state and unavailable paid gas/fee capture. The paid gas ledger remained empty.
No signer, broadcast, or production schema was involved. This run still directly
seeded the draft; setup-preflight/draft-admission through authenticated HTTP,
convert-close, and clean-source sealed sampler provenance remain separate gates.

`f53a75d` binds setup admission to a bounded process-local server review cache.
The authenticated source harness then returned HTTP 201 from actual
`/api/deployments/setup-drafts` after setup-preflight calibration/import and
fresh source/profile/cost revalidation. Its reviewed/fresh gas quote drift had
fallen between requests; admission retained the cached reviewed bound after
matching non-price source, native-reference, stage-profile and gas-unit
identities. `b413195` and `bfc5bbb` require a valid, unexpired review token for
new browser submissions while preserving same-key recovery of an already
pending draft request after token expiry. Focused admission/cache/API tests
passed 13/13 and typecheck passed. The canonical run was on the shared, dirty
source checkout (based on `7d6f76a` at start), not a sealed artifact. It exited
at open-preview HTTP 409 before operation acceptance; the response body was
not captured. Log: `/tmp/conc-liq-static-setup-quote-20260926.log`. Setup draft
creation is therefore proven through authenticated source HTTP, while the
complete setup-to-open-to-retain browser flow remains pending. The harness now
logs the created campaign ID, config hash and source age before later phases.
The next attempt at source head `eb4a171` used the corrected single captured
frame for open-preview rebuild, but admission safely rejected before draft
creation because the fresh gas price rose from `28102000` to `28156000` wei,
above the captured quote, despite remaining below its displayed 25% price
buffer. Its exact six stage identities/units, source, native reference, and
independent price proof were unchanged. No review cap was widened. Log:
`/tmp/conc-liq-static-setup-final-20260926.log`. The canonical setup path now
needs a reviewed bounded-price policy or a server-owned quote snapshot that can
be revalidated without changing shown costs; open/retain through the corrected
fixture has not yet been rerun after this rejection.

`e8973a0` passed the isolated V3 database mechanics fixture: stale-digest
rejection, concurrent same-key admission, second-anchor failure with atomic
rollback, booking, restarted-store replay, shared Positions terminal projection,
and append-only reorg invalidation. Restoring the original source hash does not
revalidate revoked economics. The fixture uses injected synthetic verifiers;
actual canonical indexed fees, owned-fork/default-worker replay and HTTP action
enablement remain distinct gates. It also fixes nonexistent campaign-column
queries, the terminal model-hash binding and compatibility with both persisted
fee-range shapes.

`99e3794` keeps saved acceptance reconciliation reachable after lifecycle
changes remove fresh-action widgets. The operator-only panel resends only the
saved payload/key and never requests a preview. The browser lifecycle fixture
passed 16 assertions, including deliberately lost accepted pause and retain-close
responses, reload, same-key reconciliation after completion/closure, no duplicate
operations or terminal mark, and desktop/mobile closed-history views. Its chain
boundary remains synthetic. Thirteen focused recovery/rendering tests and
typecheck passed. The latest prior combined workspace check passed 825 unit
tests and the separate Chromium regression passed 43 checks; those runs predate
this recovery-panel commit and do not establish an exact clean release identity.

**Current source capability boundary, September 26:**

| Path | Available source behavior | Remaining acceptance boundary |
| --- | --- | --- |
| Static/manual paper setup, open, pause/resume, retain-close | Canonical browser lifecycle assertions passed on clean runtime `5b22ce5`, build `f75d6277…`. First-session capital, persisted lower bounds, one terminal mark and desktop/mobile chart/activity/history matched evidence. A post-success cleanup error and subsequent shared-helper repair are recorded as composite evidence. | Retain exact balances, earned fees and paid gas remain unavailable. Candidate acceptance is recorded in section 12; production cutover is not authorized. |
| Static/manual paper convert-close | Latest canonical browser setup/open/later valuation/convert-close passed on `5905b47` / `d507e6d…`, with one terminal mark/V3 snapshot, modeled capital-out records and desktop/mobile captures. Economic restart, changed-anchor rejection and canonical restore passed previously on `5b22ce5` / `f75d6277…` and retain that identity. | Costs and conversion outcomes remain provisional modeled evidence. Blocked recovery is visible in activity but its headline needs a narrow clarity follow-up. Production cutover is not authorized. |
| RangeKeeper paper | Planner/confirmation foundations and matching ten-stage owned-fork evidence; bounded fresh-state prefetch measured. The newer attempt reached producer-receipt publication and failed there; see section 12. | No successful producer/worker booking is recorded. Reliable freshness, producer publication, lifecycle/management, both terminal exits and shared closure parity remain F3 gates. |
| New live deployments | Read-only pool identity, independent reference, wallet nonce and custody-replay preflight foundations. | Intent/receipt execution, custody recovery, owned-fork stage gates and explicit activation authorization remain F4/F5 requirements; action and execution remain false. |
| Predecessor live/paper positions | Existing shared dashboard adapters and history remain readable; positions without deployment metadata render correctly. | Their runtime/history evidence retains its original provenance and capability limitations. |

The source-mode setup run at `1c9ef5f` did not complete retain-close: the
authenticated retain preview and operation acceptance returned successfully,
but the worker operation remained nonterminal through the harness's 300-second
wait. The run reached setup draft ID `d97dec51-2a2c-4f25-9c4c-11a365e9116f`,
open stage `paper_open_recorded`, and a later principal-only valuation. Its log
is `/tmp/conc-liq-static-setup-bound-20260926.log`; `finally` stopped the
processes and dropped the temporary schema. That run's harness did not preserve
the final operation row or worker log tail, so the retain failure reason and
attempt count are unknown. Source review identifies a possible delay, not a
confirmed cause: a transient non-domain exception returns `retry` while the
worker claim remains leased for up to 120 seconds, and each worker pass runs
maintenance before claiming operations. The worker claim/lease behavior was not
changed. The harness now records retain status, stage, reason, attempt count,
update time and a URL-redacted worker output tail on timeout. A complete
canonical setup-to-closed-Positions run remains pending.

`30b2cb9` and `fc2d7bb` add bounded, request-local code/storage read hints and
complete RangeKeeper booking-phase timing. Hints contain addresses/slots only;
values are freshly fetched at the selected source with four-request concurrency,
100 ms shared pacing, existing budgets and uncached pre/post canonical anchors.
The final-cap RPC comparison matched all ten stage and transaction hashes:
37.610 seconds without prefetch versus 18.036 seconds with fresh prefetch.
The next database attempt nevertheless expired at the first preview: initial
source age 10 seconds, first planning about 16 seconds, first cold fork 51
seconds, import 8 seconds and model replay 9 seconds left source age 94 seconds.
The 30-second second-observation wait ran concurrently with the first report.
No booking succeeded and no expiry was extended. Request preparation and
trusted same-process evidence reuse must pass their own gates before admission.

`eaa73f6` removes design-preview routes from the normal dashboard server and
excludes `dashboard/preview` and `dashboard/prototype` from sealed assets.
Source design files remain available for review and predecessor diagnostics
remain served. Eight focused dashboard checks passed. The preceding combined
workspace check passed 832 unit tests and typecheck; Chromium passed 43 checks
with a successful exit after the bounded cleanup fix in `a9904c0`. A clean
`a9904c0` checkout passed 828 unit tests, but its built artifact still included
design fixtures and was superseded before release review. The next acceptable
sealed artifact must include the design-directory exclusion.

Do not hold F1/F2 for the deferred historical candidate engine, saved Research
replay jobs, custom/off-center ranges, range or strategy switching, a new alert
center, or cosmetic redesign. Do not weaken the existing accounting, command,
custody, independent-reference, recovery or release gates to move faster.

## 12. September 26 MVP review and Sol delivery order

Review source: `f087abc`, 2026-09-26. The operator requested this handoff after
reviewing progress with the goal of reaching an MVP as soon as possible.
This section sets the current delivery priority; older progress records remain
historical evidence. Implementation, isolated acceptance, sealed-release review,
production cutover and live validation remain distinct statuses.

### Assessment and first operator MVP

The architecture and product direction are sound, but work has spread across
too many unfinished paths. Authentication, idempotency, exact accounting,
canonical evidence, independent references and restart recovery are necessary.
The immediate delivery risk is adding more preparation/replay machinery and
live foundations before completing the first usable operator workflow.

Finish **static/manual paper** as an independently reviewable first operator
MVP. Keep today's Research view, registered supported pools, centered-width
setup, open, pause/resume, close-retain, close-convert, and the existing shared
Positions metrics, charts, activity and history. Both exits remain in this
milestone. New RangeKeeper and live actions stay unavailable until their own
gates pass; predecessor positions and their operational tooling remain visible.
This sequences delivery without removing RangeKeeper or live from the accepted
product scope, and does not mark the two-strategy W2 package complete.

The milestone is a repeatable browser demonstration from setup through closure
using canonical data and the actual command/worker processes. Normal operation
must need no manually seeded draft, source/config edits, or service restart.
Explicit restart/disconnect recovery tests are separate fault-injection cases.
Modeled costs and fees remain provisional; unavailable economics remain visibly
unavailable. Statistical calibration sufficiency gates a validated claim, not
delivery of an explicitly provisional paper workflow.

### Evidence at review time

Fresh validation ran against the shared checkout at `f087abc`, including the
pre-existing dirty hybrid/adaptive files. It is not clean-release evidence.

| Check / path | Result and boundary |
| --- | --- |
| `npm run check` with repository Node | Repository checks and typecheck passed; unit tests were **876/877**. The single failure is the stale expected cost-label string at `test/dashboard-setup.test.ts:59`; the displayed text now distinguishes expected cost, reviewed admission cap and paid gas. Log: `/tmp/conc-liq-mvp-review-check-20260926.log`. |
| `npm run test:integration` with isolated PostgreSQL | Passed migrations through v11, deployment/accounting/recovery, conversion importer, lifecycle and reference checks. This suite does not establish the complete canonical browser lifecycle. Log: `/tmp/conc-liq-mvp-review-integration-20260926.log`. |
| `npm run test:integration:dashboard-paper-lifecycle-browser` | **16 checks passed**, including actual authenticated HTTP, database-backed setup/open/pause/resume/retain-close, lost-response same-key recovery and desktop/mobile closed history. Chain observations were synthetic and worker passes were in-process. Log: `/tmp/conc-liq-mvp-review-browser-20260926.log`. |
| Canonical static setup through retain-close | Previously recorded run created the draft through HTTP, completed open and later valuation, and accepted retain-close, but timed out after 300 seconds waiting for its worker. The earlier separately seeded canonical open/retain success does not close this gap. Log: `/tmp/conc-liq-static-setup-bound-20260926.log`. |
| Canonical V3 converted close | Recorded isolated HTTP/default-worker success, one terminal mark and provisional ledger, with no paid-cost claim. Actual browser and sealed-process conversion remain unproved. Evidence: `notes/paper-close-convert-v3-http-2026-09-26.json`. |
| RangeKeeper paper | The newer recorded attempt reached producer-receipt publication and returned `rangekeeper_confirmation_producer_receipt_unavailable`; its timing record showed source age 86 seconds. This supersedes expiry as the sole current diagnosis, but proves neither successful booking nor reliable timing. Log: `/tmp/rangekeeper-paper-booking-atomic-20260926.log`. Current worker rejects RangeKeeper operation kinds other than open; lifecycle, management and both exits remain unfinished. |
| New live deployments | Read-only identity/reference/nonce/custody foundations exist. Executable lifecycle, custody recovery and applicable live/release gates remain open. |

The canonical failures and successes above were inspected from recorded
evidence, not rerun during this review. No production migration, service change,
signer use or broadcast was performed.

### Ordered tasks for Sol

Start with MVP-1 and MVP-2. Keep changes scoped to a demonstrated blocker or an
acceptance criterion below. Record the exact source/build, result and remaining
boundary after each task; a growing test count is not milestone completion.

| Task | Concrete work | Acceptance / stop condition |
| --- | --- | --- |
| MVP-1 — Restore the check gate | Update the outdated setup-label expectation to the intended provisional-cost wording. Preserve the distinction between expected cost, reviewed bound and actual paid gas. | Focused setup tests and pinned `npm run check` pass. Record shared-checkout provenance; do not claim a clean release from dirty-source tests. |
| MVP-2 — Resolve canonical retain completion | Rerun the setup-to-retain harness with the newly added operation-row and redacted worker-tail diagnostics. Capture claim/status/stage/reason/attempts and phase timings. Determine whether delay comes from maintenance, lease retry, RPC, accounting or another failure, then fix the demonstrated cause. | Authenticated canonical setup, open, later valuation and retain-close complete through actual command/worker processes within the existing bounded test wait. Terminal operation and closed Positions projection agree; exactly one terminal mark is written. Preserve the failure evidence if it still fails. Do not merely lengthen the timeout or weaken freshness/accounting checks. |
| MVP-3 — Complete both browser exit paths | Extend/reuse the existing canonical harnesses to drive setup and operation acceptance through the real browser UI. Run one campaign through pause/resume and retain-close, and a separate campaign through convert-close. Use real canonical frames, supported references and owned-fork evidence. | No manually seeded draft or routine source/config edits/restarts. At desktop/mobile widths, pending stages, first-session values, available economics, explicit gaps, activity and closed history match persisted evidence. Both terminal inventories match their respective exit semantics. Preserve provisional labels and unavailable paid costs. |
| MVP-4 — Prove economic recovery | Exercise accepted static economic operations across a worker interruption/restart, including pending conversion; reuse the existing same-key lost-response and database recovery coverage. Add only missing tests for the actual process boundary. | Recovery completes the same operation without duplicate marks, ledger rows or completed conversion stages. Expired admission previews do not cause a fresh acceptance for already accepted work; changed canonical evidence blocks or invalidates rather than creating false success. Browser reconnect retrieves the persisted outcome. |
| MVP-5 — Review the static paper release | Build one clean, pinned artifact containing MVP-1 through MVP-4. Run the applicable section 8/W7 migration/restore, manifest/unit and desktop/mobile process gates against that artifact. Include server-owned setup/cost preparation and the actual command/worker code in the recorded runtime identity. Prepare the operator runbook and concrete cutover record. | Demonstrate both static/manual paper lifecycles on the exact reviewed build with canonical evidence. Clearly record what the harness supplies versus what the sealed runtime executes. No design fixtures in runtime assets. Report this as the static paper MVP only; F3/F4 and full W2 remain open. Production cutover requires the applicable existing authorization boundary and is not implied by a passing rehearsal. |
| NEXT-1 — Finish RangeKeeper paper | After the static paper MVP review, diagnose the producer-receipt failure at its exact failing stage before adding further caching/prefetch/overlap mechanisms. Complete confirmed-open booking, persisted kernel/management, pause/resume, both exits and shared UI parity under F3. | Positive owned-fork producer/default-worker booking and economic restart recovery pass under the existing freshness rules, followed by the same complete browser/release lifecycle gates. An optimized timing measurement or successful open alone does not complete F3. |
| NEXT-2 — Finish guarded live operations | After paper milestones, continue F4 using the existing intent/receipt journal, reservations, custody preflight and recovery. | Owned-fork stage/recovery and capability-specific release gates pass. Funding, signing, broadcast and activation remain subject to the established authorization boundaries. |

**MVP-2 diagnostic pointers:** `src/deployments-paper-worker.ts` runs maintenance
before claiming operations and defaults to a 60-second loop interval.
`src/deployments/paper-operation-worker.ts` returns a generic transient retry
without releasing the 120-second claim; `DeploymentStore.claimNext()` excludes
unexpired claims. These are confirmed source behaviors and possible delay
contributors, not a confirmed explanation of the recorded timeout. Preserve
lease ownership and exact-once completion if a fix changes retry scheduling.
Use bounded, credential-redacted diagnostics; a new queue framework or telemetry
platform is not needed to establish the cause.

### Scope discipline and completion reporting

- Defer further live-foundation expansion and RangeKeeper optimization until
  the static milestone is reviewed. Preserve completed work for those paths.
- Keep the deferred Research/candidate engine, custom ranges, strategy/range
  changes, alerts, generalized infrastructure, cosmetic redesign and broad
  refactors outside this MVP. Preserve unrelated dirty research work.
- Reuse current harnesses and the TypeScript/PostgreSQL modular monolith.
  Add an abstraction, cache or preparation stage only when a measured blocker
  on the next deliverable requires it. Do not begin a cleanup rewrite.
- Keep command authentication/CSRF, idempotency, canonical/reference checks,
  exact arithmetic, append-only accounting, restart recovery and shared
  dashboard parity. Missing evidence must not become zero or a paid/validated
  claim. Do not relax expiry to make a slow preparation path pass.
- Make the current capability table and this task list the concise status
  summary. Keep detailed historical runs as evidence, but do not make Sol
  reconstruct the current priority from earlier chronological next-action lists.
- Mark MVP-5 complete only after the operator demonstration and its applicable
  release evidence pass. Track each later capability separately; do not claim
  the entire Research/Positions implementation or live readiness is complete.

### Parallel implementation follow-up — September 26

| Task | Current result | Remaining gate |
| --- | --- | --- |
| MVP-1 | Source check gate restored; latest clean candidate `5905b47` passed repository/type checks and 882/882 tests, including setup reason preservation and concurrent-verifier integrity checks. | Preserve latest runtime build `d507e6d…`; earlier acceptance results retain their original build identities. |
| MVP-2 | Canonical retain lifecycle assertions passed on `f75d6277…`: setup/open/pause/resume/close, one terminal mark and desktop/mobile parity. Original command exited 1 only during Chromium profile cleanup; fix `2279e86` passed direct cleanup proof and the final conversion command. | Complete using explicitly composite evidence; retain lower-bound and paid-cost limitations remain. |
| MVP-3 | Both canonical browser exits demonstrated on sealed `f75d6277…` / source `5b22ce5`, including first-session capital, exact terminal semantics, explicit gaps and desktop/mobile history. Ordinary conversion+restore exited 0 with harness `2279e86`; retain caveat is above. | Complete for this candidate; blocked recovery is visible in activity but its headline still says Close in progress, a narrow UX follow-up. |
| MVP-4 | On `f75d6277…`, harness `3af131b` passed expired-preview same-key replay, restart in 16.085s with 236.7 MB physical reads, exactly-once V3 conversion and desktop/mobile parity. The later restore comparison failed separately on an unsafe JSON number. | Changed-anchor rejection passed: 18.853s restart, blocked operation, zero terminal conversion marks/ledger/V3 rows. MVP-4 is complete; retain the later restore failure separately under MVP-5. |
| MVP-5 | Clean `5b22ce5` produced verified candidate `f75d6277…`; only launcher/verifier bytes differ from prior `b78c3f22…`. Manifest and 13 rendered units passed offline review without installation. Runbook and unexecuted cutover proposal remain available. | September 27 follow-up `5905b47` / `d507e6d…` preserves specific unavailable reasons, passes 882 clean tests and one canonical setup-to-convert run. Only two setup modules changed; previous recovery/restore evidence keeps its original build identity. Historical unavailable cause remains unknown; do not claim universal availability. Production configuration, compatibility, custody/ownership, backup and authorization remain pending. |

The operator authorized proceeding with Luna agents in parallel. Three Luna
workstreams are assigned within the static/manual milestone: MVP-2 retain
completion diagnosis, MVP-3 canonical browser acceptance for both exits, and
MVP-1 plus MVP-4 actual-process recovery. RangeKeeper optimization and live
foundation work remain deferred under this delivery order.

MVP-1's stale setup-label assertion is corrected. The pinned shared-checkout
`npm run check` at base head `9398d40b381ca5a27fb62e8868d43fb0dc47334a`
passed repository validators, typecheck and **877/877** tests; focused setup
tests passed **4/4**. The checkout included the existing unrelated dirty
hybrid/adaptive research changes. This is source validation, not a clean sealed
release check.

The isolated PostgreSQL `npm run test:integration` passed again, including
migration v11, supported upgrade paths, deployment/accounting/recovery,
conversion importer, lifecycle and independent-reference checks. Log:
`/tmp/conc-liq-mvp-integration-20260926-followup.log`. Its synthetic/injected
chain boundaries do not establish the canonical browser milestone.

The MVP-2 diagnostic rerun again reached authenticated setup draft creation,
open completion and later canonical principal valuation. After retain
acceptance, read-only inspection showed `status=queued`, `stage=accepted`,
`attempts=0` and no claim lease. Therefore the generic transient retry lease
does not explain that observed waiting interval. The run timed out at the
original 300-second retain bound; the last worker messages were a completed
empty maintenance pass and successful open completion. No subsequent
maintenance completion was logged. This narrows the failure to work before the
next operation claim; the exact internal phase remains under diagnosis. No
freshness rule or timeout has been relaxed. Diagnostic log:
`/tmp/static-paper-canonical-flow-mvp2-20260926.log`.

The [static paper operator runbook](../operations/static-paper-mvp.md) now
records the ordinary UI workflow, same-key uncertainty recovery and the
required concrete release/cutover evidence. It does not establish MVP-5
completion or production authorization. Browser/recovery helpers under
development are not acceptance evidence until their actual canonical process
runs pass. Both exits, economic restart recovery and the new clean sealed
artifact remain open gates.

**MVP-2 cause and backend verification:** the opt-in timed rerun localized the
stall to `sample_fee_evidence` after `record_next_accounting` returned
`paper_accounting_fee_evidence_unavailable`. The worker's three-connection
indexer pool was fully held by the lifetime readiness lease, maintenance pass
lock and campaign preparation lease. Indexed fee replay then requested a fourth
connection and waited indefinitely. Increasing the bounded worker pool to four
preserves those locks, accounting rules and all existing freshness/timeout gates.
Diagnostic log: `/tmp/static-paper-canonical-flow-mvp2-diagnostics-20260926.log`.

The subsequent actual source command/worker run created its draft through
authenticated setup, completed open and later principal valuation, then
completed retain-close in approximately **16 seconds** after acceptance with
`attempts=1`, `stage=paper_close_retain_recorded`, exactly one terminal mark and
matching closed Positions API state. Paid gas and fee capture remained
unavailable. Log:
`/tmp/static-paper-canonical-flow-mvp2-setup-diagnostic-20260926.log`.
That harness exited unsuccessfully afterward because its browser verifier waited
for a Current row before selecting History; a closed-only campaign correctly
left Current empty. This proves the backend fix, not the complete browser gate.
The earlier actual-command setup failure at `pinned_setup_source_unavailable`
is preserved in `/tmp/static-paper-canonical-flow-mvp2-fixed-20260926.log`; it
did not recur in the subsequent run, and no canonicality rule was loosened.

The bounded worker/setup diagnostic hooks are opt-in and record stage timings
and safe error classes/codes. Focused worker/maintenance/setup tests passed
**17/17**, and the pinned shared-checkout `npm run check` passed again with
**877/877** tests, repository validation and typecheck. Logs:
`/tmp/conc-liq-mvp-focused-runtime.log` and
`/tmp/conc-liq-mvp-pool-fix-check-20260926.log`. A separate clean worktree at
`3563f87` passed **873/873** tests and repository/type checks; that earlier clean
commit excludes this later runtime fix and is not its release evidence.

The opt-in PostgreSQL dump/restore rehearsal passed on the completed V3
database fixture: one closed campaign, one succeeded conversion operation,
three marks, three ledger rows and three paper accounting snapshots matched
after restore, including model identities, sequences, constraints and indexes.
All eight append-only evidence guards rejected update/delete attempts. Restored
`public` stayed empty, the source evidence hash stayed unchanged, and temporary
database/archive cleanup was verified. This fixture uses injected synthetic
verifiers; its evidence class is
`synthetic_injected_verifier_database_mechanics`. It establishes restore
mechanics, not canonical browser, economic-process recovery or sealed-release
acceptance. Reproduce with `npm run test:integration:static-paper-restore` and
the isolated `TEST_DATABASE_URL`.

**MVP-3 conversion blocker:** the first ordinary actual-process browser run at
base `caabeb7` completed UI setup, open and later principal valuation, but the
convert preview remained indicative/unavailable for the unchanged 300-second
bound. No conversion was accepted. The worker reported `AssertionError` and
`paper_fee_marks_unavailable`; the exact assertion was not captured by the safe
worker summary. Preserved evidence:
`/tmp/conc-liq-review-evidence/canonical-convert-first-run.txt`.

Source review then identified a concrete chronology defect in queries that
select numeric evidence IDs as text and use an unqualified `ORDER BY id`.
PostgreSQL resolves that order to the output text alias: a read-only SQL
reproduction sorted IDs 9, 10 and 11 as 10, 11, 9; qualifying the numeric base
column sorted them as 9, 10, 11. Numeric ordering fixes and a real-store database
regression are committed as `492c6c2`. This is a demonstrated source defect, not yet proof
that it explains every reported canonical replay failure. The next ordinary
browser run must establish that the conversion evidence gates actually pass.

The [read-only cutover inventory](../reviews/static-paper-mvp-cutover-inventory-2026-09-26.md)
records the installed older sealed identities and production visibility gaps.
At its recorded snapshot, production `public` had migrations 1–3 and no
deployment campaign/operation/reservation relations, while current source has
11 migrations. Absent relations cannot establish empty campaigns or clear
reservations. Predecessor execution units were inactive, but only stale local
custody records were available. Fresh custody reconciliation and the concrete
production migration/service proposal remain separate outstanding cutover gates.

**Numeric chronology fix:** `492c6c2` qualifies the numeric base mark ID in
13 affected ordering sites. The dedicated real-store regression crosses IDs
9, 10 and 11 through valuation, fee sampling, trusted fee persistence and
accounting projection. It passed on the corrected source and failed on the
earlier clean source at `paper_fee_open_mark_unavailable`. Logs:
`/tmp/conc-liq-paper-mark-id-order-pass-20260926.log` and
`/tmp/conc-liq-paper-mark-id-order-baseline-20260926.log`. Its schema and separate
disposable database were removed; the earlier clean worktree was restored to
clean status. This test uses synthetic database evidence and real store methods.

The first UI retain run completed open and later valuation, then failed a
harness assumption that principal-only marks expose complete token balances.
They correctly expose `lowerBoundRaw` and leave `amountRaw` unavailable.
The corrected checks bind displayed lower bounds to the persisted mark/source
and preserve that distinction through retained closure. The narrow Starting
capital metric uses the existing persisted capital-in baseline for both
provisional and unavailable accounting states; missing baseline evidence stays
unavailable. Its focused dashboard checks passed **9/9**.

**Complete source retain browser gate:** the corrected run at base `492c6c2`
plus its recorded scoped browser/UI changes passed actual UI setup, open,
later canonical valuation, pause, resume and retain-close. Campaign
`97b33af7-ee3c-4517-a02f-7a612e631a28` completed terminal operation
`b7679cba-64c8-4c68-9af3-632862f00db4` with one retain mark, `attempts=1`
and zero paid-gas rows. First-session capital matched the persisted capital-in
ledger; lower bounds matched the persisted API source-block mark while exact
token amounts remained null. Desktop/mobile history, activity, charts, visible
values, gaps and overflow checks passed. Log:
`/tmp/static-paper-canonical-retain-browser-20260926.log`; base and dirty-source
inventory are recorded beside it. Screenshots:
`/tmp/static-paper-browser-evidence-20260926/97b33af7-ee3c-4517-a02f-7a612e631a28/`.
All fixture processes and its schema were removed. This completes the source
retain browser gate; conversion, economic restart recovery and the final sealed
artifact remain required.

**Conversion setup diagnostic boundary:** the subsequent ordinary converter
browser run stopped before draft creation. Its actual setup response was
`paper_cost_sample_replay_unverified` at source block `73188317`; it accepted
no operation. The existing setup verifier swallowed the underlying replay
exception, so a narrow opt-in invariant diagnostic is required before choosing
a fix or repeating the run. Evidence:
`/tmp/conc-liq-review-evidence/canonical-convert-next-run.txt` and the redacted
`canonical-convert-setup-unavailable.json` beside it. The browser helper now
reports a terminal unavailable setup response promptly instead of waiting for
an available response that cannot arise from that completed request.

The independent review also found numeric text-alias ordering in conversion
carry and accounting audit/invalidation queries. `1844927` qualifies those three
numeric base columns. Its real-store regression across mark IDs 8, 9, 10 and 11
passed: three adjacent fee intervals produced carry through the latest source,
and the canonical audit selected the earliest changed mark, then preserved its
invalidation on replay. The pre-fix test failed at
`paper_close_convert_fee_interval_binding_invalid`. Logs:
`/tmp/conc-liq-paper-mark-id-order-pass-extended-20260926.log` and
`/tmp/conc-liq-paper-mark-id-order-baseline-extended-20260926.log`.
These defects are concrete source issues; they do not establish the cause of the
new setup replay rejection. The process recovery harness now explicitly checks
one V3 accounting row on success, zero operation-scoped rows on anchor rejection,
and closes its local fault-injection proxy during cleanup. Those assertions and
helpers remain pending actual process acceptance.

**Post-fix database verification:** pinned `npm run test:integration` passed
again after `1844927` on a separate owned disposable database, including the
extended numeric-order regression. The updated synthetic V3 restore rehearsal
also passed with all eight enabled append-only triggers rejecting mutations;
one campaign/operation, three marks/ledger/accounting rows, ten model identities,
five sequences, 88 constraints and 35 indexes matched. Restored `public` was
empty, the source stayed unchanged, and target/archive/outer test database were
removed. Logs: `/tmp/checks-recovery-test-integration-20260926.log` and
`/tmp/checks-recovery-static-paper-restore-20260926.log`. This remains synthetic
database-mechanics evidence, separate from the pending canonical process gates.

**Clean scoped source gate:** `01ed824` commits the visible Starting capital
metric, canonical browser/process/recovery fixtures, restore helpers, safe setup
verifier diagnostics and the updated runbook/cutover inventory. Its detached
clean checkout passed pinned `npm run check`: repository validation, typecheck,
**875/875** tests, 85 suites. Log:
`/tmp/static-mvp-check-01ed824-20260926.log`. Unrelated dirty hybrid/adaptive
research remained outside this commit and worktree. No release was built yet.

**Current conversion boundary:** the fresh diagnostic run at base `1844927`
plus the recorded scoped changes succeeded at actual browser setup and open,
then saved a later valuation at block `73195481`. After a transient preparation
lease cleared, a fresh preview returned `static_manual_conversion_prestate_unavailable`.
Read-only failure evidence showed mark 2, its adjacent fee proof 1→2 and
accounting through mark 2; cursor complete-through `73195632` was later than
the saved endpoint, and `paperFeeSamplingState` returned null. Thus a missing
persisted interval or perpetually uncovered latest mark does not explain this
observed rejection. The swallowed conversion preparation error still needs its
safe phase/invariant diagnostic before a fix. Log:
`/tmp/conc-liq-review-evidence/canonical-convert-diagnostic-1844927.txt`.
No conversion was accepted. The earlier setup replay rejection did not recur;
its cause remains unconfirmed rather than silently treated as fixed.

**Exact transient fee-readiness rejection:** the same-parameter run at base
`01ed824` plus opt-in conversion diagnostics reached setup/open and a later
valuation, then reported stage `paper_conversion_prestate_fee_context` and
`paper_close_convert_fee_interval_gap`. At rejection, mark 2's endpoint was
`73198452`, complete indexed coverage was `73198440`, no adjacent fee proof
was persisted and accounting covered only open mark 1. A read-only replay of
that exact interval passed after the rejection as coverage advanced. Log:
`/tmp/conc-liq-review-evidence/canonical-convert-prestate-diagnostic-01ed824.txt`.
The next browser attempt will wait for the actual worker's persisted fee carry
before requesting another fresh preview, within the same original 300-second
preview deadline. It will not seed evidence, restart the worker, weaken coverage
or add a new runtime scheduler. This measured transient gap does not explain
the preceding run's separate preparation failure after persisted fees were ready;
later phases must still be diagnosed if that failure recurs.

**Measured conversion fixture sizing:** the next run at base `f91f2e7`
proved the bounded readiness retry worked: the actual worker persisted fee carry
and accounting through mark 3, block `73203445`, with two intervals. Its fresh
preview then reached `paper_conversion_prestate_owned_fork_sample` and rejected
with `paper_close_convert_prestate_sampler_share_cap_one_percent`. The saved
USDG-2000, half-width-40 candidate had liquidity `26869210494093019`, source
pool liquidity `685478250106834630` and diluted share **37,719 ppm (3.7719%)**,
above the sampler's **10,000 ppm (1%)** guard. The ordinary open sampler has
no equivalent standalone cap; open success therefore did not prove this
conversion input was supported. Log:
`/tmp/conc-liq-review-evidence/canonical-convert-fee-gap-retry-f91f2e7.txt`.
No conversion was accepted, and fixture cleanup completed.

The next converter fixture uses capital **2 USDG**, retaining half-width 40 and
all existing runtime limits. This is a measured correction to the test input,
not a relaxed conversion guard or a completed acceptance gate. The test driver
also uses a bounded monotonic diagnostic-event sequence to correlate only the
current failed request; rolling log-tail offsets cannot misclassify an older
failure. Unknown preparation errors stop, and no fresh preview is submitted
after the original 300-second deadline.

**Real default-worker predecessor gap:** the capital-2 run at `216ab25`
successfully opened with **39 ppm** diluted share, completed valuation and
persisted fee/V1 accounting through mark 2. Conversion preview became actionable,
but UI acceptance returned HTTP 409
`paper_close_convert_v3_prior_accounting_unavailable`. No close operation was
accepted. The store's V3 admission and terminal booking both require the
runtime-bound **V2** accounting snapshot at the exact latest mark and fee proof.
Regular maintenance returned immediately when **V1** caught up; it only entered
V2 projection after an unsupported legacy conversion terminal. Thus the actual
active worker did not create the predecessor that admission requires. Prior
isolated V3 rehearsals primed V2 directly and did not establish this worker
integration. Log:
`/tmp/conc-liq-review-evidence/canonical-convert-budget2-216ab25.txt`.

The necessary next fix is canonical V2 projection after V1 catches up, within
the existing shared preparation lease and step budget. A real-store maintenance
regression must prove that automatic path, and the browser must observe the
matching V2 predecessor before previewing inside its existing timeout. No test
may manually seed or prime the missing V2 snapshot to pass this gate.

**Candidate preparation, not acceptance:** clean `216ab25` passed pinned
repository/type checks and **875/875** tests again, then built verified candidate
`d278f44c4b738f97a1137cd7d666f341c7a1c654bad50346b608b72b061fb268`
under `/tmp/conc-liq-static-mvp-releases-20260926/`, Node `v24.20.0`.
Its own launcher and 14,486-file manifest verified; prototype/preview assets were
excluded. Thirteen owned service/timer files were rendered uninstalled and
`systemd-analyze verify` exited 0 (one host snapd `RestartMode` warning).
Logs: `/tmp/static-mvp-check-216ab25-20260926.log`,
`/tmp/static-mvp-release-build-216ab25-20260926.log` and
`/tmp/static-mvp-render-units-216ab25-20260926.log`.
The proposed private environment remains absent. This candidate predates the
newly measured V2 maintenance correction and is not the final MVP-5 artifact.

**Default-worker correction and regression:** ordinary maintenance now continues
from caught-up V1 into canonical V2 projection within the same shared preparation
lease and existing step budget. The V1 caught-up probe falls through in the same
iteration; it does not consume an extra projection step. Trusted V3 terminal
handling and all canonical audits remain unchanged. The focused orchestration
suite passed 3/3 and typecheck passed. More importantly, the real PostgreSQL
regression removed the former manually inserted V2 snapshots: a maxSteps=3 pass
wrote V1 marks 1,2 and V2 mark 1, then a maxSteps=2 resume wrote V2 mark 2 and
observed catch-up before successful V3 admission. Synthetic canonical anchors
remain explicit; this is default-maintenance/store integration evidence, not
the still-pending actual canonical browser conversion. Log:
`/tmp/paper-maintenance-v2-v3-admission-20260926.log`.

The browser now observes the exact latest V2 snapshot and fee binding before
each preview within the original 300-second deadline, checking schema, hash,
mark, runtime identity and invalidation state. Sealed identity is calculated
from the actual generated private environment and pinned manifest exactly as
the launcher calculates it. These read-only observations do not prime evidence
or replace acceptance checks.

The complete pinned integration suite passed again with this correction on an
owned disposable database. The V3 restore fixture also passed after automatic
maintenance generated its V1/V2 predecessors: five accounting rows, all eight
append-only guards enabled and tested, empty restored `public`, unchanged source,
and target/archive cleanup. Both outer databases were removed. Logs:
`/tmp/paper-maintenance-v2-full-integration-20260926.log` and
`/tmp/paper-maintenance-v2-v3-restore-20260926.log`. Restore remains synthetic
database-mechanics evidence; canonical economic restart and restore are still
separate MVP-4/MVP-5 gates.

**Actual source conversion passed:** base `216ab25` plus the frozen recorded
maintenance/browser changes subsequently committed in `e88a3a5` completed the
real authenticated UI setup/open/later valuation/close-convert workflow.
Campaign `8c07d29f-52eb-4c87-bfa2-9cc1a1aa4ee7`, conversion operation
`333e28f8-7879-42a8-ac06-c15ef8945dbd`, stage
`paper_close_convert_v3_reconciled`: exactly one terminal mark, three modeled
ledger rows and zero paid-gas rows. Before preview, the real worker's latest
V2 snapshot at mark 4 matched fee evidence 3 through block `73213095`.
Closed inventory used the V3 accounting snapshot: USDG `1990523`, AAPL `0`,
native `9999964274105428000` wei, all provisional modeled conversion inventory.
Desktop 1440 and mobile 390 screenshots were inspected for closed activity,
chart/economic gaps and provisional cost labels. The initial value includes the
explicit 10-native allocation as well as the 2-USDG token budget; it is not a
claim that 2 USDG alone funded that modeled portfolio. No signer or broadcast.
Command/worker processes exited and the disposable schema was cleaned.
Log: `/tmp/conc-liq-review-evidence/canonical-convert-v2-runtime-216ab25-plus-dirty.txt`;
exact provenance: `canonical-convert-budget2-v2-provenance.txt` in that directory;
screenshots: `/tmp/static-paper-browser-evidence-20260926/8c07d29f-52eb-4c87-bfa2-9cc1a1aa4ee7/`.
This closes the source conversion diagnosis, not the sealed MVP-4/MVP-5 gates.

**Final-candidate preparation:** `eb118ea` removed the renderer's ineffective
inherited worker flag and documented its required location in the hashed
private environment. The clean check correctly stopped on the changed script
registry hash/length; `609e68f` deliberately refreshed that exact provenance
entry after `1c4889e` clarified the worker template comment. The clean check and
new candidate build now target `609e68f`. No production environment file,
migration, service installation or activation has occurred.

**Final clean candidate built:** clean detached `609e68feb95afd32ed3dd6df0ce0ec3ba15e9575`
passed pinned `npm run check`, **876/876** tests, 85 suites. Build
`b78c3f22bd0ffa11f5bf7f72cbcd0388464a65aac4b4f3c0d2e2af80d94dc9f3`
under `/tmp/conc-liq-static-mvp-releases-20260926/` passed its own pinned
Node `v24.20.0` launcher verification; prototype/preview assets were excluded.
Thirteen unit files were rendered without installation and
`systemd-analyze verify` exited 0, with only the existing host snapd warning.
The proposed private environment remains absent. Logs:
`/tmp/static-mvp-check-609e68f-20260926.log`,
`/tmp/static-mvp-release-build-609e68f-20260926.log`,
`/tmp/static-mvp-render-units-609e68f-20260926.log`.
Both ordinary sealed browser exits subsequently passed on this exact build.
Positive economic restart plus canonical restore and changed-anchor rejection
are being run serially; MVP-4/MVP-5 remain open until those process gates pass.

**Sealed retain browser passed on the final candidate:** build `b78c3f22…`
completed actual authenticated UI setup/open/later valuation/pause/resume/retain
for campaign `c3f8e9b5-519d-487a-aa46-2d0a0078e8dc`. Retain operation
`fa8ccea8-168b-41fb-9cce-42228d965834` succeeded on attempt 1 at
`paper_close_retain_recorded`, with one terminal mark and zero paid-gas rows.
First-session initial quote `26915017892` includes the explicit native allocation;
recorded principal remains lower bounds with unknown complete custody/costs.
Desktop 1440/mobile 390 history, all four operation stages, chart gaps and
unavailable final economics were checked against persisted evidence and visually
inspected. Actual command/worker both ran the verified sealed launcher; all
processes and disposable inputs were cleaned before handing off the shared DB
slot. Log: `/tmp/static-paper-retain-browser-609e68f-sealed-20260926.log`;
screenshots: `/tmp/static-paper-browser-evidence-609e68f-retain-20260926/c3f8e9b5-519d-487a-aa46-2d0a0078e8dc/`.

**Independent harness critique:** both sealed runners now require the expected
source commit, rather than accepting any self-verifying supplied release. The
actual retained run already supplied the correct pin. Conversion assertions now
inspect each of the three capital-out ledger records, modeled raw/value metadata,
asset/entry key, null settled columns, snapshot/model/quote bindings and native
inventory. Terminal mark inventory is checked against its saved post-withdrawal
model, while the final post-conversion dashboard inventory is checked against the
V3 snapshot; these deliberately different semantics are not conflated. Prior
fee evidence in mark provenance and the new terminal fee-evidence row are also
checked separately. These are external test-driver changes after the runtime
artifact was sealed; its `609e68f` identity is unchanged. Preserve the external
harness commit and artifact identity separately for the remaining process runs.

**Sealed ordinary conversion passed:** runtime build `b78c3f22…` / source
`609e68f`, external strengthened harness `633566a`, campaign
`950e046e-2c9b-4a15-b0fb-c5cc7c191ff2`, conversion operation
`6462e863-015f-4c57-9a33-6e68a465d900`: succeeded at
`paper_close_convert_v3_reconciled`, one terminal mark, one V3 snapshot,
three exactly matched modeled capital-out ledger rows and zero paid-gas rows.
Pre-conversion terminal mark/model binding and post-conversion V3 projection
were independently checked. Final modeled inventory: USDG `1991738`, AAPL `0`,
native `9999963924950024000` wei. Desktop 1440/mobile 390 closed history,
modeled conversion values/costs and gaps passed and were visually inspected.
Command/worker exited and disposable schema/runtime directory were cleaned.
Log: `/tmp/conc-liq-review-evidence/canonical-convert-sealed-609e68f-633566a-20260926.txt`;
screenshots: `/tmp/static-paper-browser-evidence-609e68f-convert-20260926/950e046e-2c9b-4a15-b0fb-c5cc7c191ff2/`.
Both ordinary sealed exits now satisfy MVP-3. Positive interruption/restart with
restore and the changed-anchor negative case remain open.

**First sealed recovery attempt did not pass:** campaign
`5c0c502a-7a80-40e8-806f-4dee46b58b81` reached matching V2/fee readiness and
worker suspension, then the helper timed out looking for the first generic
`.retain-action-status` to contain the lost-response notice. The failure page
already showed the conversion in progress/accepted/queued and the saved-request
reconciliation banner. The generic selector can read a different action's
status, and polling removes action controls once the campaign is closing.
This is a transient UI-observation problem; expiry, kill/restart and restore
were not reached and are not claimed. Log:
`/tmp/conc-liq-review-evidence/canonical-convert-recovery-sealed-609e68f-633566a-20260926.txt`.
The external helper will require proof that the real 202 response was dropped
and the durable campaign/kind-specific saved-request reconciliation control,
then rerun the entire positive gate. Runtime artifact and evidence limits remain
unchanged. Failure cleanup completed before any retry.

**Second sealed recovery attempt remains partial:** external harness `cfa74c5`
proved the actual accepted-202 response drop and visible saved-request control,
then natural expiry at `2026-09-26T16:33:43.812Z`, SIGKILL and release of the
worker readiness lease for campaign `48632379-068a-47a4-a9d1-0a3cee55d17b`.
It stopped before restart waiting for the operation ID in the reconciliation
banner. The UI clears that banner after response handling and refreshes Positions;
the failure page showed the persisted queued conversion instead. The server
already performs read-only same-key replay before readiness/preparation checks.
The next external assertion will capture the real replay HTTP response, require
202, the original operation ID and `replayed:true`, preserve exact request/key,
and check durable refreshed pending state. Restart, economic completion and
restore are still unproved. Log:
`/tmp/conc-liq-review-evidence/canonical-convert-recovery-sealed-609e68f-cfa74c-20260926.txt`.
All disposable inputs/processes were cleaned before retry.

**Third sealed recovery attempt proved reconciliation, not restart:** campaign
`9b6d9434-b21e-4fba-970e-afbae555ac9b` reached SIGSTOP, accepted-202 response
loss, natural preview expiry (`2026-09-26T16:42:49.462Z`), SIGKILL and lease
release. The reloaded browser submitted the exact saved request and received
HTTP 202 for original operation `62f4de50-bab6-4f64-a054-4d2886277f7e`, queued,
`replayed:true`, with preview expired and readiness false. Restart then timed
out at its existing 30-second readiness bound with an empty new-worker log.
Terminal economic completion and restore were not reached. Log:
`/tmp/conc-liq-review-evidence/canonical-convert-recovery-sealed-609e68f-2d8a8f-20260926.txt`.

An independent empty-schema reproduction in the shared DB, serialized with no
other fixture worker, on the exact sealed artifact passed:
initial readiness 2.434s, proven SIGSTOP/retained lease, SIGKILL/released lease,
same-file relaunch readiness 2.122s, two actual worker pass logs and no stderr
or child errors. Owned schema/runtime inputs were removed. Evidence:
`/tmp/sealed-worker-restart-diagnostic-609e68f-20260926.json`.
The separately owned random-database reproduction also passed: initial
readiness 1.622s, same suspension/kill/lease checks, relaunch readiness 1.820s,
two worker passes, no stderr/errors and a clean SIGTERM exit. The owned database,
runtime directory and script were removed. Evidence:
`/tmp/sealed-worker-restart-diagnostic-owned-db-609e68f-20260926.json`.
These isolated empty-schema and owned-database runs demonstrate successful
same-file sealed restarts; they do not explain the canonical-campaign timeout.
Advisory contention was not established. Its cause remains unconfirmed. The
external driver will capture PID/exit/error/process-state and startup timing
without secrets before rerunning, keeping the 30-second bound and unchanged
runtime artifact. MVP-4 and canonical restore remain open.


**Fourth sealed recovery attempt captured startup evidence:** external harness
`15eaf52` on the unchanged `609e68f` / `b78c3f22…` artifact again proved
accepted-response loss, natural preview expiry, actual worker kill/lease release,
and HTTP 202 reconciliation of the exact original request and operation.
Campaign `aa4ca46f-89f4-4776-b324-b23a19236d11`, operation
`324808e3-5110-4b09-8bf5-4aca41019387`, remained queued. Restart PID
308923 had no spawn error or recorded exit, zero stdout/stderr, and process
state `R` / wait channel `wait_on_page_bit_common` at the unchanged 30-second
readiness deadline. The environment file SHA and runtime identity matched the
initial worker; no readiness lock holder was present and diagnostic SQL passed.
This localizes the failure before readiness acquisition but does not establish
its cause. Processes, owned schema and temporary inputs were cleaned. Log:
`/tmp/conc-liq-review-evidence/canonical-convert-recovery-sealed-609e68f-15eaf5-20260926.txt`.
Recovery, canonical restore and changed-anchor rejection remain open. Diagnose
the measured startup boundary before repeating the same full fixture; preserve
the existing timeout, sealed verification and economic evidence gates.


**Fifth diagnostic attempt stopped before restart:** frozen external harness
`1c0f4ff` on the same sealed artifact measured initial readiness at 1.762s:
285,853,359 read characters, 1,773,568 physical read bytes and 15,532 read
syscalls. Campaign `0a293d8e-b181-40f7-8081-68aa63204418` reached open,
later valuation and fee/V2 readiness. After worker suspension, the browser
showed a saved conversion request awaiting reconciliation, but the fixture
timed out waiting for its explicit actual-202 response-loss flag. It did not
capture the HTTP outcome or durable conversion operation before cleanup, so
this attempt proves neither acceptance nor restart behavior. Log:
`/tmp/conc-liq-review-evidence/canonical-convert-recovery-sealed-609e68f-1c0f4f-20260926.txt`.
The external driver must preserve safe HTTP/error observations and bounded
campaign-operation rows on this failure path before another run. Recovery,
canonical restore and changed-anchor rejection remain open.

The worker unit is `Type=simple`, with no readiness notification or explicit
start deadline. Service `active` is insufficient evidence of the DB lease.
The fixture's 30-second readiness bound is a test gate, not a documented
production start SLA. Read-only cgroup snapshots found no memory limit/OOM
event for the fifth run; aggregate resource counters do not establish or
exclude a transient host/filesystem cause for the earlier restart stall.


### Requested checkpoint — September 26, after sixth recovery run

The operator asked to stop at the next checkpoint. The sixth bounded run is
complete; no further fixture or runtime change is being started. Three Luna
workstreams supplied implementation, canonical browser execution and independent
review. MVP-1 through MVP-3 passed on the same clean runtime `609e68f`, sealed
build `b78c3f22…`. MVP-4 and MVP-5 remain incomplete.

Frozen external harness `512e6a1` created campaign
`65d402dc-84a0-40c6-8da9-a1a404367bbc` and conversion operation
`7e3704d4-647d-48f8-985d-4f76de26ef6c`. It proved actual HTTP 202 response
loss, natural preview expiry, SIGKILL/readiness-lease release, and browser
reconnection returning the original operation with HTTP 202 / `replayed:true`
while readiness was false. The failure-time database contained exactly one
conversion, queued/accepted, attempts 0; economic completion was not reached.

The paired startup measurement narrows the failure: initial readiness took
1.761s with 285,853,410 read characters and zero physical read bytes. Restart
PID 312634 exceeded the unchanged 30-second bound (30.178s), with no output,
no recorded spawn/exit error and no readiness lock holder. Its proc ring
recorded changing artifact-relative files including dependency source maps and
type definitions, repeated `D` / `wait_on_page_bit_common` samples and rising
physical reads. At timeout it had 283,254,464 read characters, 213,606,400
physical read bytes and 14,983 read syscalls (not distinct-file count).
The launcher synchronously verifies all artifact bytes before entry import;
the sampled non-runtime files identify this verification scan as a measured
startup bottleneck. The underlying host/storage reason remains unestablished.
This explains the sixth readiness failure more specifically than generic lease
contention; it does not prove the causes of earlier failures or a production SLA.
Log: `/tmp/conc-liq-review-evidence/canonical-convert-recovery-sealed-609e68f-512e6a-20260926.txt`.

Assessment: isolated tests and ordinary terminal flows were insufficient to
establish economic restart readiness. Preserve the passing runtime and all
failed evidence. The next proposed step is a narrow review of bounded,
integrity-preserving release verification; do not bypass verification, warm
caches to manufacture acceptance, or merely extend the test deadline. Any
runtime change needs focused integrity checks, a new clean pinned artifact and
applicable ordinary/recovery/restore/negative process gates. No optimization
is implemented at this checkpoint. Canonical interrupted-campaign restore and
changed-anchor rejection were not reached; synthetic restore is separate
mechanics evidence. RangeKeeper, live operations and full W2 remain deferred.
Production migration, profile registration, service changes and activation
remain unexecuted and outside this rehearsal.

Root independently confirmed checkpoint cleanup with read-only catalog/process
checks: no canonical conversion fixture schemas, owned restore databases,
operation-readiness lock holders or temporary conversion runtime directories;
both sixth-run worker PIDs are absent. The proposed production private
environment file remains absent. No further process work is active.

### Resumed Luna orchestration — September 26

The operator subsequently requested development through parallel Luna agents.
The remaining work is limited to MVP-4/MVP-5: one agent implemented the
bounded concurrent startup verifier, one owns serialized canonical recovery
acceptance, and one independently reviews integrity and release evidence.
Root integrates scoped commits and preserves unrelated dirty research work.

The current candidate and gate results are recorded in
[the f75d6277 acceptance record](../reviews/static-paper-mvp-acceptance-f75d6277-2026-09-26.md).
Runtime commit `5b22ce5` changes launch-time verification only; harness commit
`3af131b` prevents the test from retaining a suspension while runtime database
transactions remain open. The first new attempt's HTTP 500 preceded restart;
its cause is unconfirmed, and no failed evidence has been replaced or relabeled.
Both integrity checks and the existing time/economic boundaries remain intact.

Harness `6ba12dc` corrected lossless PostgreSQL numeric comparison; `2279e86`
corrected bounded browser teardown and cleanup error reporting. The final
ordinary conversion plus actual canonical campaign restore exited zero. The
retain command's post-success cleanup failure is preserved and accepted only
as composite evidence with direct cleanup proof and the final shared-helper
run. See the linked record for exact identities, counts and limitations.

Assessment: the MVP is on the right path. Stop feature expansion at this
static/manual paper candidate. Next diagnose the extra attempt's setup source
mismatch with redacted initial-preview/source evidence, then move to operator
review and the concrete production cutover prerequisites. Do not weaken the
identity check or repeat full campaigns to conceal the failure. Keep the blocked-recovery headline correction
as a small UX follow-up. No framework, queue rewrite, cache or dependency-pruning
project is needed to deliver this milestone.

Do not expand RangeKeeper, live execution, Research replay or infrastructure
before the static paper operator milestone. Production migration, registration,
service installation and activation remain separate from disposable paper acceptance.


### September 27 — setup-preflight reason preservation

The scoped investigation reproduced diagnostic masking: an unavailable pinned
preflight with `source:null` lost its specific missing reason and was reported
as a generic source mismatch. Runtime `5905b47` preserves only allowlisted
reasons on explicitly unavailable, null-source results. Genuine anchor changes,
malformed results, freshness limits and all admission checks remain fail-closed;
no retry or new source selection was introduced.

The clean `d507e6d…` artifact passed 882 tests and one actual canonical browser
setup/open/later-valuation/convert run (exit zero), with desktop/mobile captures.
The first invocation failed its argument guard before any runtime/fixture
started and is recorded separately. Independent manifest comparison found
exactly two changed setup-preparation JavaScript files; launcher, accounting,
worker and browser assets are unchanged. Full evidence and the original
failure's retrospective limits are in the
[setup-preflight follow-up](../reviews/static-paper-setup-preflight-reasons-2026-09-27.md).

The diagnostic repair is complete. Proceed to operator review and the existing
concrete cutover prerequisites, keeping all production actions pending their
exact authorization. Preserve the blocked-recovery headline as a narrow UX
follow-up. No new architecture or repeated green-run campaign is needed.
