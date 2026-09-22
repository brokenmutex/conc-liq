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
