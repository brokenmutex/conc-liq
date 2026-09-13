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

AAPL and GOOGL already have canonical event coverage in the production research stream. GME/SPCX require their own complete event stream before forward fee accounting can be trusted. The first learning campaigns are therefore AAPL and GOOGL; this is an operational selection, not a profitability ranking.

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

## Initial forward launch and funding repair

AAPL session 62 started at 08:16:10 UTC and entered at source 08:16:56 UTC. GOOGL session 63 could not enter: its separate fee-3000 donor pool held about 4,818.79 USDG, below the 5,000 USDG fixture budget. This was a local simulation funding limitation, not an LP liquidity or profitability result. Session 63 was cancelled before entry with zero charged costs.

For explicit asset paper policies, local fixture funding now uses a dedicated Anvil account. Two `balanceOf` traces identify a unique account-specific storage word; setting it must produce exactly the requested getter balance. Ambiguous layouts or unsupported scaling fail closed. The funding proofs are retained in the execution artifact. No real transfer or token supply is claimed by this fixture. Legacy NVDA and live operator funding paths retain their existing behavior.

The complete broad scan covers 2,316,861 swaps in 300 pages over seven days. Nine independently captured HyperSync pages matched 43,528 private-RPC logs exactly, including identities, data, block hashes and timestamps.

Conditional AAPL/GOOGL replays reconstructed 135,888 and 337,296 canonical events respectively, and matched the final pool price, active liquidity and both global fee-growth accumulators. Both 30-second and 60-second decision scenarios, and the double-gas/half-fee stress scenario, encountered a disappeared initialized fee boundary. Their full-week NAV/P&L/alpha are unavailable. This prevents a defensible profitability ranking; it is not evidence of zero profits. Forward campaigns are learning deployments with currently verified boundaries, retaining the same accounting invalidation rules.

## Deployed campaigns and final checks

Confirmed at approximately 08:34 UTC on 13 September:

| Asset | Campaign/session | Initial USDG | Status | Source commit |
| --- | --- | ---: | --- | --- |
| AAPL | 62 | 5,000 | Open; valid accounting | `183b39b` |
| GOOGL | 64 | 5,000 | Open; valid accounting | `6305b88` |

GOOGL session 64 replaces the never-entered session 63 and entered at source 08:26:40 UTC. AAPL remains on its original sealed release, with sufficient original local fixture funding. Both detail APIs return HTTP 200, correctly ordered price ranges, and growing position timelines. Full database reconciliation passed for 33 AAPL observations and 16 GOOGL observations at the final check; those counts include entry signals and waits. `forward-validation.json` and `dashboard-paper-{62,64}.json` preserve the evidence.

The campaigns have independent logical streams `robinhood-v3-rwa-usdg-v1:paper:AAPL` and `robinhood-v3-rwa-usdg-v1:paper:GOOGL`, backed by the existing canonical `robinhood-v3-rwa-usdg-v1` event stream. The new asset checkpoint collector runs every 30 seconds. Each paper worker timer runs every 15 seconds to drain checkpoints after temporary coverage waits. All three timers are enabled. The retired NVDA paper timer is disabled.

Sealed releases under `/root/conc-liq-releases/`:

- AAPL, dashboard and asset checkpoint collector: `fa51a9eae0e961f85f3489167b8b0d52b37b401279edd1cd269e2727c4b19f1c`.
- GOOGL with getter-verified local fixture funding: `cd8165c9cc01f4aa97edea0a4b5e82f40c57c62c7fea758cfe202a70dd02a63e`.
- Live NVDA remains active on `ff6b9c3ec1aaa8f83e4d70e07d5d5bda118fab50094a96038f926d0d3de4f614`; its service and configuration were not changed.

The final clean runtime checkout passed all 402 tracked tests. TypeScript checking, the two conditional-replay tests, isolated PostgreSQL lifecycle/reference tests, and GOOGL's funded entry/restored-exit/recenter fork checks passed. Installed paper unit copies and release manifests are retained in the artifact directory. Research-only changes do not replace the sealed running releases.

## Reproducing the screen

The checked-in [scorecard](paper-asset-expansion-2026-09-13/scorecard.json) contains all 16 eligible-grid pool rows, current reference/execution gates, descriptive history statistics, limitations and source hashes. Original catalogue, registry, compressed log pages and fork proofs remain in the artifact directory rather than Git. Reuse a copied artifact directory when regenerating results, so the launch evidence remains frozen.

The research entry points use the repository Node runtime with `--import tsx`:

```text
scripts/lp-asset-universe.mjs ARTIFACT_DIRECTORY READ_ONLY_ENV
scripts/lp-asset-history-screen.mjs ARTIFACT_DIRECTORY READ_ONLY_ENV
scripts/lp-asset-fork-check.mjs READ_ONLY_ENV ARTIFACT_DIRECTORY AAPL,GOOGL
scripts/lp-asset-replay.mjs READ_ONLY_ENV ARTIFACT_DIRECTORY capture
scripts/lp-asset-replay.mjs READ_ONLY_ENV ARTIFACT_DIRECTORY replay
```

The universe runner consumes verified `tokens.json` and the anchored `catalog.json`. The history runner defaults to HyperSync; `ASSET_SCREEN_SOURCE=private_rpc` selects the health-gated private RPC capture used here. The detailed replay uses those private history pages to independently verify database swap hashes and timestamps. Its capture mode requires the canonical database and archive reads; replay mode uses frozen local sources. Fork checks only transact on the owned local Anvil instance. Environment inputs provide RPC/database settings and are not included in the report.

Next analysis should reconcile prospective net LP alpha, recenter costs and time in range separately across market, premarket and non-market hours after those regimes have actually been observed. Expand indexed coverage for GME/SPCX before adding them, and investigate virtual fee-boundary accounting before claiming a complete historical return ranking.
