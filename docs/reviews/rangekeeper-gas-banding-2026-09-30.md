# RangeKeeper gas banding — September 30, 2026

Status: measurement and proposal only. No `src/` change is made by this
document and nothing here authorizes execution or registers any gas
evidence. This follows up
[RangeKeeper dashboard integration](../plans/rangekeeper-dashboard-integration-2026-09-30.md)
item 2 and asks, for the RangeKeeper paper paths, the same question
[operation gate simplification](../plans/operation-gate-simplification-2026-09-30.md)
section 4/4b answered for the static path: which dimensions actually drive
gas, and how much would banding buy?

Script: `scripts/analysis/rangekeeper-size-gradient-gas.ts`. Branch
`agent/rangekeeper-banding`, HEAD `6bbc8f2c94e668ea3ab6cd9650b0b16efe5f0322`,
based on `main` at `5bd9150`. All database access in this review was
read-only (`SELECT`, via `DeploymentStore.paperSetupProfile` and one ad hoc
read query); no row was inserted, updated or registered. All RPC calls were
reads (`eth_getBlock*`, `eth_call`/`simulateContract` for the quoter) or an
owned local Anvil fork spun up per sample; no transaction was broadcast
against the live provider. Credentials were loaded in-process from
`/root/conc-liq/data/static-paper-mvp-dashboard-feedback-2026-09-28.env`, the
same file `scripts/analysis/simulate-gas-probe.mjs` already uses.

## 0. Headline finding, before any gradient: today's band key is already
## maximally fragmented, independent of what drives gas

`rangeKeeperPaperSizeBand(path, scope)` in `src/deployments/rangekeeper-paper-cost.ts:82-87`
hashes `{path, poolAddress, profileHash, candidateHash, deployedValue,
sharePpm, range, swapKind, inventoryHash?}` into the `rk_` key. The
static path's original (pre-fix) key hashed size and share to the exact wei
and diluted share to the exact ppm — bad enough that every sample was
single-use. RangeKeeper's key additionally hashes `candidateHash`, and
`candidateHash` (`rangeKeeperPaperCandidateHash`, same file, lines 90-104)
is itself a hash over `campaignId`, `revision`, the exact canonical
`source` block, and the full serialized candidate including its exact swap
quote and `expiresAt` timestamp.

**Consequence: releasing `deployedValue` and `sharePpm` from the band key
alone — the fix that worked for the static path — would do nothing for
RangeKeeper, because `candidateHash` already guarantees a distinct key on
every single open attempt,** even for two campaigns at the identical pool,
identical range, identical size and identical share. Nothing sampled
today could ever be reused, regardless of which dimensions turn out to
move gas. This is consistent with what section 1 finds: zero RangeKeeper
rows exist in `deployment_calibration_profiles`, so there is no accumulated
evidence to have gone stale or to be reused in the first place.

This reframes the task: the gradients below answer "which dimensions move
gas" (the question the brief asked), but the band-key fix needed to make
any of that actionable is structural first — `candidateHash` has to leave
the hash, not just size and share.

## 1. Existing evidence: none

```sql
SELECT path_version, count(*) FROM deployment_calibration_profiles
WHERE path_version LIKE 'paper_rangekeeper_v1%' GROUP BY path_version;
-- 0 rows
```

The table holds 262 rows total, all `paper_static_manual_*` (192
`no_swap_v1`, 70 `close_convert_prestate_v1`). **Zero RangeKeeper rows of
any path version.** There is no historical spread to analyze and no
outlier to separate out (the brief's instruction to check for one, per the
static path's 197.6%-of-median anomalous run, does not apply — there is
nothing to have an outlier in). The contribution here is therefore the
gradient measurements below plus a sampling/banding plan, not a historical
analysis.

## 2. Method

Three purpose-built gradients, each holding **one pinned canonical source
frame** constant across every sample in it (read once via
`readCanonicalPaperOpenFrame`, reused for every sample), so pool state
drift cannot explain any spread measured. Each sample calls
`sampleRangeKeeperPaperGasStages` directly — the same function the CLI
sampler (`src/deployments-rangekeeper-paper-gas-sample.ts`) and the
confirmation runner use — against a fresh owned local Anvil fork. No
draft, preview, campaign or operation is created; nothing is imported into
`deployment_calibration_profiles`.

Candidates are built directly with the same sizing primitive production
uses, `sizeRangeKeeperMint` (`src/strategy/rangekeeper/planner.ts`), rather
than through a setup preflight — **RangeKeeper has no sized/costed setup
preflight today** (`docs/plans/rangekeeper-dashboard-integration-2026-09-30.md`
§2b), so there is nothing to reuse the way
`scripts/analysis/size-gradient-gas.ts` reused
`buildStaticPaperSetupPreflight` for the static path. For the swap
gradient, the swap leg's quote comes from a real `RangeKeeperChain.quote`
call (the quoter contract) at the pinned source, exactly as the planner's
own swap-sizing loop does it — not a synthetic number.

Pool: `a8e7096f-17c3-452c-a72f-8fa962e586d2` (AAPL/USD, fee 500,
tickSpacing 10) — the same registered pool the static path's
`size-gradient-gas.ts` used, for continuity. `fullWidthSpacings=20`
(200-tick width) by default, matching the NVDA-500 production config's own
value (`config/rangekeeper-v1-nvda-disabled.json`).

Every gradient below samples the **`open`-kind probe**, which — per
`sampleRangeKeeperPaperGasStages`'s own structure — runs the open stages
*and* an immediate same-fork-session retain-exit in one sequence. That is
the only kind this review could reach; see section 6 for what this does
and does not cover on the exit side.

## 3. Measured: size and share do not drive gas on the no-swap open path

Pinned source block `76716337`, tick `218138`, range `218040/218240`
(fullWidthSpacings 20) held identical across all five samples. Capital
swept 25→1,000 USDG (40×); diluted share moved 228→9,046 ppm (~40×) as a
result, not as an independent input.

| Stage | 25 USDG | 100 | 250 | 500 | 1,000 | Spread |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| open_approve_manager_token0 | 63,246 | 63,258 | 63,258 | 63,258 | 63,258 | 0.02% |
| open_approve_manager_token1 | 68,929 | 68,941 | 68,941 | 68,941 | 68,941 | 0.02% |
| open_mint | 540,602 | 540,756 | 540,713 | 540,765 | 540,713 | 0.03% |
| exit_withdraw_collect | 291,191 | 291,433 | 291,305 | 291,421 | 291,348 | 0.08% |
| exit_cleanup_router_token0 | 42,854 | 42,854 | 42,854 | 42,854 | 42,854 | 0.00% |
| exit_cleanup_router_token1 | 48,478 | 48,478 | 48,478 | 48,478 | 48,478 | 0.00% |
| exit_cleanup_manager_token0 | 42,854 | 42,854 | 42,854 | 42,854 | 42,854 | 0.00% |
| exit_cleanup_manager_token1 | 51,552 | 51,552 | 51,552 | 51,552 | 51,552 | 0.00% |
| **TOTAL** | 1,149,706 | 1,150,126 | 1,149,955 | 1,150,123 | 1,149,998 | **0.04%** |

**Measured: over a 40× capital range and a 40× diluted-share range, total
gas moved 0.04%, and no single stage moved more than 0.08%.** This
matches the static path's own pinned-frame size-gradient result (0.011%)
qualitatively — size and share are not drivers here either.

## 4. Measured: size does not drive gas on the direct-swap open path either;
## swap input size has one small, bounded exception

Pinned source block `76846735`, tick `218232`, range `218130/218330`.
Wallet held entirely in the risky leg (AAPL); swap input fixed at 50% of
wallet value at every capital point, so the swap's *fraction* of capital
is pinned while its *absolute* size scales 40× with capital — isolating
size the same way section 3 does. Swap amount and quote came from a real
quoter call at the pinned source each time.

| Stage | 25 USDG | 100 | 250 | 500 | 1,000 | Spread |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| open_approve_manager_input | 64,484 | 64,484 | 64,484 | 64,484 | 64,484 | 0.00% |
| open_approve_manager_acquired | 58,801 | 58,801 | 58,801 | 58,801 | 58,801 | 0.00% |
| open_approve_router_input | 64,484 | 64,484 | 64,484 | 64,484 | 64,484 | 0.00% |
| open_swap | 179,121 | 187,989 | 187,989 | 188,020 | 188,030 | **4.97%** |
| open_mint | 458,067 | 458,115 | 458,103 | 458,115 | 458,115 | 0.01% |
| exit_withdraw_collect | 256,146 | 256,182 | 256,182 | 256,182 | 256,182 | 0.01% |
| exit_cleanup_router_token0 | 38,406 | 38,406 | 38,406 | 38,406 | 38,406 | 0.00% |
| exit_cleanup_router_token1 | 47,065 | 47,065 | 47,065 | 47,065 | 47,065 | 0.00% |
| exit_cleanup_manager_token0 | 41,390 | 41,390 | 41,390 | 41,390 | 41,390 | 0.00% |
| exit_cleanup_manager_token1 | 47,065 | 47,065 | 47,065 | 47,065 | 47,065 | 0.00% |
| **TOTAL** | 1,255,029 | 1,263,981 | 1,263,969 | 1,264,012 | 1,264,022 | **0.72%** |

Nine of ten stages are flat (≤0.01%). **`open_swap` alone moves 4.97%,
entirely between the 25 and 100 USDG points; it is flat from 100 through
1,000 USDG (10× further).** That step shape — one jump, then flat — is
the signature of a tick-crossing threshold (the 25 USDG swap stays inside
the currently-active tick; the 100 USDG swap and larger cross into an
adjacent initialized tick, paying its one-time initialization/SSTORE
cost) rather than a continuous size effect. This is the same kind of
step-shaped, cold-slot-flavored effect the `simulate-v1-gas-validation`
review found on `withdraw_collect` (19.75% gap, attributed to a
cold-vs-warm `SSTORE`) — plausible, not independently instrumented here
either. **Total spread (0.72%) and the `open_swap` stage's own spread
(4.97%) both sit comfortably inside the 30% `gasUnitsBound` margin.**

## 5. Measured: tick range width is the actual driver, the same as the
## static path

One pinned frame (source block `76848714`, tick `218232`), one fixed
capital (250 USDG), three different tick ranges obtained by varying
`fullWidthSpacings` (20/100/400 → 200/1,000/4,000-tick width) anchored at
the same tick. This isolates range as the variable under test the same
way sections 3–4 isolated size: only `fullWidthSpacings` changes between
samples.

| Stage | width=20 (218130/218330) | width=100 (217730/218730) | width=400 (216230/220230) | Spread |
| --- | ---: | ---: | ---: | ---: |
| open_approve_manager_token0 | 58,801 | 58,801 | 58,801 | 0.00% |
| open_approve_manager_token1 | 64,484 | 64,484 | 64,484 | 0.00% |
| open_mint | 458,115 | 492,575 | 543,244 | **18.58%** |
| exit_withdraw_collect | 256,182 | 256,158 | 283,140 | **10.53%** |
| exit_cleanup_router_token0 | 38,406 | 38,406 | 38,406 | 0.00% |
| exit_cleanup_router_token1 | 44,030 | 44,030 | 44,030 | 0.00% |
| exit_cleanup_manager_token0 | 41,390 | 41,390 | 41,390 | 0.00% |
| exit_cleanup_manager_token1 | 47,065 | 47,065 | 47,065 | 0.00% |
| **TOTAL** | 1,008,473 | 1,042,909 | 1,120,560 | **11.11%** |

**Measured: over a 20× range-width span at fixed size and fixed frame,
total gas moved 11.11%, with `open_mint` moving 18.58% and
`exit_withdraw_collect` 10.53%.** This is the same stage pair (mint,
withdraw) and the same direction the static path's historical set found
driving its 25.9%/17.8% spreads. Still inside the 30% margin at this
width span, but it is a real, one-sided, monotonic effect — unlike size
and share, which moved total gas by hundredths of a percent with no
consistent direction.

**Cross-check ruling out share as a confound:** diluted share varies
1,713→346→89 ppm across these three samples (holding deployed *value*
fixed means liquidity — and hence share — falls as the range widens).
Section 3 already measured share moving 228→9,046 ppm (40×) with ≤0.08%
effect on every stage, so this sample's share swing (a smaller range,
in the opposite direction) cannot be what is producing an 18.58% mint
spread here. Range width is the only input left varying.

## 6. What this does not cover

- **The standalone terminal retain-exit path is not sampled.** Every
  retain-exit figure above comes from the `open`-kind probe's bundled
  same-session exit (`sampleRangeKeeperPaperGasStages`'s `open` branch runs
  withdraw+cleanup immediately after mint, in the same fork). The
  *separate* `sampleRangeKeeperPaperRetainExit` function — used for a real
  later observation against `RangeKeeperPaperLoadedExitContext`, with
  `restorePaperPosition` reconstructing inventory from a persisted mark —
  is a different code path with different funding mechanics
  (`inventoryHash`-scoped) that this review did not exercise. The stage
  list is identical and the underlying withdraw/cleanup calldata is the
  same shape, so the size/range findings above are a reasonable prior for
  it, but that is an inference, not a measurement of that path.
- **Convert-exit cannot be sampled at all — confirmed, not assumed.**
  `sampleRangeKeeperPaperGasStages` throws unconditionally for
  `kind==='convert_exit'`
  (`src/deployments/rangekeeper-paper-gas-sampler.ts:222`:
  `'Convert-exit sampling requires a persisted conversion quote
  contract'`), and the only terminal-sampling CLI,
  `src/deployments-rangekeeper-paper-gas-terminal-sample.ts`, only ever
  calls `kind:'retain_exit'` — there is no entry point for convert-exit at
  all, CLI or otherwise. A conversion **quote model** does exist
  (`terminalQuote` in `src/deployments/rangekeeper-paper-exit-model.ts:174-204`,
  producing the `paper_rangekeeper_v1_direct_convert_exit_v1` cost-preview
  contract from a real quoter call), but it is a cost/preview builder, not
  a fork gas sampler — it has no counterpart to
  `sampleRangeKeeperPaperRetainExit`. What it would need: a
  `sampleRangeKeeperPaperConvertExit` branch that restores the position
  (reusing `restorePaperPosition`, as retain-exit does), runs
  `exit_withdraw_collect`, then replays `exit_convert_approve_router_input`
  and `exit_convert_swap` against the already-computed `terminalQuote`
  output (amount, minOut, deadline) the way the `open`-kind swap branch
  replays `candidate.swap`, then the four cleanup approvals. The static
  path's close-convert v3 prestate sampler
  (`src/deployments/paper-close-convert-prestate-sampler.ts`) solved the
  structurally identical problem for `static_manual_v1` and is the natural
  template. Building this is a `src/` change and out of scope here per the
  hard constraint; this review reports the gap rather than forcing a
  number for a path that cannot currently be executed.
- **Only one pool, one fee tier.** All three gradients ran against
  AAPL/USD-500. The twelve registered profiles span three fee tiers
  (500/3000/10000) with different `tickSpacing`, which changes how many
  raw ticks a given `fullWidthSpacings` covers and could change the
  mint/withdraw sensitivity curve's slope, though not its direction or
  order of magnitude, since the mechanism (tick-indexed storage touched by
  mint/burn) is shared across fee tiers.
- **Range-recurrence rate is unmeasured for RangeKeeper.** The static
  path's own banding win (section 4b of the source plan) was narrower than
  first projected: band count becomes bounded by distinct ranges rather
  than growing forever, but consecutive opens rarely land on the same
  anchored range (3 of 4 live runs re-sampled). There is no accumulated
  RangeKeeper history to check whether its range-recurrence rate is
  similar, worse or better — `rangeKeeperRange` always centers on the
  *current* tick, so recurrence depends on how often price returns to the
  same tick bucket between opens, a question this review does not answer.

## 7. Recommendation

**Band scheme for the `open`-kind probe (no-swap and direct-swap paths
only — convert-exit is out of reach, section 6):**

1. **Structural fix, required before anything else helps:** drop
   `candidateHash` (and therefore `deployedValue`/`sharePpm`, which are
   already redundant with it) from the `rk_` band-key hash in
   `rangeKeeperPaperSizeBand`. Replace with a key over
   `{poolAddress, pathVersion, tickLower, tickUpper}` — the same shape as
   the static path's `range_<hash(pool,tickLower,tickUpper)>`. Without
   this, no amount of "size doesn't matter" evidence makes anything
   reusable, because `candidateHash` alone already forces a fresh key on
   every attempt (section 0).
2. **Band deployed size and diluted share as a stored range, not an exact
   match**, mirroring the static path's `schemaVersion` 1→2 migration
   (`paperGasBand`/`PAPER_GAS_BAND_DIVISOR` in `src/deployments/paper-cost.ts`):
   add `sizeMinValue`/`sizeMaxValue`/`shareMinPpm`/`shareMaxPpm` to
   RangeKeeper's `gasProfileModel` (currently exact-match only —
   `selectRangeKeeperPaperCostProfiles`'s `valid()` at
   `src/deployments/rangekeeper-paper-cost.ts:132-133` rejects any row
   whose `deployedValue`/`sharePpm` string doesn't equal the candidate's
   exactly), and change the resolver from exact-match to
   range-containment. **Measured error bound for this band: total gas
   moved ≤0.04% (no-swap) / ≤0.72% (direct-swap, entirely from one
   tick-crossing-shaped 4.97% step on `open_swap`) across a measured 40×
   span** — both far inside the 30% `gasUnitsBound` margin already paid.
   A ¼×–4× envelope around the sampled point (the static path's own
   choice) sits comfortably inside the 40× this review measured.
3. **Keep the exact tick range pinned, unbanded.** Section 5 measured an
   11.11% total / 18.58% mint spread across a 20× range-width span at
   fixed size — bounded, but real, monotonic, and the same stage pair the
   static path found driven by range. Do not band range without a
   dedicated measurement the way size/share now have one.
4. **Do not touch `inventoryHash`-scoped exit bands** (the standalone
   terminal retain-exit and any future convert-exit key) based on this
   review — section 6 explains why that path wasn't measured directly.

**What this buys for the twelve pools:** today, `rk_` bands cannot be
reused across *any* two opens regardless of dimension, because
`candidateHash` is in the key (section 0) — so "twelve pools × three
paths" is presently not even "one sample per pool per path," it is one
sample *per open attempt*, forever, and unboundedly (same failure mode
section 4 of the source plan found for the static path pre-fix, worse
here since it was never fixed for RangeKeeper). After the structural fix
in item 1, sampling needs are bounded by **distinct (pool, path, tick
range) triples** rather than by attempt count — but convert-exit remains
completely unsampleable (section 6), so the near-term practical scope is
**twelve pools × two paths** (no-swap, direct-swap), and even then a fresh
~5–30s fork sample is still needed whenever a campaign opens at a tick
range not already banded. This review has no data on how often that will
be true for RangeKeeper specifically (section 6's last point) — that
would need production history the way the static path's 27-samples-over-
11-ranges history existed before its own fix shipped.

## 8. What contradicts or qualifies this brief

- The brief frames the question as "does size/share still not matter here,
  the way it didn't for static" — **true for total gas on both open paths
  (≤0.04%/≤0.72%), but not exactly for every stage**: `open_swap` has a
  small, bounded, step-shaped dependence on swap size that the static
  no-swap path's stages didn't show (static's own size gradient was also
  perfectly flat, 0.011%, but static has no swap stage to compare against
  — this is a genuinely new finding specific to RangeKeeper's swap path,
  not a contradiction of the static result).
- The brief anticipated the convert-exit path "may be blocked." It is not
  partially blocked — there is no sampler branch, no CLI entry point, and
  no partial evidence contract for it at all, only stage-name constants
  and an unrelated cost-preview quote builder. This review did not attempt
  to build that machinery (a `src/` change, out of scope), so there is no
  number to report for that path, bounded or otherwise.
