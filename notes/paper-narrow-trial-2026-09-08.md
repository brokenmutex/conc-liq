# NVDA narrow-range paper trial — September 8, 2026

The user selected a 1,000 USDG fixed ±20-raw-tick candidate for immediate forward paper learning. Policy: [paper-nvda-1000-ticks20.json](../config/paper-nvda-1000-ticks20.json). `halfWidthSpacings: 2` means ±20 raw ticks in this fee-500 pool, total width 40; it does not mean ±20 spacings. Bounds use the nearest feasible grid midpoint, so distances from the starting price can differ slightly between sides.

The entry targets 800 USDG of LP inventory and retains at least 200 USDG in cash. The ±5% reference guard applies to the pool price and the complete range. The existing 1% maximum minted-liquidity/historical-active-liquidity ratio and 50 bps executable swap slippage limit remain. The maximum holding period is 24 hours from simulated entry. There is no scheduled routine recenter and no automatic new session after closure.

At a minute checkpoint with reference-valued NVDA exposure at or above 60% (including wallet, LP principal, fees and estimated costs), the worker schedules a full exit to USDG on a later checkpoint. The same delayed exit applies to reference/risk failure. The threshold can be overshot between observations. **This first trial exits to cash instead of selling toward 50% and reminting**, an explicit simpler lifecycle than the historical research policy.

## Crossing-aware accounting

New sessions opt into `initialized_boundaries_v1`. The paper executor admits an entry only when both chosen boundaries are already initialized in the canonical pool. At each subsequent checkpoint it reads their liquidity gross and fee-growth-outside values at the exact checkpoint block and rechecks its hash. Reads occur outside a database transaction under the session advisory lock. The store revalidates the selected source and session before accounting or simulation.

The global fee-growth checkpoint and those two outside values determine fee growth inside the range. This follows crossings, earns zero during a completely inactive interval, and resumes earning on reentry. Fractional Q128 fee amounts survive checkpoint boundaries. Complete indexed Mint/Burn events must reconcile boundary liquidity gross across the interval without either boundary clearing; a cleared/reinitialized boundary invalidates the baseline and performance. A failed read is retried while the source remains fresh; missing coverage/source freshness cannot be filled retrospectively.

This measures the observed pool's inside fee growth exactly when the continuity proof passes, but **our hypothetical fee income remains an estimate**: the simulated LP would alter fee sharing and potentially the market path. The 1% admission cap limits initial size but does not guarantee the share remains below 1% later. Old session policies and their legacy crossing limitations are preserved.

## Execution and reference conventions

The existing signer-free Nitro/local-fork executor simulates inventory acquisition, approvals, mint, removal/collection, liquidation and allowance clearing. It records calldata, local receipts, canonical source hashes and Nitro gas estimates. No mainnet broadcasts or wallet keys are used. The 1 ETH native fixture funds local gas mechanics; estimated gas is separately deducted from the USDG NAV. The reserve is an allocation target before those gas debits.

This paper session starts from USDG cash and pays simulated acquisition/approval costs, unlike the historical replay's pre-held/preapproved inventory. It retains the paper dashboard's **pool-spot NAV basis** and an acquired-inventory passive comparator. Its results must not be directly equated with the historical independent-reference NAV and endowed-inventory sensitivities.

The trial retains the existing `continuous_bounded_v1` paper reference policy, widening only the user-selected band from 3% to 5%. Equity rounds use the feed heartbeat up to 24 hours; older held prices outside regular sessions require an update during the latest regular equity session and expire after 96 hours. USDG/ETH use their own feed heartbeat, capped at 24 hours. This is the existing regular-session-aware paper rule, **not** the historical replay's explicit Friday 17:00–Sunday 18:00 calendar. This first session's 24-hour maximum hold covers the current weekday/overnight period. Weekend extension requires reviewing that calendar difference.

Issuer/pause/multiplier, token identity, canonicality, source age, indexed event coverage and chain recovery gates continue to apply. A waiting session is observation activity, not an executed paper position. Gas estimates and hypothetical fees never become measured mainnet profit.

## Validation and operation

TypeScript and 252 tests pass. The isolated PostgreSQL lifecycle with boundary mode verifies restarted state, five boundary reads, unlocked network preflight, concurrent-tick exclusion, cancellation, source revocation, failed exit retry, and entry/exit evidence. Its temporary schemas are removed. No production migration is required; policy and proof fields use existing immutable JSON records.

The paper worker uses a new sealed release and the existing private runtime configuration. Other services retain their existing releases. The timer runs every 15 seconds and processes new canonical minute checkpoints. Runtime/policy hashes bind each session to its build and configuration. Stop through the pinned worker's `paper stop` command; stopping the timer alone does not close a position. An open session must complete its exit before changing its runtime identity.

Activation evidence will be recorded alongside this note after the new worker starts. Review the first entry, subsequent fee marks, actual cash reserve, source ages, boundary continuity, exit triggers and any failed simulations before interpreting performance.
