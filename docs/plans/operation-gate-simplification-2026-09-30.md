# Operation gate simplification — September 30, 2026

Status: proposal. No source change is applied and no item below authorizes
execution. Section 4 is the only part carried out: two measurements, one over
the historical calibration set and one a purpose-run size-gradient experiment
on an owned fork, which together decide whether category 4 can proceed.

The operator asked whether the safety checks guarding drafting, opening,
closing and pausing still make sense, or whether repetition and over-engineering
are what make the dashboard slow and unreliable. This plan answers that with
measurements rather than taste, and proposes an ordered, bounded set of changes.

## 1. What was measured

Gate density per operation, counted from the source, against each operation's
observed behaviour during the September 29–30 remediation session.

| Operation | Modules | Distinct failure codes | Preview latency | Observed record |
| --- | ---: | ---: | ---: | --- |
| pause / resume | 3 | 8 | <1 s | 2/2 succeeded first attempt |
| close and retain | 2 | 18 | ~1 s | 3/3 succeeded first attempt |
| open | 12 | 38 | 43–47 s (setup review) | 0 until four defects were fixed |
| close and convert | 13 | 223 | 91–131 s | never completed end to end |

Supporting counts across `src/deployments`:

- **48** independent 180-second freshness windows.
- **27** canonical frame read sites. Each is an RPC round trip plus oracle
  reads plus a feed-directory HTTP fetch.
- **8** cost-model resolution sites.

The relationship is monotonic across four independent operations. The two
lightest paths have no recorded failure in this session; the two heaviest
account for every defect fixed and for the one operation that has still never
completed.

This is evidence of correlation, not proof of causation. A plausible competing
explanation is that convert is intrinsically the hardest operation and would
need the most gates however it were written. Section 5 proposes treating it
accordingly rather than pruning it on a count.

## 2. Four categories

### Category 1 — load-bearing, do not touch

The recheck performed under the campaign lock at commit time. Between preview
and acceptance the world can genuinely change; the accept transaction holds
`FOR UPDATE` on the campaign, and this recheck is what prevents acting on
stale economics. The same applies to idempotency-key binding, the append-only
guards, and canonical anchor verification at commit.

Every proposal below assumes these remain exactly as they are.

### Category 2 — withdrawn; the split already exists

**This category was wrong and is retracted.** It claimed that one operator
"open" recomputes the `(candidate, costs, model)` triple five times and that
each recomputation re-reads a fresh canonical frame, making it the source of
the latency. The recomputation count is right. The premise underneath it is not.

Verified in source on 2026-09-30:

- `store.ts` contains **no chain read at all**. All six of its replay sites
  build `frame` from `model.source` and `model.poolState` — the persisted
  model — so acceptance and completion are in-memory replays, not RPC.
- Draft admission already pins: `deps.runPreflight(requested, input.reviewed.source)`.
- Gas preparation and the setup rebuild already pin.
- Exactly **two** stages read a fresh frame per open: the initial setup
  preflight and the open preview. Both are asking "what is true now?", which is
  the question that legitimately requires one.

So the architecture already performs the replay-from-pinned versus verify-now
split this category proposed to introduce. The five recomputations are cheap
in-memory rebuilds whose hash comparisons are defence in depth between review
and commit, and they cost milliseconds.

Measured, from the September 30 lifecycle run against the live services:

| Stage | Accept to succeeded |
| --- | ---: |
| open | 2 s |
| pause | 1 s |
| resume | 1 s |
| close and retain | 2 s |

The entire acceptance-plus-completion chain, including three of the five
recomputations and every hash comparison, is one to two seconds. There is no
latency there to recover.

**Where the latency actually is.** A setup preflight that does not sample gas
takes 2.7–4.5 s; one that does takes 43–47 s. So roughly 90% of setup-review
latency is the owned-fork gas sample, and the single fresh frame read is about
4 s of it. Section 4b records why banding did not remove the sample: the tick
range, which must stay pinned, moves too often for evidence to be reused
between consecutive opens.

### Category 3 — miscalibrated thresholds (the fragility)

With category 2 withdrawn, this is the live one. 48 copies of a 180-second
window guard operations measured at 43–131 seconds.

Convert is the clearest case: the preview takes 91–131 s inside a 180 s source
window, then issues a preview whose time-to-live is 46–51 s. The system spends
most of its own safety margin producing the artefact the margin protects, and
the remainder becomes the operator's clicking budget.

The fee-cursor settle budget has the same shape, and now has data behind it.
During the operator's manual campaign on September 30, across 48 worker passes:

| Outcome | n | Mean | Max |
| --- | ---: | ---: | ---: |
| Settle succeeded | 34 | 4.3 s | 10.0 s |
| Settle timed out | 12 | 16.9 s | 17.7 s |

Every failure pins at the 15-second budget plus query overhead; every success
completes under 10 s. These are budget-limited, not a distinct fault.
`waitForCompletePaperFeeCursor` already validates up to 30,000 ms.

Thresholds should be derived from measured stage latency with stated headroom.

**The preview time-to-live half of this was also wrong, and is retracted.**
Extending preview TTL past `source + 180s` would be inert as well as unsafe:
acceptance gates independently on source age at `server.ts:326` for open and
`:355` for convert, so a longer-lived preview would simply be refused there.
The source-age check is the real guard — it is what stops an operator acting on
stale economics — and the TTL at `paper-preview.ts:82` is correctly derived from
it. The short fuse on a convert preview is a symptom of generation taking
91–131 s of the source's 180 s life, not of the TTL formula. The fix for that is
to make generation faster, which is section 4b's unresolved problem, or to
surface the remaining time in the UI. It is not to widen the window.

Likewise, the server re-checking source age after the store already bounded the
preview is a double-check of one property — but it is a comparison at a trust
boundary, not a chain read, and removing it would weaken defence in depth for
no measurable gain.

So of the 48 windows, the one with evidence behind it is the fee-cursor settle
budget below.

### Category 4 — fragile by construction

`paperGasModelSchema` carries `sizeMinValue`/`sizeMaxValue` and
`shareMinPpm`/`shareMaxPpm`, and `costIndicativePaperOpenPreview` validates
with `min>size||size>max`. The schema and resolver are built for **ranges**.

`paper-gas-sampler.ts` writes every one of them as a point:

```js
sizeMinValue:  candidate.deployedValue,   sizeMaxValue:  candidate.deployedValue,
shareMinPpm:   candidate.dilutedSharePpm, shareMaxPpm:   candidate.dilutedSharePpm,
```

and `paper-gas-evidence.ts` asserts that collapse on import. The range
machinery exists and is deliberately disabled.

That single decision is why every setup review must sample fresh evidence on a
fork (~40 s of the 43–47 s total), why the calibration table grew six rows per
review until it approached the 200-row resolver bound, and why no piece of gas
evidence is ever reused.

## 3. What the gates cost, and why they were added

Each gate was almost certainly added in response to something that went wrong;
the incident records in `docs/reviews/` and `docs/incidents/` read that way.
The failure mode is not that individual checks are unreasonable. It is that
**no check was ever removed when a later one subsumed it**.

Accordingly, every removal proposed here must name the incident the check was
added for and argue that another gate now covers it. A count alone is not an
argument for removal.

## 3b. Implemented: the fee-cursor settle budget

`CURSOR_SETTLE_BUDGET_MS` in `paper-fee-replay.ts` was raised from 15,000 to
30,000 ms, the maximum `waitForCompletePaperFeeCursor` accepts, and both the
deadline and the per-wait cap now read from that one constant instead of two
copies of a literal.

The measurement is recorded next to it. One caveat is recorded with it too:
nothing succeeded between 10 s and the old 15 s ceiling, so the successes and
the failures look like two regimes rather than one distribution cut in half.
Raising the budget may therefore convert all, some or none of the failures. The
stage duration the worker already logs makes the change self-measuring — if
failures still pin, now at ~32 s, the constraint is indexer throughput and not
the budget, and the next step is the indexer rather than another increase.

A maintenance pass can now spend up to 30 s per campaign awaiting catch-up
against a 60 s worker interval, which is fine at one or two campaigns and would
need revisiting as that count grows.

## 4. Measured: the gas banding error bound

This is the only section that has been executed. It exists to decide whether
category 4 can proceed.

Source: all 27 `paper_static_manual_no_swap_v1` bands in
`deployment_calibration_profiles`, sampled 2026-09-28 to 2026-09-30.

### The outlier

One band, `exact_caba131cb2de121c8710afc1608038ec` (sampled 09-29 19:31), is
**197.6% of the median total gas**, with all six stages inflated roughly 2×
together. The next highest band is 110.5% of median. It is a single anomalous
sampling run, not a size effect, and is excluded from the bound below and
reported separately.

### The bound, 26 bands, outlier excluded

| Stage | Bands | Min units | Max units | Spread |
| --- | ---: | ---: | ---: | ---: |
| mint | 26 | 455,755 | 573,628 | **25.9%** |
| withdraw_collect | 26 | 257,178 | 302,978 | 17.8% |
| cleanup_token0 | 26 | 38,406 | 41,963 | 9.3% |
| cleanup_token1 | 26 | 44,030 | 47,637 | 8.2% |
| approve_token0 | 26 | 58,801 | 62,272 | 5.9% |
| approve_token1 | 26 | 64,484 | 67,955 | 5.4% |

**Every stage's total observed spread is below the 30% margin that
`gasUnitsBound = ceil(expected × 13/10)` already commits to paying.** Banding
would therefore admit at most variation the system already tolerates.

### What the variation is not driven by

Across those 26 bands, holding the outlier out:

- **Diluted share varied 3,317–5,847 ppm, a 1.76× range, while
  `approve_token0` stayed at exactly 58,801 units in 19 of 27 samples.** Gas is
  insensitive to share over the observed range.
- The **fixed-cost stages** (both approvals, both cleanups) are insensitive to
  tick range as well: they move under 10% across all 11 ranges in the set.

The 25.9% mint spread and the 17.8% withdraw spread are therefore the residue,
and the size-gradient experiment below identifies the tick range as their
driver: with the range pinned, both collapse to 0%.

### What the historical set could not establish

**Size never meaningfully varied in it.** Every historical sample sits between
239.95 and 250.00 USD, a 4% range, because every campaign used 250 USDG. That
dataset therefore could not bound the error of reusing a band across materially
different position sizes, and the size-gradient experiment below was run to
settle it rather than extrapolate.

### Measured: the size gradient

Executed 2026-09-30 against pinned source block 76,499,708, tick 218,338, with
the canonical frame, pool state and tick range (218280/218400) **held constant
across every sample**, so any spread is attributable to size alone. Sampled on
an owned fork; nothing was imported and no draft, preview or operation was
created.

| Stage | 25 USDG | 100 | 250 | 500 | 1,000 | Spread |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| approve_token0 | 58,789 | 58,801 | 58,801 | 58,801 | 58,801 | **0.0%** |
| approve_token1 | 64,472 | 64,484 | 64,484 | 64,484 | 64,484 | **0.0%** |
| mint | 490,200 | 490,249 | 490,249 | 490,249 | 490,249 | **0.0%** |
| withdraw_collect | 290,826 | 290,863 | 290,863 | 290,863 | 290,863 | **0.0%** |
| cleanup_token0 | 38,406 | 38,406 | 38,406 | 38,406 | 38,406 | **0.0%** |
| cleanup_token1 | 44,030 | 44,030 | 44,030 | 44,030 | 44,030 | **0.0%** |
| **Total** | 986,723 | 986,833 | 986,833 | 986,833 | 986,833 | **0.0%** |

Across a **40× capital range** and a **39× share range** (369 → 14,570 ppm),
total gas moved by **110 units, or 0.011%** — and only for the smallest sample,
where the difference is calldata zero-byte encoding of smaller amounts, not
execution. Gas for this path is independent of position size and of diluted
share.

### What this changes

The three dimensions the band key pins now decompose cleanly:

| Dimension | Effect on gas | Evidence |
| --- | --- | --- |
| Deployed size | **none** (0.011% over 40×) | size-gradient experiment above |
| Diluted share | **none** (0% over 39×) | size-gradient, and 19/27 historical samples identical across 1.76× |
| Tick range | **material** — the 25.9% mint spread | historical set; 0% once range is pinned |

So the band key pins three things and only one of them matters. Releasing size
and share while keeping the exact tick range is therefore not a precision
trade at all on this evidence — it is removing two keys that control nothing.

The historical set is **27 bands across 11 distinct tick ranges**. Banding size
and share would have collapsed it to 11, and would make every repeat open at a
recurring range reuse existing evidence instead of sampling. The ~40 s fork
sample becomes necessary only when the range itself is new.

### The reuse caveat the outlier exposes

A reused band carries its own `gasUnitsBound`. A band sampled at the low end
(455,755 expected, bound 592,482) would **not** have covered the anomalous mint
at 746,842. Reuse across time therefore needs either a bounded reuse window
short enough that pool state cannot drift, a bound derived from the observed
maximum rather than a single sample, or re-sampling when a fresh estimate
deviates beyond a stated threshold. Widening the bands without addressing this
would trade a slow open for an under-bounded one.

## 4b. Implemented, and what it actually bought

Banding was implemented on 2026-09-30: `paperGasBand` in `paper-cost.ts` is the
single contract, the sampler applies it, the importer verifies the exact
documented envelope rather than merely that the candidate falls inside one, and
the band key in `registerPaperGasEvidence` drops size and share to become
`range_<hash(pool, tickLower, tickUpper)>`. The stage model is now versioned:
version 1 is the retained point-scoped evidence, version 2 is banded, and both
stay verifiable, so the retained fork artifact in `research/calibration/` did
not have to be regenerated or its guard weakened.

Four live preparation runs at 250, 500 and 100 USDG then measured what it buys,
and the answer is narrower than section 4 projected.

| Sampled | Tick range | Band | Outcome |
| --- | --- | --- | --- |
| 15:30:29 | 218260/218380 | `range_c049c1b4` v1 | sampled |
| 15:32:00 | 218250/218370 | `range_97d5cb86` v1 | sampled |
| 15:32:42 | 218240/218360 | `range_d454a247` v1 | sampled |
| 15:33:23 | 218240/218360 | `range_d454a247` **v2** | re-sampled |

**What it did buy.** Re-sampling at a range that already has evidence now
appends a *version* of the existing band instead of minting a new one, as the
last row shows. Band count is therefore bounded by distinct tick ranges rather
than by sample count, which is exactly the growth that drove the calibration
table toward the 200-row resolver bound. Evidence is also genuinely reusable
within the envelope at a recurring range.

**What it did not buy.** It does not remove the ~35 s fork sample from most
opens. The tick range moved on three of four consecutive runs inside three
minutes, and the range must stay pinned because it carries the entire measured
variance. Reuse therefore only occurs when the pool tick happens to stay inside
the same anchored bucket between opens. The earlier projection that this would
remove sampling from "every repeat open" was wrong: recurring ranges are common
over days, as the historical 27-bands-over-11-ranges shows, but rare between
consecutive opens.

The 100 USDG run also fell outside the 500 USDG run's size envelope (125–2000
USD) and so re-sampled. That is the ±4× band working as specified. The
measurement would support widening toward a 36× span and still sit inside the
40× it covered, but the binding constraint is the range, not the envelope, so
widening was not done — it would buy little and cost evidence support.

**Consequence for the plan.** Setup-review latency is not addressed by banding.
If that latency is the goal, the lever is how the range anchor is chosen — a
product decision about range selection, which the calibration measurement does
not speak to and which must not be inferred from it.

## 4c. Where the fork simulation earns its cost, and where it does not

The same question the plan started with — is a check over-engineered — has
opposite answers in the two halves of the system, because the owned-fork
simulation does a different job in each.

### Live: it is not gas estimation, and it is not redundant

`src/strategy/rangekeeper/fork-simulator.ts` is 119 lines and only one of its
assertions concerns gas. The rest assert **outcomes over a sequence**:

```
:41   assert(same(first.hash,source.hash),'Fork source differs from canonical observation')
:61   assert(receipt.status==='success',`Fork ${plan.kind} reverted`)
:104  assert(plan?.kind==='mint','Post-swap fork mint is infeasible or missing a preapproval')
:112  assert(current.position?.liquidity>=mintPlan.candidate.liquidity)
```

It executes approve → swap → approve → mint against the exact canonical block
and checks every stage succeeds and that the resulting position carries the
liquidity the plan claimed.

`eth_estimateGas` cannot answer that. It validates one transaction against
current state. It cannot establish whether a mint will be feasible *after* a
swap that has not happened yet — and the swap is the irreversible step. By the
time an estimate could report the mint failing, the inventory is already
converted and the exposure is already taken.

This is not hypothetical. Per the [activation record](../operations/rangekeeper-activation-2026-09-21.md),
the first 40-tick live attempt completed its swap and then missed the mint
floor. That is exactly the failure the sequence rehearsal exists to catch, and
the remedy was reordering so both mint legs are preapproved before the swap.

The per-submission `estimateGas` at `live-controller.ts:464` and `:667`, and
the signed-approval recheck at `live-pilot/controller.ts:193`, answer a
different question — will this one transaction succeed now, and cost what. The
two are complementary, not duplicated.

### The economics are inverted between the two halves

| | Paper | Live |
| --- | --- | --- |
| Runs on | every interactive setup review | `start()`, `rearmUntraded()`, `resumeCosted()` only |
| Frequency | every operator click | about three economic actions per 12-hour scope |
| Share of latency | ~35 s of a 43–47 s wait | negligible, off the interactive path |
| What the number authorizes | a displayed estimate and an admission limit | a real broadcast of real funds |

Same mechanism, opposite cost-benefit. In paper it dominates an interactive
wait and gates nothing that moves value. In live it is cheap and gates
everything.

### The cheaper substitute, and its real limit

`eth_simulateV1` is available on the configured provider; `debug_traceCall` is
not (paid tier). A single request with a state override and two sequenced calls
returned:

```
call 0: status=0x1  gasUsed=57,976   (cold slot)
call 1: status=0x1  gasUsed=38,076   (warm slot)
```

That demonstrates per-call gas attribution, execution over evolving state — the
~20k delta is the cold-slot cost — state overrides, and sequencing, in under a
second against roughly 35 s for anvil. The cold figure is within **1.4%** of the
fork's 58,801 for the same stage.

For context, the fork's estimates are conservative against realized on-chain
gas from the live pilot (NVDA/USDG, so indicative rather than like-for-like):

| Stage | Realized avg | Realized max | Fork estimate |
| --- | ---: | ---: | ---: |
| approve | 48,129 | 63,649 | 58,801 |
| mint | 435,008 | 465,940 | 490,249 |
| withdraw | 212,820 | 227,811 | 290,863 |

Always above realized, before `gasUnitsBound` adds a further 30%.

**Corrected on validation — the provenance claim below was wrong.** This
section originally argued that a provider simulation "can be told which block to
use but cannot prove which state it used". Tested directly: `eth_simulateV1`
returns a `parentHash` that matches an independently fetched canonical hash of
the pinned block, on the live tip and on an archive block, and it rejects a
future or invalid block tag outright. That is the same check the fork's
`first.hash===source.hash` assertion performs, and against the same provider.

The real residual difference is narrower and worth stating accurately: the fork
fetches state and then **executes locally** in anvil, whereas `eth_simulateV1`
executes **on the provider**. So what substitution actually costs is execution
independence, not state identification — a provider that misreports execution
would be caught by the fork and not by the simulation. That still argues for
keeping the fork where it validates a broadcast, because there the provider
checking the plan is the provider carrying it out. It is a much weaker argument
than the one this section originally made, and it does not apply to paper at
all, where nothing is broadcast.

### Validated: all six stages reproduce

Run on 2026-09-30 against an unmodified fork sample of the **identical
candidate and frame**, which is a stronger comparison than matching bands in the
database — same block, same calldata.

| Stage | simulateV1 | fork | Δ |
| --- | ---: | ---: | ---: |
| approve_token0 | 57,988 | 58,801 | −1.38% |
| approve_token1 | 63,649 | 64,484 | −1.29% |
| mint | 468,434 | 490,390 | −4.48% |
| withdraw_collect | 233,479 | 290,934 | −19.75% |
| cleanup_token0 | 38,040 | 38,406 | −0.95% |
| cleanup_token1 | 43,653 | 44,030 | −0.86% |

All inside the 30% `gasUnitsBound` margin, reproduced across two independent
runs. Gas sampling drops from ~19–22 s and 122 requests to **~0.4 s and two
requests**, roughly 50× faster; slot discovery is a one-off 63-request cost per
token pair rather than per sample.

On `withdraw_collect`, the stage with the largest divergence, the simulation is
**closer to realized on-chain gas than the fork is**. Against the live pilot's
43 confirmed withdrawals (NVDA/USDG, so indicative rather than like-for-like),
which realized 212,820 average and 227,811 maximum: the simulation's 233,479 is
2.5% above the realized maximum, while the fork's 290,934 is 28% above it. The
divergence is the fork being more conservative, not the simulation being wrong.

Two bugs were found and fixed in the probe itself during validation — a
balance-slot override keyed to the discovery holder rather than the funding
account, and a timer that included the fork's own wall clock in the
simulation's measured time — which is worth noting because both would have
flattered or broken the result silently.

### Blocked on a policy decision, found while wiring it in

Two facts surfaced during implementation that change what the substitution
*means*, and the second is not a technical question.

**The fork's slot discovery is not portable.** It finds each token's balance
storage slot by differencing `debug_traceCall` prestate traces — run against its
own anvil, where tracing is free. Against the configured provider that method is
paid-tier only (verified: "debug_traceCall is not available on the Free tier").
A simulation sampler must therefore scan storage slots instead, which is
layout-dependent and is also what explains the `withdraw_collect` divergence:
the probe overrode the recipient's balance slot cold, where the fork funds by a
real donor transfer that warms it. Mitigable by falling back to the fork on any
discovery failure, so no new failure mode reaches an operator.

**The recorded number is not the number the simulation produces.** The stage
model's `gasUnitsExpected` is the node's `eth_estimateGas` result — schema basis
`node_estimateGas_with_paper_prestate_and_parent_component` — not executed gas.
Against the retained 2026-09-22 calibration artifact, `parentGas` is **0 on all
six stages**, so this chain has no L1 data component to lose. But the estimate
sits above actual execution, and `eth_simulateV1` reproduces *actual* execution
essentially exactly:

| Stage | fork `localGasUsed` | simulateV1 | fork `estimate.gas` (recorded) |
| --- | ---: | ---: | ---: |
| approve_token0 | 57,988 | 57,988 | 58,801 |
| approve_token1 | 63,649 | 63,649 | 64,484 |
| cleanup_token0 | 38,040 | 38,040 | 38,406 |

So section 4c's "−1.38% to −19.75% versus the fork" is more precisely *actual
execution versus the estimator's padding*, which ranges from ~1.4% on the
approvals to ~21% on `withdraw_collect`. The simulation is not less accurate;
it measures a different and arguably truer quantity.

**The decision.** Substituting changes the recorded figure from "the node's
estimate" to "simulated actual", lowering recorded gas units by 1–21% and
removing an implicit margin, while the explicit `gasUnitsBound = 1.3×` stays.
That is a deliberate change to how conservative the cost model is, and it
belongs to whoever owns the risk rather than to whoever noticed it.

Implemented so far: the evidence contract now carries the method that produced
each stage and binds the stored evidence class to it, so simulated gas can never
be read back as fork gas. That is a strengthening and is independent of the
decision above. The simulation sampler itself is not written.

### Position

- **Live: keep it.** It is the only check that establishes whole-sequence
  feasibility before an irreversible step, it costs nothing on the interactive
  path, and its independence from the broadcast provider is a feature.
- **Paper: replace it.** Validated above: all six stages reproduce inside the
  existing margin, ~50× faster, and on the one divergent stage the simulation
  tracks realized gas more closely than the fork does.

Remaining gaps, both bounded and neither a blocker: the `withdraw_collect`
divergence has a plausible but unconfirmed cold-versus-warm SSTORE explanation,
and at production's 50 bps slippage this candidate was observed reverting
repeatedly before the override bug was found, which was not re-checked at 50 bps
afterwards. That revert condition deserves separate attention on its own terms.
Close-convert's swap-involving stages were out of scope and remain unvalidated.

## 5. Proposed order

1. ~~**Band size and share; keep the tick range pinned exactly**~~ (category 4).
   **Done** — see section 4b. Bounds band growth to distinct tick ranges, which
   was the lockout driver. It does not reduce setup-review latency; that needs
   the range-anchor question, which is out of this plan's scope.
2. ~~**Split replay-from-pinned versus verify-now**~~ (category 2).
   **Withdrawn** — the split already exists; see the retraction above. No work
   to do, and doing it would have churned the accounting path for nothing.
3. ~~**Derive freshness windows from measured latency**~~ (category 3).
   **Done, and half of it retracted** — see sections 3 and 3b. The fee-cursor
   budget is raised and self-measuring; the preview-TTL proposal was inert and
   is withdrawn.
4. ~~**Validate `eth_simulateV1` against the existing bands**~~ (section 4c).
   **Done** — all six stages reproduce inside the existing margin, ~50× faster.
   The remaining work is to wire it into the paper sampler behind the existing
   evidence contract, keeping the live fork. This is the one change still
   outstanding that reduces setup-review latency.
5. **Leave close and convert until last.** 223 failure codes across 13 modules,
   for an operation that has never once completed, is not a tuning problem. Its
   contract needs restating before its gates can be pruned safely, and it is
   the one path where removing a check is most likely to lose something real.

## 6. Out of scope

- Any change to the commit-time recheck, idempotency binding, append-only
  guards or anchor verification (category 1).
- Any change that widens a bound without a measurement behind it.
- Any change to the live RangeKeeper controller's custody rules, or to its
  fork simulation, which section 4c concludes should stay.
- Route or authentication changes to the operator surface, which stays at
  `/operator` per the September 30 decision.
