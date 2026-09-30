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

The static path's stage runner now exists in two forms — the owned fork and
`paper-gas-simulation-sampler.ts`.

**Measured 2026-10-01, and the framing above was wrong in one important way.**
See [the validation](../reviews/swap-simulation-validation-2026-09-30.md).

`eth_simulateV1` does reflect a swap moving the pool price within a sequence.
Observed on two independent live runs: the router swap's output exactly equalled
a quote taken moments earlier, a `slot0()` read appended after the swap returned
a moved tick, and a mint whose slippage minimums were only valid post-swap
succeeded. Verified independently at the mechanism level as well — in one
sequence an allowance reads zero, an approve writes 12,345, and a later read in
the same sequence returns 12,345.

Against the unmodified owned-fork sampler on the same candidate and frame,
across the `direct_swap` open path and the retain exit: **8 of 10 stages match
the fork's actual consumed gas exactly**, `open_mint` is −1.88% and
`exit_withdraw_collect` −4.26%, reproducible in direction and magnitude across
two runs at different blocks. Both deltas land on balance-crediting stages,
the same cold-versus-warm signature as the static path's, and both sit far
inside the 30% `gasUnitsBound` margin. Sampling takes ~0.37 s against 30–34 s.

**But the convert exit is not merely unvalidated — it is untestable today.**
`rangekeeper-paper-gas-sampler.ts` throws unconditionally for
`kind:'convert_exit'` (assert at line 140, throw at line 222): there is no
owned-fork convert-exit sampler at all, so no ground truth exists to compare a
simulated convert sequence against, for anyone. Building that sampler is a
prerequisite to convert-exit work, not a follow-on.

So the retain exit can be unblocked now on measured evidence, and the convert
exit cannot be assessed until an owned-fork sampler for it exists.

One honest limit from the validation: its per-sample request count of four
covers only direct `client.request` calls and misses traffic from reused viem
actions, so the true count is higher and was not re-measured.

### 2b. There is no sized, costed setup path

`buildStaticPaperSetupPreflight` is hardcoded `strategyId:'static_manual_v1'`
(lines 41, 199), and `static-paper-draft-admission.ts` rejects anything else
(line 85). RangeKeeper therefore has no equivalent of the flow that sizes a
position to a capital budget, prices it, and binds a reviewed source.

A draft can still be created directly, so this is not strictly blocking — but
without it the operator supplies raw allocations by hand, with no preflight, no
cost evidence and no review binding. That is a materially worse contract than
static/manual has, and it is where most of the remaining work sits.

**Built 2026-10-01.** `rangekeeper-paper-setup-preflight.ts`,
`rangekeeper-paper-setup-review-cache.ts` and `rangekeeper-paper-draft-admission.ts`,
with 13 tests. The preflight sizes a wallet allocation to the capital budget and
then hands it to `planRangeKeeper`, taking `deployedValue`, `liquidity` and
`range` for the cost scope **from the planner's candidate** rather than from its
own sizing — the exact mistake that broke every static open until it was found,
avoided here from the start. Limits are validated by replaying
`resolveRangeKeeperPaperPolicy`, the same function the real open model uses,
rather than by re-deriving its rules. Admission replays the reviewed source,
rejects any change to the binding, cost identity, cost structure or gas-price
bound, and is idempotent on a request id.

One deliberate deviation from the static contract: `limits` is required rather
than optional, because the RangeKeeper kernel reads `maxDeploymentValue`,
`minDeploymentPpm` and `maxSlippageBps` to size anything at all, so a
limits-free preflight could not call the planner meaningfully.

**It is complete, tested, and inert in production.** The band it computes uses a
pre-draft candidate identity, because `campaignId`, `revision` and the source
anchors that `rangeKeeperPaperCandidateHash` embeds do not exist before a draft
is created. No sampler targets that identity, so the preflight resolves to
cost-unavailable — failing closed, correctly — until §2d's re-key lands. It is
also not wired to any HTTP route yet, which was deliberately left out of scope.
Once the re-key lands it picks it up without rework, because it calls the shared
production band and cost functions rather than copies of them.

### 2c. The strategy is refused in two places

- `server.ts:205` — `paper: id==='static_manual_v1' && staticPaperAvailable`,
  so `rangekeeper_v1` can never report `paper: true`.
- `tabs.js` `runSetupReview` — refuses any strategy but static/manual before
  sending a request.

Both are one-line gates once what they guard actually works. They should be the
**last** things changed, not the first.

### 2d. Gas evidence is needed per pool and per path

**Measured 2026-10-01.** See [the banding review](../reviews/rangekeeper-gas-banding-2026-09-30.md).
The answer is worse than the static path's was, and for a structural reason
found before any gradient was run.

`rangeKeeperPaperSizeBand` hashes `candidateHash` into the band identity, and
`rangeKeeperPaperCandidateHash` covers `campaignId`, `revision`, `sourceBlock`,
`sourceHash`, `expiresAt` and the exact swap quote. **So the band key changes on
every open attempt**, whatever drives the gas. Releasing size and share from the
key — the fix that worked for the static path — would achieve nothing here
unless `candidateHash` comes out too. There are currently **zero** RangeKeeper
rows in `deployment_calibration_profiles`, so nothing is broken today; this path
has simply never run.

Three pinned-frame gradients establish what actually drives gas:

| Gradient | Span held constant against | Total spread |
| --- | --- | ---: |
| No-swap open + retain exit | 40× capital, 40× share | **0.04%** |
| Direct-swap open + retain exit | 40× capital, 40× share | **0.72%** |
| Range width, fixed capital | `fullWidthSpacings` 20/100/400 | **11.11%** |

Same shape as the static path: size and share drive nothing, the range drives
everything — `open_mint` 18.58% and `exit_withdraw_collect` 10.53% across the
width gradient, with approvals and cleanups flat. One new wrinkle the static
path had no analogue for: `open_swap` moves 4.97% with size, but as a step
between 25 and 100 USDG and then flat to 1,000, which looks like a tick-crossing
threshold rather than a continuous dependence. Everything stays inside the 30%
`gasUnitsBound` margin.

The recommended scheme therefore mirrors the static v1→v2 fix, plus the extra
step: drop `candidateHash`, `deployedValue` and `sharePpm` from the `rk_` hash
and key on `{pool, pathVersion, tickLower, tickUpper}`; band size and share as a
stored range; keep the tick range pinned. That needs a model schema version bump
and a resolver change from exact match to range containment, exactly as the
static path took.

Sampling then bounds to distinct (pool, path, range) triples across **two**
paths, not three — convert exit has no sampler at all, per §2a.

Limits stated in the review: only AAPL-500 was sampled, and other fee tiers have
different tick spacing; only the `open`-kind probe was exercised, so the
standalone terminal retain-exit path is inference; and RangeKeeper's
range-recurrence rate is unmeasured, because no history exists to measure it
against.

## 3. Proposed order

1. ~~**Measure whether the simulation runner extends to swap stages.**~~
   **Done** — it does, for the `direct_swap` open path and the retain exit. The
   retain exit can be unblocked on this evidence. Convert exit needs an
   owned-fork sampler built first before it can even be compared.
2. ~~**Ask the banding question for the RangeKeeper paths**~~ **Done** — see
   §2d. Size and share drive nothing, the range drives everything, and the band
   key additionally embeds `candidateHash`, so it must be re-keyed before any
   reuse is possible at all. Implementing that re-key is now the work item.
3. ~~**Build the RangeKeeper setup preflight and draft admission**~~ **Done** —
   see §2b. Complete and tested, but inert until the §2d re-key lands and it is
   wired to a route. **The re-key is therefore now the critical path**: without
   it the setup contract exists but can never resolve a cost.
4. **Extend the dashboard form** to collect `fullWidthSpacings` and the
   RangeKeeper limit set, which is larger than the static one.
5. **Open the two gates** in `server.ts` and `tabs.js`, last.

## 4. Decisions needed before starting

- **Does a RangeKeeper paper campaign need the full setup/preflight contract, or
  is direct draft creation acceptable to start?** The second is much faster and
  materially weaker. This determines whether item 3 is in the first slice.
- **Is the convert exit in scope?** Retain-only is now clearly the faster route
  and is the one with measured evidence behind it. Convert additionally requires
  an owned-fork convert-exit sampler to be written before its simulation could
  be validated at all, which is a substantial piece of work in its own right.
- **How many pools at once?** Twelve registered profiles do not have to become
  twelve campaigns. The gas evidence cost scales with pools actually used.

## 5. What this does not cover

The live RangeKeeper controller is out of scope entirely. It has its own custody
rules, its own fork simulation which
`docs/plans/operation-gate-simplification-2026-09-30.md` §4c concludes should
stay, and two recorded live attempts whose lessons are in
`docs/operations/rangekeeper-activation-2026-09-21.md`. Nothing here changes it,
and paper availability must not be read as live readiness.
