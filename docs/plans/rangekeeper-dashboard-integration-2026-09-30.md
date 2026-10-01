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

**Built 2026-10-01.** The convert-exit sampler now exists, and the blocker was
not the fork plumbing the paragraph above assumed. The throw's own wording was
exact: what was missing was a *persisted conversion quote contract*, so a sampler
had no way to prove it priced the same swap the exit would execute.
`rangeKeeperPaperConvertQuoteContent`/`Hash` and
`rangeKeeperPaperConvertQuoteSchema` now expose that contract standalone out of
`rangekeeper-paper-exit-model.ts` — the hash `terminalQuote` already computed
inline, unchanged — and `validateRangeKeeperPaperConvertQuoteBinding` binds a
persisted quote to the trusted terminal context: input amount against
`wallet+released` kernel inventory, minimum output against the policy slippage
floor replayed from `maxSlippageBps`, shortfall against `maxSwapShortfallValue`,
and the hash recomputed from the trusted candidate, source, pool and limits
rather than from the quote's own fields.

`sampleRangeKeeperPaperConvertExit` then restores the position with
`restorePaperPosition`, runs `exit_withdraw_collect`, **re-derives the quote on
its own pinned fork and requires `chain.quote`'s output to equal the persisted
`expectedOutput` exactly** before sending anything, replays
`exit_convert_approve_router_input` and `exit_convert_swap`, checks the decoded
router return equals the quoted amount and that the risky leg is left at zero,
then the four cleanups — matching `RANGEKEEPER_PAPER_CONVERT_EXIT_STAGES`. Only
two of the seven stages were genuinely new; five are the retain sequence.
A CLI mirrors the retain one. 15 tests; 994 total, check green.

**Still unvalidated against a live fork**, and this is the honest limit: convert
exit has no ground truth anywhere, which is why it was blocked. Every new test is
a unit test of the quote contract, its hash binding and fail-closed dispatch.
Nothing has exercised the owned-fork replay — not its gas numbers, not whether
the live quoter still agrees with a persisted quote at replay time, not whether
the paper router's `multicall` return shape decodes as expected. Validating it
needs a `rangekeeper_v1` paper campaign carried far enough to hold a real
persisted terminal context, then
`src/deployments-rangekeeper-paper-gas-convert-terminal-sample.ts` against it.

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

~~**It is complete, tested, and inert in production.**~~ **No longer inert, as
of 2026-10-01.** It was inert because it computed a *separate* pre-draft
candidate identity, on the reasoning that `campaignId` and `revision` cannot
exist before a draft. But `produceRangeKeeperPaperGasEvidence` asserts the
scope's `candidateHash` is the production `rangeKeeperPaperCandidateHash`, so
nothing could ever sample against a separate hash space — the preflight was
waiting for evidence no sampler could produce.

It now **samples its own candidate at review time**, which is what the open path
already does and what §2d establishes is the only way this path can resolve a
cost at all. Three changes:

- `rangeKeeperPaperSetupCandidateIdentity` is now the production
  `rangeKeeperPaperCandidateHash` over the real profile, configHash, source,
  reference proof and candidate, with `campaignId` and `revision` replaced by
  fixed sentinels (`00000000-0000-4000-8000-000000000000`, revision 1). Same
  hash space as post-draft, which is what makes it sampleable.
- The `readGasProfiles` dependency is replaced by `sampleOwnedFork`. The
  preflight calls `produceRangeKeeperPaperGasEvidence`, verifies the report, and
  costs it through `rangeKeeperPaperSpeculativeGasRows` — a helper now shared
  with `rangekeeper-paper-open-model-overlap.ts`, which had its own private copy.
  **Nothing is persisted**: the rows are costed in the request and discarded, so
  a sentinel identity never enters the store's hash space and can never be
  mistaken for a real campaign's evidence. That is what makes the sentinel safe,
  and it keeps the preflight's declared `read_only_no_draft_or_operation`
  contract intact.
- The configHash derivation, previously duplicated verbatim here and in
  admission, is now `rangeKeeperPaperSetupConfigHash` in `contracts.ts`. The
  preflight folds it into the candidate identity, so a drift between the two
  copies would have changed what admission replays.

A sampling failure now returns the full sizing output with reason
`rangekeeper_setup_gas_sample_unavailable`, rather than the bare unavailable
shape — the operator keeps the range and requirements even when cost evidence
cannot be obtained.

It is still **not wired to an HTTP route**, which remains deliberately out of
scope, and no live fork sample has run through it: its tests drive
`sampleOwnedFork` with a fixture, so the produce/verify/select path is exercised
end to end but the fork itself is not.

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

**That recommendation is not implementable as written. Found 2026-10-01 while
starting the re-key, by reading the resolver rather than the band function.**

The band key is not the binding constraint, so dropping `candidateHash` from it
buys nothing. `valid()` inside `selectRangeKeeperPaperCostProfiles`
(`rangekeeper-paper-cost.ts:132-146`) independently requires, for every row:

- `parsed.data.source.block===source.block` and the same `source.hash` — the row
  must have been sampled at the **exact block** of the current frame;
- `parsed.data.simulation.candidateHash===scope.candidateHash` — and for the
  exact same candidate;
- `sampled>=source.timestamp*1000 && sampled-source.timestamp*1000<=180_000` —
  within 180 seconds of that block's timestamp.

`selectRangeKeeperPaperExitCostProfiles` carries the same three. Re-keying the
band leaves all of them in force, so evidence would still be unreusable past the
frame it was taken at. The key was never what stopped reuse.

**The deeper reason: a RangeKeeper calibration row is not a gas measurement.**
`gasProfileModel` embeds `simulation:{kind:'owned_fork_full_candidate_v1',
status:'success',sourceBlock,sourceHash,candidateHash,sequenceHash}`. The row is
a *feasibility proof that one exact candidate's whole sequence executed on a fork
at one exact block*, which also happens to carry per-stage gas units. Its
`sequenceHash` is load-bearing well downstream — cross-checked in
`rangekeeper-paper-confirmation-simulation.ts:152,196`,
`rangekeeper-paper-confirmation-provenance.ts:42,56`,
`rangekeeper-paper-persistence.ts:103` and
`rangekeeper-paper-confirmed-open-adapter.ts:123`, where it becomes provenance
for the confirmed open.

The architecture is deliberately sample-per-open, not accidentally so.
`rangekeeper-paper-open-model-overlap.ts` `scopedRows()` builds rows with
`id:'speculative:<n>:<stage>'` out of the report *just sampled* and feeds them
straight to the selector; `settleRangeKeeperPaperOpenOverlap` exists to run that
sampling concurrently with registration. The `rk_` band is a **same-frame retry
cache**, not a reuse mechanism. The zero rows in
`deployment_calibration_profiles` (re-confirmed 2026-10-01: zero for every
`paper_rangekeeper%` path) are consistent with that.

Contrast the static path, which genuinely does reuse: `paperGasModelSchema`
(`paper-cost.ts:31-35`) carries gas units, size/share bands, a tick range and a
24-hour freshness window — **no candidate binding, no simulation object, no
source-block equality**. It is a pure measurement, which is exactly why it can
be banded.

**So loosening `valid()` to obtain reuse would be a safety regression, not a
cleanup.** It would let a feasibility proof for candidate X at block B vouch for
candidate Y at block C, while that proof's `sequenceHash` continues to flow into
the confirmed open's provenance.

**What the re-key actually requires** is splitting one artifact into two:

1. a reusable per-stage **gas measurement** row, static-shaped — size/share
   bands, pinned tick range, 24-hour freshness, no candidate or block binding;
2. a per-attempt **feasibility proof** that stays bound to candidate and block
   and keeps feeding the confirmation and provenance chain unchanged.

Only after that split do items 1 and 2 of the review's recommendation do
anything at all. This is a larger change than a key-shape fix and it carries a
risk decision — how conservative the cost model is, and whether a gas number may
outlive the proof that the sequence it priced was executable. That is the same
class of decision `4a10877` recorded rather than settling unilaterally, and it is
recorded here for the same reason.

**And measured against the campaign scope, the split is not worth doing.**
`rangeKeeperConfigSchema.campaignScope` (`src/strategy/rangekeeper/config.ts:46-47`)
defaults to `maxDurationSeconds:43200` and `maxEconomicActions:2`, capped at 10.
An economic action is the mint itself — `live-controller.ts:620` increments
`economicActions` when a position is created, and `:758` gates any further action
on that cap. So a RangeKeeper campaign performs **2 economic actions over at most
12 hours by default, and at most 10**.

At roughly 30 seconds per owned-fork sample, that is 1 to 5 minutes of sampling
per campaign, spread across a 12-hour window. Twelve pools running concurrently
is 24 to 120 samples per cycle — tens of minutes of fork time per half-day, on
independent serializable work. Banding could remove at most that, and only in
the fraction of cases where a recenter happens to land on an already-sampled tick
range.

So the sample-per-open architecture is not a defect to be engineered around; it
is well matched to a strategy that is capped at a handful of actions per
half-day. The banding question was the right question for the static path, whose
setup reviews are operator-driven and unbounded in frequency, and it was imported
here by analogy without checking the action budget first. **The re-key should not
be built.** `§2d`'s measured gradients keep their value as evidence about what
drives RangeKeeper gas — which matters for the `gasUnitsBound` margin and for the
convert path — but no band key change follows from them.

What this frees up: §2a's convert exit, wiring the §2b setup contract to a route,
§4's dashboard form, and §2c's two gates are now the entire remaining path. None
of them depends on banding.

One consequence worth stating plainly, because §2b claims the opposite: the setup
preflight is **not** waiting on a re-key that will never come. Its problem is
different and smaller — it computes a pre-draft candidate identity that no
sampler targets. The fix is for the preflight to sample at review time, the way
the open path samples at open time, rather than to look up a band that was never
going to exist.

**One correction to a concern raised earlier in the same session.** The
`rows.length>200` guard was described as a cliff the re-key must ship around,
on the basis that 192 rows exist on the live static path. That was the wrong
denominator: `paperGasProfiles` (`store.ts:799-811`) is already range-scoped, as
it filters `model->'tickLower'` and `model->'tickUpper'`. Measured 2026-10-01,
the hottest single range returns **72 of 201** rows (12 bands × 6 stages), so
the static path is not near lockout. The ceiling is real but distant and
monotonic: nothing prunes superseded versions, each new size band at a recurring
range adds 6 rows, and that range locks out at 34 bands. Worth fixing with
`DISTINCT ON` or a prune when the re-key makes RangeKeeper bands long-lived —
not before.

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
   retain exit can be unblocked on this evidence. ~~Convert exit needs an
   owned-fork sampler built first before it can even be compared.~~ **That
   sampler is built** (§2a), so convert exit is now comparable in principle —
   but it has no live fork run yet, so there is still no ground truth to compare
   a simulated convert sequence against.
2. ~~**Ask the banding question for the RangeKeeper paths**~~ **Done** — see
   §2d. Size and share drive nothing, the range drives everything, and the band
   key additionally embeds `candidateHash`, so it must be re-keyed before any
   reuse is possible at all. **But the re-key is no longer the work item:**
   §2d records that the key is not the binding constraint, and that reuse
   requires first splitting the calibration row's reusable gas measurement from
   its per-candidate feasibility proof — and against a campaign scope of 2 to 10
   economic actions per 12 hours, that split is not worth its risk. **Dropped,
   with the reasoning recorded in §2d.**
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
