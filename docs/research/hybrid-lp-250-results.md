# $250 hybrid LP research result

Completed September 20, 2026. Decision: **no candidate**. Research and inactive
paper mechanics only; `executionEligible=false` and `broadcastsEnabled=false`.
No service, campaign state, signer, allowance, funding, or live configuration
was changed.

## Decision

The preregistered hybrid policy did not enter on AAPL or NVDA. Every fixed span
(1, 2, 4, 8, 16, and 32 tick spacings) and the adaptive arm chose keep/cash in
base and stressed costs, for both full-session and off-hours-only operation.
No feasible entry produced a strictly positive incremental benefit over keeping
after staged costs and the larger of the 50%-of-cost and 25%-of-forecast-fees
buffers.

This is a rejection, not evidence that cash will outperform LP generally. The
dates were inspected previously, the replay has no independent reference marks,
and the stage split is borrowed/assumed. Those limitations independently prevent
selection even if a hybrid arm had looked favorable.

## Preregistered scope

The experiment reserves 240 USDG for strategy inventory and 10 USDG once for gas,
with no refill or borrowing from future sales. AAPL and NVDA from September 8–11
are development data. QQQ remains an untouched holdout. No complete validation
period was available. The exact split, grid, risk thresholds, source hashes, cost
classes, Node version, baseline, and acceptance rules are frozen in
[`hybrid-lp-250-2026-09-20.json`](../../research/experiments/hybrid-lp-250-2026-09-20.json).

The table below uses six-decimal quote units converted to USDG. `Pool alpha` is
the terminal pool-marked comparison against each arm's fixed post-entry inventory;
it is a development diagnostic. Independent-reference alpha is unavailable for
every row and was not replaced with pool spot. The hybrid never entered, so its
pool-marked alpha, fees, gas, turnover, and exposure are all zero.

| Asset | Scenario | Session | Arm | Net P&L | Pool alpha | Fees | Gas | Moves / swaps |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| AAPL | base | full | outside-range | +5.944 | +2.766 | 14.728 | 1.507 | 6 / 7 |
| AAPL | base | full | inventory-only | +9.596 | +6.547 | 6.447 | 0.528 | 2 / 1 |
| AAPL | base | full | hybrid adaptive | 0 | 0 | 0 | 0 | 0 / 0 |
| AAPL | base | off-hours | outside-range / inventory-only | +4.296 | +1.119 | 4.604 | 0.202 | 0 / 1 |
| AAPL | double gas, half fees, delayed | full | outside-range | +1.661 | -1.183 | 2.302 | 0.404 | 0 / 1 |
| AAPL | double gas, half fees, delayed | full | inventory-only | +5.378 | +2.590 | 2.004 | 0.730 | 1 / 1 |
| AAPL | double gas, half fees, delayed | all modes | hybrid adaptive | 0 | 0 | 0 | 0 | 0 / 0 |
| NVDA | base | full | outside-range | -8.062 | +4.548 | 6.345 | 0.811 | 3 / 4 |
| NVDA | base | full | inventory-only | -11.489 | +1.235 | 2.028 | 0.195 | 0 / 1 |
| NVDA | base | all modes | hybrid adaptive | 0 | 0 | 0 | 0 | 0 / 0 |
| NVDA | double gas, half fees, delayed | all modes | outside-range / inventory-only | -12.835 | +0.221 | 1.014 | 0.390 | 0 / 1 |
| NVDA | double gas, half fees, delayed | all modes | hybrid adaptive | 0 | 0 | 0 | 0 | 0 / 0 |

Every fixed-width hybrid row has the same no-entry outcome as the adaptive row.
The compact evidence retains all 72 rows, raw token fees, terminal holdings,
terminal position, drawdown, risky exposure, holding/out-of-range time, gas,
adverse-selection allowance, exit cost, rejection counts, and full-replay hashes:
[`hybrid-lp-250-results-2026-09-20.json`](../../research/evidence/hybrid-lp-250-results-2026-09-20.json).
Day-level independent alpha dispersion is unavailable because the retained replay
does not contain independent-reference interval marks; no pool-marked substitute
was created.

## Competitor attribution

The bounded AMC audit reproduces 47 cohort NFTs: 35 fully settled and 12 with
remaining liquidity. It contains 52 September 4 sender transactions with 56 AMC
pool Swap events. The compact timeline records timestamp, direction, raw pool
flows, route-leg count, live cohort liquidity, and neighboring LP actions for all
52 transactions. Per-transaction wallet balances and exact own-flow fee shares
remain explicitly unavailable because the retained compact analysis does not
prove them.

The deterministic fixture covers the direct swap counterexample, a four-addition
top-up, a partial withdrawal whose added minus burned liquidity equals its live
remainder, and a position spanning midnight. Core Collect amounts and actual ERC-20
payment matching are retained separately from Burn principal. The three adopted
behaviors are limited to: separate range placement from inventory trading; value
top-ups, idle balances, and residual liquidity; and start with one managed NFT
instead of imitating multi-NFT concurrency.

- [Competitor timeline](../../research/evidence/hybrid-lp-250-competitor-timeline-2026-09-20.json)
- [Deterministic attribution fixture](../../research/fixtures/hybrid-lp-250/competitor-attribution.json)

## Implementation and recovery behavior

The opt-in engine in `src/research/hybrid-lp.ts` evaluates keep, no-swap redeploy,
and bounded swaps in both directions across exact tick-aligned spans, offsets,
and deployment fractions. It values all idle and LP tokens, embeds swap fee and
historical price impact in the exact quote, charges stage gas and adverse selection
separately, reserves exit cost, prefers the smaller input on an economic tie, and
requires strict `benefit > buffer`.

Actions advance through later canonical approval when required, withdrawal and
collection, optional swap, and mint observations. A submitted revert pays gas.
Completed-stage receipt IDs, token balances, direction, raw input, minimum output,
range, minimum liquidity, TTL, and provenance persist. A failed mint after a swap
resumes at mint and cannot repeat the swap. Cancellation before withdrawal keeps
the old LP; cancellation after withdrawal retains valued wallet inventory.

The inactive diagnostic config is
[`hybrid-lp-250-paper.json`](../../config/hybrid-lp-250-paper.json). It assumes an
existing allowance because approval evidence is unavailable and labels the stage
split as borrowed; it is therefore not activation-ready evidence. No launch command
or service unit was produced after the rejection. The conditional canary controls
are documented in
[`hybrid-lp-250-canary-checklist.md`](../operations/hybrid-lp-250-canary-checklist.md).

## Reproduction

From the repository root with Node 24:

```sh
PATH="$PWD/.tools/node/bin:$PATH" node --import tsx \
  scripts/research/hybrid-lp-replay.mjs \
  data/lp-small-budget-2026-09-13 AAPL \
  data/hybrid-lp-250-2026-09-20/AAPL.json

PATH="$PWD/.tools/node/bin:$PATH" node --import tsx \
  scripts/research/hybrid-lp-replay.mjs \
  data/lp-small-budget-2026-09-13 NVDA \
  data/hybrid-lp-250-2026-09-20/NVDA.json

PATH="$PWD/.tools/node/bin:$PATH" node \
  scripts/research/hybrid-lp-compact.mjs \
  data/hybrid-lp-250-2026-09-20 \
  research/evidence/hybrid-lp-250-results-2026-09-20.json
```

The replay refuses to overwrite outputs and verifies retained input and page
hashes. Ignored full outputs remain on this host; the tracked compact evidence
pins their hashes but is not an off-host archive.

## Failed promotion gates

- No hybrid arm passed the development economic gate, so no candidate was frozen.
- Independent-reference alpha and the required complete validation period are
  unavailable.
- Hybrid stage costs are borrowed/assumed; approval cost and current allowance
  state are unavailable.
- Pool- and size-specific executable exit cost has not been measured for a hybrid
  candidate.
- The prospective three-week, two-weekend immutable paper run did not start.

The active four-book campaign and its QQQ holdout were not modified.
