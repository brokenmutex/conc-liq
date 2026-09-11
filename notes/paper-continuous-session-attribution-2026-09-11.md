# Continuous paper strategy and market-session attribution

The approved 5,000 USDG strategy now has an explicit `continuous_v1` schedule. It keeps the ±20 raw-tick range, full token allocation, outside-range recentering and only the net swap needed for each move. There is no inventory cap, routine holding timeout or market-hours cash exit. Existing reference, execution and infrastructure guards remain, including the 30-block holding tolerance. Risk exits and the existing funded reentry mechanism still apply.

Policy: `config/paper-nvda-5000-recenter-continuous.json`. The 2% pool-liquidity share ceiling is unchanged. All execution remains paper simulation.

## Dashboard

The new **Position evolution & market sessions** section provides whole-campaign and New York day filters, market/premarket/non-market totals, and a detailed after-hours/overnight/weekend/holiday breakdown. Chart modes show NAV versus the original passive holdings, pool tick and LP bounds, and NVDA exposure. Recenter marks and session boundaries are visible; hovering exposes balances, price, fees and charged gas. The boundary table retains the adjacent marks and ranges rather than attributing an entire position's result to its exit session.

Every accepted observation already persists the position, cumulative fees, cost ledger and source time. The report reads those observations over the validated funding chain in one repeatable-read snapshot. It uses all observations for totals, even when chart points are sampled. Failed preflights and unused exit previews do not become charged trades.

## Accounting and limits

- Session net P&L is the change in marked NAV **before the unspent exit reserve**, after charged gas and embedded swap costs. A separate bridge reconciles exactly to NAV after the reserve.
- Mark-to-mark inventory changes and incremental earned fees belong to a session only when the whole interval stays in that session. Changes spanning a session or date boundary remain in `mixed_boundary`; they are not interpolated or prorated. Known gas and swap costs are assigned to their accepted source time. Cross-date mixed changes are retained at campaign level rather than fabricated into a daily result.
- Swap cost is signed input-minus-output value at source spot, including fee and impact. It is already embedded in P&L and must not be deducted a second time. Earned token fees are valued at the interval endpoint and are a diagnostic component, not an additional P&L credit.
- The original post-acquisition passive token benchmark persists through recentering, cash exits and funded reentry. Paid counters can restart in a child session without charging prior costs twice.
- Boundary rows bracket values with real adjacent marks. They are not exact boundary valuations. Exposure, capital-hours and time in range use the preceding observation; paths between marks are not reconstructed. Sampled chart backgrounds also follow observations.
- Earnings remain hypothetical fee-growth estimates; action gas remains node estimates. Continuous-strategy attribution does not simulate what would have happened with restricted trading hours.
- The calendar currently classifies 2026, including New York DST and scheduled holidays/early closes. Unsupported years are reported as unknown. The continuous schedule itself is not an hours gate.
- API histories are bounded at 100,000 marks; a larger history produces an unavailable report rather than partial totals. The API samples the chart and retains the most recent 60 boundary records; the UI displays 30 boundary rows. Full export retains all marks/boundaries within the same history bound.

Full audit export from an installed release:

```sh
<release>/bin/node <release>/launch.mjs /root/conc-liq/data/runtime-refactor.env paper-performance --output /absolute/output-directory
```

This writes timestamped JSON and a SHA-256 sidecar. Policies and runtime identities accompany the report; credentials are not exported.

## Validation

93 focused paper/dashboard tests passed, TypeScript typecheck passed, and both isolated PostgreSQL lifecycle/recenter evidence checks passed. Added coverage includes open-position gains before exit, exact boundary duration splitting, conservative mixed attribution, reserve changes, cumulative fee continuity, child-session cost resets, history rejection, and continuous operation retaining risk exits.

A read-only replay of historical campaign 5 through session 56 used **3,008 marks, 104 accepted swaps and 14 boundaries**. Group totals reconcile exactly with the existing campaign summary: P&L **−60.846571 USDG**, gas **37.538862 USDG**, passive-holding P&L **−16.402542 USDG**, and alpha **−44.444029 USDG**. This validates accounting on the former policy; these are not results for the new 5,000 USDG strategy.

Local evidence is in `data/paper-continuous-sessions-2026-09-11/`, including the historical reconciliation, test logs, full report exports and dashboard checks. Activation details follow after release verification.

Chromium browser verification passed against the workspace server and live read-only API. Historical data exercised all three chart modes, five grouped rows, eight detailed rows, fourteen boundary rows and the daily filter, with no JavaScript exceptions or invalid chart coordinates. The captured historical screenshot is QA evidence only; the live dashboard uses the current campaign.

## Activation

At **2026-09-11 12:37:33 UTC**, session **59** replaced uninvested session **58**. Immediately before the transition, 58 was waiting with no position or charged costs. It was stopped and retained; 59 starts with the same **5,000 USDG**, so no economic balance was discarded. Older campaigns are also preserved. This is a new policy root because a canceled waiting session has no completed cash-exit funding link.

- Source commit: `889d8cbe1b8953b656bddc90fc3087040673a1c3`.
- Sealed build: `afca2ce0f29ba35624c079a11c1fc0302dc8e61e70f7bd0ccf5ae27b6a4d000e`.
- Policy hash: `1798b15b75dd1a3bb4a479ed4e32ec3c69626257ab5ba21d90fa57e9cec314d7`.
- Runtime configuration hash unchanged: `5d3a46a4842931e979072b8042a45fb5d46bd53edf1539598b125043c4549944`.
- Paper timer and dashboard service active; `/api/dashboard` HTTP 200 with valid campaign and performance reporting (initial response 491 ms).
- The deployed page passed an actual Chromium render with no JavaScript exceptions or error banner and displayed the continuous policy plus its first recorded mark.
- At **12:38:03 UTC**, session 59 signaled entry with no gate reasons on the first fresh source, **12:37:44 UTC**. This is during premarket, confirming the former off-hours exclusion no longer blocks entry. A signal is not yet a fill.
- Only paper and dashboard units were switched. The frozen cap/recenter validation timers remain active and unchanged. No database migration or live execution was introduced.

Activation, API response, deployed-browser verification and screenshots are retained under the local evidence directory above.

## Dashboard refinement

Removed the earlier duplicate NAV chart. The position-evolution chart now has a date/time axis labeled New York (ET) in every chart mode. Session tables replace return bps/hour with **Estimated APY**, calculated as `100 * ((1 + hourlyNetReturn)^8760 - 1)` from the existing capital-time-weighted hourly return. This extrapolates the same hourly return across a full year with hourly reinvestment; it does not adjust for the annual frequency of a particular market session. Missing or mathematically undefined rates display a dash. The UI explains that short samples can give extreme estimates. Accounting and the paper strategy are unchanged.
