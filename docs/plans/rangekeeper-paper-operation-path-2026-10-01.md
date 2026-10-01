# RangeKeeper paper operation path — scope, October 1, 2026

## Current status — October 1, 2026

The RangeKeeper paper setup, open, observation, and retained-close source paths
are implemented. The full test suite passes 1,048 tests, and SQL integration
for retained close/replay is green. Canonical-source setup, opening, and
observations have passed in some runs; the complete canonical lifecycle through
retained NFT close and recovery is still pending. Confirmation now reuses its verified owned-fork result for gas evidence and
overlaps fresh fork prefetching with planning. Earlier swapped-entry attempts
failed the unchanged 90-second guard; diagnostics confirmed preview expiry.
The lifecycle fixture now waits for the required confirmed-chain timestamp,
rather than wall time. Retained-NFT/slippage fixes still need the complete
end-to-end lifecycle proof.

The dashboard command-browser integration passes 20 checks with zero browser
exceptions, including the RangeKeeper setup-review/admission body. Its
RangeKeeper source and cost evidence are explicitly synthetic fixtures: this
proves the browser session, CSRF, UI binding, and command route contract, not
canonical chain behavior or economics. Keep this evidence separate from the
canonical setup/open/observation runs and the outstanding full-lifecycle gate.

Do not describe this as a completed or managed RangeKeeper lifecycle, and do not
claim a sealed release or production deployment. The initial open/exit gap
analysis below is preserved as a dated historical source snapshot; claims about missing routes
and unreachable paths describe that earlier snapshot and are superseded by the
current status above. The follow-up recenter plan remains separate work.

Commissioned to scope the RangeKeeper **exit** operation path, after
`rangekeeper-dashboard-integration-2026-09-30.md` §2a was corrected: a campaign
is uncloseable because no exit operation path exists, not because of the
`simulate` stub that section blamed.

Tracing the static chain to compare against produced a larger finding, which
changes the order of the work.

## Historical source snapshot — initial gap analysis

The findings below record the source state observed when this plan was first
written. They are retained to explain the original implementation sequence;
they are not a statement of current source status.

### Initial headline: no RangeKeeper operation could be accepted

Not the exit — **any** operation, open included. Verified by reading, not
inferred.

`DeploymentStore.acceptOperation` (`store.ts:2890`) is strategy-agnostic on its
own: with no `staticPaperAdmission` argument it validates the preview, checks for
a pending operation and the lifecycle, then inserts into
`deployment_operations` (`store.ts:3188`) without ever looking at
`strategy_id`. But every wrapper passes an admission discriminator, and the
discriminators hardcode the strategy:

- `acceptStaticPaperOpenOperation` (`store.ts:2881`) → admission `kind:'open'`,
  which requires `campaign.strategy_id==='static_manual_v1'` or throws
  `paper_open_admission_unavailable`.
- `acceptStaticPaperRetainOperation` (`store.ts:2876`) → admission
  `kind:'close_retain'`, same check at `store.ts:3048-3050`, throwing
  `paper_close_retain_admission_unavailable`.
- `acceptStaticPaperLifecycleOperation` (`store.ts:2886`) → `kind:'lifecycle'`,
  pause/resume only.

Those three plus `createStaticPaperCloseConvertAcceptance` are the only
acceptances that exist. The bare `acceptOperation` is declared on the command
server's store interface (`server.ts:50`) but **no route calls it** — the four
accept routes (`/operations`, `/lifecycle-operations`, `/open-operations`,
`/close-convert-operations`) each call a static-only acceptance.

So a `rangekeeper_v1` campaign cannot have an operation admitted by any route.

### The open preview never becomes actionable either

The dashboard's actionability test requires the preview result to carry
`trustedPreviewSaved===true` (`server.ts:370-418`), which is what binds a
persisted `deployment_previews` row that acceptance then re-validates.

The RangeKeeper open preview returns early. `deployments.ts:415-426` branches on
`draft.strategyId==='rangekeeper_v1'` and returns
`readCanonicalRangeKeeperPaperOpenModel(...)` directly — **before** the static
path reaches `persistTrustedPaperOpenPreview` and sets
`trustedPreviewSaved:true` at `deployments.ts:461-463`. No trusted preview row
is written, so the actionability test cannot fire even if an acceptance existed.

### The confirmation producer is not wired into production

`createRangeKeeperPaperConfirmationProducer`
(`rangekeeper-paper-confirmation-producer.ts:65`) is the thing that would run the
owned-fork confirmation and call
`store.persistRangeKeeperPaperConfirmationWithProducerReceipt`. Its only callers
are four test files. Nothing under `src/` constructs it.

### How the built machinery has been exercised without any of this

`test/integration/rangekeeper-paper-booking.mjs:415` creates its operation with a
direct `INSERT INTO deployment_operations`. That is how 18 modules of open
confirmation, the worker branch and the booking path have been tested green
while remaining unreachable from the product. It is consistent with the zero
`paper_rangekeeper%` rows in `deployment_calibration_profiles` recorded in the
integration plan's §2d.

**So the exit path is not a bolt-on to a working open path. The open path's last
two links are missing too.**

## 1. The static chain, for comparison

What a static close-retain actually traverses:

| Link | Where | What it does |
| --- | --- | --- |
| Preview | `deployments.ts:358` `persistTrustedStaticPaperRetainPreview` | Builds the retain model from the saved open mark, a fresh canonical frame, gas profiles and gas price; persists a trusted preview row. |
| Actionability | `server.ts:413` | Requires a saved preview, a ready worker and an available acceptance before the dashboard offers the action. |
| Acceptance | `store.ts:2876` → `acceptOperation` admission `close_retain` | Re-validates the preview digest, strategy, lifecycle and model, refuses a pending operation, inserts the operation, notifies the worker, moves the campaign to `closing`. |
| Worker claim | `paper-operation-worker.ts:146` | Claims by mode and strategy. |
| Worker source | `paper-operation-worker.ts:59-74` `sourceFor` | Parses the saved model per kind to recover its canonical source. |
| Worker completion | `paper-operation-worker.ts:235` `completeTrustedPaperCloseRetain` (`store.ts:5065`) | Re-verifies anchors and books the close. |

Close-convert adds a whole prestate stage on top (`deployments.ts:300-337`), with
its own report, replay hashes and gas scope — plus the terminal V3 envelope the
worker verifies at `paper-operation-worker.ts:237-250`.

## 2. What RangeKeeper already has

Substantial, and more than the gap suggests:

| Capability | Where | State |
| --- | --- | --- |
| Exit context load | `store.ts:1818` `rangeKeeperPaperExitContextSnapshot`, `rangekeeper-paper-context.ts` | Built. |
| Exit model builder | `rangekeeper-paper-exit-model.ts` | Built; read-only by contract — see §3. |
| Convert quote contract | `rangekeeper-paper-exit-model.ts:40-61` | Built 2026-10-01, hash-bound. |
| Retain exit gas sampler | `rangekeeper-paper-gas-sampler.ts` | Built. |
| Convert exit gas sampler | `sampleRangeKeeperPaperConvertExit` | Built 2026-10-01; no live fork run yet. |
| Terminal inventory identity | `rangekeeper-paper-gas-sampler.ts:126` `terminalInventoryHash` | Built. |
| Mark recording | `store.ts:1673` `recordRangeKeeperPaperMark` | Built. |
| Open confirmation + booking | 18 modules; `store.ts:1358` `completeRangeKeeperPaperConfirmedOpen` | Built, reachable only by direct SQL. |
| Worker open branch | `paper-operation-worker.ts:169-172` | Built. |
| Setup preflight + admission + routes | `rangekeeper-paper-setup-preflight.ts`, `-draft-admission.ts`, `server.ts` | Built and routed 2026-10-01. A draft can be created. |

## 3. The gaps, with anchors

**A. No trusted preview for either RangeKeeper preview kind.** Open returns
early at `deployments.ts:423`; the exit model returns a plain model with no
persistence. Both need the equivalent of
`persistTrustedPaperOpenPreview`/`persistTrustedStaticPaperRetainPreview`: a
`deployment_previews` row whose canonical digest acceptance can re-derive.

**B. No acceptance admits `rangekeeper_v1`.** Needs either a RangeKeeper
admission discriminator alongside the static ones in `acceptOperation`, or a
separate acceptance that reuses the generic path. The static discriminators each
re-parse their own model schema and re-check profile/config integrity; a
RangeKeeper one has to do the same against its own models.

**C. The exit model cannot carry an action, by type.**
`RangeKeeperPaperExitModel.actionAvailable` is declared as the literal `false`
(`rangekeeper-paper-exit-model.ts:82,106`), and its blocking reason is
`rangekeeper_operator_terminal_request_read_only`. Widening that is a contract
change, not a flag flip, and every consumer of the type is affected.

**D. The worker handles only open.** `paper-operation-worker.ts:170` blocks any
other kind for `rangekeeper_v1`. Needs exit branches plus `sourceFor` support
for the RangeKeeper exit models, which `sourceFor` (`:59-74`) currently parses
only as static open/retain/convert shapes.

**E. No exit completion or booking.** The open side has
`completeRangeKeeperPaperConfirmedOpen` (`store.ts:1358`); there is no exit
counterpart to book the withdraw, the optional conversion and the final mark.

**F. The confirmation producer is unwired** (§0), so even the open path has no
production runner.

**G. No dashboard exit controls for RangeKeeper.** `dashboard/app.js:47` gates
every lifecycle, retain and convert control on
`strategyId==='static_manual_v1'`.

## 4. Recommended order, and why it is not the exit first

**The open acceptance path must come first.** Three reasons:

1. It is the smaller half. The confirmation, provenance, replay-verifier,
   persistence and booking modules all exist; what is missing is the trusted
   preview, the acceptance and the producer wiring — gaps A, B and F.
2. An exit cannot be tested without an opened campaign. Building the exit first
   produces another module that cannot run, which is the pattern that has
   already cost this project the band re-key and the inert setup preflight.
3. Gap C, D and E all have an open-side analogue to mirror. Mirroring an
   untested path is how the static open's sizing bug was reproduced in the first
   RangeKeeper draft.

Proposed sequence:

1. **Persist a trusted RangeKeeper open preview** (gap A, open half) and wire the
   confirmation producer (gap F).
2. **Add a RangeKeeper open admission** (gap B, open half), then take one live
   open through the dashboard. This is also what first exercises the preflight's
   fork sampling against a real chain.
3. **Widen the exit model contract** (gap C) and persist a trusted exit preview
   (gap A, exit half).
4. **Add the retain exit admission, worker branch and completion** (gaps B, D, E
   for retain only).
5. **Add convert**, which additionally needs the persisted conversion quote
   carried through acceptance into the worker, and whose sampler still has no
   live fork run.
6. **Dashboard exit controls** (gap G), last.

## 5. Decisions needed before starting

- **Is a shared admission worth it, or a parallel one?** The static
  discriminators are already a long `if` chain inside `acceptOperation`. Adding
  RangeKeeper branches there keeps one transaction and one pending-operation
  check, but grows a function that is already hard to read. A separate
  acceptance calling the bare `acceptOperation` would be cleaner and would
  duplicate the preview re-validation.
- **Retain-only first, or retain and convert together?** Retain is materially
  smaller and has measured simulation evidence behind it. Convert's sampler is
  built but unvalidated against any fork.
- **Does the open path need the confirmation producer wired, or is a CLI
  acceptable to start?** A CLI runner would make the open reachable without
  touching the preview/acceptance chain, which would let step 2's live open
  happen sooner — at the cost of an operator-driven step the dashboard will
  later have to absorb.

## 6. What this does not cover

The live RangeKeeper controller remains out of scope, as in the integration
plan's §5. Nothing here changes it, and paper operation support must not be read
as live readiness.

No estimate is offered. The open half's gaps are well-bounded; the exit half's
gap E (booking a withdraw plus an optional conversion into the paper accounting
ledger) is the least explored part of this scope and the most likely to be
larger than it looks.

## 7. Gap D and gap E, worked — October 1, 2026

Commissioned to build gaps D and E against the shared contract an in-flight
exit-preview track is writing (`proposal.rangekeeperPaperExitModel`,
`proposal.rangekeeperPaperExitModelHash`, `proposal.rangekeeperPaperConvertQuote`,
and `request` carrying `exitKind`). Gap D is done in full. Gap E turned out to
be exactly as large as §6 warned, and is built for `close_retain` only.

### Gap D — done, both kinds

`paper-operation-worker.ts` previously blocked every `rangekeeper_v1` kind but
`open` at a single line (`:170` before this change). It now routes
`close_retain` and `close_convert` through a new branch that mirrors the
static chain's shape — `sourceFor` → single-source canonical anchor check →
claim-status advance — rather than the open flow's snapshot/adapter/owned-fork
replay, because retain has no on-chain execution to replay. `sourceFor`
(`:59-74`) gained a case for `strategy_id==='rangekeeper_v1'` with a
`close_retain`/`close_convert` kind, delegating to
`recoverRangeKeeperPaperExitModelSource` (new,
`rangekeeper-paper-exit-completion.ts`), which hash-binds
`proposal.rangekeeperPaperExitModel` to `proposal.rangekeeperPaperExitModelHash`
before trusting the `.source` field inside it — the same posture every other
`sourceFor` branch already takes toward its saved model. `close_convert`
reaches the same claim-advance path as `close_retain` (so gap D's "reach"
claim is true for both kinds) and is refused only at the very last step, with
`rangekeeper_paper_exit_convert_completion_unavailable`, because gap E below
does not cover it. Every existing static/open branch is untouched; the 1002
baseline tests pass unmodified.

### Gap E — real size, found by tracing, not guessed

Reading `completeTrustedPaperCloseRetain` (`store.ts:5083`, at the time of
reading) and `completeTrustedPaperOpen` (`store.ts:3366`) first established
this codebase's one completion convention: every static completion
deterministically **rebuilds the saved model from already-canonical, already-
persisted inputs and requires the rebuild to hash-match** (`buildPaperOpenModel`,
`buildPaperCloseRetainModel`), rather than trusting the saved model's content
on the strength of its preview-time acceptance alone. RangeKeeper open does
something structurally different — `completeRangeKeeperPaperConfirmedOpen`
(`store.ts:1376`) does not rebuild the open model's valuation; it trusts the
(separately hash-chain-verified) snapshot and instead replays the **on-chain
mint execution** on an owned fork, because that is the part a pure function
cannot prove.

The reason `RangeKeeperPaperExitModel` cannot simply follow the static
convention is in `rangekeeper-paper-exit-model.ts`'s own `buildRangeKeeperPaperExitModel`:
it calls live `chain.quote(...)` (inside `terminalQuote`, convert only, and
again inside `planRangeKeeper`'s `quote` callback for `kernelEvaluation`,
*all* exit kinds) and a `simulate` callback. A worker-side rebuild-and-compare,
in the static style, would need to re-issue those RPC calls — and would need
the exact `simulate` wiring the in-flight exit-preflight module uses, which
this task does not own and could not read without depending on another
track's uncommitted work. Re-implementing that live evaluation a second time,
independently, inside the worker would also duplicate logic this task does
not own (`idleInventory`, `validateIdentity`, `terminalQuote` are none of them
exported from `rangekeeper-paper-exit-model.ts`), which is itself a reason not
to: a second, drifting copy of that logic is worse than no copy.

**What was actually buildable, and why it is still a real check and not a bare
hash-trust:** the model's `position.retainedLowerBound0/1` — the numbers
actually written to the ledger — are reconstructible without any RPC call,
from data already sitting on two existing `deployment_marks` rows:

- the open mark's `inventory.position.{tickLower,tickUpper,liquidity}`
  (written by `buildRangeKeeperPaperConfirmedOpenInventory`,
  `rangekeeper-paper-confirmed-open-adapter.ts:153`), and
- the latest prior mark's `inventory.idle.{token0,token1}` (written by
  `buildRangeKeeperPaperMarkPayload`, `rangekeeper-paper-persistence.ts:177`,
  which itself forces `kernel.wallet0===idle0` on every mark, so this value
  never silently drifts from the open-time idle balance).

`principalAmounts` (`src/backtest/principal.ts:148`, already imported by both
`rangekeeper-paper-exit-model.ts` and `store.ts`) applied to those two marks'
data plus the exit model's own pinned `poolState.sqrtPriceX96` reproduces
exactly the `retained0`/`retained1` computation at
`rangekeeper-paper-exit-model.ts:353`. That is a real, independent, DB-only
re-derivation of the booked amounts — the same kind of defense-in-depth the
static paths apply, just scoped to the part that is actually reconstructible
without RPC.

### What was built

- `src/deployments/rangekeeper-paper-exit-completion.ts` (new, owned): a
  deliberately narrow, non-strict mirror of the fields
  `RangeKeeperPaperExitModel` exposes that the retain booking path reads
  (`rangeKeeperPaperCloseRetainModelBookingSchema`); `recoverRangeKeeperPaperExitModelSource`
  for gap D; and the pure, DB/RPC-free
  `buildRangeKeeperPaperCloseRetainBooking`, which re-derives and requires an
  exact match on the retained-lower-bound arithmetic above before producing
  any ledger/mark content, and throws a specific reason on every mismatch it
  can check (kind, previous-mark identity, position, idle, principal,
  retained-lower-bound).
- `DeploymentStore.completeRangeKeeperPaperConfirmedExit` (new, store.ts,
  flagged inline where it is inserted, after `completeTrustedPaperCloseRetain`):
  self-contained — reads/writes only `deployment_operations`,
  `deployment_campaigns`, `deployment_marks` and `deployment_ledger` rows
  scoped to its own `operationId`, inside one `FOR UPDATE`-locked transaction,
  mirroring `completeTrustedPaperCloseRetain`'s shape (idempotent replay
  return, claim/lifecycle/status/revision checks, preview digest integrity,
  then booking). `close_retain` only; it throws
  `rangekeeper_paper_exit_operation_unavailable` for any other `kind`.
- Worker wiring in `paper-operation-worker.ts` as described under gap D.

### What was deliberately not built, and why

- **`close_convert` booking.** Needs the conversion-accounting pattern the
  static path uses (`PAPER_CONVERSION_ACCOUNTING_POLICY_V2`, a separate
  accounting table — see `completeTrustedStaticPaperCloseConvertV3`,
  `store.ts:4496`, not fully read for this pass) plus a live re-verification of
  `proposal.rangekeeperPaperConvertQuote` this task cannot build without the
  same RPC/simulate dependency problem above. The worker refuses it with
  `rangekeeper_paper_exit_convert_completion_unavailable` rather than booking
  an unverified conversion.
- **`kernelEvaluation` and `costs` are carried through unverified.** They are
  copied into the booked mark's `provenance` verbatim from the hash-bound
  model, not re-derived. They do not gate whether booking happens and are not
  used in any arithmetic this method performs; they are provenance-only. If
  the model's reported `kernelEvaluation`/`costs` were wrong, this method
  would still book the correct retained-lower-bound (which it does
  independently verify) with incorrect decorative context attached.
- **The independent-price-deviation band check**
  (`rangekeeper-paper-exit-model.ts:339-341`) is not re-verified. It is a
  build-time gate on the model's own `status`; this method trusts
  `model.status==='indicative'` (required) as proof it already passed, rather
  than re-fetching `poolPrice1` independently.
- **`inventoryProofHash`** (`rangeKeeperPaperExitInventoryProofHash`,
  exported from `rangekeeper-paper-exit-model.ts:121`) is not re-derived. It
  would require fully reconstructing the kernel's `RangeKeeperState`
  (confirmation/exit sub-objects) from the prior mark's `kernelSnapshot`,
  which is more surface than the retained-lower-bound check above for a field
  that is not itself written to the ledger.
- **Gap B (acceptance) for the exit side is still not built**, by anyone, as
  far as this pass could tell — this track did not touch acceptance routes or
  `server.ts`/`deployments.ts`. `completeRangeKeeperPaperConfirmedExit`
  assumes acceptance will set `lifecycle='closing'` before the worker claims,
  mirroring the static convention; until an acceptance path exists for
  `rangekeeper_v1` exits, no operation reaches this method at all, and it is
  unreachable in production exactly like gap E was before this pass.

### What is unverified

No live database or RPC run backs any of this. All nine new tests
(`test/rangekeeper-paper-exit-completion.test.ts`) stub `store`/`chain`/
`indexer`; the SQL inside `completeRangeKeeperPaperConfirmedExit` — the
`deployment_marks`/`deployment_operations`/`deployment_previews` joins, the
`FOR UPDATE`/`FOR SHARE` locking, the exact column casts — has not executed
against a real schema. The static `completeTrustedPaperCloseRetain` query
shapes it was modeled on are exercised elsewhere in this suite against a real
database; this new method is not. Until it runs once against a live
`deployment_marks` table with a genuine open mark and a genuine
`recordRangeKeeperPaperMark`-written prior mark, treat the SQL as reviewed,
not proven.
