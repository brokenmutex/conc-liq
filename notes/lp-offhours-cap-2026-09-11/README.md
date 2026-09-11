# Off-hours inventory caps and paper recovery — September 11, 2026

**Keep the paper cap at 60% while the frozen 60/70/80% comparison receives a complete weekend of new data.** In three complete historical trading windows, 80% improved average net cash P&L by **1.908411 USDG per window** relative to 60%. Its average P&L remained **−2.025651 USDG**, and it spent substantially longer outside its LP range. This is evidence that repeated liquidation and reentry can be expensive; it does not establish profitability or an optimal cap.

## Controlled historical comparison

Each allowed window starts with **939.964887 USDG**. All candidates use **80% LP allocation, ±20 raw ticks**, a 600-second cooldown after a full cash exit, and a 24-hour maximum holding period. Only the inventory exit threshold differs. Remaining net cash funds each subsequent entry within the same window. Capital resets between windows, so these results are not a continuous campaign return. New entry quotes recenter around the current price; there is no separate in-position recenter operation.

Source: **5,839 canonical checkpoints, 717,465 events and 49,880 health samples**, September 5 12:32:48–September 11 07:18:05 UTC. Pool price, liquidity, initialized ticks and fee growth reconcile against every checkpoint. Recorded health samples drive the bounded holding model with a 30-block lag tolerance. Historical checkpoint capture plus 30 seconds defines a decision; an entry or exit needs a later source to fill.

Three complete, paired windows qualify: September 8 00:00–04:00 New York after the Labor Day exclusion, September 8 16:00–September 9 04:00, and September 9 16:00–September 10 04:00. These have different lengths. The first captured weekend is partial and contains missed holding decisions; the final overnight window is still partial at capture. Both are excluded from ranking. **No complete weekend validates the cap comparison yet.**

| Inventory cap | Mean net P&L/window | Mean alpha vs passive inventory | Mean gain vs 60% | Entry/exit cycles | Inventory exits | Total gas estimate | Total fees modeled | Hours outside range |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 60% | −3.934062 | −2.283246 | — | 12 | 8 | 12.611616 | 9.955974 | 0.443 |
| 70% | −3.030010 | −1.379194 | +0.904051 | 9 | 5 | 9.458712 | 9.295837 | 3.637 |
| 80% | −2.025651 | −0.374835 | +1.908411 | 4 | 0 | 4.203872 | 6.610951 | 9.083 |

All monetary figures are USDG. Totals cover all three qualifying windows. The caps are exit triggers, so delayed decisions and fills can exceed them; 60% reached 70.3927% exposure in this sample. Each candidate also made three scheduled cash exits and one holding-guard exit. No qualifying window exited after its cash deadline.

| Window ending, UTC | 60% net P&L | 70% net P&L | 80% net P&L |
|---|---:|---:|---:|
| September 8 08:00 | −9.307824 | −8.361973 | −5.830953 |
| September 9 08:00 | +2.201637 | +4.144650 | +4.144650 |
| September 10 08:00 | −4.695998 | −4.872708 | −4.390649 |

70% underperformed 60% in one window by 0.176710 USDG. 80% improved all three, with a smallest improvement of 0.305349 USDG. The worst marked drawdowns were 9.307824, 8.361973 and 5.922370 USDG respectively. This small, correlated sample cannot establish future downside protection.

With **double gas and half the modeled fees**, mean P&L is −9.792642, −7.728925 and −4.527546 USDG for 60%, 70% and 80%. Less turnover remains favorable in that sensitivity, but every candidate loses on average.

The 80% allocation limits how much inventory can initially become NVDA. An 80% cap therefore permits most of that sleeve to become one-sided before triggering an exit. Its reduced churn and increased time outside the range are connected. Fees, costs, reference prices and inventory valuation can still move the measured exposure above 80%; the cap is not mathematically unreachable.

## Accounting and evidence limits

Entry buys and exit liquidations use exact integer historical depth and swap fees/slippage, with position-manager mint rounding, idle cash and tokens, and retained Q128 fee remainders. Fees follow actual crossings with added-liquidity dilution. Later historical market prices remain unchanged by the hypothetical trades. Time outside the range is measured from checkpoint states, not exact intracheckpoint crossing durations.

Entry gas **0.868343**, exit gas **0.182625**, and passive benchmark buy gas **0.251146 USDG** come from saved local Nitro fork estimates for paper entry run 181 and exit run 182. They are reused at other times and sizes. These are neither mainnet expenses nor future cost quotes. Partial transaction failures and their gas are not modeled. Entry failures rejected before a hypothetical fill incur no transaction gas in this replay.

The passive benchmark buys the same initial token inventory as the first entry, includes its buy gas, and remains invested through the common window endpoint after the LP exits. Absolute net cash P&L is reported alongside alpha. Fees are income, not profit.

Source reference/issuer checks and recorded chain readiness are enforced. **Current-risk refresh timing is approximated by source-reference eligibility; historical ETH/USD gas-feed freshness is not proven.** This is a matched policy model, not exact reproduction of all live executor decisions or simultaneous fork executions. Missing holding decisions over 900 seconds, stale decision sources, partial windows, or unresolved scheduled exits make the paired window unavailable. Complete event coverage alone cannot repair missing decisions.

## Paper repair and off-hours operation

Session **55** had a successful, timely saved fork exit (run **182**, computed September 10 15:27:03.431 UTC), but persistence rejected it as `paper_session_changed_during_preflight`. Later, the session was invalidated as `source_stale_or_worker_missed_decision`; the dashboard displayed the resulting invalid continuation history.

The state comparison depended on JSON object-key order. PostgreSQL `jsonb` reordered nested holding evidence, producing a false change even though values were unchanged. Commit **0c882e4** replaces that check with semantic JSON equality while retaining guards against operator cancellation, financial changes, changed safety evidence and array reordering.

At **September 11 07:20:08.674 UTC**, recovery reconciled the existing saved exit after checking source identity, canonicality, event coverage, health, inventory, fees, costs and the later invalidation. It did not generate a replacement historical fill. Proceeds of **941.015855** minus cumulative costs of **1.050968** leave **939.964887 USDG**, preserving session 55's **−6.851637 USDG** loss. The original rejection and superseded observation remain in the database recovery envelope and captured incident files. The observation shares the exit checkpoint's unique key, so the audited recovery corrects that row and preserves its previous content in `recovery.beforeObservation`.

Session **56** continued explicitly from that cash and entered successfully through paper run **192**. At **07:32:57 UTC**, it was open with no exit reasons and valid campaign ancestry. Its policy remains **60% cap / 80% allocation / ±20 raw ticks**, with the existing 30-block holding tolerance, ±5% reference-price band and USDG freshness policy. Dashboard and paper timer were active. The former four-strategy experiment remains stopped.

Both paper and dashboard use sealed release `b4909be4c608676f7a2f0ea9fb55159bca2ea25fe475d25d9c691cf01a8fac38`, built from `0c882e41d2571cab901d50a29822c57a9b1d40a6`. Other producers were not redeployed. All transaction simulation remains local paper execution; no signing/broadcast capability was added.

The new schedule allows New York after-hours (16:00–20:00), overnight (20:00–04:00), and weekends. Premarket and regular sessions are excluded. Recognized 2026 holidays are excluded, early closes adjust the after-hours start, and unsupported years fail closed. Calendar reference: [Nasdaq holiday schedule](https://www.nasdaq.com/market-activity/stock-market-holiday-schedule).

New entry quotes and fills stop **30 minutes** before an exclusion. An open position requests a full cash exit **10 minutes** before it. The schedule cannot guarantee a fill during an outage; late exits are counted separately in the model. On September 11 this means stop entries at **10:30 Vilnius**, request cash at **10:50**, with an **11:00** cash deadline. The next allowed period begins Friday **23:00 Vilnius**.

## Frozen prospective validation

The [plan](frozen-plan.json) fixes all three caps, cash, allocation, width, cooldown, schedule, cost profiles and dependency hashes before the new sample. It uses a read-only capsule and sealed runtime dependencies, so workspace edits cannot silently alter Monday's comparison. Plan SHA-256: `93251f7196733c61487c720670c0413a782b2a2d240a20580ab1b6d6602efe0c`.

`conc-liq-cap-validation.timer` is installed, enabled and active for **Monday, September 14, 08:35 UTC / 11:35 Vilnius**. The allowed sample runs from **Friday September 11 20:00 UTC** through the **Monday September 14 08:00 UTC** cash deadline, covering the full September 12–13 weekend. Capture includes ten minutes before entry eligibility and thirty minutes after the deadline to verify both boundaries and late fills. The runner refuses an early evaluation, altered plan/code, missing boundary coverage, or invalid capture hashes. A failed run reports unavailable evidence; it never substitutes favorable windows or changes the paper cap.

Output will be `/root/conc-liq/data/lp-cap-validation-2026-09-14/{replay.json,completed.json}` or `failure.json`. This is a scheduled capture and replay of newly accumulated data, not a revival of the old four-strategy experiment. Review net cash P&L, passive alpha, drawdown, realized modeled exposure, entry/exit costs, time outside the range and cash deadlines together. There is no automatic cap promotion.

```sh
systemctl status conc-liq-cap-validation.timer
journalctl -u conc-liq-cap-validation.service --no-pager
```

## Reproduction and verification

[Detailed results](results.json), [per-window CSV](windows.csv), and [audit](audit.json) retain all candidates, exclusions and action sequences. Local raw evidence is under `/root/conc-liq/data/lp-cap-study-2026-09-11/`; the 371 MB market capture stays outside Git, identified by its SHA-256 in the results. Recovery files include `incident55.json`, `recovery-plan.json`, `recovery-applied.json`, the previous service units and deployment manifest.

```sh
.tools/node/bin/node --import tsx scripts/replay-offhours-caps.mjs \
  data/lp-cap-study-2026-09-11/market.json \
  notes/lp-offhours-cap-2026-09-11/frozen-plan.json \
  /tmp/offhours-cap-verification.json
```

Typecheck passed. Focused tests cover key-order-safe preflight, actual recorded recovery, operator/state rejection, quote-to-later-fill causality, common initial benchmark, cost conservation through reentry, distinct cap decisions, unavailable holding gaps, entry cutoff, scheduled exits and late-exit accounting. The isolated PostgreSQL lifecycle integration passed through a complete held-position exit. Per-window net P&L, alpha, gas totals and aggregate arithmetic were independently checked. Systemd unit validation, capsule module loading and refusal to run before the sample ends passed.
