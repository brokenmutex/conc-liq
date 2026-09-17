# 60-minute adaptive-width paper strategy with economic gate

Date documented: 2026-09-17  
Strategy version: `adaptive_paper_60m_v1`  
Session state: `/root/conc-liq/data/adaptive-paper-60m-2026-09-16/state.json`  
Configuration: `config/adaptive-paper-60m.json`  
Implementation: `src/adaptive-paper.ts`, `src/research/agile-forecast.ts`, `src/research/adaptive-forecast.ts`, and `src/research/adaptive-lp.ts`  
Documented source commit: `81d2662`  
Deployed release: `ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf` (occupancy correction, from 2026-09-17 08:45:48 UTC; previously `f602f6a12a6ce8cf3b56427539a77ac8d90f23d7813f4097811ebcad4b0c1048`)

## Scope and status

This note describes the exact forward paper policy running for NVDA/USDG,
AAPL/USDG, and GOOGL/USDG. It is distinct from the earlier six-hour adaptive
research configuration and from the database-backed fixed/earlier paper
sessions.

The strategy is an offline conditional model. It does not sign or broadcast
transactions, and it does not modify the canonical pool book. Its results are
not evidence that the strategy is live-executable or profitable.

Each asset starts with `1_000_000_000` raw USDG, or 1,000 USDG. Each pool is a
0.05% Uniswap v3-style pool with tick spacing 10. The strategy begins with all
capital in USDG, so its passive chart benchmark is the unchanged initial 1,000
USDG inventory.

## Frozen policy parameters

| Parameter | Value |
|---|---:|
| Forecast lookback | 60 minutes |
| Minimum real span | 40 minutes |
| Minimum samples | 40 |
| Forecast sampling cadence | At most one sample per minute |
| Decision cadence | 30 seconds |
| Forecast horizon | 10 minutes |
| Candidate half-widths | 10, 20, 40, 80, 160 ticks |
| Quote time-to-live | 90 seconds |
| Swap/price slippage ceiling | 50 bps |
| Cost buffer | 50% of recenter cost |
| Fee buffer | 25% of forecast move fees |
| Modeled fee share | 100% |
| Failure injection | Disabled |
| Independent reference tolerance | +/-5% |

The width candidates are approximately +/-0.10%, +/-0.20%, +/-0.40%,
+/-0.80%, and +/-1.61% in price. Tick-to-price direction depends on token
ordering; the dashboard converts the bounds to USDG prices.

Frozen fork-derived costs in raw USDG are:

| Asset | Entry | Recenter | Exit | Minimum 50% recenter buffer |
|---|---:|---:|---:|---:|
| NVDA | 176,526 | 220,524 | 117,376 | 110,262 |
| AAPL | 178,897 | 225,140 | 117,634 | 112,570 |
| GOOGL | 177,373 | 221,310 | 118,088 | 110,655 |

These are fixed model inputs, not fresh gas quotes. In USDG terms, the NVDA
recenter cost is $0.220524 and its minimum cost buffer is $0.110262, for
example.

## 1. Source-data admission

The runner reconstructs each pool from canonical indexed events and strategy
checkpoints. A checkpoint is used for a decision only when all relevant gates
pass:

- the checkpoint is canonical;
- event coverage and coverage identity are complete;
- the target-set identity has not changed;
- the pool is unlocked;
- the source is no more than 180 seconds old;
- chain/RPC recovery evidence is healthy;
- the independent reference evidence passes;
- pool price is within +/-5% of the accepted reference; and
- issuer pause, multiplier, and other asset-risk checks pass.

Only canonical, covered, identity-valid source rows enter the reconstruction.
The reconstructed price, tick, liquidity, and cumulative fee growth must agree
exactly with the checkpoint. A mismatch invalidates the asset model rather than
silently continuing.

Equity-session reasons are intentionally removed from the decision gate, so
the stock-token pools are modeled 24/7. This does not waive the price-reference
or chain-health requirements.

When a decision gate fails, the runner still marks the existing portfolio at
the new pool state, but it does not quote an entry or recenter. The reason is
counted under `blocked`.

## 2. Causal trailing forecast

Each forecast sample contains:

- source timestamp;
- pool square-root price;
- reconstructed cumulative token-0 fee growth; and
- reconstructed cumulative token-1 fee growth.

The latest sample must be no more than 90 seconds old. The selected window must
contain at least 40 samples and 40 minutes of actual time. Any observation gap
over 15 minutes makes the forecast unavailable. Missing observations are never
interpreted as a quiet market.

The sampler retains the observation immediately before the one-hour cutoff as
the causal baseline. The effective span can therefore be slightly longer than
exactly 60 minutes by up to roughly one sample interval.

### Volatility rate

For adjacent square-root prices, the model converts price movement to tick
movement:

```text
delta_tick_i = 2 * ln(price_i / price_(i-1)) / ln(1.0001)
```

The trailing variance rate is:

```text
variance_ticks_per_ms = sum(delta_tick_i^2) / sum(delta_time_i)
```

There is no predicted directional drift. The forecast estimates movement
magnitude, not whether the stock will rise or fall.

### Fee-growth rate

The model measures actual reconstructed fee-growth changes over the same
causal window. The deployed configuration has no volatility or fee half-life,
so observations are effectively equally weighted.

Forecast fee income accounts for:

- observed fee-growth rate;
- the 10-minute horizon;
- current canonical pool liquidity;
- hypothetical strategy liquidity;
- dilution between canonical and hypothetical liquidity;
- forecast time inside the range; and
- the configured 100% modeled fee share.

## 3. Decision trigger

The strategy evaluates at most once every 30 seconds. If an existing position
is inside its range, it holds the position and does not continuously re-optimize
the width.

A range decision is considered when:

- there is no position; or
- current tick is below `tickLower`; or
- current tick is at or above `tickUpper`.

The upper boundary is outside because Uniswap ranges are lower-inclusive and
upper-exclusive.

There is no ordinary persistence requirement or recenter cooldown. A cooldown
exists only for the disabled partial-mint-failure stress path. The economic
gate is the principal protection against excessive recentering.

## 4. Candidate construction

For every candidate half-width, the runner:

1. selects the nearest valid tick-grid center whose range contains the current
   tick;
2. reconstructs idle balances, LP principal, and accrued modeled fees;
3. solves the balancing swap needed to deploy that inventory into the range;
4. quotes the swap through the canonical pool path;
5. rejects incomplete fills or excessive slippage;
6. calculates the candidate mint and requires positive liquidity; and
7. retains unavoidable residual inventory as idle balances.

One infeasible width does not exclude the other candidates. The plan may use a
token-0-to-token-1 swap, a token-1-to-token-0 swap, or no swap.

## 5. Ten-minute scenario forecast

Every feasible candidate is evaluated over the same ten-minute horizon.

**Fee occupancy (corrected 2026-09-17).** The original implementation sampled
range occupancy at ten points along three deterministic paths (down, zero,
up, weighted 1:4:1). Because the zero-move path never leaves any band, every
width had at least two-thirds occupancy regardless of volatility, and fee
income scales with liquidity, which scales with 1/width. The narrowest
feasible width therefore always won: all 21 placements in the first 18 hours
of this session chose ±10 ticks, including the Sep 16 18:00–20:00 UTC period
when the trailing 10-minute sigma on NVDA was 11–20 ticks.

The forecast now uses the analytic expected in-band time until first exit for
a driftless diffusion in tick space with the trailing variance
(`rangeOccupancy` in `src/research/adaptive-forecast.ts`). The survival
probability is computed by the method of images and integrated over the
horizon. A position that starts outside its band earns no forecast fees;
re-entry is a later decision. Fee income is:

```text
fees = trailing_fee_rate × horizon × dilution × occupancy × fee_share
```

Each candidate that starts inside its band is also charged the recenter cost
multiplied by the probability of leaving the band within the horizon. That
charge is the management a narrow range is expected to need. With this model
the fee-optimal half-width scales with the forecast move: about ±10 ticks when
10-minute sigma is below roughly 10 ticks, ±20 near 20 ticks, ±40 near 40
ticks, before the crossing charge pushes the choice wider still.

**Terminal value.** Inventory value is still evaluated at three
moment-matched zero-drift scenarios:

| Scenario | Volatility displacement | Weight |
|---|---:|---:|
| Down | `-sqrt(3) * sigma` | 1 |
| Central | `0` | 4 |
| Up | `+sqrt(3) * sigma` | 1 |

```text
expected_terminal = (down + 4 * central + up) / 6 - crossing_charge
```

A lognormal correction is applied to the scenario price displacement. At each
terminal scenario the model:

1. reconstructs LP principal at the scenario price;
2. adds idle balances and forecast fees;
3. hypothetically withdraws the LP;
4. converts remaining stock-token inventory to USDG through the canonical
   pool path; and
5. subtracts the configured exit cost.

If the terminal unwind cannot be completely and safely quoted, the candidate
forecast is unavailable. Among valid candidates, the width with the highest
expected terminal USDG is selected.

The correction was deployed to the running session at 2026-09-17 08:45:48 UTC
as release `ed9a77be…` (source `81d2662`): the service was stopped with no
pending quote, the state file was backed up and migrated with
`adaptive-paper migrate-runtime`, and only the release path in the unit
changed. Strategy configuration, environment and session state were
unchanged. Evidence is in `data/adaptive-occupancy-deployment-2026-09-17/`.
Placements before that time were made by the original sampled occupancy. The
earlier adaptive studies were also produced with the original occupancy and
are not rerun here.

## 6. Economic recenter gate

For a recenter, the selected move is compared with retaining the existing
position. Both alternatives use identical scenarios, forecast horizon, fee
inputs, price path, and terminal-exit treatment.

Let:

```text
move_terminal = expected terminal USDG after moving
keep_terminal = expected terminal USDG from keeping the existing position
```

The incremental benefit is:

```text
benefit = move_terminal - recenter_cost - keep_terminal
```

Two safety buffers are calculated:

```text
cost_buffer = recenter_cost * 50%
fee_buffer  = forecast_move_fees * 25%
buffer      = max(cost_buffer, fee_buffer)
```

The move is accepted only when:

```text
benefit > buffer
```

Equality is rejected. The recenter cost is in addition to the common terminal
exit cost already included in both forecasts.

This gate intentionally permits an out-of-range position to remain out of
range. If the candidate's forecast fees and inventory outcome do not repay the
move plus its buffer, doing nothing wins even though the retained position is
earning no LP fees.

For example, a projected gross improvement of $0.10 cannot justify a $0.22
recenter. Its benefit after the move cost is about -$0.12, below the roughly
$0.11 minimum buffer.

The initial entry is different: candidates still require valid forecasts and
all execution/risk checks, but the keep-versus-move economic gate is not
applied because there is no existing LP position to retain.

## 7. Frozen quote and later-block fill

Passing the gate creates a pending paper quote; it does not immediately change
inventory. The pending record freezes:

- range bounds;
- swap direction;
- quoted input and output;
- maximum input budget;
- reference price;
- source block and timestamp; and
- economic-gate score.

Fill requires a later block and later timestamp, within the 90-second quote
TTL. At fill time the runner verifies:

- the source advanced;
- the frozen target range still contains the current tick;
- current and post-swap prices remain within the 50-bps bound;
- swap direction did not change;
- input does not exceed the frozen budget;
- output meets the frozen minimum rate;
- the mint remains feasible; and
- a refreshed economic forecast still clears the same gate.

The last item creates `fill_economic_gate` rejections: a quote may be attractive
at decision time but cease to be attractive before its later-block fill.

Failed preflight does not charge modeled gas or mutate inventory. On a
successful fill, the runner releases the old position, applies the balancing
swap, charges the fixed recenter cost once, mints the new position, retains
idle residuals, and records the complete modeled action.

## 8. Accounting and dashboard semantics

Modeled fees accrue only while liquidity is inside its range. Out-of-range
liquidity remains one-sided inventory and earns no modeled LP fees.

Marked NAV is:

```text
NAV = value(idle balances + LP principal + accrued fees)
      - cumulative modeled execution costs
```

The chart's passive benchmark is the unchanged initial 1,000 USDG inventory.
Adaptive history is persisted approximately once per minute and for every
action. History before the first persisted adaptive baseline remains explicitly
unobserved rather than interpolated.

The current dashboard word `recentring` means that the position is outside its
range and is being evaluated for range management. It does **not** prove that a
move passed the economic gate. The authoritative indicator of an accepted
quote is `model.pending`; when that value is null, no recenter is pending.

## 9. Important limitations

The policy does not currently:

- predict directional equity returns;
- use an external volatility forecast or order book;
- continuously replace an in-range position;
- force a move solely because the range was crossed;
- compare recentering with a permanent strategic exit;
- refresh modeled execution costs from live gas on every decision;
- learn cost parameters online; or
- sign or broadcast transactions.

The narrowest +/-10-tick range can cross frequently. The economic gate can then
leave the strategy outside range for long periods because paying to restore fee
earning is still forecast to destroy more value than it creates. This is
intended behavior under the current policy, not by itself evidence that the
runner is stalled.

## 10. Relationship to research evidence

The earlier adaptive studies remain relevant warnings, not promotion evidence.
They found that the economic gate reduced trading but could leave positions
outside range for substantial periods, and that adaptive candidates did not
uniformly outperform fixed-width controls. This forward session changes the
forecast lookback from six hours to 60 minutes and adds the +/-10 candidate; it
does not erase those historical findings or establish profitability.

Any policy change should be evaluated as net LP alpha versus the passive
benchmark with complete action costs, range-crossing behavior, inventory path,
and an untouched holdout. Gross fee generation alone is not sufficient.
