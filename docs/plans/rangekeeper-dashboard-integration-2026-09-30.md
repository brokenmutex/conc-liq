# RangeKeeper dashboard integration — scope, September 30, 2026

Status: scope only. No source change is proposed here for immediate execution,
and nothing below authorizes execution of a strategy.

The operator asked to be able to deploy several RangeKeeper instances across
pools. Pool availability is now solved separately — twelve verified market
profiles are registered and every one is available to any strategy. This
document scopes what remains, which is making `rangekeeper_v1` a selectable
paper strategy at all.

## 1. What already exists

More than the strategy flag suggests. Verified by reading the source, not
inferred:

| Capability | Where | State |
| --- | --- | --- |
| Draft creation | `server.ts` `/api/deployments/drafts` | **Works today.** Only `static_manual_v1` is diverted to setup admission; a RangeKeeper draft is accepted by the generic endpoint. |
| Parameters contract | `contracts.ts` `rangeKeeperParameters` | Complete: `fullWidthSpacings` plus its own limit set. |
| Open confirmation model | 18 modules, `rangekeeper-paper-*.ts`, 4,352 lines | Built: context, confirmation, provenance, simulation, replay verifier, persistence. |
| Open persistence | `store.ts` `persistRangeKeeperPaperConfirmationEnvelope`, `completeRangeKeeperPaperConfirmedOpen` | Built. |
| Worker completion | `paper-operation-worker.ts:209` | Built. |
| Exit model builder | `rangekeeper-paper-exit-model.ts` | Built, but blocked — see §2. |
| Gas sampler and CLI | `rangekeeper-paper-gas-sampler.ts`, `deployments-rangekeeper-paper-gas-sample.ts` | Built. |
| Dashboard strategy option | `index.html:44` | **Already offered in the form.** |

## 2. What blocks it

Four gaps, in descending order of difficulty.

### 2a. The exit preview is deliberately blocked

`deployments.ts:341`:

```js
// This preview must stay blocked until the owned-fork stage runner is wired.
simulate:async()=>false});
```

So a RangeKeeper paper campaign could be opened but never closed. This is the
substantive blocker and everything else is small beside it. It is also the same
shape as the static path's problem: an exit needs per-stage gas for a sequence
that has not happened yet.

The static path's stage runner now exists in two forms — the owned fork and, as
of today, `paper-gas-simulation-sampler.ts`. The simulation reproduces the
fork's actual consumed gas exactly on five of six static stages. **It has not
been validated on any swap stage**, and a RangeKeeper exit is swap-involving on
the convert path, so extending it is plausible but unproven and must be measured
before it is relied on.

### 2b. There is no sized, costed setup path

`buildStaticPaperSetupPreflight` is hardcoded `strategyId:'static_manual_v1'`
(lines 41, 199), and `static-paper-draft-admission.ts` rejects anything else
(line 85). RangeKeeper therefore has no equivalent of the flow that sizes a
position to a capital budget, prices it, and binds a reviewed source.

A draft can still be created directly, so this is not strictly blocking — but
without it the operator supplies raw allocations by hand, with no preflight, no
cost evidence and no review binding. That is a materially worse contract than
static/manual has, and it is where most of the remaining work sits.

### 2c. The strategy is refused in two places

- `server.ts:205` — `paper: id==='static_manual_v1' && staticPaperAvailable`,
  so `rangekeeper_v1` can never report `paper: true`.
- `tabs.js` `runSetupReview` — refuses any strategy but static/manual before
  sending a request.

Both are one-line gates once what they guard actually works. They should be the
**last** things changed, not the first.

### 2d. Gas evidence is needed per pool and per path

`rangeKeeperPaperGasProfiles(poolAddress, pathVersion, sizeBand)` takes three
path versions — `paper_rangekeeper_v1_no_swap_v1`,
`..._direct_swap_v1`, `..._direct_convert_exit_v1` — against `rk_` size bands,
which are a different scoping scheme from the static path's. Twelve registered
pools times three paths is a lot of sampling if each is single-use; the banding
work done for the static path on 2026-09-30 does not carry over automatically
and the same question — which dimensions actually drive the gas — has not been
asked here.

## 3. Proposed order

1. **Measure whether the simulation runner extends to swap stages.** Cheap,
   read-only, and decides 2a. If it does, the exit unblocks without an owned-fork
   stage runner being written. If it does not, that runner is the next item and
   is significantly larger.
2. **Ask the banding question for the RangeKeeper paths** before sampling twelve
   pools three ways. The static path's answer — that size and share do not drive
   gas and the tick range does — was worth an order of magnitude and took under
   an hour to establish.
3. **Build the RangeKeeper setup preflight and draft admission**, mirroring the
   static contract: size to a capital budget, price from banded evidence, bind a
   reviewed source, and admit against limits. This is the bulk of the work.
4. **Extend the dashboard form** to collect `fullWidthSpacings` and the
   RangeKeeper limit set, which is larger than the static one.
5. **Open the two gates** in `server.ts` and `tabs.js`, last.

## 4. Decisions needed before starting

- **Does a RangeKeeper paper campaign need the full setup/preflight contract, or
  is direct draft creation acceptable to start?** The second is much faster and
  materially weaker. This determines whether item 3 is in the first slice.
- **Is the convert exit in scope?** The retain exit avoids the swap entirely, so
  scoping to retain-only would likely sidestep the unvalidated swap-simulation
  question and deliver a complete open-and-close loop sooner.
- **How many pools at once?** Twelve registered profiles do not have to become
  twelve campaigns. The gas evidence cost scales with pools actually used.

## 5. What this does not cover

The live RangeKeeper controller is out of scope entirely. It has its own custody
rules, its own fork simulation which
`docs/plans/operation-gate-simplification-2026-09-30.md` §4c concludes should
stay, and two recorded live attempts whose lessons are in
`docs/operations/rangekeeper-activation-2026-09-21.md`. Nothing here changes it,
and paper availability must not be read as live readiness.
