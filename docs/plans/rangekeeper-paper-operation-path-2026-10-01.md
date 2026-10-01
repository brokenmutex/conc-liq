# RangeKeeper paper operation path — scope, October 1, 2026

Status: scope only. No source change is proposed here for immediate execution,
and nothing below authorizes execution of a strategy.

Commissioned to scope the RangeKeeper **exit** operation path, after
`rangekeeper-dashboard-integration-2026-09-30.md` §2a was corrected: a campaign
is uncloseable because no exit operation path exists, not because of the
`simulate` stub that section blamed.

Tracing the static chain to compare against produced a larger finding, which
changes the order of the work.

## 0. The headline: no RangeKeeper operation can be accepted at all

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
