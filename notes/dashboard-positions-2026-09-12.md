# Connected position dashboard — 12 September 2026

The approved multi-position design is now the main dashboard at `/`. Live positions appear first, paper positions second, using the same metrics, charts, inventory/range facts, session attribution and activity layout. The current ledger adapters serve NVDA/USDG; the browser renders position records and asset filters without single-position selectors. Additional assets need their own validated accounting adapter.

Both sections offer 1h, 6h, 24h and **1 week (168h)** windows. Charts use actual timestamps, New York market-session shading, changing series legends, entry/recenter/cash-exit markers and keyboard/pointer inspection. The window remains a real elapsed-time window; it does not synthesize history before the campaign started. Gaps over 15 minutes break chart lines and their economic movement is separately attributed. Available coverage is displayed beneath each session table.

## Data and accounting

- `/api/positions` lists current and historical campaign records. `/api/positions/{live-UUID|paper-ID}?hours={1|6|24|168}` returns the selected campaign's recorded history. Queries are read-only repeatable-read transactions. IDs and windows are validated; raw signed transactions, signer configuration and private keys are never selected into the response.
- Live marks contain wallet inventory excluding reserved USDG, NFT principal, claimable fees, passive benchmark and cumulative receipt-valued gas. Historical collected-fee counters come from confirmed transitions at or before each mark. Swaps use accepted receipt token deltas valued at their pre-transaction spot. Net value already includes swap losses and gas; neither is deducted twice.
- Paper session ancestry is validated with the existing canonical-source, execution-evidence and cash-continuation checks. The full unsampled campaign report supplies continuous NAV, fees, costs and holding baseline across re-entry. A reset such as session 60 is a separate campaign. Invalid session 59 retains its actual reason and original timestamp. Unsupported/unproven histories show unavailable accounting.
- Both modes display economic net value after paid gas, before unspent estimated exit costs. The paper exit reserve remains visible separately; a live future exit estimate is unavailable. Swap shortfall includes pool fees and impact, rather than implying those components were independently measured.
- Session tables aggregate full observations before chart downsampling. Mixed market-boundary movements and unobserved intervals remain separate; charges are assigned to the recorded endpoint. A partially observed interval at the left edge is excluded, with its actual coverage start shown. Cash before acquisition uses the initial capital as the passive baseline, then the original acquired token benchmark persists.
- APY extrapolates observed return per capital-hour over 8,760 hours; it is not a forecast. Missing samples show no APY. Extreme extrapolations are labelled.
- Source/heartbeat times are separate from API freshness. Current state, pause/exit/recenter state, cash entry waits and historical invalidation are distinct. Strategy configuration, evidence and infrastructure detail are in dialogs. The previous full diagnostics view remains at `/legacy`; `/preview` remains explicitly fictional.

## Validation and operation

- 22 focused dashboard, performance-attribution and release tests pass. They cover raw-amount reconciliation, boundary costs, unknown accounting, partial windows, gaps, downsampling, 168h requests and HTTP validation.
- `scripts/check-dashboard-position-accounting.mjs` reconciles live and paper net NAV, gas, swap shortfall, earned fees and passive alpha in one database snapshot, and checks all four windows. Output: `data/dashboard-position-accounting-checks.json`.
- `scripts/check-dashboard-positions.mjs` performs 18 Chromium desktop/mobile interaction checks with actual API data, including the 1-week window, legends, interrupted history and receipt details. Output: `data/dashboard-connected-checks.json` and screenshots.
- All historical campaign groups were queried. Sessions 1 and 2 retain unavailable accounting; later supported history loads, including the continuous campaign ending at session 57.
- Only the dashboard service is restarted for this release. Live and paper workers, wallet, capital and strategy parameters are unchanged.

The detail reader currently bounds a campaign at 100,000 observations. Exceeding that bound returns unavailable history rather than silently dropping earlier accounting. Chart downsampling does not alter session totals.
