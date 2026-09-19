# W5: restart plan — prepared, not executed

Date documented: 2026-09-18
Status: **nothing is enabled, started or applied.** No systemd unit was
touched, no migration was run, no config was installed. This is a proposal and
a checklist.
Evidence directory: `notes/restart-plan-2026-09-18/`
Config: `config/adaptive-paper-restart-2026-09-18.json`
Prerequisites: all five W0–W4 notes in this series.

## 1. What changed against the handoff's prescription, and why

The handoff specified the restart policy as "W1 residual range on, W2
timescales and blackout on, calibrated `feePpm`, W4 fixes in". Three of those
survived contact with the evidence and one did not.

| Handoff | Proposed | Why |
|---|---|---|
| W1 residual range **on** | **on**, pinned to `residualWidthsTicks` rather than ranked | It wins net fees in both windows, so the handoff's own porting condition is met. But its width ranker is degenerate — it always picks the narrowest band, which is the arm with the worst alpha in both windows. Pinning the ladder is the difference between shipping the result and shipping the defect. |
| W2 timescales **on** | **on** (`volFlat_fee15m`) | +57% and +73% net fees, best arm in both windows, and the schema now permits it. |
| W2 open blackout **on** | **off** | It loses 7.3% and 12.5% of net fees in the two windows. Ranked on net fees, as the evaluation rule requires, it is not a candidate. It does buy alpha, but by an amount inside the noise band. |
| Calibrated `feePpm` | `feePpm: 1000000` | The calibration came back at 1.00. The deployed value was already right. |
| W4 fixes in | entry fill and coverage cursor in; pause allowances **not in this config** | The pause allowances live in the *paper execution* and *live pilot* configs (`src/paper/config.ts`), not in the adaptive-paper runner, which does not execute. They are ready but belong to a live restart, not this one. |

## 2. The proposed book set

Five books, 9,500 USDG of notional, sized under the 5% liquidity-share cap
measured at the narrowest band each grid permits (W3 §5).

**Correction, 2026-09-18 evening: GLD-3000 is dropped; four books, 7,000 USDG.**
The first poll of the started session blocked every GLD decision with
`oracle_feed_missing` and `paper_equity_oracle_missing`: the asset checkpoint
has no oracle address for GLD, which the September 13 reference snapshot had
already recorded ("rejected GLD, LLY and SGOV for missing feeds"). The W3
replay never saw this because the offline harness does not apply the
per-asset decision gate. A book that is blocked on every decision measures
nothing, so it is removed from `config/adaptive-paper-restart-2026-09-18.json`
until a GLD feed exists. The MSFT-3000 row is now the only 3000-tier book.

| Book | Size | Share at that size | Half-widths | Residual span | Role |
|---|---:|---:|---|---:|---|
| NVDA-500 | 2,500 | 1.21% | 10/20/40/80/160 | 20 | deepest book, full cost evidence |
| GOOGL-500 | 2,500 | 3.20% | 10/20/40/80/160 | 20 | full cost evidence |
| MSFT-3000 | 1,000 | 0.91% | 60/120/180/240/360 | 120 | best fee per unit liquidity; **cost evidence borrowed** |
| GLD-3000 | 2,500 | 0.46% | 60/120/180/240/360 | 120 | only book whose flow is not concentrated at the US open; **cost evidence borrowed** |
| QQQ-500 | 1,000 | 2.32% | 10/20/40/80/160 | 20 | **holdout**; **cost evidence borrowed** |

Deliberate departures from the sizes W3's table alone would give:

- **NVDA-500 at 2,500, not 5,000.** The cap permits 5,000 (2.39% share). The
  fee model does not: the calibration validated it at a maximum share of
  **0.103%**, and the universe study showed the fixed-recorded-flow assumption
  is what breaks as share rises, not the accounting. 2,500 is 1.21% — an
  extrapolation of 12×, which is defensible; 5,000 is 23×, which is a decision
  for the user, not for this note. Item G4 on the checklist.
- **AAPL-500 is absent entirely.** It is at 4.03% of pool liquidity at 1,000
  USDG, already effectively at the cap, and the handoff forbids more. A book
  that cannot be sized is not worth a slot in a five-book set.
- **MSFT-3000 at 1,000, not 2,500.** Its cost bundle is borrowed from
  NVDA-500 and the borrowing error favours it (W3 §4). The smallest useful
  size until a fork probe exists.

### The holdout

**QQQ-500 at 1,000 USDG, flagged `"holdout": true` in the config and in the
status file.** It is the only pool in the set that contributed to no selection
anywhere in this series: it was not papered, not swept, not used to choose a
width, a timescale or a size. It appears in the universe table only as a row.
It runs the identical policy and is to be excluded from every comparison that
picks anything. If the restart's result on the four tuned books does not also
appear on QQQ-500, the result is tuning.

QQQ-500's own properties make it a reasonable control rather than a token one:
48,056 swaps over the screen window, 685 USDG of fees per unit liquidity per
day (mid-pack), and the same ±10 grid as the two fee-500 books.

## 3. Deliverables

| Item | Path |
|---|---|
| Paper-set config | `config/adaptive-paper-restart-2026-09-18.json` |
| Proposed unit template | `notes/restart-plan-2026-09-18/conc-liq-adaptive-paper.service.proposed` |
| Diff against the repo template | `notes/restart-plan-2026-09-18/unit.diff` |
| Diff against the installed unit | `notes/restart-plan-2026-09-18/installed-unit.diff` |

The unit changes are small by design — a description, the release path and the
state path:

```diff
 [Unit]
-Description=NVDA AAPL GOOGL 60-minute adaptive-width paper sessions
+Description=Five-book adaptive-width paper sessions with residual ranges
@@
-WorkingDirectory=/root/conc-liq-releases/ed9a77be…
-ExecStart=…/launch.mjs …/paper-aapl-2026-09-13.env adaptive-paper watch …/adaptive-paper-60m-2026-09-16/state.json
+WorkingDirectory=<NEW_RELEASE>
+ExecStart=<NEW_RELEASE>/bin/node <NEW_RELEASE>/launch.mjs /root/conc-liq/data/paper-aapl-2026-09-13.env adaptive-paper watch /root/conc-liq/data/adaptive-paper-restart-2026-09-18/state.json
```

`<NEW_RELEASE>` is unknown until `npm run release:build` runs, which requires
a clean checkout, so the release hash is a checklist step rather than a value
in this document.

## 4. The ordering problem that has to be solved first

Migration 3 (`indexer_cursors.covered_through_block`) makes `schema_migrations`
three rows. Every worker's `assertSchemaReady` requires exactly
`REQUIRED_SCHEMA_VERSION` rows, and the running collectors are on releases
where that constant is 2. **Applying the migration before upgrading the
collectors stops data collection**, which is the one thing this workstream was
told not to do.

The safe order is:

1. Build and stage the new release.
2. Stop `conc-liq-tail` and the checkpoint timers.
3. Apply migration 3.
4. Re-point `conc-liq-tail`, `conc-liq-strategy-checkpoint` and
   `conc-liq-paper-assets-checkpoint` at the new release and restart them.
5. Verify the coverage cursor no longer reads back (§5, item V3).
6. Only then start the paper set.

Steps 2–4 are a collection outage of a minute or two. Everything above block
`last_scanned_block` at the moment of the stop is re-scanned on restart, so no
history is lost, but the gap will appear in the checkpoint series and the
first forecast after the restart needs its full 6-hour warmup.

Alternatively steps 2–5 can be skipped entirely and the paper set run against
the unmigrated database, with the cursor flake still present, costing roughly
9% of polls. That is the lower-risk option and the one to take if the
collectors are not to be touched.

**Correction, 2026-09-18 evening.** The first draft of this section claimed the
`COALESCE(covered_through_block, last_scanned_block)` readers made an
unmigrated database transparent. They do not: PostgreSQL rejects an unknown
column at parse time, and the first manual `adaptive-paper start` on release
`852f4189…` failed with `column i.covered_through_block does not exist`. The
adaptive-paper source now detects the column at connect time
(`hasCoverageColumn` in `src/paper/store.ts`) and falls back to the
pre-migration `last_scanned_block` predicate. The other readers of that column
(`src/experiment/source.ts`, `src/risk/gate.ts`, `src/paper/recovery.ts`,
`src/live-pilot/guard.ts`) are unchanged and still require migration 3 before
their releases are upgraded.

**Dashboard, same evening.** The paper unit was enabled on release
`9fed9384…` (four books). The dashboard could not follow: every worker except
the adaptive-paper runner calls `assertSchemaReady`, which requires exactly
`REQUIRED_SCHEMA_VERSION` migration rows, so a dashboard built from this tree
refuses the unmigrated database outright (release `c70210f3…`, commit
`4e0cc26`, is built and smoke-tested to that failure). The running dashboard
release `f602f6a1…` (commit `ffd2c86`) was pointed at the new state via
`ADAPTIVE_PAPER_STATE_PATH` instead. Its adaptive panel predates per-asset
budgets, so it labels every book `A-60m` and shows 1,000 USDG initial capital
for the 2,500 USDG books; NAV, fees, gas, decisions and blocks are right. The
accurate panel ships with the migration-3 upgrade (§4 steps 1–5), which also
has to carry `conc-liq-rpc-health`, `conc-liq-accounting`,
`conc-liq-perp-reference` and `conc-liq-paper-assets-checkpoint`, because
they run the same schema check.

## 4b. Migration and fleet upgrade, executed 2026-09-19

The user gave the go. The §4 safe order was followed, with the collectors
upgraded rather than left alone. Collection outage **07:54:14Z to 07:57:27Z,
3 min 13 s**; the migration itself took 2 s.

1. Stopped the four timers, then `conc-liq-adaptive-paper`, `-dashboard`,
   `-tail`, `-rpc-health` and the four timer-driven services.
2. `migrate` on release `c70210f3…` applied version 3 alone. `schema_migrations`
   now has three rows; `indexer_cursors.covered_through_block` exists, nullable,
   and was NULL until the new tail first raised it.
3. `adaptive-paper migrate-runtime` moved the session state from build
   `9fed9384…` to `c70210f3…` (state sha256 `b88710d8…`, one history entry).
   The prior state is kept at `state.pre-runtime-migration-2026-09-19.json`.
4. Eight units repointed at `c70210f3…`: tail, rpc-health, strategy-checkpoint,
   paper-assets-checkpoint, accounting, perp-reference, dashboard and
   adaptive-paper. Only `WorkingDirectory` and `ExecStart` changed; the
   originals are kept in this session's scratchpad. Started rpc-health first,
   then tail, then the paper session and dashboard, then the timers.

**Units deliberately left on their old releases**, all inactive: live-pilot and
its bootstrap, experiment, paper, paper-aapl, paper-googl,
paper-release-activation, usdg-grace-activation, cap-validation and
recenter-validation. `conc-liq-live-pilot.service` is `enabled` but dead; on its
current release it would now fail `assertSchemaReady` rather than start, which
is a safe failure but must be fixed before any live restart.

### Verification against §5

| Item | Result |
|---|---|
| V1 | All four books `running` with decisions climbing within a minute. |
| V2 | Policy reads `lookbackMinutes: 360`, `feeHalfLifeMs: 900000`, `residualRange: true`, `feePpm: 1000000`. |
| V3 | **Satisfied in substance, not in wording.** 100 reads over 60 s: the pre-migration cursor (`last_scanned_block`) was blind (more than 10,000 blocks behind the tip) on **11 of 100** reads with a worst lag of **7,277,174** blocks, reproducing the 9.3% duty cycle this series measured. `COALESCE(covered_through_block,last_scanned_block)` was blind on **0 of 100**, worst lag **848** blocks. The coverage cursor does still regress by up to ~256 blocks when `rewind` re-scans the tail's reorg overlap, which is the documented design: it drops to the block it invalidated and no further. "Never regresses" was the wrong acceptance wording; "never goes blind" is the property that was fixed. Live proof: at 11:01:58 EEST `last_scanned_block` read 59,644,695 while `covered_through_block` read 66,923,447. |
| V4 | `event_coverage_unavailable` is reachable and non-zero on every book. |
| V5 | QQQ-500 carries `holdout: true` in the status file and the dashboard. |
| V6 | GOOGL placed five residual ranges. Each has `action: "residual"`, `swapsThisMark: 0`, a 20-tick one-sided band, and a gas charge of **147,159**, exactly 2x221,310 - 177,373 - 118,088. The third converted the inventory back to 2,489 USDG of quote, which is the covered-call mechanism completing. |

### Two things the upgrade did not fix

- **HyperSync rate limiting at the top of each hour.** `conc-liq-accounting`'s
  `action-cost` step still exits 1 on `HyperSync HTTP 429`, and while it runs it
  starves the tail: four `tail_cycle_failed` entries between 08:00:22Z and
  08:00:57Z, during which coverage stopped advancing and every book deferred.
  The tail recovered by itself and resumed ten cycles in the next three minutes.
  This predates the migration and is unrelated to it, but it is now the largest
  remaining source of `event_coverage_unavailable`. Sampling the status file
  every 30 s for six minutes across the boundary separates the two regimes
  cleanly:

  | regime | span | deferrals | decisions |
  |---|---:|---:|---:|
  | during the HyperSync 429 burst | 90 s | 37 | 0 |
  | normal operation after it | 240 s | 4 | 30 |

  So the checkpoint stream is not being lost, it is being deferred and
  re-offered once the tail catches up, exactly as the counter is meant to
  record. Any future reading of `event_coverage_unavailable` has to exclude the
  first minute of each hour or it will measure the accounting job, not coverage.
- **The dashboard is the only consumer verified on the new release.** The
  accounting, principal, nft and backtest steps ran clean, but `action-cost`
  has not completed successfully since before the upgrade for the reason above.

## 5. Go/no-go checklist

Each item is either satisfied now, or is a step to take, or is a decision for
the user. Nothing below has been done.

### Gates on evidence — these block a start

- **G1. Fork cost probes for MSFT-3000, GLD-3000 and QQQ-500.**
  `scripts/lp-asset-fork-check.mjs` has never been run for the two 3000-tier
  pools (it is hard-wired to fee 500 and a 10-tick grid), and both carry
  NVDA-500's bundle with
  `"fork": "BLOCKED_no_fork_cost_probe_borrowed_from_nvda_500"` in the config
  as a deliberate tripwire. The error direction favours the 3000 tier.
  **Not satisfied for MSFT-3000 and GLD-3000.** QQQ-500 was in fact probed on
  2026-09-13 (`data/adaptive-lp-universe-study-2026-09-13/fork-QQQ.json`,
  passed, gas 4–13% above NVDA-500 per stage); the config now cites that probe
  and keeps the borrowed bundle, which slightly understates QQQ's costs.
- **G2. The residual width is a judgement, not a measurement.**
  `residualWidthsTicks: 20` on the fee-500 books is the arm with the best alpha
  in both windows and the second-best net fees. The evaluation rule selects
  `10`. This config overrides the rule on purpose and the reason is in W1 §4.
  **Decision for the user.**
- **G3. The 3000-tier residual span of 120 is untested.** No arm was run at
  that span; the 4-day probe only ever placed ±60 two-sided bands and three
  residuals. 120 is 2× the grid minimum by analogy with the fee-500 books'
  20-against-10. **Decision for the user**, or run the arm first.
- **G4. NVDA-500 at 2,500 is a 12× extrapolation of the validated fee share.**
  5,000 is 23×. **Decision for the user.**
- **G5. No `npm run test:integration`.** It needs `TEST_DATABASE_URL` and an
  isolated schema, and the migration-3 semantics test is only exercised there.
  **Not satisfied.** Run it before the migration.

### Steps to take, in order

- **S1.** Commit the working tree. `release:build` refuses a dirty checkout.
- **S2.** `npm run typecheck && npm test` — currently 576 tests across 76 suites, 0 failures.
- **S3.** `TEST_DATABASE_URL=… npm run test:integration` (gate G5).
- **S4.** `npm run release:build -- /root/conc-liq-releases` and record the hash.
- **S5.** Decide the migration question in §4: upgrade the collectors and
  migrate, or leave both alone and accept the cursor flake. Either is
  defensible; doing the migration without the collectors is not.
- **S6.** Render the unit from
  `notes/restart-plan-2026-09-18/conc-liq-adaptive-paper.service.proposed` with
  the new release hash and the new state path, and `systemctl daemon-reload`.
- **S7.** `adaptive-paper start config/adaptive-paper-restart-2026-09-18.json
  /root/conc-liq/data/adaptive-paper-restart-2026-09-18/state.json` once, by
  hand, and read the status file before enabling anything.
- **S8.** `systemctl enable --now conc-liq-adaptive-paper.service`.

### Verifications after starting

- **V1.** All five books report `status: "running"` and a non-zero `decisions`
  count within ten minutes. A book stuck at zero is a coverage or identity
  failure, not a quiet market.
- **V2.** The status file's `policy` block reads `lookbackMinutes: 360`,
  `feeHalfLifeMs: 900000`, `residualRange: true`, `feePpm: 1000000`. If it
  reads `lookbackMinutes: 60` the wrong config was loaded.
- **V3.** If the migration was applied: `SELECT covered_through_block FROM
  indexer_cursors` polled for a minute never regresses. Before the fix it read
  back to block 59,644,695 in 20 of 215 reads.
- **V4.** `blocked.event_coverage_unavailable` is now a reachable counter and
  should be small but non-zero. Zero on every book means the new counting is
  not wired; large means coverage is genuinely failing.
- **V5.** QQQ-500's status carries `holdout: true`.
- **V6.** Each book's first residual placement has `kind: "residual"`,
  `token: null` and a gas charge of `2*recenter − entry − exit`. A residual
  with a non-null `token` would mean it swapped, which it must never do.

### Do not read the result before

- **Three full weeks spanning two weekends.** The handoff's requirement, and
  this series is the reason for it: every ranking in it that held over four
  days and nine days was still measured on one price path with one sustained
  decline and no sustained recovery.
- Marks per minute and every action logged, in the archive layout of
  `data/adaptive-paper-60m-2026-09-16/`.
- QQQ-500 excluded from anything that selects.

## 6. What this restart cannot tell you

- **Whether the residual range helps when the market recovers.** Its mechanism
  is a covered call. The whole sample it was fitted on contains one 6% decline
  and no sustained recovery, which is precisely the regime that flatters it on
  net fees and punishes it on alpha. Three weeks may or may not supply one.
- **Whether any of it is live-executable.** Everything here is the offline
  conditional model. The live pilot's own evidence — 12.78 USDG of cost against
  7.38 of fees on 250 USDG — is the only realized data in the series, and the
  restart does not add to it.
- **Whether 2,500 USDG behaves like 1,000.** The fee model is validated at one
  size and one share. The capacity cap bounds one risk; the fixed-recorded-flow
  assumption is a different one and no forward paper run tests it, because the
  paper book never actually trades.

## 7. Reproduction

```bash
export PATH="$PWD/.tools/node/bin:$PATH"
npm run typecheck && npm test

# Validate the restart config against the grid and the cap
node --import tsx -e '...'   # the check in this workstream's transcript; the
                             # schema itself enforces the same on `start`
diff -u ops/conc-liq-adaptive-paper.service \
  notes/restart-plan-2026-09-18/conc-liq-adaptive-paper.service.proposed
```

No command in this note starts, enables or restarts anything, and none has
been run against the live database.
