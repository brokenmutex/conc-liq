# Full-deployment off-hours paper campaign — September 11, 2026

The user approved a new **5,000 USDG** paper campaign, **±20 raw ticks** (40 total), **100% target token allocation**, recentering on the first eligible observation outside the current range, and no inventory cap. Rebalancing is only the net trade needed to fund the replacement range. The user also approved replacing the routine 24-hour holding timeout with the scheduled trading-window exit.

Policy: [paper-nvda-5000-recenter-offhours.json](../../config/paper-nvda-5000-recenter-offhours.json). This creates a new root campaign; the old campaign's losses and session records are retained, not topped up or rewritten. Full deployment concerns USDG/NVDA capital; native ETH gas is a separately valued economic cost. Integer minting and a frozen trade executed at a later source can leave residual tokens; those tokens remain in NAV.

## Decisions and execution

- `maxHoldingSeconds: null` is permitted only with the explicit trading-hours policy. A position can remain open throughout a weekend without a routine daily exit/reentry. Existing numerical timeouts retain their historical meaning in old sessions.
- Existing calendar remains: New York after-hours, overnight and weekends; regular hours, premarket, holidays and unsupported years are excluded. Quotes/new deployments stop 30 minutes before excluded hours; cash exit is requested 10 minutes before the boundary. On this weekend, the allowed window starts **September 11 20:00 UTC**, with exit requested **September 14 07:50 UTC**, before the **08:00 UTC** boundary. Runtime failures can defer an exit; the schedule is a request, not a guarantee of execution.
- The trigger uses `tick < tickLower || tick >= tickUpper`. There is no displacement trigger, persistence period or recenter cooldown. Only one move can be pending. Returning inside cancels it.
- A quote freezes replacement ticks, net swap direction/input, swap minimum output and mint minimum amounts. A move requires a later source whose timestamp is after the quote, quote age at most 90 seconds, valid current reference and initialized boundaries, fresh execution/source checks, and an eligible trading window. Rejections retain the marked old position and try again on subsequent observations.
- Removal/collection, an optional net buy or sell, approvals and minting execute only on an owned local fork. A quoter-based integer search includes pool fees and price impact when solving the new range's token ratio. It does not first sell the whole NVDA balance to cash.
- Successful moves charge their own fresh Nitro gas estimates once. A separate same-fork cash-exit preview supplies an exit reserve; it is never charged as executed recenter gas. A later actual paper cash exit replaces that reserve with its own new estimate.
- A range move carries original entry time, passive holdings, campaign budget, cumulative gas and earned fee totals forward. The new NFT starts a fresh boundary-fee baseline. Collected estimated fees become balances, not extra P&L. Every move's execution proof remains part of campaign canonicality validation.

The true-price band remains ±5%, with the existing oracle policy, 30-block holding lag tolerance, bounded infrastructure pauses and 0.5% swap slippage tolerance. The inventory threshold is absent, rather than set to 100% (which could still trigger on costs and one-sided inventory).

## Paper size ceiling

A fresh sizing check at block **60238541** estimated 5,000 USDG in the requested range at **10,902 ppm (1.0902%)** of active pool liquidity. A scaled historical fork test also rejected the old 1% share cap. Keeping that ceiling would silently block the requested experiment.

The new active paper policy therefore uses **20,000 ppm (2%)** as its pool-share ceiling. This is distinct from the removed portfolio inventory cap. The higher bound is allowed only for the explicit recenter experiment; legacy paper policies retain their 1% ceiling. Thin liquidity can still block a quote/fill. This is a paper-only adjustment, not authorization for a live LP or a claim that 5,000 USDG is an optimal size.

## Evidence and limits

[Owned fork checks](fork-checks.json) exercise both directions: a scaled recorded holding needing a net NVDA sale, and a constructed approximately 5,000 USDG one-sided book needing an NVDA purchase. Quotes use block **59509160**, and both fills execute at **59509161**. Each successful move used six priced transactions, followed by four separate exit-preview transactions. Contract outputs, mint liquidity/token amounts, residual balances and local native spending reconcile. These historical probes exercise execution mechanics; they do not prove current freshness gates or strategy profitability.

**101 focused tests** passed, covering paper accounting, old session recovery, market hours, native gas, recenter quotes/fills and both net-trade directions. Isolated PostgreSQL checks cover the existing holding/restart/exit lifecycle and revocation of any recenter proof, wrong execution scope, source/valuation/runtime mismatches and duplicate move IDs. Typecheck and dashboard JavaScript syntax checks passed.

Remaining modeling limitations from the [fee/cost audit](../lp-cost-validity-2026-09-11/README.md) still apply: observed fee growth is an undiluted counterfactual, not actual NFT earnings; a larger position may change flow and fee share. Native costs are node estimates, not paid receipts. Acceptance of the local recenter sequence is all-or-none; costs and exposure from a submitted partially completed live sequence are not modeled. Preflight rejection means no simulated submission or charged gas.

No database migration or other worker deployment is needed. A recenter is stored in the existing execution table as an LP `entry`, with `result.scope = paper_inventory_recenter`; its observation action and dashboard label are `recenter`. These are new NFT entries within one session, not new cash-funded campaigns. The running old strategy comparison stays stopped, and the already frozen weekend validation continues from its separate immutable source capsule.

## Activation

Activated at **12:03:52 UTC**. Session **57** was waiting with no position and was stopped normally. Session **58** is a new root with **5,000 USDG**, zero costs and zero campaign P&L; no predecessor funding link is attached. The previous campaign and its realized paper losses remain in the database.

Paper worker and dashboard use sealed release `3a88ac569313243cfbe4340a59ffe702fa01c87758ce45e64355588dc30677fa`, from source commit `f5fe86d1371845816fe3312a93d11dee9de7cb4f`. Policy hash: `474040b443955d490ebe518cfa650aa3a575f9fc265160045e4c11764cb34875`.

The dashboard health endpoint and API both returned **HTTP 200**, showing a valid standalone campaign with the new policy and no routine timeout. The paper timer and dashboard are active. The new session is waiting in cash before the allowed Friday evening window, initially awaiting new canonical checkpoint coverage. No new LP fill or recenter has occurred yet in this forward campaign.

[Activation record](activation.json) and [dashboard verification](dashboard-check.json). Other workers and both frozen prospective validation timers were left running on their existing code and plans.
