# RangeKeeper AAPL/USDG open session, 22 September 2026

The first 12-hour campaign closed at 2026-09-22 02:24:17 UTC after a
receipt-reconciled withdrawal and sale. It has no active NFT or pending
transaction. Its append-only campaign ID is
`470e5f84-ab82-4735-92f9-57e96c05b344`; NFT `1259529` is now retired.

The replacement campaign uses the same AAPL/USDG pool, operator, $250 LP cap,
$325 combined capital cap, and existing cost, loss, drawdown, price, custody,
and gas rules. The private configuration is
`/root/conc-liq/data/rangekeeper-v1-aapl-open-live.json`. Its explicit
`campaignScope.maxDurationSeconds: 0` has no calendar expiry; the controller
stores `Number.MAX_SAFE_INTEGER` as the expiry sentinel and the dashboard
renders no expiry. The new configuration lists all 44 retired NFTs. Each new
campaign receives a separate ledger row and dashboard position, preserving
the preceding campaign and its receipts. A fresh full-wallet fork and exact
post-closure custody check gate initialization. The worker continues until an
operator stop or an existing safety exit. The two-economic-action and four-
recenter limits are retained; they can leave a position held without further
recentering after the action budget is exhausted. No automatic refill occurs.

Before launch, verify the sealed build, pilot inactivity, private configuration,
full-wallet fork preflight, dashboard release parity, and the new campaign's
initial status. The installed systemd unit must name the same sealed build and
private configuration. `rangekeeper-live stop` requests a guarded exit, then
the unit exits once custody is reconciled. Use the commands and recovery
rules in [the RangeKeeper runbook](rangekeeper-v1.md).

## Activation record

The previous campaign closed at confirmed block 69,296,369 with 276272972
raw USDG, zero AAPL, 8246516797624364 wei native, nonce 339, 44 retired
NFTs, and zero guarded allowances. The new preflight passed a full-wallet fork
at confirmed block 69,442,126, hash
`0x19e14f91f889c253354ad973360b99503edda1de5c07c1009a216903325ba3d9`.
It projected 249.500001947510562344 USD-equivalent LP, 5763 ppm pool share,
1093401280000000 wei bounded native requirement, and zero native shortfall.
These are source-specific estimates, not realized economics.

The sealed worker build is
`2ba1dde7fd115690755148e4adb429c1bcacd6f5d4e2088853307a00ebe3c4a4`
from commit `be65cca`. It initialized new campaign
`31802d63-9ec8-423c-bc1b-f781f8b44f92` with 44 retired NFTs and an
open-ended expiry sentinel. The installed worker started at 2026-09-22
06:33:24 UTC, with zero restarts. The dashboard build is
`3106f1c5e5b248e2ee2dfc8037274ca6728df7d2447a07553a41f3350fc1ba23`.
The live API shows the new campaign alongside the closed campaign; the new
campaign has no expiry, and its current detail contains valuation/chart data.
Chromium desktop and mobile captures are in
`data/rangekeeper-open-units-2026-09-22/` and
`data/rangekeeper-open-dashboard-final-2026-09-22/`.

The new entry confirmed router and manager approvals at nonces 339–341,
the entry swap at nonce 342, mint at nonce 343, and three allowance
revocations at nonces 344–346. The first approval's candidate went stale
before a swap, so the controller obtained fresh confirmations. At confirmed
block 69,452,654 (`0x64a2fae4cbed859f728a33cb5ac185b40203efac33b2a2336dce8d267c070e19`),
the campaign was `holding/running` and `inside_range` with NFT `1269524`,
40-tick range `[218030,218070)`, 45 owned NFTs, 17166847 raw USDG,
26469193340952316 raw AAPL, 8194691294266364 wei native, nonce 347,
zero monitored allowances, and no pending action. Eight receipt-valued cost
events were recorded, including 51825503358000 wei gas; the dashboard
displayed about $0.29 in total execution costs at this source. This is
neither final campaign P&L nor passive alpha.

The live dashboard displayed the open NFT, current independent-reference
valuation, 12 chart points, and the closed prior campaign in history. Its
desktop and mobile captures show the live summary, charts and position
facts without overlapping summary columns. The dashboard `/healthz` returned
200. Both services were active with zero restarts after allowance cleanup.
