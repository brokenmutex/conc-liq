# Dashboard redesign preview — 12 September 2026

The first review deliverable is a clickable, sample-data mockup at `/preview`, alongside the current dashboard. It uses no API data, wallet access or trading controls. The banner remains explicit that every position and number is illustrative.

## Layout

Live positions appear first and paper positions second. Both sections use the same components: portfolio summary, visible position rows, selected-position metrics, chart, inventory/range facts, market-session table and activity. Each contains multiple assets. Examples include an open LP, management paused while inventory remains deployed, capital awaiting re-entry, closed history and an invalidated paper campaign.

The useful existing paper metrics are retained for both modes: net value, P&L, performance versus holding, fees, execution costs, drawdown, inventory, LP range, session attribution and APY. Explanatory detail lives in dialogs rather than paragraphs on the main page. Old research/canary panels are omitted from this preview.

Controls include asset and status filters; current/history selection; individual position selection; value/range/inventory charts; 1h/6h/24h windows; market-session/activity tabs; strategy, event, accounting and diagnostic details. Each chart has a changing series legend and a persistent market-session/event legend. Charts support pointer and keyboard inspection and scale to mobile widths.

## Scope and evidence

Fixtures in `dashboard/preview/app.js` deliberately demonstrate layout and interactions. Their trajectories, cost allocation and APY are illustrative. No real receipt hashes are fabricated. Live and paper use identical information architecture, with actual versus simulated accounting labels.

The next implementation step after design review is to connect the shared view to normalized position records, database-backed live history and reconciled accounting. Actual capital and paper campaign resets must remain separate; unavailable values remain unavailable.

Verification:

- 18 Chromium interaction/layout checks, on desktop and 390px mobile, with no browser exceptions or CSP errors and zero production API requests from the preview.
- The 10 existing dashboard/release unit tests pass; TypeScript checking passes.
- Browser check: `scripts/check-dashboard-preview.mjs` (requires a disposable local Chromium debugging endpoint).
- Screenshots and check results: `data/dashboard-preview-desktop.png`, `data/dashboard-preview-mobile.png`, `data/dashboard-preview-checks.json`.
- A self-contained downloadable copy is generated at `data/dashboard-preview.html`.

The only server change adds four fixed static routes for the preview and its assets. Trading workers and the original dashboard view are outside this change.

## Available for review

The preview is served at `/preview` by dashboard release `62d7e1234396c9bbada7e983d1e4b97b83d25997ee09e8bed544182841991513`, source `0a0c708d75cd2ece7a08a1c625e3b8f0016c5239`. The 18 browser checks also passed against that deployed route, including its real CSP. The original dashboard, both APIs and preview assets return HTTP 200. Before/after dashboard units and the release manifest are retained in `data/dashboard-preview-deployment-2026-09-12/`.
