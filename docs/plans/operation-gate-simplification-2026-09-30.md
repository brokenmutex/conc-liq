# Operation gate simplification — September 30, 2026

Status: proposal. Nothing here is applied. No item below authorizes execution,
and the measurement in section 4 is the only part that has been carried out.

The operator asked whether the safety checks guarding drafting, opening,
closing and pausing still make sense, or whether repetition and over-engineering
are what make the dashboard slow and unreliable. This plan answers that with
measurements rather than taste, and proposes an ordered, bounded set of changes.

## 1. What was measured

Gate density per operation, counted from the source, against each operation's
observed behaviour during the September 29–30 remediation session.

| Operation | Modules | Distinct failure codes | Preview latency | Observed record |
| --- | ---: | ---: | ---: | --- |
| pause / resume | 3 | 8 | <1 s | 2/2 succeeded first attempt |
| close and retain | 2 | 18 | ~1 s | 3/3 succeeded first attempt |
| open | 12 | 38 | 43–47 s (setup review) | 0 until four defects were fixed |
| close and convert | 13 | 223 | 91–131 s | never completed end to end |

Supporting counts across `src/deployments`:

- **48** independent 180-second freshness windows.
- **27** canonical frame read sites. Each is an RPC round trip plus oracle
  reads plus a feed-directory HTTP fetch.
- **8** cost-model resolution sites.

The relationship is monotonic across four independent operations. The two
lightest paths have no recorded failure in this session; the two heaviest
account for every defect fixed and for the one operation that has still never
completed.

This is evidence of correlation, not proof of causation. A plausible competing
explanation is that convert is intrinsically the hardest operation and would
need the most gates however it were written. Section 5 proposes treating it
accordingly rather than pruning it on a count.

## 2. Four categories

### Category 1 — load-bearing, do not touch

The recheck performed under the campaign lock at commit time. Between preview
and acceptance the world can genuinely change; the accept transaction holds
`FOR UPDATE` on the campaign, and this recheck is what prevents acting on
stale economics. The same applies to idempotency-key binding, the append-only
guards, and canonical anchor verification at commit.

Every proposal below assumes these remain exactly as they are.

### Category 2 — duplicated recomputation (the latency)

One operator "open" recomputes the same `(candidate, costs, model)` triple
**five times**: setup preflight, the pinned rebuild after gas sampling, the
open preview, the acceptance, and the worker completion. Each recomputation
re-reads a fresh canonical frame.

The hash comparison at each stage is cheap and worth keeping. Re-reading the
chain to produce the value being compared is what costs the time.

The distinction that collapses this: each stage is asking one of two different
questions.

- *"Does this still equal what was reviewed?"* — should replay from the
  **pinned** source, which needs no fresh frame.
- *"Is this still true now?"* — needs a fresh frame, and belongs only at the
  commit boundary.

Most stages currently perform the second while meaning the first.

### Category 3 — miscalibrated thresholds (the fragility)

48 copies of a 180-second window guard operations measured at 43–131 seconds.

Convert is the clearest case: the preview takes 91–131 s inside a 180 s source
window, then issues a preview whose time-to-live is 46–51 s. The system spends
most of its own safety margin producing the artefact the margin protects, and
the remainder becomes the operator's clicking budget.

The fee-cursor settle budget has the same shape, and now has data behind it.
During the operator's manual campaign on September 30, across 48 worker passes:

| Outcome | n | Mean | Max |
| --- | ---: | ---: | ---: |
| Settle succeeded | 34 | 4.3 s | 10.0 s |
| Settle timed out | 12 | 16.9 s | 17.7 s |

Every failure pins at the 15-second budget plus query overhead; every success
completes under 10 s. These are budget-limited, not a distinct fault.
`waitForCompletePaperFeeCursor` already validates up to 30,000 ms.

Thresholds should be derived from measured stage latency with stated headroom.
At minimum, preview time-to-live should stop inheriting the source window, so a
slow preview cannot hand the operator a short fuse.

### Category 4 — fragile by construction

`paperGasModelSchema` carries `sizeMinValue`/`sizeMaxValue` and
`shareMinPpm`/`shareMaxPpm`, and `costIndicativePaperOpenPreview` validates
with `min>size||size>max`. The schema and resolver are built for **ranges**.

`paper-gas-sampler.ts` writes every one of them as a point:

```js
sizeMinValue:  candidate.deployedValue,   sizeMaxValue:  candidate.deployedValue,
shareMinPpm:   candidate.dilutedSharePpm, shareMaxPpm:   candidate.dilutedSharePpm,
```

and `paper-gas-evidence.ts` asserts that collapse on import. The range
machinery exists and is deliberately disabled.

That single decision is why every setup review must sample fresh evidence on a
fork (~40 s of the 43–47 s total), why the calibration table grew six rows per
review until it approached the 200-row resolver bound, and why no piece of gas
evidence is ever reused.

## 3. What the gates cost, and why they were added

Each gate was almost certainly added in response to something that went wrong;
the incident records in `docs/reviews/` and `docs/incidents/` read that way.
The failure mode is not that individual checks are unreasonable. It is that
**no check was ever removed when a later one subsumed it**.

Accordingly, every removal proposed here must name the incident the check was
added for and argue that another gate now covers it. A count alone is not an
argument for removal.

## 4. Measured: the gas banding error bound

This is the only section that has been executed. It exists to decide whether
category 4 can proceed.

Source: all 27 `paper_static_manual_no_swap_v1` bands in
`deployment_calibration_profiles`, sampled 2026-09-28 to 2026-09-30.

### The outlier

One band, `exact_caba131cb2de121c8710afc1608038ec` (sampled 09-29 19:31), is
**197.6% of the median total gas**, with all six stages inflated roughly 2×
together. The next highest band is 110.5% of median. It is a single anomalous
sampling run, not a size effect, and is excluded from the bound below and
reported separately.

### The bound, 26 bands, outlier excluded

| Stage | Bands | Min units | Max units | Spread |
| --- | ---: | ---: | ---: | ---: |
| mint | 26 | 455,755 | 573,628 | **25.9%** |
| withdraw_collect | 26 | 257,178 | 302,978 | 17.8% |
| cleanup_token0 | 26 | 38,406 | 41,963 | 9.3% |
| cleanup_token1 | 26 | 44,030 | 47,637 | 8.2% |
| approve_token0 | 26 | 58,801 | 62,272 | 5.9% |
| approve_token1 | 26 | 64,484 | 67,955 | 5.4% |

**Every stage's total observed spread is below the 30% margin that
`gasUnitsBound = ceil(expected × 13/10)` already commits to paying.** Banding
would therefore admit at most variation the system already tolerates.

### What the variation is not driven by

Across those 26 bands, holding the outlier out:

- **Diluted share varied 3,317–5,847 ppm, a 1.76× range, while
  `approve_token0` stayed at exactly 58,801 units in 19 of 27 samples.** Gas is
  insensitive to share over the observed range.
- **Multiple distinct tick ranges** (217970, 217980, 218070, 218200–218300)
  produced identical approval gas.

So two of the three dimensions the band key pins to the wei — share and tick
range — demonstrably do not drive the gas they are pinning.

### What this does not establish

**Size never meaningfully varied.** Every sample sits between 239.95 and 250.00
USD, a 4% range, because every campaign used 250 USDG of capital. This dataset
therefore **cannot** bound the error of reusing a band across materially
different position sizes. Claiming otherwise from this data would be invention.

To band by size, deliberate samples at distinct sizes are required — 100, 250,
500 and 1,000 USDG against the same pool and range. `sampleStaticPaperGas`
already does this, takes roughly 40 s per sample, touches no economic state,
and needs a fork RPC only. That is a bounded experiment of well under an hour.

### The reuse caveat the outlier exposes

A reused band carries its own `gasUnitsBound`. A band sampled at the low end
(455,755 expected, bound 592,482) would **not** have covered the anomalous mint
at 746,842. Reuse across time therefore needs either a bounded reuse window
short enough that pool state cannot drift, a bound derived from the observed
maximum rather than a single sample, or re-sampling when a fresh estimate
deviates beyond a stated threshold. Widening the bands without addressing this
would trade a slow open for an under-bounded one.

## 5. Proposed order

1. **Band share and tick range only** (category 4, partial). Measured above as
   safe: neither drives gas, and the residual spread is inside the existing 30%
   bound. Leave size pinned until section 4's size experiment is run. Removes
   most fork sampling from repeat reviews at the same capital.
2. **Run the size-gradient experiment**, then decide on size banding with a
   real number. Under an hour, no economic state touched.
3. **Split replay-from-pinned versus verify-now** (category 2). Mechanical, and
   where the remaining latency lives. Each converted site must state which of
   the two questions it is asking.
4. **Derive freshness windows from measured latency** (category 3). Start with
   decoupling preview TTL from the source window, and raising the fee-cursor
   settle budget to the already-validated 30,000 ms with a re-measurement
   against the next campaign.
5. **Leave close and convert until last.** 223 failure codes across 13 modules,
   for an operation that has never once completed, is not a tuning problem. Its
   contract needs restating before its gates can be pruned safely, and it is
   the one path where removing a check is most likely to lose something real.

## 6. Out of scope

- Any change to the commit-time recheck, idempotency binding, append-only
  guards or anchor verification (category 1).
- Any change that widens a bound without a measurement behind it.
- Any change to the live RangeKeeper controller's custody rules.
- Route or authentication changes to the operator surface, which stays at
  `/operator` per the September 30 decision.
