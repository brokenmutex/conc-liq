# Active-LP objective and evaluation contract

## Objective

Optimize net LP alpha against passive ownership of the same starting assets,
not displayed APR, gross fees, or profit relative to cash alone.

Every report must keep these measures separate:

- strategy NAV and absolute P&L versus initial cash;
- passive-hold NAV using fixed initial token quantities;
- strategy return minus passive-hold return;
- earned fees by token;
- gas, approvals, swap loss/slippage, removal and liquidation costs;
- inventory exposure, drawdown, range occupancy and time with unavailable data.

Pool spot may price execution and reconcile pool accounting. A policy-accepted
independent reference must price comparable economic performance. An unavailable
reference or cost remains unavailable; it is not replaced by a convenient pool
price or invented estimate.

## Managed states

Crossing a range is an ordinary managed state, not a failed observation.

The strategy must retain and value one-sided inventory, accrue no fees while
liquidity is inactive, and compare at least:

- waiting with existing inventory;
- placing a residual one-sided range without a swap;
- widening or reducing deployment;
- recentering with existing tokens;
- a minimal-swap redeployment;
- a complete exit.

Moving liquidity and swapping inventory are separate decisions. No policy may
silently force a 50/50 reset after every crossing.

## Evidence contract

Every decision should resolve to one immutable decision frame containing:

- source block, hash, timestamp and checkpoint identity;
- event-coverage and canonicality evidence;
- risk, oracle, asset-health and corporate-action evidence;
- pool state and exact integer portfolio state;
- quote and complete action-cost evidence;
- policy, configuration and build identity;
- the resulting action or fail-closed reason.

Cost evidence is classified as `measured`, `fork_estimated`, `borrowed`,
`assumed`, or `unavailable`. Borrowed, assumed or unavailable costs may support
research sensitivity analysis but cannot promote a policy to live execution.

## Validation sequence

1. Development replay establishes mechanics and rejects broken hypotheses.
2. Validation replay uses frozen rules and independent periods/assets.
3. An untouched holdout is excluded from selection.
4. Forward paper operation covers at least three weeks and two weekends for the
   current adaptive campaign.
5. Pool- and size-specific cost probes replace borrowed assumptions.
6. A tiny live canary requires separate authorization and complete custody,
   recovery, reference and cost gates.

Research, paper and live results must not be merged into one evidence class.
Execution and broadcasts remain disabled unless a separately reviewed gate
explicitly says otherwise.
