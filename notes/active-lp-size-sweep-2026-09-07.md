# LP portfolio-size sweep — September 7, 2026

The seven-size **capacity and geometry** sweep is complete. It does not select a profitable portfolio size: the guarded economic replay remains blocked by incomplete historical reference/risk coverage and unmeasured size-specific rebalance/exit costs. The ±5% independent-reference tolerance is retained; passing it was not demonstrated by this run.

## Frozen scope and evidence

- Total portfolios: 250, 500, 1,000, 2,000, 3,000, 4,000 and 5,000 USDG; nominal LP placement 80%, reserve 20%, before costs and sizing residuals.
- Development window: **August 10, 00:28:17–August 12, 00:24:22 UTC**, blocks 32367320–34092320, inclusive. The first August 10 checkpoint was selected using liquidity/data availability before candidate outcomes. Validation and holdout strategy results were not inspected.
- HyperSync independently matched all **13,985 raw logs**: 13,696 in fee 500 and 289 in fee 3000. Verified 11,661 headers, including exact endpoints. Initial pool state is replayed from initialization, including Mint/Burn events.
- 2,877 observations per pool, spaced 60 seconds apart. The final endpoint is five seconds after the last decision observation; diagnostics end at that last observation.
- Four half-widths (0.5%, 1%, 2%, 4%), four geometric policies (fixed, edge, immediate 70%, persistent 70%), two pools and seven sizes: **224 combinations; 196 valid and 28 excluded**. All exclusions are the fee-3000 ±0.5% initial ranges, which cannot fit the inward-rounded tick grid.
- Persistent 70% requires two observations, a ten-minute cooldown and a 60-second delayed range change. Changes are geometric placements, not executable portfolio rebalances.

## Capacity result at ±2% LP half-width

The table compares the same persistent-70% geometry at every size. The LP half-width here is distinct from the ±5% true-price tolerance. Peak means the largest combined-liquidity share found at placements, active minute observations or overlapping observed swap segments.

| Total portfolio (USDG) | Nominal LP (USDG) | Fee 0.05% entry share | Fee 0.05% peak share | Fee 0.30% peak share |
|---:|---:|---:|---:|---:|
| 250 | 200 | 0.1186% | 0.1906% | 4.2047% |
| 500 | 400 | 0.2369% | 0.3805% | 8.0702% |
| 1,000 | 800 | 0.4728% | 0.7581% | 14.9351% |
| 2,000 | 1,600 | 0.9411% | 1.5049% | 25.9888% |
| 3,000 | 2,400 | 1.4051% | 2.2406% | 34.5002% |
| 4,000 | 3,200 | 1.8647% | 2.9653% | 41.2558% |
| 5,000 | 4,000 | 2.3201% | 3.6794% | 46.7481% |

Combined share is `our liquidity / (historical active liquidity + our liquidity)`. Each placement is independently sized with bigint math at its frozen tick range and execution-observation price. Shares are not obtained by linearly scaling the 1,000 USDG output. Segment distributions are unweighted counts, not time-weighted or fee-weighted averages.

At this width, portfolios up to 1,000 USDG remain below 1% combined share in the fee-500 diagnostic; 2,000 USDG reaches 1.5049%. These are descriptive thresholds, not deployment approval limits. The fee-3000 pool has materially less capacity: even 250 USDG reaches 4.2047% and 5,000 USDG reaches 46.7481%. The unchanged historical price path becomes especially questionable at large shares.

Width matters: for a 1,000 USDG portfolio in fee 500, the persistent policy's maximum overlapping swap-segment share is 3.1929% at ±0.5%, 1.5401% at ±1%, 0.7581% at ±2%, and 0.3776% at ±4%. Capacity cannot be summarized by portfolio size alone.

At ±2%, persistent geometry makes four range changes in fee 500 and two in fee 3000; neither is out of range at a minute observation. Fixed geometry is out of range at 66.7014% and 67.7789% of observations respectively. At ±4%, fixed geometry stays in range at every minute observation in both pools. These are occupancy/churn results only: no fees, inventory intervention, transaction costs or profitable ranking follows from them.

## Economic evidence and limitations

The configured archive successfully returned an NVDA oracle round at the starting block. Its age was **1,666 seconds**, exceeding the configured 300-second freshness bound. A current stored feed mapping was used to locate this probe; this is not historical registry attestation or continuous reference coverage. Stored risk snapshots begin September 3. Historical fallback references, issuer/corporate-action state and sequencer continuity were not reconstructed for the entire window.

The only stored NVDA cost model is fee 500, status `entry_measured`, with rebalance and exit costs null and reason `rebalance_execution_path_unset`. Its entry cost belongs to its own measured context; it is not a matched historical cost for these seven sizes. No costs were invented or scaled across budgets.

Capacity probes reset the declared nominal LP budget at each geometric placement; they do not maintain a self-financing inventory ledger. The sizing helper values floor-rounded withdrawable principal at pool spot, so its amounts are **not feasible mint quotes** and its spot valuation is **not a substitute for true price**. Adding liquidity would change swap paths and fee allocation; swap impact and counterfactual fees remain unmodeled.

Every economic result remains unavailable: net alpha in USDG/percent, drawdown, inventory exposure and mandatory 60% interventions, turnover, transaction costs/impact, and matched passive benchmark returns. Fixed candidates are geometry controls only. Every result has `executionEligible=false`, `rank=null`, and null fee/cost/net-alpha fields. No funded deployment, service configuration, database schema or signing path changed.

## Artifacts and reproduction

- [Frozen window and size selection](active-lp-research-2026-09-07/size-sweep-selection.json)
- [Run manifest](active-lp-research-2026-09-07/size-sweep-v1.json.manifest.json)
- Full output recovery and the byte-identical replay receipt are recorded in
  `research/manifests/active-lp-size-sweep-2026-09-07/pruned-artifacts.json`.
- [Current economic gaps and historical reference probe](active-lp-research-2026-09-07/size-sweep-economic-gaps.json)

The source snapshot is unchanged from the [first historical milestone](active-lp-historical-milestone-2026-09-07.md). The timestamp file is `data/lp-research-2026-09-07/size-sweep-timestamps.json`; its SHA-256 is `88595db4707df74a6b8a278bf2a19565f4bd28c89cd0883fdd7921fc3d95947a`. The run manifest also fingerprints the original source and frozen selection.

Use a new output path; the CLI creates outputs exclusively:

```bash
.tools/node/bin/node --import tsx scripts/lp-research.mjs sizes \
  --input data/lp-research-2026-09-07/source.jsonl.gz \
  --timestamps data/lp-research-2026-09-07/size-sweep-timestamps.json \
  --selection notes/active-lp-research-2026-09-07/size-sweep-selection.json \
  --output data/lp-research-2026-09-07/size-sweep-repeat.json
```

Validation: TypeScript and all **222 tests** pass, including independent size math, combined denominators, transient empty-liquidity segments, and delayed placement sizing. Artifact checks verify every budget split, combination/exclusion count, placement count and unavailable economic field.
