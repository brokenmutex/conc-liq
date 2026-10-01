# RangeKeeper gas vs. absolute tick position — October 1, 2026

Status: measurement only. No `src/` change is made by this document and
nothing here authorizes execution, registers gas evidence, or changes the
`rk_` band key. This follows up
[RangeKeeper gas banding](rangekeeper-gas-banding-2026-09-30.md) section 7,
whose recommended band key, `{poolAddress, pathVersion, tickLower,
tickUpper}`, pins the exact absolute tick range — and asks the question
that review's own gradients never isolated: **does gas depend on where a
range sits (absolute tick position), independent of how wide it is?**
Section 5 of that review varied width at a fixed center; it never varied
the center at a fixed width. This review does.

Script: `scripts/analysis/rangekeeper-size-gradient-gas.ts`, modes
`range_position` and `swap_position` (new in this review; `no_swap`,
`swap`, `range` and `both` modes are untouched — same code paths, same
default behavior, verified by re-running `npm run check`, 979 tests / 85
suites / 0 fail, unchanged from the `4499a05` baseline). Worktree
`.claude/worktrees/agent-a467ebbdeaf750ac4`, HEAD `4499a05` ("docs: record
the RangeKeeper setup contract") before this review's own commit — the
worktree was stale at `60d2625` on creation and was fast-forwarded to
`main` (`4499a05`) before any measurement was taken, per this task's setup
requirement. All database access was read-only
(`DeploymentStore.paperSetupProfile`); no row was inserted, updated or
registered. All RPC calls were reads (`eth_getBlock*`, `eth_call` for the
quoter and, for the root-cause check in section 3, a direct `ticks(int24)`
read against the live pool at a historical block) or an owned local Anvil
fork spun up per sample; no transaction was broadcast against the live
provider. Credentials were loaded in-process from
`/root/conc-liq/data/static-paper-mvp-dashboard-feedback-2026-09-28.env`,
the same file the prior review used — never echoed.

Pool: `a8e7096f-17c3-452c-a72f-8fa962e586d2` (AAPL/USD, fee 500,
tickSpacing 10) — the same pool every gradient in the prior review used.

## 1. Method and the confound this review exists to avoid

A Uniswap V3 range that sits entirely above or below spot mints
single-sided liquidity — a different code path and token-transfer pattern
than a straddling range. Sliding a range up or down naively would confound
"absolute tick position" with "one-sided vs. two-sided mint." This review
controls for that explicitly:

- **One pinned canonical source frame** per run (read once via
  `readCanonicalPaperOpenFrame`, reused for every sample in that run) —
  pool state drift cannot explain any spread measured.
- **Fixed width, fixed capital.** `fullWidthSpacings=20` (200 raw ticks,
  spacing 10 — the NVDA-500 production default, same as the prior review's
  base case) and a fixed 25 USDG capital, identical across every sample in
  the `range_position` gradient. Only the range's **center** varies,
  shifted by a small number of tick spacings (`RK_POSITION_SHIFTS`,
  default `-5,-3,-1,0,1,3,5`) around the pinned tick — the mirror
  experiment to the prior review's section 5, which shifted width at a
  fixed center.
- **A hard two-sidedness guard, enforced twice.** A new `shiftedRangeFor`
  helper refuses (returns `null`, logged and skipped, not silently
  substituted) any shift that would leave the pinned spot tick within
  `RK_POSITION_MARGIN_TICKS` (default 20) raw ticks of either edge. Every
  sample additionally checks `sized.mint.amount0 > 0n && sized.mint.amount1
  > 0n` after sizing and skips (logged) rather than samples a candidate
  that sizing reduced to single-sided. No skip fired in either run reported
  below — every sample is confirmed two-sided by construction and by
  runtime check, not by assumption.
- Candidates are built with the same sizing primitive production uses,
  `sizeRangeKeeperMint`, exactly as the prior review did.

`buildScope`/`runSample` were generalized to accept an explicit range
parameter defaulting to the module-level pinned `range`, so the existing
`no_swap`/`swap`/`range`/`both` modes are byte-for-byte unchanged when that
parameter is omitted — verified by diff and by the unchanged `npm run
check` result.

## 2. Measured: at fixed width, absolute position moves gas almost as much
## as width itself does

Pinned source block `77183500`, tick `218211`, poolLiquidity
`798590986566410088`. Seven shifts of a fixed 200-tick-wide range around
that tick, fixed 25 USDG capital (deployed value and liquidity varied by
≤0.07% across all seven — the prior review's own size/share gradient
already puts an effect that small at noise level, so it is not a
confound here).

| Shift (spacings) | Range | open_mint | exit_withdraw_collect | TOTAL |
| ---: | --- | ---: | ---: | ---: |
| -5 | 218060/218260 | 493,881 | 257,344 | 1,049,753 |
| -3 | 218080/218280 | 540,461 | 279,487 | 1,118,464 |
| -1 | 218100/218300 | 540,530 | 279,564 | 1,118,610 |
|  0 | 218110/218310 | 459,496 | 257,431 | 1,015,443 |
|  1 | 218120/218320 | 459,245 | 274,675 | 1,029,446 |
|  3 | 218140/218340 | 540,421 | 290,612 | 1,126,559 |
|  5 | 218160/218360 | 534,842 | 296,643 | 1,127,023 |

**Per-stage spread across the seven samples:** `open_mint` 17.70%,
`exit_withdraw_collect` 15.27%, `exit_cleanup_manager_token0` 7.64% (two
discrete values, 42,121 vs. 39,131 — see section 4), everything else
(approvals, router cleanups, manager-token1 cleanup) flat at ≤0.02%.
**TOTAL spread: 10.99%.**

For comparison, the prior review's section 5 (width varied, center fixed)
measured 18.58% on `open_mint` and 11.11% total across a **20× width
span**. This review measures 17.70% / 10.99% from shifting the center by
at most **5 tick spacings (50 raw ticks) each way — 2.5% of the range's
own 2,000-tick full span** (shift ±5 of a ±100-tick half-width, i.e. a
tiny fraction of the range's own extent, not a large excursion). Position
moves gas by almost exactly as much as a 20× width change does, from a
far smaller perturbation. **This directly contradicts the premise that
width alone could stand in for position: at fixed width, position is at
least as strong a driver as width was found to be.**

## 3. Root cause, confirmed directly (not inferred): cold vs. warm tick
## initialization, not distance from the current tick

The shape in section 2's table is not smooth in shift — it is **bimodal**:
shift -5/0/1 sit near 459–494k on `open_mint`; shift -3/-1/3/5 sit near
540k, a ~80k (17%) step between two clusters that does not track |shift|
monotonically (shift -5, the *largest* magnitude in the low cluster, is
further from shift 0 than shift -3 or -1, which are in the *high*
cluster). That shape is the same "step, not slope" signature the prior
review flagged for `open_swap`'s size dependence (section 4 there) and
attributed, without instrumentation, to a cold-vs-warm SSTORE from
crossing an initialized tick. This review checked that hypothesis
directly rather than inferring it: a read-only `ticks(int24)` call against
the live pool contract, at the exact pinned block, for each of the
fourteen tick boundaries used.

| Shift | tickLower | initialized | tickUpper | initialized | open_mint |
| ---: | ---: | :---: | ---: | :---: | ---: |
| -5 | 218060 | true | 218260 | true | 493,881 |
| -3 | 218080 | **false** | 218280 | **false** | 540,461 |
| -1 | 218100 | **false** | 218300 | **false** | 540,530 |
|  0 | 218110 | true | 218310 | true | 459,496 |
|  1 | 218120 | true | 218320 | true | 459,245 |
|  3 | 218140 | **false** | 218340 | true | 540,421 |
|  5 | 218160 | **false** | 218360 | **false** | 534,842 |

**Every sample where both boundary ticks were already initialized
(nonzero `liquidityGross`, from other LPs' existing positions) falls in
the low cluster; every sample where at least one boundary was
uninitialized falls in the high cluster — exact agreement, 7 for 7.**
This is the standard Uniswap V3 mechanism: `Tick.update` flips a tick's
`initialized` bit (and writes the tick-bitmap word) only on a zero↔nonzero
transition; initializing a previously-empty tick pays a cold `SSTORE`
(~20k gas) that updating an already-nonzero tick does not. Shift -1 and
shift 0 are only **one tick spacing (10 raw ticks) apart** and land in
opposite clusters — a 17.6% `open_mint` swing from the smallest possible
position change this pool's granularity allows.

`exit_withdraw_collect` correlates with the same split directionally
(both-initialized mean 263,150 vs. not-both mean 286,576) but less
cleanly — shift 1 (both initialized) reads 274,675, between the two
cluster means, not with the low group. `exit_cleanup_manager_token0`'s
two-valued split (42,121 for shifts -5/-3/-1/0, 39,131 for shifts 1/3/5)
does not align with the initialization split at all (shift 1 is
both-initialized but reads the low value; shift -5 is also
both-initialized but reads the high value). **This review did not
instrument those two residual effects further and reports them as
observed but not fully explained** — see section 5.

Ruled out as alternative explanations: liquidityGross at the "warm" ticks
(1.5e14–1.6e16) is 1–100× larger than the liquidity this review's mint
adds (~1.37e14), so burning it on exit cannot zero the tick back to
uninitialized (no "clear tick" delete/refund asymmetry); all fourteen
boundary ticks fall in the same tick-bitmap word (word 85 at this
tickSpacing), so no word-boundary-crossing effect is in play; deployed
value and liquidity varied ≤0.07% across the seven samples, far below the
size/share effect's own noise floor from the prior review.

## 4. Secondary check: is the `open_swap` step itself position-dependent?
## No — and the reason is structural, not just empirical

The prior review found `open_swap` stepping 4.97% between 25 and 100 USDG
swap input, flat beyond. Run at a shifted, uninitialized-boundary range
(shift=5, 218160/218360 — the "high" cluster from section 3) instead of
the tick-centered range:

| Stage | 25 USDG | 100 USDG | Spread |
| --- | ---: | ---: | ---: |
| open_swap | 180,457 | 189,339 | 4.92% |
| open_mint | 539,621 | 539,684 | 0.01% |
| TOTAL | 1,366,368 | 1,375,347 | 0.66% |

4.92% at shift=5 vs. 4.97% at shift=0 — the step reproduces almost
exactly. **But this is close to a structural certainty, not just an
empirical finding:** the `open_swap` stage trades through the pool's
*current* price via `RangeKeeperChain.quote`, entirely independent of
which range the candidate will mint into afterward — the swap never reads
or writes `candidate.range`'s boundary ticks at all. This check confirms
the LP range's position does not leak into swap gas (it structurally
cannot, in this code path), not that swap gas is position-independent in
general. Whether the step's *location* depends on where the *current
price* sits relative to nearby initialized ticks — a different notion of
"position," tied to the swap's own path through tick space rather than
the eventual mint's range — is a question this review did not attempt
(it would require different pinned frames at genuinely different current
ticks, not a shifted mint-destination range) and does not answer. Two
samples only; this did not displace the primary question's budget.

## 5. What this does not cover / what contradicts or qualifies this review

- **Only one frame, one small neighborhood, one pool.** All seven
  `range_position` samples sit within ±50 raw ticks of one pinned tick
  (218211) in one pool (AAPL/USD-500). Production recenters can land
  arbitrarily far from any previously-sampled tick as price drifts over
  longer horizons; this review did not and could not sample that — it
  shows position matters *locally*, not what the distribution of spreads
  looks like across a realistic recenter history.
- **The mechanism found is not a fixed property of the range — it is a
  property of the pool's current occupancy at two specific ticks.**
  This is the review's central qualification of the gas-banding review's
  section 7 recommendation. Pinning `{poolAddress, pathVersion, tickLower,
  tickUpper}` fixes *which* ticks matter, but not *whether* they are
  initialized — that depends on whether some other LP currently has a
  position with a boundary at that exact tick, which can change over time
  independent of anything RangeKeeper does. A band sampled while a
  boundary happens to be warm could go stale (silently, from the band
  consumer's point of view, since nothing about the pinned key itself
  changed) if that other LP later withdraws and the tick cools. This
  review did not measure how often that happens — it would need
  historical tick-initialization churn data this review did not collect.
- **`exit_withdraw_collect`'s correlation with the initialization split is
  directional but not clean (section 3)** — one of seven samples (shift 1)
  does not sort with its cluster. Do not read the withdraw-side finding as
  having the same evidentiary strength as the `open_mint` finding, which
  is a clean 7-for-7 split.
- **`exit_cleanup_manager_token0`'s two-valued spread (7.64%) does not
  track the initialization split at all** and was not otherwise explained.
  It is a real, measured effect, reported without a mechanism.
- **The swap-position check (section 4) is a near-tautology by
  construction**, not strong evidence about swap-gas position-dependence
  in general — see section 4's own discussion. It should not be read as
  settling whether swap gas depends on absolute position; it only shows
  the *mint destination's* position does not leak into the *swap's* gas,
  which the code structure already guarantees.
- **Sample count: 9 fork samples total** (7 for the primary
  `range_position` gradient, 2 for the secondary `swap_position` check),
  plus 14 free read-only `ticks()` lookups (no fork needed) for the
  root-cause check in section 3. Chosen deliberately small — each fork
  sample costs roughly 30s, and the design prioritized a clean, narrow,
  well-controlled comparison (one frame, one width, small symmetric
  shifts) over a wide sweep that would cost more samples without
  necessarily clarifying the mechanism. Per-sample wall-clock numbers
  appear in the raw script output but are not reported as measurements
  here — other agents share this box, and a timing number taken now would
  be unreliable; gas units, not wall-clock, are what the fork makes
  deterministic.

## 6. Recommendation

**The evidence rules out keying on width alone.** Section 2's position
gradient, from a far smaller perturbation (±5 spacings) than the prior
review's width gradient (20× span), produced a comparably large spread
(17.70% mint / 10.99% total here vs. 18.58% / 11.11% there). If width were
the only driver, a ±5-spacing shift at fixed width should have moved gas
negligibly, the way the prior review's size/share gradients did (≤0.08%
per stage). It did not. **Position is not a dimension that can be folded
into a width-only band — the evidence requires pinning absolute ticks**,
consistent with the gas-banding review's section 7 recommendation.

**But pinning exact ticks is necessary, not obviously sufficient, for a
stable band**, which section 5's central qualification spells out: the
mechanism this review isolated (section 3) is not a geometric property of
the range itself but a transient property of the pool's occupancy at two
specific ticks, controlled by other market participants, not by
RangeKeeper or by price. A `{poolAddress, pathVersion, tickLower,
tickUpper}` key is stable against *RangeKeeper's own* recenters (same
range sampled twice gets the same key, which is the win the re-key is
for), but this review found a second failure mode the original
recommendation did not anticipate: the SAME pinned key's true gas cost
can drift over time as *other* LPs' positions at those exact boundary
ticks come and go. Whether that drift is common enough to matter in
practice is unmeasured here (section 5) and would need production
tick-initialization churn data, the same way the original review flagged
unmeasured range-recurrence rate as an open question for the re-key.

**Within the 30% `gasUnitsBound` margin** (`expected * 13 / 10` in
`src/deployments/paper-gas-sampler.ts` and
`src/deployments/paper-gas-simulation-sampler.ts`), the spreads measured
here (10.99% total, 17.70% on `open_mint`) fit comfortably — but section 5
already flags that this was measured in one small neighborhood of one
frame, not across the range of positions a real recenter history would
visit, so this is **not a claim that every possible pinned-tick band
sits inside that margin**, only that this review's own samples do.

**Practical implication for the re-key:** pin exact ticks as proposed (do
not band by width alone — section 2 rules that out), but do not treat a
pinned-tick band as permanently valid the way the structural fix for
`candidateHash` makes it *reusable* across identical opens (gas-banding
review section 0). The `initialized`-state mechanism found here means a
pinned-tick band's accuracy can degrade from causes outside RangeKeeper's
own control, which argues either for periodic resampling even of
previously-banded ranges, or for a cheap freshness check (e.g., reading
`ticks(tickLower)`/`ticks(tickUpper)`'s `initialized` bit, far cheaper
than a full fork sample) before trusting a cached band — a design this
review surfaces but does not specify further, since that is a `src/`
change and out of scope here.
