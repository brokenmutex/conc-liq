# Strategy redesign: implementation handoff — 2026-09-18

Audience: the implementing agent (Opus). Author of the design: Claude Fable 5.1
with the user, 2026-09-18. Decision status: the user has agreed to this design.
Source commit at handoff: `d8b304a` plus untracked research files (see `git status`).

## 0. Read these first, in this order

1. `notes/adaptive-forecast-and-exit-rule-2026-09-17.md` — why alpha does not
   reproduce, why net fees does, why exit-to-cash is a one-way door, and the
   three blockers. Do not re-derive any of it.
2. `notes/adaptive-residence-cap-sweep-2026-09-17.md` — §3.1 (volume/sigma²
   by session), §3.2 (band survival by session), §4.3 (directional vs residual).
3. `notes/live-cost-analysis-2026-09-17.md` — what a live action really costs
   and the ranked cost levers.
4. `notes/adaptive-paper-60m-economic-gate-2026-09-17.md` — the exact deployed
   policy this work modifies.
5. `notes/adaptive-lp-universe-study-2026-09-13/README.md` — the sign flip
   under half fees / double gas, and SPCX as the exposure counterexample.

## 1. The design in one paragraph

P&L is set by two large terms: inventory stranded after a band crossing
(NVDA −57 USDG directional over 9 days at 1,000 USDG) and the gap between
modeled and realized fee capture (live pilot: 7.38 realized fees vs 12.78
costs on 250 USDG; paper credits 100% share at quoted fills). The recenter
gate decides amounts of 0.2–0.5 USDG. Redesign around the big terms:
(a) calibrate the fee model to live data before trusting any number;
(b) redeploy stranded inventory as a one-sided range with no swap instead
of exiting or swapping at the band edge; (c) make width a function of
session as well as trailing variance, staying in 24/7; (d) scale by adding
pools under a per-pool liquidity-share cap, which requires 3000-tier
support; (e) fix the execution defects already identified. Rank every
variant by net fees, report exposure-weighted directional P&L separately,
keep a holdout, and run no further width/horizon/timescale sweeps on the
current sample.

## 2. Ground rules

- Everything here is offline research and code changes. Nothing broadcasts.
  Do not start, enable or restart any `conc-liq-*paper*` or live unit; the
  restart in §W5 needs the user's explicit go. Data collectors
  (`conc-liq-tail`, `conc-liq-rpc-health`, checkpoint timers) stay running.
- `node` is not on PATH. Use the release binary:
  `R=/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf; $R/bin/node`.
  Simulation harnesses import the compiled strategy from `$R` (override with
  `CONC_LIQ_RELEASE`). For code changes under `src/`, build with
  `npm run build` and point `CONC_LIQ_RELEASE` at the fresh build, or add a
  source-import mode to the harness; say which you did in the note.
- Tests: `npm test`, `npm run typecheck`. Add tests for every behaviour change
  in `src/`; `test/adaptive-lp.test.ts` and `test/agile-lp.test.ts` are the
  patterns.
- Simulations read the local database and must never write to it or to any
  live session state. Follow the pattern in `scripts/adaptive-exit-rule-sim.mjs`
  (subclass `AdaptiveLpReplay`, wrap `step()`, keep a `baseline` arm that
  reproduces the deployed policy to the microUSDG). That reproduction check
  is mandatory for every new harness.
- Every workstream ends with a note under `notes/<topic>-<date>.md` plus an
  evidence directory, in the style of the notes above: summary, design,
  results tables, limitations, next steps, reproduction commands.
- Windows: NVDA history is clean from 2026-09-08 02:00Z; AAPL and GOOGL
  checkpoints begin 2026-09-13, so report the warmed window
  (2026-09-13 15:00Z onward) alongside the full one. Warm up for the longest
  lookback any arm uses. More history accrues daily; extend `SIM_END`.
- Evaluation rule (from the forecast note §4): rank by **net fees** (fees −
  gas − swap shortfall). Report alpha and absolute P&L, and the directional
  split of §4.3 of the residence-cap note, but do not select on them.
  Differences inside one day's directional swing on one book are noise.

## 3. Workstreams, in order

Do W0 first; its output changes how every later result is read. W1–W4 can
proceed in parallel after W0's fee-share number exists. W5 last.

### W0. Calibrate modeled fee capture and fill cost to the live pilot

Goal: replace the frozen `feePpm` = 1,000,000 (100% share) and quoted-fill
assumption with numbers fitted to the only realized data we have.

Evidence: `data/live-cost-analysis-2026-09-17/ledger.json` (`actions`,
`transitions`, `marks` for campaign `f8affe19`, 2026-09-12 14:24 to
2026-09-15 05:50 UTC, 302 tx), `decomposition.json`, `extract.mjs`. The
campaign's realized fees are 7.38 USDG; swap shortfall 3.22 USDG on 6,277
notional (5.1 bps, of which 5.0 bps is the pool fee).

Tasks:
1. For each live holding segment (mint to withdraw), reconstruct the modeled
   fee accrual the paper model would have credited at that position's
   liquidity, range and time in range, using the canonical pool events and
   the same `diluted_segments_v1` accounting. Compare with fees actually
   collected. Report the ratio per segment and pooled; that ratio is the
   calibrated fee share.
2. Fit the fill model: realized swap output vs QuoterV2 quote at the source
   block (routes.json already has the quotes), and realized mint amounts vs
   plan. Express as bps.
3. Rerun the three existing harnesses (`adaptive-forecast-sweep.mjs`,
   `adaptive-residence-cap-sim.mjs`, `adaptive-exit-rule-sim.mjs`) with the
   calibrated `feePpm` and a fill haircut, and restate the headline tables.
   Say whether any conclusion changes.

Acceptance: a note with the calibrated fee share and fill haircut, their
uncertainty (63 hours, one pool, 250 USDG), and the restated tables. Every
later note quotes these numbers.

### W1. One-sided inventory range ("residual range") instead of exit or swap

Goal: when the price leaves the band and the gate refuses a recenter, place
the held inventory as a one-sided range adjacent to the current price, funded
without a swap, so it earns fees on reversion and converts back to quote on
the way. Directly targets the −57 USDG term.

Mechanics:
- Stranded above the range with token ordering such that the book is all RWA
  (or all quote; dispatch on `quoteIsToken0` exactly as
  `isStrandedRisky` in `scripts/adaptive-exit-rule-sim.mjs` does): mint a
  range whose near edge is the current tick rounded to the grid and whose
  far edge is `halfWidth` ticks beyond, on the side that makes the position
  one-sided in the token we hold. No swap; withdraw + collect + mint only.
- Cost: use the decomposition in the live cost note — mint 0.071 + withdraw
  0.034 USDG post-allowance, i.e. ~0.105, not the 0.22 all-in recenter.
  Add a `cost('residual')` entry alongside `entry/recenter/exit` in the
  policy and config (`config/adaptive-paper-60m.json` has the frozen costs).
- Gate: cheap action, light gate. Accept when forecast fees over the horizon
  at the calibrated share exceed the residual cost plus the 50% buffer.
  Do not run the keep-vs-move terminal comparison for this action; the
  inventory is identical either way, only fee-earning differs.
- The residual range becomes `this.position`; the ordinary gate then governs
  whether it is later replaced by a two-sided recenter once price returns.
  Width candidates: the same 10/20/40/80/160 list, ranked by forecast fees
  net of the crossing charge, as in `rangeOccupancy`.

Implementation: subclass `AdaptiveLpReplay` in a new
`scripts/adaptive-residual-range-sim.mjs` first (research proof). Arms:
`baseline`, `residual_w10/20/40/80`, `residual_adaptive`. Only after it wins
on net fees in both windows, port into `src/research/adaptive-lp.ts` behind a
policy flag (`residualRange: boolean`, default false) with tests.

Why the Sep 11 preserve-tokens result does not settle this: it priced actions
at ~0.8 gwei against 0.2 actual, and it minted a two-sided range from a
mismatched inventory, deploying only 52% of NAV
(`notes/lp-recenter-study-2026-09-11/README.md`). This design mints
one-sided by construction.

Acceptance: net fees, time earning, recenter/residual counts, directional
split, and the fraction of stranded minutes recovered, per book, both
windows, at calibrated fee share. Also report the exit-rule failure mode does
not recur: a residual mint from held tokens must not go through the entry
`frozen_mint_minimum` path (`src/research/adaptive-lp.ts:150-152`).

### W2. Session-aware width and decoupled forecast timescales

Goal: use the one predictable volatility event (13:30 UTC weekday open) and
the measured session structure (volume/sigma² best 20:00–08:00 UTC, worst
13:30–15:00) without leaving the pool.

Two changes, tested separately and together:
1. **Timescales.** Volatility estimate: flat over a 6 h lookback. Fee
   estimate: 15-minute half-life. This is `volFlat_fee15m`, the best net-fee
   cell in both windows. `AgileForecastSpec` already supports
   `volatilityHalfLifeMs` and `feeHalfLifeMs`
   (`src/research/agile-forecast.ts:5-11`); `src/adaptive-paper.ts:33` pins
   `lookbackMs` to a literal 3,600,000 and must be widened to a schema range.
2. **Open schedule.** No new entry or recenter from 13:15 to 14:00 UTC on
   NYSE weekdays (use the holiday logic already in the off-hours schedule,
   `src/research/offhours-cap.ts` and `src/paper/`); positions are held, not
   exited. Optionally a minimum half-width of 40 for decisions made 14:00 to
   15:00. Weekend and overnight: unchanged (the ranker already narrows when
   sigma is low). Do not add exit-before-open; exit/re-enter cycles are what
   sank the off-hours study.

Harness: extend `scripts/adaptive-forecast-sweep.mjs` arms with a schedule
hook in the wrapper (skip `step()` decisions inside the blackout; keep
marks). Arms: `live_60m`, `volFlat_fee15m`, `live_60m+open_blackout`,
`volFlat_fee15m+open_blackout`, `+minwidth40`.

Acceptance: net fees both windows, recenter counts, exposure, and
specifically fees earned and inventory P&L inside 13:30–15:00 vs the rest of
the day, so the effect is attributed to the session it targets.

### W3. 3000-tier support and the pool universe

Goal: remove the assertion blocking every 3000-tier book and produce a
per-pool ranking of fee yield per unit of pool liquidity so capital can be
spread under a share cap.

Tasks:
1. `src/research/adaptive-lp.ts:42` asserts `market.fee===500 &&
   market.tickSpacing===10`. Generalise: take `tickSpacing` from the market,
   derive grid rounding from it everywhere the constant 10 is assumed (grep
   `tickSpacing`, `/10`, `*10`, `%10` in `src/research/adaptive-*.ts`,
   `agile-lp.ts`, `adaptive-forecast.ts`), scale the half-width candidate
   list to the grid (3000 tier: spacing 60, so candidates 60/120/240/480/960
   or an equivalent in price terms), and add tests with a 3000/60 market.
2. Universe table from the 15 pools in `config/indexer-pools.json` over the
   last 30 days: gross USDG fees, mean active liquidity, fees per unit
   liquidity, our share of liquidity at 1,000/2,500/5,000 USDG
   (`src/research/capacity.ts`), and 13:30–15:00 vs overnight split. The
   forecast note already has: GLD-3000 1,488, MSFT-3000 1,176, AAPL-500 782
   gross over ~300k blocks; MSFT-3000 leads on fee per liquidity.
3. Run the W1+W2 winner on MSFT-3000 and GLD-3000 once (1) is in.

Acceptance: the ranking table, the assertion gone with tests, and a
recommended allocation: per-pool size such that our share of active
liquidity stays under 5% (AAPL-500 at 13.09% for 1,000 USDG is already over;
NVDA-500 0.86% and GOOGL-500 0.52% have room).

### W4. Execution defects (no strategy change)

1. **Cash-funded mint fills.** `src/research/adaptive-lp.ts:150-152`: entry
   fills assert both mint legs within slippage of the quote, which failed 30
   of 31 gated re-entries. Replace with the bounded adaptive funding
   convention used by recenters, or re-plan the mint from the post-swap
   balances and assert on liquidity rather than per-leg amounts. Keep the
   swap minimum. Test with a drifted price between quote and fill.
2. **Indexer `covered` flake.** `src/adaptive-paper.ts:72` and `:106` drop
   any checkpoint whose `covered` or `coverage_identity_valid` is false. The
   flag flips false for every row when the indexer cursor reads back an old
   block. Find the cursor read in the indexer/checkpoint path, make coverage
   monotone (never report a lower cursor than the last committed one), and
   count from the archived status files how many live decisions were lost
   under `blocked` with `event_coverage_unavailable`.
3. **Pause allowances.** `src/paper/config.ts:35-36` and
   `src/paper/holding.ts:74-75`: 60 s chain / 30 s risk pauses force exits
   that were 8 of the pilot's 12 exits (~25% of its cost). Raise to values
   justified from `conc-liq-rpc-health` history (distribution of outage
   lengths) so that short blips hold rather than exit. Schema literals must
   change; keep the hard lag limit.
4. **Per-trade route quote.** Quote fee-500 and fee-3000 through QuoterV2
   and take the best net of gas (live cost note: +0.64 USDG, 19/58 swaps).
   Live executor only; paper harnesses keep the canonical pool path. Guard
   as described in that note's last paragraph. Lowest priority of the four.

Acceptance: tests for each, and a short note with before/after counts from
replaying the archived paper status and the pilot ledger.

### W5. Restart plan (needs the user's explicit go before any unit is enabled)

Prepare, do not execute:
- Config for a new paper set: NVDA-500 and GOOGL-500 at the size W3
  recommends under the 5% cap, plus MSFT-3000 and GLD-3000 if W3 clears
  them. Not AAPL-500 at more than 1,000.
- Policy: W1 residual range on, W2 timescales and blackout on, calibrated
  `feePpm`, W4 fixes in.
- An untouched holdout: one pool (or one time slice) that receives no
  policy tuning from here on.
- Forward run of at least three weeks spanning two weekends before any
  ranking is read. Marks per minute, actions logged, same archive layout
  as `data/adaptive-paper-60m-2026-09-16/`.

Deliver the config, the unit changes as a diff, and a one-page go/no-go
checklist for the user.

## 4. Traps already hit; do not repeat

- Warm up for the longest lookback in the arm set, or 6 h arms score
  availability, not estimates (forecast note §3).
- Alpha rank correlation between windows was +0.51; net fees +0.92. Do not
  pick winners on alpha.
- `volFlat_feeFlat` had zero recenters and was best in one window and
  worst in the other. A zero-action arm's ranking is the price path.
- A downside crossing is a local low. Any rule that sells there must be
  scored on reversion episodes (only three exist in the sample so far).
- Fee density scales with 1/width. Wider bands that stay in range earned
  less than narrow bands that left. Do not "fix" out-of-range time by
  widening; fix it by keeping inventory earning (W1).
- Out-of-scope: an off-chain hedge in the underlying would remove the
  directional term entirely. It is not available in this stack; the design
  bounds exposure instead.

## 5. Kickoff prompt for the implementing agent

> Read `notes/strategy-redesign-handoff-2026-09-18.md` and the five notes it
> lists in §0. Execute the workstreams in §3 in order, W0 first. Do not
> start or enable any paper or live systemd unit; W5 is preparation only.
> For each workstream produce the note and evidence directory it specifies,
> with a baseline arm reproducing the deployed policy exactly. Rank on net
> fees. Report what did not work as plainly as what did.
