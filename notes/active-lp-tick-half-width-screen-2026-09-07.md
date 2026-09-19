# Corrected tick half-width screen

The user clarified **10–50 raw ticks on each side of the price**. The current candidates are **±10, ±20, ±30, ±40 and ±50 ticks**, giving total lower-to-upper widths of **20, 40, 60, 80 and 100 ticks**. This supersedes the first run's total-width interpretation.

For fee 500, the center is placed at the nearest feasible tick-grid midpoint to the signal price; both boundaries are exactly the requested half-width from that center. The center can differ slightly from the exact pool price because boundaries must lie on the spacing-10 grid. For example, around grid-center tick 222170, ±10 uses [222160,222180), while ±50 uses [222120,222220).

The corrected grid is approximately ±0.10%, ±0.20%, ±0.30%, ±0.40% and ±0.50% around the grid center. Exact upward/downward percentages differ slightly because ticks are logarithmic. The independent-reference tolerance remains ±5%.

All seven portfolio sizes were rerun at 80% nominal deployment and 20% reserve in the same verified August 10–12 development window. Five widths, seven sizes and four geometric controls produce **140 combinations**, without exclusions. Fee 500 is the focused pool; fee 3000 cannot express the complete grid. This window is not a weekend test.

## Persistent-70% result at 1,000 USDG

The rule remains two consecutive one-minute observations, a ten-minute cooldown and a 60-second delayed range change. Expired changes are discarded geometric placements, not charged reverted transactions.

| Raw ticks on each side | Total ticks | Range changes | Expired changes | Observations outside range | Peak overlapping swap-segment liquidity share |
|---:|---:|---:|---:|---:|---:|
| ±10 | 20 | 139 | 14 | 19.2909% | 12.8952% |
| ±20 | 40 | 80 | 1 | 7.8554% | 6.8935% |
| ±30 | 60 | 56 | 0 | 3.1630% | 4.7104% |
| ±40 | 80 | 44 | 0 | 1.4598% | 3.5775% |
| ±50 | 100 | 28 | 0 | 0.5561% | 2.8832% |

These are range/churn and capacity results, not a self-financing portfolio replay. Deployments reset nominal capital; inventory swaps, fees, costs and the ±5% reference guard are not simulated by this screen. No net-optimal half-width has been selected. The subsequent [September 8 portfolio sensitivity](active-lp-portfolio-replay-2026-09-08.md) adds funded inventory, fees, modeled costs and the independent-price guard; its results must be read separately from these geometric counts.

## Artifacts and reproduction

- [Corrected frozen selection](active-lp-research-2026-09-07/tick-half-width-selection.json)
- [Run manifest](active-lp-research-2026-09-07/tick-half-width-screen-v1.json.manifest.json)
- [All 140 corrected results](active-lp-research-2026-09-07/tick-half-width-screen-v1.json)
- [Superseded initial interpretation](active-lp-tick-width-screen-2026-09-07.md)

Use a new output path:

```bash
.tools/node/bin/node --import tsx scripts/lp-research.mjs ticks \
  --input data/lp-research-2026-09-07/source.jsonl.gz \
  --timestamps data/lp-research-2026-09-07/size-sweep-timestamps.json \
  --selection notes/active-lp-research-2026-09-07/tick-half-width-selection.json \
  --output data/lp-research-2026-09-07/tick-half-width-repeat.json
```

Validation: CLI syntax and the focused research test command pass. Artifact checks verify every half-width/total-width pair, all placement bounds and grid centers, source selection fingerprint, and null economic rankings. The overlapping total-width 20/40 candidates exactly match the prior run after removing the new half-width metadata field. No live settings changed.
