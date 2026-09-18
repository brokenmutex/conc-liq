# W0: calibrating modeled fee capture and fill cost to the live pilot

Date documented: 2026-09-18
Strategy version: `adaptive_paper_60m_v1` (`config/adaptive-paper-60m.json`)
Deployed release: `ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf`
Documented source commit: `d8b304a` plus the working tree described below
Evidence directory: `notes/fee-calibration-2026-09-18/`
Scripts: `scripts/live-fee-calibration.mjs`, `scripts/sim-source.mjs`
Predecessor: [strategy-redesign-handoff-2026-09-18.md](strategy-redesign-handoff-2026-09-18.md)

## Summary

1. **The modeled fee share is 1.00, not something lower.** Over all 43 holding
   segments of the 250-USDG live campaign `f8affe19`, the paper model's
   `diluted_segments_v1` accounting reproduces the fees the pool actually paid
   to within **7 parts in 10,000**, and the entire residual is the model's own
   dilution term. Against the share the pool itself applied the agreement is
   3 parts in 100,000. The frozen `feePpm` = 1,000,000 is correct at this
   size and needs no change.
2. **The fill haircut is 0 bps.** Realized swap output against the QuoterV2
   quote frozen at the source block: notional-weighted **0.035 bps**, median
   −0.001 bps, and 30 of 58 swaps beat their quote. Mints deployed the
   liquidity their plan implied, worst case 17.9 bps short, none above 50.
3. **So the handoff's first premise does not survive contact with the data.**
   The 7.38 USDG of realized fees against 12.78 USDG of cost is not a
   modelling error. The model would have predicted those fees. The gap is
   capital size, action count and time out of range — the terms W1 through W4
   address — not fee-share optimism.
4. Rerunning the exit-rule harness at the calibrated share reproduces the
   published tables **exactly**, to the microUSDG, on every arm and both
   books. No conclusion in the three predecessor notes changes.
5. What the calibration is *not*: 63 hours, one pool, one size, and a maximum
   liquidity share of **0.103%**. It validates the accounting, not the
   fixed-recorded-flow assumption that the accounting rests on. At 5,000 USDG
   the universe study found 31% of NVDA fees earned above a 10% share, where
   that assumption is untested and untestable on recorded flow.
6. One measurement here is direct evidence for W4.1: the balanced per-leg mint
   amounts swing by orders of magnitude as the price crosses a band, while the
   liquidity those amounts support does not. Nonce 100 minted with
   `amount0Desired` = 105,916,684 and `amount0Min` = 3,559.

Everything here is a read-only reconstruction of a completed campaign. No
service, policy or transaction was changed, and nothing was broadcast.

## 1. Method

Every confirmed `mint` opens a holding segment that a confirmed `withdraw`
closes. The withdraw receipt carries both a `DecreaseLiquidity` and a
`Collect` for the same `tokenId`, and their difference is the fee the pool
actually paid that position — no valuation, no inference.

Against that, `scripts/live-fee-calibration.mjs` rebuilds the canonical pool
book at each segment's mint block from the complete `Mint`/`Burn`/
`SetFeeProtocol` history (the NVDA-500 pool is indexed from its creation block
15,511,376), replays every event to the withdraw block through
`ExperimentMarket`, and scores each fee segment with the same
`virtualFeeCredit` the paper accrual uses, at the position's real liquidity
and range. The reconstructed price is asserted equal to the withdraw
receipt's pool price at all 43 closes; the seeded liquidity is asserted equal
to the first mint receipt's pool liquidity.

Two shares are reported because they answer different questions:

- **diluted** — `ours / (segment.liquidity + ours)`, which is what the paper
  model books, because a hypothetical position is liquidity *added* to a book
  that does not contain it.
- **undiluted** — `ours / segment.liquidity`, which is the share the pool
  itself applied, because in the live campaign our liquidity was already
  inside `segment.liquidity`.

The difference between them is exactly the self-inclusion bias of comparing a
hypothetical-position model against a real position. Separating it is the
only way to tell a modelling error from an artefact of the comparison.

Window: campaign `f8affe19`, 2026-09-12 14:24 to 2026-09-15 05:50 UTC,
302 mined transactions, 43 segments, 163,096 replayed pool events,
118,046 fee-bearing segments scored in range, **0 partial segments**.

## 2. The fee share

Pooled over all 43 segments:

| | token0 (USDG, raw) | token1 (NVDA, raw) |
|---|---:|---:|
| Realized (`Collect` − `DecreaseLiquidity`) | 3,494,895 | 18,287,240,000,000,000 |
| Modeled, diluted (what the paper model books) | 3,492,403 | 18,273,943,000,000,000 |
| Modeled, undiluted (the pool's own share) | 3,495,003 | 18,287,491,000,000,000 |
| realized / modeled-diluted | **1.000714** | **1.000728** |
| realized / modeled-undiluted | 0.999969 | 0.999986 |

Per segment, the ratio is not merely close on average — it is close on every
segment:

| Ratio | min | p10 | median | p90 | max |
|---|---:|---:|---:|---:|---:|
| realized / diluted, token0 | 1.00000 | 1.00012 | 1.00072 | 1.00086 | 1.00090 |
| realized / diluted, token1 | 1.00015 | 1.00016 | 1.00072 | 1.00085 | 1.00115 |
| realized / undiluted, token0 | 0.99925 | 1.00000 | 1.00000 | 1.00000 | 1.00000 |
| realized / undiluted, token1 | 0.99955 | 1.00000 | 1.00000 | 1.00000 | 1.00025 |

The diluted ratio's median of 1.00072 is the median liquidity share, 0.085%,
turned into 1/(1−s). It is the bias, not an error. Against the undiluted
share the model is exact to integer rounding on 40 of 42 segments.

**Calibrated modeled fee share: `feePpm` = 1,000,000.** The deployed value
stands. The dilution the paper model applies on top is correct behaviour for
a position that would genuinely be added to the pool, and at 1,000 USDG in
NVDA-500 it is worth about 0.5% of fee income (§W3 table).

### What this does not establish

The accounting is validated; the assumption underneath it is not. The model
holds recorded flow fixed: it assumes the swaps that arrived would have
arrived unchanged with our liquidity in the book, and only divides the fees
differently. At 0.103% maximum share that assumption is close to free. It is
not testable at all on recorded flow, and the universe study's capacity table
shows it is the binding limitation at 5,000 USDG, where 31% of NVDA's modeled
fees were earned while our hypothetical position exceeded 10% of existing
liquidity. Nothing here licenses a larger size; §W3's 5% share cap does that
work separately.

Sample: 63 holding hours, one pool, one tier, one size, one price path with a
6% decline in it. Segment lengths run 263 to 257,004 blocks (median 18,348).

## 3. The fill model

### Swaps

All 58 confirmed swaps, realized wallet delta against the QuoterV2 quote
frozen in the plan at the source block. The fill landed a median of 156
blocks later (p90 184, max 220).

| | value |
|---|---:|
| Notional-weighted shortfall | **0.035 bps** |
| Mean | 0.209 bps |
| Median | −0.001 bps |
| p10 / p90 | −0.39 / 1.02 bps |
| min / max | −2.58 / 8.81 bps |
| Beat the quote | 30 of 58 |
| Matched exactly | 5 of 58 |

**Calibrated fill haircut: 0 bps.** The paper model quotes through the
canonical pool path with `historicalSwapQuote`, which already charges the
0.05% pool fee and the price impact; the live campaign's 3.22 USDG "swap
shortfall against pre-trade spot" (of which 3.14 is the pool fee) is that same
charge, not an unmodelled one. There is no residual slippage to add.

### Mints

Comparing the liquidity the live mint actually created against the liquidity
`replayPaperMint` says the same balances support at the quote-block price:

| | value |
|---|---:|
| Median shortfall | −1.80 bps (more liquidity than planned) |
| Mean | −45.91 bps |
| p90 / p99 | 9.94 / 15.42 bps |
| min / max | −1128.10 / **17.90** bps |
| Above 50 bps short | **0 of 43** |

The per-leg amounts behave completely differently, and this is the W4.1
finding. `amount0Desired` in the live plan is the wallet ceiling, and
`amount0Min` is 50 bps below the *re-planned balanced* amount at the fill
price. At nonce 100 the tick sat at 222,579 inside a `[222540, 222580)` band —
one tick from the top edge, so the balanced mint needed almost no token0:

```
nonce 100  range [222540, 222580)  tick 222579
  desired0 105,916,684   min0 3,559              minted0 3,577
  desired1 655,719,589,933,083,357  min1 652,440,991,983,417,891
                                    minted1 655,719,589,933,083,308
```

The live recenter executor survives this because `executionRecenterPlan`
re-plans the mint from the post-swap balances and regenerates its minima from
that re-plan (`src/paper/execution-recenter.ts:82`). The research entry path
did not: it compared the re-planned legs against the *frozen quote's* legs at
50 bps, which is why 30 of 31 gated re-entries died on `frozen_mint_minimum`.
A direct simulation of the same geometry gives the same answer — across
5/10/20/30-tick drifts inside a ±160 band, the worse leg moves 311 to 1,902
bps while the liquidity moves 2 to 15 bps, always upward. The fix is in
[execution-defects-2026-09-18.md](execution-defects-2026-09-18.md).

## 4. Restating the three harnesses

`SIM_FEE_PPM` was added to `adaptive-forecast-sweep.mjs`,
`adaptive-residence-cap-sim.mjs` and `adaptive-exit-rule-sim.mjs`, defaulting
to the deployed 1,000,000 and recorded in each output.

At the calibrated share the restated tables **are** the published tables. The
exit-rule harness over 2026-09-08 02:00Z → 2026-09-17 14:05Z reproduces every
published figure to the microUSDG:

| Book | Arm | Published alpha | Reproduced (raw) | Recenters | Exits |
|---|---|---:|---:|---:|---:|
| NVDA | `baseline` | −14.12 | −14,121,971 | 15 | 0 |
| NVDA | `exit_0m` | −0.41 | −412,977 | 0 | 1 |
| NVDA | `exit_15m` | −1.73 | −1,731,691 | 0 | 1 |
| NVDA | `exit_60m` | −2.67 | −2,672,799 | 0 | 1 |
| NVDA | `exit_0m_ungated` | −30.81 | −30,805,988 | 0 | 8 |
| AAPL | `baseline` | +51.53 | +51,530,824 | 17 | 0 |
| AAPL | `exit_0m` | +10.86 | +10,862,619 | 3 | 2 |
| AAPL | `exit_15m` | +22.82 | +22,815,352 | 9 | 2 |
| AAPL | `exit_60m` | +23.27 | +23,271,463 | 9 | 2 |
| AAPL | `exit_0m_ungated` | +34.86 | +34,857,526 | 7 | 8 |

**No conclusion changes.** Net fees remain the metric that reproduces across
windows; alpha remains the one that does not; the exit rule remains a one-way
door. Every later note in this series quotes `feePpm` = 1,000,000 and a fill
haircut of 0 bps, and none of them can claim the fee model as an excuse for a
weak result.

Note on the metric: the published "net fees" figures are `feesQuote −
gasPaidQuote`. Swap cost is *not* subtracted from them, despite the phrase
"fees − gas − swap shortfall" in the handoff. The later notes keep the
published definition so the numbers stay comparable, and report swap cost as
its own column where the harness computes it.

## 5. A defect found while reproducing

The first reproduction attempt failed on AAPL and GOOGL with `no covered
rows` after ten retries. Two separate faults:

- The harnesses' flake heuristic compared the covered row count against
  *every* row the pool has ever had, not against the rows inside `SIM_END`.
  Once 1.5 days of history accrued past the published window, a perfectly
  clean read scored 11,682/14,243 = 82% and was rejected as a flake. Fixed by
  bounding the window in SQL.
- The `covered` predicate really does read back 6.5 million blocks, for about
  one second in every ten. Root cause, measurement and fix are in
  [execution-defects-2026-09-18.md](execution-defects-2026-09-18.md) (W4.2).

Both are now handled in `scripts/sim-source.mjs`, shared by the three
harnesses.

## 6. Limitations

- One campaign, one pool, one fee tier, 63 holding hours, 250 USDG.
- Maximum liquidity share 0.103%. The fixed-recorded-flow assumption is
  untested above that and cannot be tested on recorded flow at all.
- Segment boundaries are block-aligned: a swap landing in the mint block after
  our `Mint`, or in the withdraw block before our `Burn`, is attributed to the
  neighbouring segment. Zero of 43 segments show a resulting discrepancy above
  1.2 parts in 10,000, so the effect is below the measurement.
- The campaign's own `collectedFee0` field reads 3,494,893 against the 3,494,895
  summed here, a 2-raw-unit (0.000002 USDG) difference in the final collect's
  attribution. Not pursued.
- The swap-fill comparison is against QuoterV2 at the source block, which is
  the same object the paper model quotes. It does not price a route the paper
  model would not have taken.
- Gas is not recalibrated here. The frozen fork-derived costs in
  `config/adaptive-paper-60m.json` (recenter 0.2205 USDG) sit above the
  campaign's measured post-allowance recenter gas (0.134), so the paper model
  is conservative on gas by about 60%. That is deliberate and unchanged.

## 7. Reproduction

```bash
R=/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf

# Fee share and fill model from the live ledger
$R/bin/node scripts/live-fee-calibration.mjs notes/fee-calibration-2026-09-18/live-segments.json

# Restated exit-rule table at the calibrated share (SIM_FEE_PPM defaults to it)
SIM_START=2026-09-08T02:00:00Z SIM_END=2026-09-17T14:05:00Z SIM_FEE_PPM=1000000 \
  $R/bin/node scripts/adaptive-exit-rule-sim.mjs notes/fee-calibration-2026-09-18/exit-restated.json
```

The calibration script opens the database read-only in a repeatable-read
transaction and writes only its output path. It reads
`data/live-cost-analysis-2026-09-17/ledger.json` and `routes.json`, both
extracted read-only on 2026-09-17.
