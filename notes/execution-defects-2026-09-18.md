# W4: four execution defects, and what fixing them is actually worth

Date documented: 2026-09-18
Strategy version: `adaptive_paper_60m_v1` (no strategy change in this note)
Deployed release: `ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf`
Evidence directory: `notes/execution-defects-2026-09-18/`
Changed: `src/research/adaptive-lp.ts`, `src/indexer/store.ts`, `src/indexer/domain.ts`,
`src/storage/migrations.ts`, `src/storage/migration-checksums.ts`, `src/storage/compatibility.ts`,
`src/paper/store.ts`, `src/paper/holding.ts`, `src/paper/config.ts`, `src/experiment/source.ts`,
`src/risk/gate.ts`, `src/adaptive-paper.ts`, `src/live-pilot/route-selection.ts` (new)
Prerequisite: [fee-calibration-2026-09-18.md](fee-calibration-2026-09-18.md)

## Summary

1. **Entry fills (W4.1).** The per-leg mint bound is replaced by a bound on
   deployed liquidity. Evidence both ways: across 5/10/20/30-tick drifts in a
   ±160 band the worse leg moves 311–1,902 bps while liquidity moves 2–15 bps,
   always upward; across the live pilot's 43 mints the worst liquidity
   deviation was 17.9 bps and none exceeded 50. Replayed on the exit-rule
   harness, NVDA's 30 `frozen_mint_minimum` failures become 0.
2. **Indexer cursor (W4.2).** Root-caused and measured: the tail's own
   `runBackfill` → `rewind()` re-points the coverage cursor at the newest
   *surviving* `indexer_checkpoints` row, which its own rolling deletes leave
   at block 59,644,695 from 2026-09-10. Every consumer reads 6.5 million
   blocks of missing coverage for about one second in every ten — measured at
   **20 of 215 reads, 9.3%**. Fixed with a separate monotone
   `covered_through_block` column.
   **But the count the handoff asked for is zero.** No live decision was ever
   lost to this, and none could have been: `Source.rows()` filters uncovered
   rows out *before* `sourceReasons` runs, so `event_coverage_unavailable` is
   unreachable and reads 0 across all three books of the 27-hour session. The
   cost is polling latency and a silently invisible failure mode. Both are now
   fixed; the second one is arguably the more important.
3. **Pause allowances (W4.3).** The live cost note's estimate that timeout
   exits were "a quarter of campaign cost" and removable by raising the
   allowances **does not survive the health history.** Inside the pilot's own
   window there were 21 transient chain episodes and the longest was 50
   seconds — not one exceeded the 60-second budget. Raising
   `chainPauseSeconds` would have saved nothing there. The risk allowance is
   different and is genuinely misconfigured: 30 seconds sits *below* its own
   producer's cadence, which exceeded it in 21.4% of intervals inside the
   window and 35.9% over 13.9 days. That accounts for exactly the two
   `paper_risk_pause_expired` exits, and nothing more. Of the eight
   infrastructure exits, **two are removable, six are not**: three are hard lag
   faults no allowance covers, one is a hard evidence failure, and one chain
   pause expired with no recorded fault at all.
4. **Per-trade route quote (W4.4).** Implemented as a pure, tested selector
   with the two-stage guard from the live cost note, and deliberately **not
   wired into the executor** — that is a broadcast-path change and belongs to
   W5. Replayed against the campaign's 58 recorded quote sets it reproduces
   the 19-of-58 higher-tier wins.

Nothing here changes a strategy decision rule. Nothing was broadcast, no unit
was started, and the migration in §2 is **not applied** to the live database
(see §2.4).

## 1. W4.1 — cash-funded mint fills

`src/research/adaptive-lp.ts` previously asserted, on entry fills only:

```ts
for(const token of [0,1] as const)
  assert(plan.mint[`amount${token}`]*10000n >= pending.plan.mint[`amount${token}`]*(10000n-slippageBps));
```

The fill already re-plans from current balances at the fill price
(`this.plan(m,pending.plan)`). What it then compared was the *re-planned*
balanced legs against the *frozen quote's* balanced legs. Those two are not
close, because the split between the legs is a function of where the price
sits inside the band, and it is not a small function:

| Drift between quote and fill | worse leg | deployed liquidity |
|---:|---:|---:|
| 5 ticks | 316 bps | −2 bps |
| 10 ticks | 632 bps | −5 bps |
| 20 ticks | 1,267 bps | −10 bps |
| 30 ticks | 1,902 bps | −15 bps |

(±160 band, 5,000 USDG, negative = more than planned. Beyond ~50 ticks the
frozen 50-bps price band rejects the fill first, so a liquidity shortfall past
50 bps is not reachable at all under the existing price bound.)

The live pilot shows the same geometry from the other side. Its recenter
executor re-plans the mint from post-swap balances and regenerates its minima
from *that* re-plan (`src/paper/execution-recenter.ts:82`), so a mint one tick
from the top of its band sets `amount0Min` to 3,559 against an
`amount0Desired` of 105,916,684 and still fills. Measured over all 43 live
mints, realized liquidity against the liquidity the same balances support at
the quote-block price: median −1.80 bps, p90 +9.94, worst **+17.90**, none
above 50.

The fix keeps the frozen swap minimum and the frozen price band, and bounds
the mint on liquidity:

```ts
if(pending.kind==='entry')
  assert(plan.mint.liquidity*10000n >= pending.plan.mint.liquidity*(10000n-slippageBps),'frozen_mint_minimum');
```

The recenter path is untouched and still carries no mint bound of its own, so
every published baseline reproduces unchanged.

### Before and after

`scripts/adaptive-exit-rule-sim.mjs`, arm `exit_0m`, 2026-09-08 02:00Z →
2026-09-17 14:05Z. "Before" is the deployed release; "after" is a fresh
`npm run build` of the working tree with `CONC_LIQ_RELEASE=/root/conc-liq`.

| Book | | gate accepted | `frozen_mint_minimum` | entries | recenters | net fees | alpha |
|---|---|---:|---:|---:|---:|---:|---:|
| NVDA | before | 31 / 23,837 | **30** | 1 | 0 | 1.85 | −0.41 |
| NVDA | after | 1 / 20,493 | **0** | 2 | 3 | 27.27 | +21.01 |
| AAPL | before | 27 / 7,686 | **22** | 3 | 3 | 21.36 | +10.86 |
| AAPL | after | 4 / 7,300 | **0** | 4 | 10 | 36.53 | +20.70 |
| GOOGL | before | 0 / 0 | 0 | 1 | 0 | 7.79 | +11.78 |
| GOOGL | after | 0 / 0 | 0 | 1 | 0 | 7.79 | +11.78 |

`frozen_mint_minimum` disappears entirely: every acceptance that reaches the
fill now completes. GOOGL is never stranded in this window and is unchanged,
which is the control. The acceptance counts differ because a successful
re-entry changes every decision after it — these are whole trajectories, not
matched decisions, and the P&L columns should be read as "the rule now runs"
rather than as a measured improvement.

The re-entry gate itself still accepts only 0.13% of attempts, so this fix
makes the exit rule *executable*, not good. It is a prerequisite for any
future rule that ever steps aside, not a result in itself.

## 2. W4.2 — the indexer cursor readback

### 2.1 What it is

A probe reading `indexer_cursors` in a tight loop for 50 seconds
(`notes/execution-defects-2026-09-18/cursor-probe-2026-09-18.log`):

```
15:09:47.704  next 66213544  last_scanned 66213543
15:09:47.741  next 66213288  last_scanned 59644695   <- committed at .730018
 ... 20 consecutive reads ...
15:09:48.765  next 66213644  last_scanned 66213643   <- committed at .732053
```

20 of 215 reads, **9.3% duty cycle**, one committed transaction, exactly
1.00 second wide. The value 59,644,695 is fixed, not a trailing window.

### 2.2 Why

`next_block = 66,213,288` paired with `last_scanned_block = 59,644,695` is a
pair only `PostgresEventStore.rewind` writes: it sets `next_block = fromBlock`
and `last_scanned_block` to the newest `indexer_checkpoints` row **below**
`fromBlock`.

`conc-liq-tail` calls `runBackfill` every ten seconds. `calculateResumeStart`
returns `cursor.nextBlock − reorgOverlap`, and `runBackfill` unconditionally
calls `store.rewind(fromBlock)`, which deletes `indexer_checkpoints` at or
above `fromBlock` before re-fetching. Since each cycle deletes the previous
cycle's checkpoint, the table's persistent maximum is whatever last survived a
cycle: **2,898 rows, maximum block 59,644,695, 2026-09-10 19:13:58 UTC, and
zero rows between that and the head.** So every cycle, for the ~1.0–1.6 s the
scan takes, the coverage cursor claims the chain is indexed to 2026-09-10.

The column is doing two incompatible jobs. `findCanonicalAnchor` needs it to
be a reorg anchor with a matching hash, which is why it follows the sparse
checkpoint table. Every consumer — `sourceSql`, `ExperimentSource.coverage`,
`risk/gate.ts` — reads it as a coverage high-water mark.

### 2.3 The fix

Migration 3 adds `indexer_cursors.covered_through_block`. `saveChunk` only
ever raises it (`GREATEST`); `rewind` lowers it no further than `fromBlock −
1`, which is the block it actually invalidated, rather than to the anchor.
Consumers read `COALESCE(covered_through_block, last_scanned_block)`, so a
database that has not yet been written by the new writer behaves exactly as
today. Semantics are covered by the migration integration test.

Residual exposure after the fix is the reorg overlap itself — about 355 blocks,
roughly 75 seconds — which is *correct*: those events genuinely are being
re-scanned. That is the difference between a rare, honest deferral and a
blanket outage.

### 2.4 It is not applied, and cannot be yet

Migration 3 makes `schema_migrations` three rows. The running collectors are
on releases whose `assertSchemaReady` requires exactly two, so applying it now
would fail every worker's readiness check and stop data collection. The
migration therefore ships unapplied and belongs to the W5 restart, upgraded
together with the units. In the meantime the research harnesses read the
checkpoint query from the deployed release
(`CONC_LIQ_SOURCE_RELEASE` in `scripts/sim-source.mjs`'s callers) while running
whichever strategy build is under test.

### 2.5 The count the handoff asked for is zero, for a reason worth fixing

`Source.rows()` filtered `covered !== true` out of its result set, and only
then did the surviving rows reach `sourceReasons`, where
`event_coverage_unavailable` is counted. The reason was unreachable by
construction. The archived 27-hour session confirms it:

| Book | decisions | blocked total | `event_coverage_unavailable` |
|---|---:|---:|---:|
| NVDA | 3,906 | 1,121 | **0** |
| AAPL | 2,718 | 789 | **0** |
| GOOGL | 2,727 | 763 | **0** |

The checkpoints were not lost, only deferred: the runner polls
`c.block_number > last`, so a cycle that returns nothing retries the same
range a few seconds later. The real costs were (a) roughly 9% of polls doing
nothing, and (b) a failure mode invisible in the status file. `Source.rows()`
now returns the dropped counts and the caller records them under
`event_coverage_unavailable` and `checkpoint_not_canonical`, so the next
session measures this instead of hiding it.

It also cost the research harnesses outright: the first reproduction attempt
in this workstream failed on two books after ten retries.

## 3. W4.3 — pause allowances

### 3.1 What the health history says

119,427 samples over 13.91 days, one per 10.02 s (median). Episodes are runs
of consecutive samples carrying at least one fault of the relevant class.

**Transient chain faults** — the class `chainSince` tracks and
`chainPauseSeconds` bounds (`reference_count_below_quorum`,
`reference_hash_quorum_unavailable`, `private_probe_failed`,
`private_reports_syncing`, `private_confirmed_anchor_unavailable`,
`private_block_lag_soft`, `private_time_lag_soft`, `private_latency_soft`):

| episodes | mean | p50 | p90 | p95 | p99 | max |
|---:|---:|---:|---:|---:|---:|---:|
| 386 | 30 s | 10 s | 20 s | 38.5 s | 451 s | 2,676 s |

| allowance | episodes held |
|---:|---:|
| 60 s (deployed) | 372 / 386 = 96.4% |
| 120 s | 377 / 386 = 97.7% |
| **300 s** | 382 / 386 = **99.0%** |
| 600 s | 383 / 386 = 99.2% |

**Hard chain faults** — no allowance covers these: 27 episodes over 13.91 days
(1.94/day), median 20 s, p90 180 s, max 872 s. By reason:
`private_block_lag_hard` 227 samples, `private_time_lag_hard` 132,
`private_head_stalled` 2, `private_canonical_hash_mismatch` 1.

**Risk proof cadence** — what `riskPauseSeconds` is really bounding. The risk
producer's own interval, over 50,358 intervals: median 22 s, p90 59 s, p99
70 s, max 12,939 s. **18,070 intervals (35.9%) exceed the 30-second
allowance**; 79 (0.16%) exceed 180 s. The allowance is set inside the
producer's ordinary cadence, so one late run spends all of it.

### 3.2 What that means for the campaign

The live cost note attributed about a quarter of campaign cost to
timeout-driven churn and proposed raising the allowances. Checking that
against the health history for the pilot's own window (2026-09-12 14:24 →
2026-09-15 05:50 UTC):

- **21 transient chain episodes, longest 50 seconds, none over 60.** Raising
  `chainPauseSeconds` would not have prevented a single exit in this campaign.
- 12,672 risk intervals, of which **2,716 (21.4%) exceeded 30 s** and 80
  exceeded 60 s, maximum 185 s. Around the first `paper_risk_pause_expired` at
  16:00:04Z the producer was running on a ~60-second cadence (15:57:02,
  15:58:00, 15:59:02, 16:00:02) — twice the allowance.
- The 2026-09-14 15:46 `paper_chain_pause_expired` is recorded together with
  `private_block_lag_hard`. The health samples confirm a hard lag fault at
  15:46:03 and 15:46:13. No pause budget covers that.
- The 2026-09-12 14:46 `paper_chain_pause_expired` has **no recorded fault at
  all**: 138 consecutive healthy samples with `allow_bulk` true in the
  preceding 23 minutes, and no sample gap above 30 s anywhere near it (only 4
  such gaps exist in the whole 119,427-sample history, three of them on
  2026-09-04). It is not explained by this database.

Of the eight infrastructure exits — `private_block_lag_hard` ×3,
`paper_chain_pause_expired` ×2, `paper_risk_pause_expired` ×2,
`paper_current_risk_evidence_invalid` ×1 — **two are removable by this change**
and six are not. At the campaign's ~0.42 USDG exit-plus-re-entry round trip
that is about 0.84 USDG of 12.78, roughly **6.6% of campaign cost, not 25%**.

### 3.3 The change

`chainPauseSeconds` and `riskPauseSeconds` become bounded ranges instead of
frozen literals (`z.number().int().min(60).max(900)` and `min(30).max(900)`).
`maxLagBlocks` stays `z.literal(30)` — the hard lag limit is unchanged, as the
handoff requires. Recommended values for the W5 config: **chainPauseSeconds
300, riskPauseSeconds 300**. The first is justified by the 14-day distribution
and not by this campaign; the second is justified by both.

The exit rate the history predicts — 1.94 hard-fault episodes per day plus
about 1.0 transient over-runs per day — is 2.9/day against the campaign's
observed 8 exits in 63.4 hours, 3.0/day. The dominant term is hard faults, and
they are out of scope by design.

## 4. W4.4 — per-trade route quote

`src/live-pilot/route-selection.ts` is a pure module: `selectSwapRoute` picks
the best quoted fee tier **net of that route's own gas**, defaulting to the
baseline and requiring a configurable minimum gain; `acceptSimulatedRoute`
applies the live cost note's guard, rejecting a route whose simulated calldata
comes in more than `slippageBps` under its own quote, or whose simulated
output no longer beats the baseline by the minimum margin after gas.

Replayed over the campaign's 58 recorded quote sets it reproduces the
published result: the 3000 pool wins 19 of 58 with a positive total gain.
Valuing gas at campaign prices (0.083 gwei, ETH ≈ 2,530 USDG, so 157k gas =
0.033 USDG, matching the measured figure) is what makes an aggregator route
lose: 310k of extra gas costs about 0.065 USDG against roughly 0.06 USDG of
extra output at a 115-USDG swap.

It is **not wired into `src/live-pilot/chain.ts`**, which still quotes and
swaps `fee: 500` unconditionally. Wiring it changes what the live executor
broadcasts, which needs the user's go; it is listed in the W5 checklist.

## 5. Tests

| Change | Test |
|---|---|
| W4.1 liquidity bound | `test/adaptive-lp.test.ts` — three cases: a drifted fill that passes on liquidity while both legs blow past the old bound; a fill rejected when the re-plan does lose the liquidity; the drift sweep across 5/10/20/30 ticks |
| W4.2 monotone coverage | `test/integration/migrations.mjs` — `saveChunk` raises only, a stale writer cannot lower it, `rewind` drops to `fromBlock − 1` and not to the old anchor, and migration history is `[1,2,3]` |
| W4.3 allowances | `test/paper-holding.test.ts` — a 100-second transient fault exits at 60 and holds at 300; a late risk proof exits at 30 and holds at 300; the hard lag fault is still hard |
| W4.4 route selection | `test/route-selection.test.ts` — gas-net selection, missing candidates, minimum gain, both guard rejections, and the 19-of-58 replay |
| W3 3000-tier (separate note) | `test/adaptive-lp.test.ts` — a 3000/60 market, grid rounding, seed fee/spacing round-trip |

`npm run typecheck` passes. `npm test` passes: 576 tests, 76 suites, 0 failures.
`npm run test:integration` needs `TEST_DATABASE_URL` and an isolated schema; it
was not run here because applying migration 3 anywhere the running workers can
see it would stop data collection (§2.4).

## 6. Limitations

- The 2026-09-12 14:46 chain-pause expiry is unexplained. Something set
  `chainSince` while the circuit was healthy and the samples were fresh. The
  remaining candidate in `advanceHolding` is the controller's own tick clock
  running more than 30 seconds ahead of the newest sample it read, which this
  database cannot confirm or refute.
- The pause-allowance recommendation rests on 13.9 days of health history from
  one private RPC and one reference quorum. Nothing says the next fortnight
  has the same tail.
- The route selector is exercised against recorded quotes only. No simulated
  calldata was produced here; `acceptSimulatedRoute` is tested on constructed
  inputs, and the Kyber simulations it is calibrated against are in the live
  cost note, not reproduced.
- The W4.1 fix loosens a fill check. It is a bound on liquidity rather than on
  legs, but it is still weaker in one respect: a mint could deploy the quoted
  liquidity from a very different inventory split. The frozen price band and
  the frozen swap minimum are what stop that, and they are unchanged.
- No `npm run test:integration` run, per §5.

## 7. Reproduction

```bash
export PATH="$PWD/.tools/node/bin:$PATH"
npm run typecheck && npm test
npm run build                      # produces dist/ for the "after" replay

R=/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf

# W4.1 before (deployed release) and after (working tree)
SIM_START=2026-09-08T02:00:00Z SIM_END=2026-09-17T14:05:00Z $R/bin/node \
  scripts/adaptive-exit-rule-sim.mjs notes/fee-calibration-2026-09-18/exit-restated.json
CONC_LIQ_RELEASE=/root/conc-liq SIM_START=2026-09-08T02:00:00Z SIM_END=2026-09-17T14:05:00Z \
  node scripts/adaptive-exit-rule-sim.mjs notes/execution-defects-2026-09-18/exit-after-w41.json \
  --arms notes/execution-defects-2026-09-18/arms.json

# W4.2 cursor readback probe (read-only, ~50 s)
notes/execution-defects-2026-09-18/cursor-probe.sh
```

The W4.3 distributions are SQL over `rpc_health_samples` and
`risk_snapshot_runs`; the queries are in
`notes/execution-defects-2026-09-18/health-distributions.sql`.
