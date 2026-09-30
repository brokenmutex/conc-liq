# eth_simulateV1 gas-validation — September 30, 2026

This follows up
[operation gate simplification](../plans/operation-gate-simplification-2026-09-30.md)
section 4c / section 5 item 4: validate whether `eth_simulateV1` can reproduce
the six static/no-swap paper-open gas stages that
`src/deployments/paper-gas-sampler.ts` samples on an owned anvil fork
(`approve_token0`, `approve_token1`, `mint`, `withdraw_collect`,
`cleanup_token0`, `cleanup_token1`), and at what latency and request cost.
Only `approve` had previously been demonstrated, via a two-call probe cited
in that plan. This record demonstrates all six, on live provider state, and
states two findings that contradict assumptions in the source plan.

No `src/` file was changed. Everything in this record is read-only:
`eth_simulateV1`, `eth_call`, `eth_getStorageAt`, `eth_getBlockByNumber` and
`eth_blockNumber` against the live provider; the fork comparison runs the
**unmodified** `sampleStaticPaperGas` unchanged, exactly as production calls
it; database access is `SELECT`-only. No transaction was broadcast, no
draft/preview/operation was created, and nothing was written to
`deployment_calibration_profiles`.

- Script: `scripts/analysis/simulate-gas-probe.mjs`.
- Branch: `agent/simulate-validation`, HEAD `4f0c56db6e1e1bf635df99bcff7dbbcdb46ad7bd`,
  merged with `main` at `fc4291d` (which added gas banding, `paperGasBand`,
  model `schemaVersion` 2 and the `range_<hash>` band key — this record
  compares against that current schema; see the DB-comparison note below).

## Method

The script reproduces `paper-gas-sampler.ts`'s own first step — it calls the
unmodified `buildIndicativePaperOpenPreview(draft, frame)` against a **live**
canonical frame (`readCanonicalPaperOpenFrame`), using the same
`buildStaticPaperSetupPreflight` path `scripts/analysis/size-gradient-gas.ts`
already uses to size `draft.allocation`. This guarantees the candidate (tick
range, mint amounts, slippage minimums, deadline, recipient) is the same
object the fork sampler would build from the same draft/frame — not a
re-derivation that could silently diverge.

It then runs two things against that one candidate/frame:

1. **The unmodified `sampleStaticPaperGas`** (owned anvil fork) — ground
   truth, run fresh on this exact candidate rather than compared against a
   historical DB band that might sit at a different tick range.
2. **The `eth_simulateV1` sequence**, built independently:
   - `approve_token0`, `approve_token1`: plain calldata, no overrides needed
     beyond `PAPER_ACCOUNT`'s native balance (for gas; `validation:false` is
     also set, so this isn't strictly required, but it's set anyway).
   - `mint`: needs real token balances. The ERC20 balance mapping slot for
     each pool token is discovered by brute-force `eth_getStorageAt` probing
     — classic sequential slot indices first (token0 matched slot `1`), then
     OpenZeppelin's ERC-7201 namespaced layout (token1 matched
     `openzeppelin.storage.ERC20`, field offset `0`; token1's 568-byte
     bytecode is thin enough that it's evidently a proxy over a shared
     implementation using namespaced storage, which is why the classic scan
     alone doesn't find every token). The discovered slot is then re-keyed
     for `PAPER_ACCOUNT` specifically (see "what went wrong" below) and set
     via `stateDiff` overrides for `amount0Desired`/`amount1Desired`.
   - `withdraw_collect`: needs the NFT position `mint` creates, in the same
     sequence. Handled with two `eth_simulateV1` round trips at the identical
     pinned block and identical state overrides: round trip A runs
     `[approve0, approve1, mint, pool.slot0()]` and decodes the tokenId,
     liquidity and post-mint price from the **return data of that same
     response** — nothing is assumed from the fork or the DB. Round trip B
     then runs the full six-call sequence
     `[approve0, approve1, mint, withdraw_collect(multicall), cleanup0, cleanup1]`
     using that tokenId/liquidity/price, and its own re-decoded mint result is
     checked against round trip A's for consistency. This is not one atomic
     round trip: `eth_simulateV1`'s call list is static, so a value only
     knowable from an earlier call's return data cannot be woven into a later
     call's calldata within the same request. Determinism across the two
     round trips (same pinned block, same overrides, same calls up to that
     point) was checked, not assumed — see the result below.
   - `cleanup_token0`, `cleanup_token1`: plain `approve(...,0)` calldata.

All six stages reproduced successfully. No stage failed to reproduce.

## What went wrong before it worked

Two defects were found and fixed during this validation, both in the script,
not in any production code:

1. **Balance overrides landed on the wrong address.** The slot-discovery
   function used the pool address as the "holder" to compare
   `eth_getStorageAt` reads against `balanceOf` (the pool is guaranteed to
   have a nonzero balance of both tokens; `PAPER_ACCOUNT` starts at zero, so
   it can't be used to discover which slot index is live). The bug: the
   function returned the **storage key already bound to the pool's own
   address**, and the override then wrote that key — silently crediting the
   pool's balance slot with the funding amount while leaving
   `PAPER_ACCOUNT`'s own balance at zero. `approve` doesn't care about
   balance, so both approvals still returned `status: 0x1`; `mint` then
   reverted (`status: 0x0`) on `transferFrom`, consistently, because the
   funded account was never actually funded. Fixed by having discovery return
   the slot index/base only, and re-deriving `keccak256(abi.encode(PAPER_ACCOUNT, slot))`
   at the override call site.
2. **Timing accounting bled the fork's wall-clock time into the
   `eth_simulateV1` total**, because the elapsed-time timer was started before
   the retry loop and read again after the (separately timed) fork run had
   already executed in between. Fixed by snapshotting elapsed time
   immediately after the candidate/prediction step and before the fork runs,
   and reporting `gasSamplingOnlyMs` (the two `eth_simulateV1` round trips
   only) as the number directly comparable to the fork's own sampling time.

Both are recorded here because the first one, before it was found,
produced a false signal that looked exactly like a slippage-floor revert
(`amount0Min`/`amount1Min` too tight against the independently-derived
reference price) — an isolated debug pass with `amount0Min=amount1Min=0`
ruled that out before the real cause was traced to the override address.
That debug step is worth naming because it's the difference between
concluding "this candidate is economically unviable right now" (wrong) and
"the override was wrong" (the actual, fixable cause).

## Per-stage comparison

One representative run (source block `76672784`, tick `218127`, candidate
range `218070/218190`, `deployedValue≈250 USD`), against the unmodified fork
sampler run on the identical candidate/frame. A second, independent run
minutes later (block `76673244`, same tick/range — the pool genuinely wasn't
trading between runs) reproduced every sim and fork gas figure exactly,
confirming both methods are deterministic given identical pinned state.

| Stage | sim gas | fork gas | Δ% | fork's own bound (×1.3) | sim as % of fork's bound |
| --- | ---: | ---: | ---: | ---: | ---: |
| approve_token0 | 57,988 | 58,801 | −1.38% | 76,442 | 75.9% |
| approve_token1 | 63,649 | 64,484 | −1.29% | 83,830 | 75.9% |
| mint | 468,434 | 490,390 | −4.48% | 637,507 | 73.5% |
| withdraw_collect | 233,479 | 290,934 | −19.75% | 378,214 | 61.7% |
| cleanup_token0 | 38,040 | 38,406 | −0.95% | 49,928 | 76.2% |
| cleanup_token1 | 43,653 | 44,030 | −0.86% | 57,239 | 76.3% |

All measured (both sim and fork gas figures are the two methods' own gas
readings from this run; the ×1.3 bound and the "% of bound" column are
computed from them, not cited).

**Every stage sits comfortably inside the existing 30% margin
(`gasUnitsBound = ceil(expected × 13/10)`)** — the bar the plan sets. The
tightest is `withdraw_collect` at 61.7% of the fork's own bound; the loosest
five sit at 73.5–76.3%.

**`simulateV1` is lower than the fork on every stage** (all deltas negative).
For five stages the gap is 0.9–4.5%; `withdraw_collect` is an outlier at
19.75%. A plausible (not confirmed) explanation: the fork funds
`PAPER_ACCOUNT` via a real `transfer()` from a donor, so its balance word for
each token is a genuinely-written nonzero value before `mint` consumes most
of it, typically leaving some dust; this script funds the same amount via a
direct storage override to the exact mint requirement, which — if the
override leaves the post-mint balance at exactly zero where the fork's
organic transfer leaves a nonzero remainder — would make `collect`'s token
transfer into a **cold zero-to-nonzero** `SSTORE` (~20,000 gas) in one path
and a warm nonzero-to-nonzero write (~5,000 gas) in the other. The ~57,000-unit
gap between the two `withdraw_collect` readings is consistent with that
magnitude but this was not independently instrumented to confirm it; it is
reported as the most likely explanation, not a verified one.

Both readings stay **above the realized on-chain gas from the live pilot**
cited in the source plan's indicative comparison (approve avg 48,129 / max
63,649; mint avg 435,008 / max 465,940; withdraw avg 212,820 / max 227,811) —
`sim`'s mint (468,434) and withdraw (233,479) both clear their respective
realized maxima; `sim`'s approve (57,988/63,649) sits above the realized
average and at/near the realized max. Because `gasUnitsBound` is computed
from whichever `expected` value is used, a lower `sim` base still yields a
bound comfortably above the realized historical range in every stage here —
the 30% margin is not eaten away, it is just computed over a smaller
starting number.

### DB calibration-band comparison

`store.paperGasProfiles(pool, tickLower, tickUpper)` — the same bounded,
public, read-only lookup the resolver itself uses — was queried for the
exact candidate's tick range (`218070/218190`) at each run. No row exists at
that exact range: **expected, not a gap in this script.** Per section 4b of
the source plan, the live tick range changes on most consecutive reads, and
historical bands only accumulate at ranges that recur; this run's range was
sampled live moments earlier and is not one of the 27 historical bands
(11 distinct ranges) already in the table. The comparison against the
**freshly run, unmodified fork sampler on the identical candidate** (the
table above) is the comparison this script actually relies on — it is
strictly stronger than a DB-band comparison would be, because it holds
tick range, block, candidate and calldata identical rather than merely tick
range.

Separately, a manual query (not through this script) confirmed
`store.paperGasProfiles` returns real `schemaVersion: 2` banded rows with
`range_<hash>` size bands for other, previously-sampled tick ranges (e.g.
`range_d454a247a55e93e5bed2efc7bb270c9d` at `218240/218360`), so the lookup
path itself is exercised and working against the current (post-`fc4291d`)
schema; it simply found nothing at this run's particular live range, which
is the expected outcome.

## Block provenance

The source plan's stated argument against substitution was: *"A provider
simulation can be told which block to use but cannot prove which state it
used."* **This was tested directly and found not to hold, for `eth_simulateV1`
on this provider.**

`eth_simulateV1`'s response is a synthetic next block built on top of the
pinned block; its `parentHash` is independently checkable against the
canonical hash of that pinned block number (fetched separately via
`eth_getBlockByNumber`):

```
sim parentHash:        0x9e8dcb3874d8836d5379447809c393b6dab83bc6c0aeb4481949a9e2f5a60915
canonical block hash:  0x9e8dcb3874d8836d5379447809c393b6dab83bc6c0aeb4481949a9e2f5a60915
match: true
```

This was verified not just on the live tip (where a lenient provider might
special-case "latest") but also against an archive read of a historical
block from the DB's own calibration data (block `76517935`) — the returned
`parentHash` matched that block's real hash too, and that hash independently
matched the `sourceHash` already recorded in that DB row's
`canonicalAttestation` (`0x1b2418cd...`). Passing a block number past the
current tip (`0xffffffff`) was rejected by the provider outright rather than
silently clamped or served from a different block.

This is the same guarantee the fork's own
`assert(same(first.hash,source.hash),'Fork source differs from canonical observation')`
(`src/strategy/rangekeeper/fork-simulator.ts:41`) provides: independent proof
of which state was used, checked against a value the caller fetches itself
and that the simulation does not control. **The source plan's premise that
this specific property is unavailable through a provider simulation is
incorrect for `eth_simulateV1` on this provider** — flagging this because it
directly contradicts the brief's framing, not to relitigate the live/paper
recommendation in section 4c, which rests on a different, still-valid
argument (independence from the broadcast provider, not provability of block
state — a call from the same provider can prove which block it used while
still being the same provider that would broadcast a live transaction).

## TokenId determinism

Round trip A predicts the tokenId from `mint`'s decoded return data; round
trip B re-derives it independently in a full six-call sequence built from
that prediction. Both round trips start from the identical pinned block and
identical state overrides, so the position manager's internal counter should
advance identically. Checked, not assumed:

```
predicted: 1349954
confirmed: 1349954
matches: true
```

Held across both runs recorded above (a second pair, `1349956`/`1349956`,
also matched).

## Timing and request count

| | eth_simulateV1 | owned fork |
| --- | ---: | ---: |
| Gas-sampling-only time (directly comparable) | 401ms / 388ms (two runs) | 19.1s / 22.0s |
| Round trip A (predict) | 175ms / 174ms | — |
| Round trip B (final six-stage measurement) | 226ms / 214ms | — |
| Candidate/frame construction (shared overhead, not gas-sampling-specific) | 2,660–2,886ms | same step, shared |
| RPC requests, this run | 65 (63 of which are one-off slot discovery) | 122 (`readBudget.requests`) |

Gas-sampling-only time is **≈50–55× faster** than the fork (≈0.4s vs
≈19–22s). Request count is lower too (65 vs 122), though 63 of the 65 are
one-off slot-discovery probes that would only need to run once per token pair
in any real deployment (a constant per pool, not per sample) — the
per-sample request count for `eth_simulateV1` is 2 (round trip A + round trip
B), against 122 for the fork.

Candidate/frame construction (~2.1–2.9s, one live RPC round trip plus a DB
read) is common to both methods — a real "open" setup review needs a fresh
frame regardless of which gas-sampling technique runs after it — and is
excluded from the sampling-time comparison above. It is not the ~35–47s the
source plan attributes to the fork; that full figure already includes this
shared construction step plus the fork's own spin-up and execution, so the
fork-only sampling time measured here (19–22s) is somewhat faster than the
plan's ~35–40s citation, plausibly reflecting favorable network conditions or
fork startup variance on this run rather than a correction to the plan's
number.

## What was not tested

- **Slippage sensitivity of the candidate itself**, observed but not chased
  down: at the source plan's production default (50 bps), this exact
  candidate's `mint` reverted consistently across 8 retries over several
  minutes of frozen pool state (tick never moved) before this script was
  fixed to use 500 bps (the schema's own ceiling) for its own funding-only
  purposes. Once the real defect (wrong override address) was fixed, 500 bps
  succeeded immediately and reliably. Whether the *same* candidate would also
  have reverted at 50 bps after the override fix was not re-checked — the
  widened tolerance was kept because it isolates the question this script
  asks (does `eth_simulateV1` reproduce the fork's gas) from a separate,
  pre-existing question (does this candidate clear its own slippage floor at
  this instant), and because gas cost for a successful mint does not depend
  meaningfully on which slippage minimum was used, only on whether it clears
  at all. This is flagged, not investigated further, because it is outside
  this task's scope (validating `eth_simulateV1`, not auditing candidate
  construction) — but it is a real, observed revert condition that both the
  fork and `eth_simulateV1` would hit identically at production's tighter
  tolerance, and is worth someone's attention separately.
- Close-convert (`withdraw_collect` in that flow includes a swap) was out of
  scope; this script only covers the six static/no-swap open stages the
  source plan named.
- Repeated sampling across many distinct tick ranges (the size-gradient
  experiment's style) was not repeated here; two runs at one range confirm
  determinism but not range-to-range consistency of the ~20% `withdraw_collect`
  gap.

## Recommendation

**Validate `eth_simulateV1` for the paper gas sample only; keep the live
fork — consistent with the source plan's section 4c position, now with
evidence for the previously-untested stages.**

- All six stages reproduce, all comfortably inside the existing 30% bound
  margin (61.7–76.3% of the fork's own bound).
- Gas-sampling-only latency drops from ~19–22s to ~0.4s (~50–55×); per-sample
  RPC requests drop from 122 to 2 (plus a one-off 63-request slot discovery
  per token pair).
- Block provenance **is** provable via `parentHash`, contradicting the source
  plan's stated reason this couldn't be done — this removes what the plan
  called "the main argument against substitution" for the *provability*
  half of that argument specifically.
- The plan's other reason to keep the fork — independence from the same
  provider used for broadcasting — is untouched by this finding and remains
  a legitimate reason to prefer the fork specifically on the live path, where
  a real broadcast is at stake. It does not apply with the same force on the
  paper path, where nothing broadcasts and the number only sizes a displayed
  estimate and an admission limit (per section 4c's own economics table).
- The `withdraw_collect` stage's larger (though still in-bound) deviation and
  the systematic sim-below-fork direction across all six stages are real,
  reported findings that should inform how `gasUnitsBound` is validated if
  this is adopted, not reasons to withhold the recommendation.

**Confidence: moderate-high for paper.** The mechanism works, reproduces
cleanly across two independent runs, and answers the one structural doubt
(block provenance) the source plan raised against it. The `withdraw_collect`
gap is unexplained with certainty and the retry/slippage behavior at
production's default tolerance was not re-verified after the override fix —
both are bounded, reportable gaps rather than blockers, and both would be
cheap to close with one or two more runs before this is relied on in
production.

Nothing here changes the section 4c recommendation to **keep the fork on the
live path**: that conclusion rests on independence from the broadcast
provider, not on provability of block state, and this run does not test or
weaken that argument.
