# Dashboard audit — 2026-09-06

The dashboard had fallen behind the one-position NVDA/USDG milestone. Its
underlying research results were useful historical records, but the default
presentation mixed current collection, old simulations, and global collector
gates. The revised default view answers what we need for the next canary:
whether the relevant inputs are current, what remains unresolved, what the
local rehearsal proved, and whether any mainnet position is actually tracked.

## Findings and corrections

| Finding | Evidence and correction |
| --- | --- |
| Research dominated the landing page | September 4 static/recentering scenarios used illustrative costs. They now sit inside collapsed research, with explicit UTC computation dates and historical assumptions. No strategy is selected by those rankings. |
| Global “Execution gate” did not represent this canary | It combined all assets and missing sequencer-feed findings. The default view now reads the NVDA-scoped gate and the existing five-minute chain-recovery/session evaluator. The raw global collector remains available as diagnostics. There is no dashboard execution authorization. |
| `open_24_7` could be mistaken for the entry session | This is Robinhood venue-policy evidence. The canary's New York regular equity session and opening/closing buffers are now shown separately. |
| A successful fetch said “Live data” | It now says “Dashboard connected”; source ages are independent. Matching stopped index/replay cursors show stale after 180 seconds. Fresh cursor agreement is explicitly not a chain-head-lag measurement. Fetches time out after eight seconds, and failures mark the last response as no longer current. |
| Unknown flags appeared healthy | Null oracle pause and corporate-action flags rendered “No” and “None”. They now remain “Unknown”; missing tradability/multiplier flags also remain unknown. |
| Paused research snapshots looked like an unexplained gap | All-pool accounting last captured run 40 at 10:00 UTC in the before snapshot. Its configured pause is now explicit, with the saved capture date and aggregate/core-position ownership limits. |
| Current milestone evidence was absent | The completed local mint/observe/decrease/collect artifact is shown as dated local evidence. It adds no mainnet NFT, balance, fee or P&L. Missing, wrong-stream, nonlocal, or incomplete-exit artifacts show unavailable. |
| Price/reference freshness was buried | The landing page shows NVDA pool spot, the saved oracle mark, deviation, block time, capture freshness and mark exclusions. Collector freshness is distinguished from NVDA feed age. Hyperliquid remains research-only; a Nasdaq/last-close policy is not implemented in current preflight. |
| Core keys could be mistaken for LP counts | Pool tables now say core positions/core-key owners. Tracked NFT status is explicitly at capture and includes the capture date. An empty table means no stored mainnet NFT checkpoint, not proof about all external wallets. |

## Verified state

The [before API extract](dashboard-evidence-2026-09-06/before.json) was captured
at 15:21:37 UTC. The dashboard backend had been running since September 4. It
was restarted after the backend changes passed checks, including the final
stream-scoped plan query; the tail worker was not restarted.

The [after API evidence](dashboard-evidence-2026-09-06/after.json) records
15:34:45 UTC, with [desktop](dashboard-evidence-2026-09-06/desktop.png) and
[mobile](dashboard-evidence-2026-09-06/mobile.png) renders from that audit:

- HyperSync is the configured historical source; full-universe accounting is
  intentionally disabled. The dashboard reads PostgreSQL and the local milestone
  artifact only, adding no node/archive traffic.
- Index/replay agree at block 56,088,401, with recent cursor updates.
- Chain recovery was observed over 31 samples; regular equity entry was closed.
- NVDA checkpoint 302, block 56,087,604, was excluded for a stale RWA oracle.
  Latest risk snapshot 4297 was newer than its linked risk snapshot 4295.
- The saved pool spot was 231.300073 USDG/NVDA; the excluded oracle mark was
  230.250674 USDG/NVDA, a 0.4557% deviation. These are dated diagnostics, not
  an executable spread or entry approval.
- Local lifecycle evidence completed at 14:50:33 UTC. No wallet preflight was
  saved and no mainnet NFT checkpoint was stored. Live execution was disabled.

These are point-in-time observations. The page recomputes input findings from
the database every ten seconds; it does not turn historical evidence into a
current preflight. The local lifecycle card intentionally reads the checked-in
accepted milestone artifact, not the scratch `data/canary-rehearsal.json` file.
When that milestone is superseded, update the referenced evidence explicitly.

## Validation and next steps

`npm run check` passed typechecking and all 173 tests. Dashboard tests cover
stopped matching cursors, future timestamps, unknown flags, the narrowly scoped
recovery display rule, false-valued configuration, and rehearsal scope/exit
validation. The [browser audit](dashboard-evidence-2026-09-06/browser-audit.mjs)
checked desktop/mobile layout, collapsed research, historical dates, missing
evidence, injected stale inputs, and API failures with no page errors. Browser
dependencies were cached outside the repo; shared libraries were extracted to
`/tmp/conc-liq-browser-libs`, with no system-package installation.

The browser script accepts `PLAYWRIGHT_MODULE` (module path or installed package)
and optional `DASHBOARD_AUDIT_URL`; it writes the dated screenshots and evidence
beside itself. It is a snapshot audit for this milestone, not a production
dependency or a fixture to rerun blindly after the project advances.

The remaining operational gap is freshness coordination: the strategy timer
runs every five minutes, the checkpoint ceiling is three minutes, and the risk
collector advances more often. A live canary needs a fresh synchronized
checkpoint and wallet-specific preflight immediately before its review. This
audit leaves the timer and trading policy unchanged. Capture deliberately for
that attempt before considering more automation.

Next, choose the real wallet and capital cap, refresh the scoped inputs during
the permitted entry session, and review the resulting preflight. Position
principal/fees, cash flows, gas including L1 data fees, and alpha versus passive
holding should become the primary performance view once a real position exists.
Another archive-data project is not a prerequisite.
