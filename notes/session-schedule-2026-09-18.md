# W2: session-aware width and decoupled forecast timescales

Date documented: 2026-09-18
Strategy version: `adaptive_paper_60m_v1`, with the forecast lookback unpinned (§5)
Deployed release: `ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf`
Evidence directory: `notes/session-schedule-2026-09-18/`
Scripts: `scripts/adaptive-forecast-sweep.mjs` (extended), `notes/session-schedule-2026-09-18/report.py`
Prerequisite: [fee-calibration-2026-09-18.md](fee-calibration-2026-09-18.md)
Predecessor: [adaptive-forecast-and-exit-rule-2026-09-17.md](adaptive-forecast-and-exit-rule-2026-09-17.md)

## Summary

1. **The timescale change is confirmed and is worth a lot.** `volFlat_fee15m`
   — a flat 6-hour variance estimate with a 15-minute fee half-life — earns
   229.01 against the deployed config's 145.72 in net fees over nine days
   (+57%) and 165.46 against 95.54 over four (+73%). Both figures reproduce
   the published sweep to the microUSDG, and `src/adaptive-paper.ts` now
   accepts them: the `lookbackMs` literal is gone.
2. **The open blackout does not pay, and the two windows agree that it does
   not.** On `volFlat_fee15m` it costs 7.3% of net fees over nine days and
   12.5% over four. Ranked on net fees, as the evaluation rule requires, it
   loses in both windows. It is not a deployment candidate.
3. **But the attribution shows it doing exactly what it was designed to do.**
   13:30–15:00 UTC is 6.25% of the clock and carries 27.2% of
   `volFlat_fee15m`'s fee income over nine days — and −83.40 USDG of its
   inventory P&L. The blackout halves both: open fees 70.28 → 35.15, open
   inventory −83.40 → −45.64. The inventory saving is larger than the fee
   loss, which is why alpha rises from 27.93 to 46.37 while net fees fall.
   The session hypothesis was right about the session and wrong about which
   term to optimise.
4. **The minimum-half-width rule makes it worse on net fees and better on
   alpha again**, in the same direction and by a similar amount, so it adds
   nothing the blackout has not already said.
5. The alpha differences here — an 18 USDG swing over nine days on three
   books — sit inside the one-day-directional-swing noise band the predecessor
   notes warn about. The net-fee differences do not. That asymmetry is the
   whole reason the evaluation rule exists, and it points the same way in both
   windows: keep the timescales, drop the schedule.
6. One number in the 9-day table must not be read as a schedule effect:
   `live_60m+open_blackout` on AAPL shows 21.47 against 66.82. AAPL's
   checkpoints begin 2026-09-13, so on the 9-day window it runs with negative
   warmup, its first feasible decision lands inside the blackout, and the
   blackout defers its *entry* by most of a day. That is an artefact of the
   unwarmed window, which is why the 4-day window exists (§4).

Everything here is offline paper modelling. Nothing was broadcast and no unit
was started.

## 1. The two changes

**Timescales.** `agileForecastStats` derives the width-selecting variance and
the gate-driving fee rate from one window. `AgileForecastSpec` already
supported decoupling them; the deployed config used none of it, and
`src/adaptive-paper.ts:33` pinned `lookbackMs` to a literal 3,600,000 so a
different value could be simulated but never deployed. That literal is now a
bounded range (§5).

**Open schedule.** No new entry or recenter from 09:15 to 10:00 New York time
on non-holiday weekdays — 13:15 to 14:00 UTC while EDT is in force. Minutes
are New York local and the weekday/holiday test is the 2026 calendar already
in `src/paper/trading-hours.ts`, so the window tracks the open through DST
rather than a fixed UTC clock. Positions are held, never exited; a quote
frozen before the blackout is still allowed to fill. The optional variant adds
a 40-tick minimum half-width for decisions made 10:00–11:00 ET.

## 2. Harness

`scripts/adaptive-forecast-sweep.mjs` gains a `ScheduledReplay` subclass and an
optional `schedule` key per arm. With no schedule it is the base class exactly,
which is the check that matters: `live_60m` and `volFlat_fee15m` reproduce the
published sweep to the microUSDG in both windows.

It also gains per-session attribution. Each observation closes the previous
interval on the state that interval was actually carried in, valuing the fee
tokens earned in the interval at the interval's own price so a later price
move cannot revalue fees already booked. `NAV = inventory + fees − gas`, so
inventory is recovered as `navDelta − feeDelta + gasDelta`. The `open` bucket
is 13:30–15:00 UTC on non-holiday weekdays, matching the window the
residence-cap sweep measured worst on volume/sigma²; everything else is
`rest`.

## 3. Results

Combined over the books present, USDG. Net fees are `fees − gas`.

### Nine days, 2026-09-08 02:00Z → 2026-09-17 14:05Z

| Arm | Net fees | Alpha | open fees | open inventory | rest fees | rest inventory | open fee share |
|---|---:|---:|---:|---:|---:|---:|---:|
| `live_60m` | 145.72 | 49.18 | 21.79 | −35.42 | 131.95 | −61.42 | 14.2% |
| `volFlat_fee15m` | **229.01** | 27.93 | 70.28 | −83.40 | 187.77 | −117.51 | 27.2% |
| `live_60m+open_blackout` | 101.41* | 29.08* | 12.46 | −33.26 | 92.96 | −39.11 | 11.8% |
| `volFlat_fee15m+open_blackout` | 212.34 | **46.37** | 35.15 | −45.64 | 196.17 | −120.27 | 15.2% |
| `volFlat_fee15m+blackout+minw40` | 189.39 | 36.41 | 28.02 | −38.02 | 177.75 | −115.01 | 13.6% |

\* contaminated by AAPL's deferred entry on the unwarmed window; see §4.

### Four days, 2026-09-13 15:00Z → 2026-09-17 14:05Z (all books fully warmed)

| Arm | Net fees | Alpha | open fees | open inventory | rest fees | rest inventory | open fee share |
|---|---:|---:|---:|---:|---:|---:|---:|
| `live_60m` | 95.54 | 59.56 | 13.42 | −12.08 | 87.49 | −23.54 | 13.3% |
| `volFlat_fee15m` | **165.46** | 46.28 | 51.99 | −51.83 | 134.94 | −66.45 | 27.8% |
| `live_60m+open_blackout` | 96.86 | 61.91 | 14.05 | −11.61 | 87.96 | −22.98 | 13.8% |
| `volFlat_fee15m+open_blackout` | 144.75 | 57.37 | 24.95 | −18.85 | 133.09 | −67.86 | 15.8% |
| `volFlat_fee15m+blackout+minw40` | 139.98 | **63.13** | 19.35 | −11.74 | 131.78 | −64.55 | 12.8% |

### What the blackout does to the window it targets

On `volFlat_fee15m`, restricting attention to 13:30–15:00 UTC:

| Window | | open fees | open inventory | open net | recenters, whole run |
|---|---|---:|---:|---:|---:|
| 9 days | without | 70.28 | −83.40 | −13.12 | 128 |
| 9 days | with | 35.15 | −45.64 | −10.49 | 83 |
| 4 days | without | 51.99 | −51.83 | +0.16 | 97 |
| 4 days | with | 24.95 | −18.85 | +6.10 | 60 |

The open is where both the income and the damage live. Suppressing decisions
there suppresses both, and on this sample the inventory saving is slightly the
larger of the two — +2.63 USDG over nine days, +5.94 over four, on a book of
3,000 USDG. That is real but it is small, and it is bought by giving up 16.67
and 20.71 USDG of net fees respectively. The rest of the day is essentially
untouched (fees 187.77 → 196.17 and 134.94 → 133.09), which is the check that
the effect is attributable to the session it targets.

## 4. What did not work, and one number that is not a result

- **The blackout loses on the ranking metric in both windows.** −7.3% and
  −12.5% of net fees. Per the evaluation rule that settles it.
- **The minimum half-width adds nothing separable.** It moves net fees and
  alpha further along the same axis the blackout already moved them
  (189.39/36.41 and 139.98/63.13), and it does so by suppressing narrow bands
  in a second window rather than by any new mechanism.
- **`live_60m+open_blackout` over nine days is not interpretable.** AAPL and
  GOOGL checkpoints begin 2026-09-13, so on that window they run with
  −7,572 minutes of warmup. AAPL's first feasible decision falls inside the
  blackout, the entry is deferred, and the book finishes with 1 recenter
  against 17 and 21.47 net fees against 66.82. The blackout is blocking entry,
  not managing a session. On the 4-day window where the same arm is warmed it
  reads 96.86/61.91 against 95.54/59.56 — a small improvement on both. The
  9-day row is retained only so the artefact is visible rather than quietly
  dropped.
- **The alpha gains are inside the noise band.** 18.4 USDG over nine days on
  three books, against daily NAV swings of 10–25 USDG per variant per book in
  the residence-cap sweep. The net-fee losses are three to four times larger
  and are what the arms are ranked on.

## 5. The schema change that came out of this

`src/adaptive-paper.ts` pinned the whole forecast spec to literals:

```ts
forecast:z.object({lookbackMs:z.literal(3600000),minimumSpanMs:z.literal(2400000),
  minimumSamples:z.literal(40)}).strict()
```

It is now a bounded range that also admits the half-lives
`AgileForecastSpec` has always supported, with the lookback required to cover
its own minimum span:

```ts
forecast:z.object({lookbackMs:z.number().int().min(600000).max(21600000),
  minimumSpanMs:z.number().int().min(600000).max(21600000),
  minimumSamples:z.number().int().min(40).max(1000),
  volatilityHalfLifeMs:z.number().int().positive().optional(),
  feeHalfLifeMs:z.number().int().positive().optional(),
  weightedFeePpm:z.number().int().min(0).max(1000000).optional()}).strict()
  .refine(f=>f.lookbackMs>=f.minimumSpanMs,...)
```

The existing config parses unchanged, so the deployed session's config hash is
unaffected. `volFlat_fee15m` is now expressible as
`{lookbackMs:21600000, minimumSpanMs:7200000, minimumSamples:60,
feeHalfLifeMs:900000, weightedFeePpm:1000000}`.

## 6. Limitations

- One price path. NVDA nine days, AAPL and GOOGL four, one sustained decline
  and no sustained recovery.
- Four observed open sessions in the warmed window and seven in the full one.
  A session effect measured on seven mornings is a hypothesis with a number
  attached, not an estimate.
- The blackout boundaries (09:15–10:00 and 10:00–11:00 ET) were chosen from
  the residence-cap sweep's volume/sigma² table and were not tuned here. They
  are also not the only reasonable choice, and the handoff's own instruction
  not to run further sweeps on this sample is why no others were tried.
- The session attribution splits NAV into fees and inventory at observation
  resolution, which is finer than the residence-cap sweep's 15-minute marks,
  but it still uses exposure carried into each interval and is an
  approximation of the same kind.
- Chain-health gates are not applied, so the simulation decides at timestamps
  the live runner would skip — including inside the blackout, where the live
  runner's own behaviour is untested.
- Per the handoff, no further width, horizon or timescale sweeps were run on
  this sample. The five arms here are the five the handoff names.

## 7. Recommendation

Take the timescales; leave the schedule.

- **`volFlat_fee15m` for the restart**: it is the best net-fee arm in both
  windows, the change is now deployable, and the forecast note already
  established that its ranking reproduces where alpha's does not.
- **No open blackout, no minimum half-width.** Both lose on net fees in both
  windows. What they establish is narrower and more useful: the open is
  responsible for a quarter of fee income and roughly all of the inventory
  damage, at 6.25% of the clock. Whatever eventually manages that term will
  have to do it without giving up the income, which neither of these does.

## 8. Reproduction

```bash
R=/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf
E=notes/session-schedule-2026-09-18

SIM_START=2026-09-08T02:00:00Z SIM_END=2026-09-17T14:05:00Z $R/bin/node \
  scripts/adaptive-forecast-sweep.mjs $E/session-full.json --arms $E/arms.json
SIM_START=2026-09-13T15:00:00Z SIM_END=2026-09-17T14:05:00Z $R/bin/node \
  scripts/adaptive-forecast-sweep.mjs $E/session-warmed.json --arms $E/arms.json

python3 $E/report.py $E/session-full.json $E/session-warmed.json
```

`SIM_FEE_PPM` defaults to the calibrated 1,000,000. The harness reads the
local database directly, imports the compiled strategy from the release
directory, and never writes to the database or to any live session state.
