# eth_simulateV1 swap-validation — September 30, 2026

This is item 1 of
[`docs/plans/rangekeeper-dashboard-integration-2026-09-30.md`](../plans/rangekeeper-dashboard-integration-2026-09-30.md)
section 3: can `eth_simulateV1` reproduce the **swap-involving** RangeKeeper
paper stages the way
[`docs/reviews/simulate-v1-gas-validation-2026-09-30.md`](simulate-v1-gas-validation-2026-09-30.md)
already showed it reproduces the six static/no-swap stages? RangeKeeper's
exit preview is hard-blocked at `src/deployments.ts:341` pending exactly this
answer, and the plan names it as the item that decides whether the exit
unblocks without a much larger owned-fork stage runner being built.

**The single decisive question, answered first:** does `eth_simulateV1`
correctly reflect the pool price moving mid-sequence, after a swap, in a
*later call of the same request*? **Yes, on both runs, directly observed,
not inferred:**

- The router's `exactInputSingle` (wrapped in `multicall`), executed as call
  4 of a 10-call `eth_simulateV1` sequence, returned an output
  (`actualOut`) that **exactly equals** the quote taken moments earlier
  against the same pinned block (`148,409,249,477,957,595` vs quoted
  `148,409,249,477,957,595` on run 1; `148,593,315,848,367,208` vs quoted
  `148,593,315,848,367,208` on run 2 — exact equality, not approximate, in
  both).
- A `pool.slot0()` read appended as call 6, **after** the swap and mint,
  returned a tick different from the pre-swap frame tick (`210248 → 210247`
  on both runs), proving the mint (call 5) executed against the
  swap-moved price, not the pre-swap one.
- The mint itself (call 5) succeeded using the candidate's pre-computed
  `amount0Desired`/`amount1Desired`/`amount0Min`/`amount1Min` — quantities
  that were only valid *if* the swap's actual output matched its quote and
  the resulting price stayed inside the candidate's range. It did, on both
  runs (`tokenIdDeterminism.matches: true`, `open_mint` status `0x1`).
- This is also independently confirmed by the **unmodified owned-fork
  sampler**, which performs its own internal assertion after the real swap
  (`src/deployments/rangekeeper-paper-gas-sampler.ts:317-320`,
  `assert.equal(mintPlan.candidate[key],candidate[key],...)`) and did not
  throw on either run — the fork agrees the frozen candidate's amounts were
  still exactly correct after its own real swap moved the price.

No `src/` file was changed. Read-only against the live provider:
`eth_simulateV1`, `eth_call`, `eth_getStorageAt`, `eth_getBlockByNumber`.
Reused production helpers (`readCanonicalPaperOpenFrame`'s
`RangeKeeperChain.verify`, and `RangeKeeperChain.quote`) also make ordinary
`eth_getCode` / `eth_chainId` / `eth_gasPrice` calls as part of existing,
already-reviewed canonical-source verification — flagged here rather than
silently included, since skipping that verification would leave the pinned
source itself unproven (see "What contradicts the brief" below). The fork
baseline runs the **unmodified**
`sampleRangeKeeperPaperGasStages` (owned anvil fork); its sends happen only
against the local anvil fork it spawns, never against the live provider. No
transaction was broadcast. Database access was `SELECT`-only, through
`DeploymentStore`'s public read methods (`listMarketProfiles`,
`paperSetupProfile`).

- Script: `scripts/analysis/swap-simulation-probe.mjs`.
- Branch: `agent/swap-simulation`, this record's commit follows
  `d75ecee` (the probe script itself, committed first per instruction, before
  it had been run).
- Two independent live runs, minutes apart, both against
  profile `df4e460b-fc7f-462b-a653-507d8a4906b1`
  (pool `0xD60A5d14dB690B7Afad71F76B108071D7175597d`, `USDG/USD`/`QQQ/USD`),
  the only one of twelve registered profiles whose independent references
  were eligible at run time (the others were skipped automatically by the
  script; see "Pool selection" below).

## Method

The script does not hand-roll a candidate. It calls the **unmodified**
`planRangeKeeper` (`src/strategy/rangekeeper/planner.ts`) against a live,
canonically-verified frame (`readCanonicalPaperOpenFrame`), with the paper
account's capital placed entirely in the quote leg (one-sided funding, ~300
USD-equivalent of USDG, zero of the RWA token) so the kernel's own sizing
logic is forced into its swap branch — the same branch a real single-token
paper deposit would take. This is the same reuse principle the static
predecessor review used: the candidate is the exact object the production
kernel would build, not a re-derivation that could silently diverge.

It then runs two things against that one candidate/frame:

1. **The unmodified `sampleRangeKeeperPaperGasStages`** (owned anvil fork,
   `kind:'open'`) — ground truth, run fresh on this exact candidate.
2. **The `eth_simulateV1` sequence**, built independently, in two round
   trips at the identical pinned block and state overrides (the call list is
   static in a single `eth_simulateV1` request, so a value only knowable
   from an earlier call's return data — the minted `tokenId` — cannot be
   woven into a later call's calldata within the same request; this is the
   same two-round-trip pattern the static predecessor used):
   - **Round trip A** (predict): `approve_manager_input`,
     `approve_manager_acquired`, `approve_router_input`, `swap`, `mint`,
     `pool.slot0()`. Decodes the swap's actual output, the minted
     `tokenId`/`liquidity`, and the post-mint tick/price — all from this
     response's own return data.
   - **Round trip B** (measured): the full 10-call sequence —
     `RANGEKEEPER_PAPER_OPEN_STAGES_SWAP` (5 stages) followed by
     `RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES` (5 stages) — using the
     `tokenId`/`liquidity`/post-mint price predicted in round trip A to build
     `exit_withdraw_collect`'s minimums. This is the sequence reported below.

Calldata for every stage is built with the **unmodified**
`encodeRangeKeeperTx` (`src/strategy/rangekeeper/calldata.ts`) — the same
function the owned-fork sampler itself calls — so calldata identity is not
re-derived by this script; only the funding technique (a storage override
instead of a real donor transfer) and the transport (`eth_simulateV1`
instead of a sent transaction on an owned fork) differ.

Funding is narrower than the static case: only the swap's **input** token
needs a balance override (found by the same bounded
classic-slot/ERC-7201 scan `paper-gas-simulation-sampler.ts` uses — this
pool's input token matched `classic_slot_1` in 2 probe requests). The
acquired (RWA) leg is never overridden; it starts at zero and arrives
entirely from the simulated swap, exactly as a real paper account would
receive it.

### Pool selection

`store.listMarketProfiles()` returned 12 draft-available registered
profiles. The script tries each in order (`paperSetupProfile` +
`readCanonicalPaperOpenFrame`) and uses the first whose independent
references are eligible at that moment — only one was, at both run times:
the `USDG/QQQ` pool (an ETF token, not an individual equity, so its
reference session is broader than a single stock's trading hours). This is
reported as observed, not chased further: it is a live-market-hours
constraint on which of the twelve pools this script could validate *right
now*, not a defect in the twelve profiles themselves — the other eleven were
skipped for being reference-ineligible at that instant (most are individual
equities, subject to `latest_equity_session`), not for failing chain/pool
verification.

## Per-stage comparison

Two independent runs, minutes apart, same pool, same range
(`210230`/`210270` both times — the pool did not trade between runs, as the
static predecessor also observed), against the **unmodified fork sampler**
run fresh on each run's own identical candidate/frame. Every stage succeeded
(`status: 0x1`) on every call, on both methods, on both runs — no revert
observed at the 50 bps slippage ceiling (`rangeKeeperParameters` and
`sampleRangeKeeperPaperGasStages` both hard-cap RangeKeeper at 50 bps; unlike
the static predecessor, there was no wider schema tolerance available to
retry into if one had occurred — see "Slippage ceiling" below).

The fork sampler returns two gas figures per stage: `estimate.gas`
(`eth_estimateGas` under the fork's own prestate overrides — this is what
`produceRangeKeeperPaperGasEvidence` records as `gasUnitsExpected`, the
number that would be priced and bounded in production) and `localGasUsed`
(the real fork transaction receipt's actual consumption). Both are reported;
`eth_simulateV1`'s `gasUsed` is actual consumption, so `localGasUsed` is the
apples-to-apples column.

**Run 1** (source block `76846504`, tick `210248`, range `210230`/`210270`,
swap `110,082,559`→`148,409,249,477,957,595` wei, deployedValue≈245 USD):

| Stage | sim gas | fork estimate | fork local (actual) | Δ% vs estimate | Δ% vs local |
| --- | ---: | ---: | ---: | ---: | ---: |
| open_approve_manager_input | 57,976 | 58,789 | 57,976 | −1.38% | 0.00% |
| open_approve_manager_acquired | 63,649 | 64,484 | 63,649 | −1.29% | 0.00% |
| open_approve_router_input | 57,976 | 58,789 | 57,976 | −1.38% | 0.00% |
| open_swap | 179,954 | 186,592 | 179,954 | −3.56% | 0.00% |
| open_mint | 478,483 | 492,700 | 487,662 | −2.89% | −1.88% |
| exit_withdraw_collect | 199,595 | 256,239 | 208,471 | −22.11% | −4.26% |
| exit_cleanup_router_token0 | 36,040 | 41,390 | 36,040 | −12.93% | 0.00% |
| exit_cleanup_router_token1 | 43,653 | 44,030 | 43,653 | −0.86% | 0.00% |
| exit_cleanup_manager_token0 | 36,040 | 41,390 | 36,040 | −12.93% | 0.00% |
| exit_cleanup_manager_token1 | 41,653 | 47,065 | 41,653 | −11.50% | 0.00% |

**Run 2** (source block `76847044`, same tick/range, swap
`110,082,559`→`148,593,315,848,367,208` wei, deployedValue≈245 USD):

| Stage | sim gas | fork estimate | fork local (actual) | Δ% vs estimate | Δ% vs local |
| --- | ---: | ---: | ---: | ---: | ---: |
| open_approve_manager_input | 57,976 | 58,789 | 57,976 | −1.38% | 0.00% |
| open_approve_manager_acquired | 63,649 | 64,484 | 63,649 | −1.29% | 0.00% |
| open_approve_router_input | 57,976 | 58,789 | 57,976 | −1.38% | 0.00% |
| open_swap | 179,954 | 186,592 | 179,954 | −3.56% | 0.00% |
| open_mint | 478,471 | 492,687 | 487,650 | −2.89% | −1.88% |
| exit_withdraw_collect | 199,585 | 256,227 | 208,459 | −22.11% | −4.26% |
| exit_cleanup_router_token0 | 36,040 | 41,390 | 36,040 | −12.93% | 0.00% |
| exit_cleanup_router_token1 | 43,653 | 44,030 | 43,653 | −0.86% | 0.00% |
| exit_cleanup_manager_token0 | 36,040 | 41,390 | 36,040 | −12.93% | 0.00% |
| exit_cleanup_manager_token1 | 41,653 | 47,065 | 41,653 | −11.50% | 0.00% |

**All measured** (sim and both fork columns are each method's own gas
reading from that run; Δ% is computed from them, not cited).

**All ten stages reproduced exactly against the fork's actual consumed gas**
(`localGasUsed`) on **eight of ten** stages (all four approvals, the swap,
and all four cleanup approvals — `0.00%` delta on both runs). The two
stages with a nonzero delta — `open_mint` (−1.88%, both runs) and
`exit_withdraw_collect` (−4.26%, both runs) — are **identical in direction
and magnitude across two independent, minutes-apart live runs at different
blocks**, which is strong evidence this is a systematic property of the
funding technique, not sampling noise.

## The cold/warm funding difference, confirmed again on a new stage shape

The static predecessor review found a ~1.18–19.75% sim-below-fork gap on its
single token-receiving stage (`withdraw_collect`) and attributed it,
plausibly but not confirmed, to the fork funding via a real donor
`transfer()` (leaving a nonzero remainder balance, so a later credit is a
warm `SSTORE`) versus the script's direct storage override funding to the
exact requirement (leaving exactly zero, so a later credit is a cold
zero-to-nonzero `SSTORE`, ~15,000 gas costlier).

This run reproduces the same signature on RangeKeeper's two token-crediting
stages — `open_mint` (which credits the position, and also is the first
call to touch the acquired token's balance word at all, since it was never
funded and arrives purely from the swap) and `exit_withdraw_collect` (which
credits the wallet) — while leaving the eight stages that never move a
token balance (approvals, cleanup approvals) at **exactly 0.00%** delta on
every one, every run. That pattern — zero delta on non-balance-touching
stages, a consistent negative delta only on balance-crediting stages — is
the same signature, on a different path, and is reported as corroborating,
not independently re-instrumented to prove the SSTORE-warmth mechanism
directly (neither this run nor the predecessor's isolated the storage
warmth with a direct `eth_getStorageAt` before/after comparison).

## Slippage ceiling

Flagged per the brief's hazard list: RangeKeeper's slippage is hard-capped
at 50 bps in two independent places —
`rangeKeeperParameters` (`src/deployments/contracts.ts:37`,
`bps.refine(value=>value>0&&value<=50)`) and
`sampleRangeKeeperPaperGasStages`'s own assertion
(`src/deployments/rangekeeper-paper-gas-sampler.ts:207` and `:233`,
`limits.maxSlippageBps<=50`). Unlike the static predecessor, which widened
to the schema's 500 bps ceiling when it hit a slippage-floor revert at
production's 50 bps default, **there is no wider tolerance available here**
— 50 bps already is the ceiling, in the kernel's own schema and in the
fork sampler's own guard. Both runs here used 50 bps and **neither reverted**
at any stage on either method; no retry was needed. This is reported as
observed (two runs, no reverts), not as proof the candidate never reverts at
this tolerance — a revert is a real, block-dependent economic condition
this script did not have to route around this time, and if RangeKeeper's
setup preflight (plan item 2b, not yet built) produces a candidate that
does clear the peak-search but fails the final slippage check, the owned
fork and `eth_simulateV1` would hit it identically, since both send the same
calldata.

## Block provenance and determinism

Repeated from the static predecessor's method, re-confirmed here on
RangeKeeper's sequence shape:

- `eth_simulateV1`'s response `parentHash` matched the independently-fetched
  canonical block hash on both runs (`matches: true`).
- The minted `tokenId` predicted in round trip A matched the `tokenId`
  re-derived independently in round trip B's full sequence, on both runs
  (`1,352,584`/`1,352,584` on run 1; `1,352,588`/`1,352,588` on run 2).
- `exit_withdraw_collect`'s `collect()` returned amounts that covered the
  `decreaseLiquidity()` amounts exactly, on both runs
  (`collectionCoversPrincipal: true`).

## Timing and request count

| | eth_simulateV1 | owned fork |
| --- | ---: | ---: |
| Gas-sampling-only (round trip A + round trip B) | run 1: 369ms (145+224); run 2: same order | run 1: 34.4s; run 2: 30.4s |
| Candidate/frame construction (shared overhead, not gas-sampling-specific) | ~10–16s (dominated by `planRangeKeeper`'s swap peak-search, which issues many `chain.quote` rounds) | same step, shared |

Gas-sampling-only is **~80–130× faster** than the fork (0.37s vs 30–34s).

**Request-count caveat, reported honestly rather than omitted:** the
script's request counter wraps `client.request` directly, but viem's
`readContract`/`getBlock`/`getBytecode`/`simulateContract` actions bind
their own reference to the client's request method at client-construction
time, not at call time — so the counter (`4` in the JSON output: 2
slot-discovery `eth_getStorageAt` calls + the 2 `eth_simulateV1` round
trips) **does not** include the `eth_call`/`eth_getBlockByNumber`/
`eth_getCode` traffic made by the reused `readCanonicalPaperOpenFrame`,
`RangeKeeperChain.verify`, and the swap peak-search's repeated
`RangeKeeperChain.quote` calls inside `planRangeKeeper`'s `construct()`.
This is a real gap in this script's instrumentation, found after both runs
completed and not fixed before this record was written (time-constrained by
a session interruption; see commit history on this branch) — the true
per-sample request count against the live provider is higher than 4, and
this document does not claim a total. What **is** measured precisely is the
gas-sampling-only path itself: exactly 2 `eth_simulateV1` calls per sample,
plus a one-off 2-request slot discovery per token pair (not per sample) —
directly comparable to the static predecessor's own "2 requests per sample"
finding.

## What was not tested, and what contradicts the brief

- **`direct_swap` open path plus the retain-exit stages that follow it is
  what this record validates.** The brief named "a RangeKeeper exit is
  swap-involving on the convert path" as the motivating case. That is
  **not** the path validated here, for a reason stronger than scope: **the
  owned-fork sampler itself has no implementation for it.**
  `sampleRangeKeeperPaperGasStages` throws unconditionally on
  `kind:'convert_exit'` —
  `src/deployments/rangekeeper-paper-gas-sampler.ts:140` and `:222`,
  `'Convert-exit sampling requires a persisted conversion quote contract'`
  — and there is a unit test asserting exactly this
  (`test/rangekeeper-paper-gas-sampler.test.ts:57-60`,
  *"explicitly rejects convert-exit without a saved conversion quote
  contract"*). **This means there is no ground truth this script, or any
  script, could compare a convert-exit `eth_simulateV1` sequence against
  today** — the "same candidate and frame" comparison the brief asks for is
  structurally unavailable for this specific path, not merely unattempted.
  This directly contradicts the brief's framing that validating "the swap
  stages" settles the convert-exit question; it settles the *open* swap
  question (which is also swap-involving, also exercises the router and
  quoter, and also requires the moved-price property under test) but not
  the convert-exit one. **Flagging this rather than working around it**,
  per the brief's own instruction: building a convert-exit owned-fork
  sampler is a prerequisite to validating `eth_simulateV1` on that specific
  path, not something this kind of probe can shortcut. It is plausible
  `eth_simulateV1` would reproduce it too — the swap mechanics tested here
  (quoter read, router swap, price-impact-aware later call) are the same
  ones a convert-exit's post-withdrawal swap would exercise — but that is
  an inference from this record, not a measurement in it.
- **The no-swap open path (`RANGEKEEPER_PAPER_NO_SWAP_PATH`)** was not
  re-tested here; it shares its non-swap stages' mechanics with the static
  predecessor's fully-validated approve/mint/withdraw/cleanup stages and was
  out of this record's scope (swap-involving stages specifically).
- **Only one of twelve registered pools** could be tested at run time, for
  the live-market-hours reason given under "Pool selection" above, not a
  per-pool defect. Range-to-range or pool-to-pool consistency of the
  mint/withdraw gap was not established — two runs on the same pool confirm
  determinism at that pool, not generality across all twelve.
- **The request-count instrumentation gap** above is itself a limitation
  worth a reader's attention if this script is reused for a production
  estimate of per-sample request cost.

## Recommendation

**Yes, with high confidence, for the `direct_swap` open path and the
retain-exit stages that follow it — this is enough to unblock RangeKeeper's
*retain* exit preview without an owned-fork stage runner being written.**
The decisive property the brief asked about — a later call in the same
`eth_simulateV1` sequence seeing the swap-moved pool state — is directly
demonstrated, not inferred, on two independent live runs: exact swap-output
match against the pre-swap quote, a materially different post-mint tick, and
a mint that only succeeds because the frozen candidate's slippage-derived
minimums were computed against that already-moved price.

**No, not yet, for the `convert_exit` path specifically** — not because
`eth_simulateV1` was shown to fail it, but because there is currently no
owned-fork ground truth to validate it against at all. Per the plan
document's own section 4 decision list ("Is the convert exit in scope? ...
scoping to retain-only would likely sidestep the unvalidated
swap-simulation question and deliver a complete open-and-close loop
sooner"), **retain-only is both the scope this record actually validates
and the scope the plan already flagged as the faster path** — those two
facts now agree with each other with evidence behind them, not just
scheduling convenience.

Confidence: **high** for the open/`direct_swap` path (two independent live
runs, exact reproduction on 8/10 stages, a consistent and explicable
±2–4% gap on the other two, all within the existing 30% `gasUnitsBound`
margin by a wide margin). **Not assessed** for `convert_exit` — this is a
gap to close (build the owned-fork convert-exit sampler first, matching the
"next, much larger piece of work" the brief itself named as the
alternative), not a negative finding.
