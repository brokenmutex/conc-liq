# Paper asset expansion — 13 September 2026

The discovery universe is all 194 currently verified Robinhood stock/ETF tokens, not the original six research assets. The refreshed catalogue contains 424 V3, 11,366 V4 and 20 V2 pools. Initial paper deployment uses V3/USDG because the existing executor and fee reconstruction support that venue. V4/V2 remain in the discovery inventory; they are not simulated by pretending they are V3.

Each new campaign starts with **5,000 USDG**, ±20 raw ticks (40 total), full inventory allocation, no inventory cap, outside-range recentering, only the net swap needed to fund a recenter, and continuous 24/7 operation. The ±5% independent reference band, 30-block holding tolerance, and prospective transaction simulation remain in force. The liquidity-share setting is a warning with diluted fee accounting, not a 2% entry cap.

## Frozen discovery evidence

`data/asset-expansion-2026-09-13/` holds the original source evidence and hashes. Anchor: block 61,776,927, hash `0x5169292f4036448cab5779b70ef16e10cbd43dfac8bb4e29b66b1316f2a0da29`, 2026-09-13 07:24:14 UTC.

- `asset-sync.json`, `tokens.json`: fresh issuer registry and on-chain identity checks; 194 active verified assets, no pending multipliers.
- `catalog.json`, `catalog.sqlite3`: copied catalogue independently refreshed through the anchor. The sibling research database was not changed.
- `universe.json`: 306 V3/USDG pools, independently factory/token/fee/spacing checked. Sixteen have active liquidity and support the requested width. Exclusions can overlap; zero current liquidity is not a claim of historical inactivity.
- `candidate-risk.json`, `candidate-references.json`: current eligibility checked using the same continuous-reference policy as paper. Missing feeds and stale held references remain exclusions.
- `fork-*.json` plus SHA256 sidecars: each asset's own fork transactions, token deltas, Nitro estimates, restored position and recenter checks. All upstream RPC is read only; local transaction hashes are not chain broadcasts.

AAPL, GOOGL, GME and SPCX passed the initial full fork mechanics checks. SLV completed the transaction sequence but lacked both initialized fee boundaries. TSLA's acquisition moved the price outside the intended range. Current probes are not historical net LP returns.

AAPL and GOOGL already have canonical event coverage in the production research stream. GME/SPCX require their own complete event stream before forward fee accounting can be trusted. The intended first learning campaigns are therefore AAPL and GOOGL; this is an operational selection, not a profitability ranking.

## Runtime implementation

An optional immutable `market` in the policy binds symbol, token, pool, fee, tick spacing and decimals. Legacy policies retain NVDA defaults and their original hashes. `PAPER_SESSION_STREAM_KEY` separates campaigns while `INDEXER_STREAM_KEY` names their underlying canonical data stream. The sealed runtime configuration binds both values.

Canonical token0/token1 amounts remain canonical in LP principal and fee ledgers. Wallet balances and swap directions retain their named USDG/RWA meaning. Entry, restored exit, recenter, continuation funding, reference checks, passive holdings, session attribution and dashboard range orientation support both token orders. A different market cannot inherit the previous campaign's cash or risk approval.

Explicit asset campaigns use the latest completed risk evidence containing their asset. Successful snapshots covering other assets do not displace it. Failed and in-flight attempts remain conservative global barriers, including failed issuer lookup; a failed update is never skipped for an older successful one. NVDA legacy selection is unchanged.

## Retired NVDA paper

Session 61 closed through the original sealed worker. Re-entry was disabled at 2026-09-13 07:53:19 UTC; the old paper timer was stopped after closure. The full final journal, execution evidence and report are in `nvda-paper-final.json` and its SHA256 sidecar.

Campaign sessions 60–61: initial 5,000 USDG; final 4,955.902440; net P&L −44.097560; passive holding 4,965.414989; alpha −9.512549; estimated paid gas 1.563629; 894 accepted marks. These remain paper estimates. Earlier campaigns remain in the database. Live NVDA continues on its existing release and configuration.

## Verification and interpretation

The first implementation check passed 114 paper/dashboard tests, an isolated PostgreSQL lifecycle check and an isolated risk-selection check. Real fork mechanics were checked in both token orders. Restoration funding now explicitly inverts the position manager's intermediate rounding before restoring exact original liquidity.

Historical descriptive activity, conditional market-path scenarios and forward paper results are different evidence classes. Do not annualize a short sample into an expected return or call the selected assets optimal. Record net LP alpha, fee income, swap shortfall, gas, deployment fraction, recenter counts and drawdown across market, premarket and non-market hours.
