# RangeKeeper v1.0.0 — Sol implementation and live-launch plan

Prepared: September 21, 2026. Status: ready for implementation.

Strategy name: **RangeKeeper**. Strategy version: **1.0.0**.
Machine policy ID: `rangekeeper_v1`. Configuration schema version: `1`.
Persist strategy version, config hash, build ID, and state schema version separately.

## Objective and user decisions

Implement an asset-agnostic, reactive concentrated-liquidity strategy and carry
it through a bounded real-money launch. Use fixed range width and deployment
rules, observed range exits, current inventory, and executable cost limits.
No fee forecast, volatility forecast, directional forecast, forecast terminal
value ranking, or predicted-benefit economic gate participates in decisions.

The user approved this simpler algorithm, a five-minute wait after range exit,
and an asset-agnostic implementation. The user explicitly does not require a
benchmark against the current algorithm. Do not build a comparative study,
retune the old hybrid, or make outperforming it a launch condition.

The intended endpoint is funded operation, not an inactive research package.
Implementation correctness, actual execution readiness, accounting, and bounded
custody are the launch gates. These gates do not establish future profitability.
Report absolute net P&L, inventory, fees, and all costs from the first real action.
Passive-hold attribution may remain an accounting diagnostic; it is not a
strategy-selection exercise or a prerequisite requiring positive alpha.

The prior adaptive campaign's three-week/two-weekend evaluation and the old
hybrid checklist's forecast-based acceptance criteria do not apply to this new
strategy. Preserve the existing campaigns and their own rules. Retain independent
reference, asset-health, canonicality, custody, and execution controls.

## Execution authority and capital

This document requests implementation and preparation of a concrete live launch.
It does not itself identify an approved launch wallet, pool, or signing window.
Complete implementation, validation, release preparation, read-only discovery,
and the proposed launch record before requesting any missing live authorization.
If subsequent user instructions already authorize that exact launch scope,
proceed within it without asking again.

Carry forward the discussed first-campaign cap: **250 USD-equivalent total**,
comprising at most **240 for strategy inventory and 10 for native-gas funding**.
Make these configured accounting values, not six-decimal USDG literals. Value
quote tokens and native gas against the configured reporting numeraire with
verified independent references. Include preparation/probe spending in the same
cap; there is no additional probe budget, automatic refill, or borrowing from
future sales. Report actual remaining usable inventory after probe costs.

Start with one campaign, one verified pool, one managed NFT, and one pending
transaction. Asset agnosticism means the same implementation accepts different
verified assets; it does not mean automatically funding an asset universe or
granting every pool a separate 250 budget. Additional pools/capital need explicit
allocation under the aggregate authorized cap.

## Current repository and prerequisites

Starting HEAD at plan preparation: `273b75b46f10419b557cfef5c6a7891bf9fd6393`.
The current working tree includes authorized, uncommitted rejection-cadence and
five-minute exit-timer changes. Inspect and preserve them. Do not reset them,
overwrite their historical evidence, or sweep them into unrelated commits.

Read:

- `src/research/hybrid-lp.ts`, `inventory-range.ts`, and `inventory-lp.ts` for
  exact inventory/mint math and the existing exit-timer behavior. Both managers
  still have forecast-driven decisions; neither is RangeKeeper unchanged.
- `src/live-pilot/{config,domain,chain,guard,controller,journal,receipt,reconcile,valuation,store}.ts`
  for the real execution, persistence, accounting, and recovery surfaces.
- `src/live-pilot/mint-recovery.ts`, `src/execution/allowance-policy.ts`,
  `docs/operations/live-pilot.md`, and `ops/live-pilot/README.md`.
- `docs/research/hybrid-lp-250-cadence-correction-2026-09-21.md` and
  `research/manifests/hybrid-lp-250-2026-09-20.json` for historical reproduction.

The live pilot currently hardcodes NVDA/USDG, token order, 6/18 decimals, fee 500,
tick spacing 10, and asset-named state fields. Generic research configuration
alone is insufficient. Asset identity must remain generic through signing,
receipt parsing, reconciliation, valuation, recovery, and shutdown.

## Frozen v1 behavior

### 1. Configuration and asset identity

Require an immutable pool profile containing chain ID, factory, pool, token
addresses, token ordering, quote/base designation, decimals, fee, tick spacing,
position manager, allowed swap router/quoter, and independent reference identities.
Validate these against canonical chain state and existing approved deployments.
Symbols are display metadata, never routing, authorization, or valuation keys.
No signer input may choose an arbitrary unverified spender or contract.

Use generic token-address/raw-amount accounting with exact integer V3 math.
Support quote as either token0 or token1 and differing token decimals. Reference
adapters must specify asset/session/corporate-action rules explicitly. Unsupported
token transfer behavior, missing references, or unknown pool implementations
reject admission; asset agnosticism does not imply arbitrary-token support.

Require these policy fields:

| Parameter | v1 rule |
| --- | --- |
| Decision interval | 30 seconds between eligible observations |
| Exit persistence | 300 seconds outside the same active range |
| Post-move cooldown | Disabled |
| Confirmations | Two consecutive eligible observations, at most 90 seconds apart |
| Range width | One positive, even `fullWidthSpacings` per pool, fixed for the campaign |
| Deployment | Fixed maximum deployment value and explicit minimum deployment fraction |
| Swap allowance | Explicit maximum input value/fraction and execution shortfall cap |
| Execution slippage | At most the existing 50-bps ceiling; may be tighter per profile |
| Costs | Explicit per-action, rolling-24-hour, and campaign spending limits |
| Inventory/risk | Explicit exposure, loss, drawdown, and maximum recenter-count limits |
| Safety reserve | Current conservative complete-exit gas requirement, reserved separately |

Live configuration must contain concrete non-null values for every limit.
Missing limits disable activation; zero must not silently mean unlimited.
Sol should prepare and justify one concrete initial pool profile using verified
liquidity, exact mint feasibility, current quotes, and cost evidence. Width and
risk/cost limits are explicit operating choices, not forecast-optimal numbers.
Freeze them before the canary. Do not tune a profitability sweep or copy NVDA
units into other pools. Provide broadcast-disabled example profiles and include
the actual proposed values in the final activation record.

### 2. Observe and determine eligibility

On each usable canonical observation, reconcile inventory, fees, active NFT,
pending transactions, source continuity, and current independent valuation.
Safety/stop decisions and pending-transaction reconciliation run before ordinary
entry/recenter scheduling. Missing inputs never become zero cost or a fabricated
price. Loss of entry permission does not disable monitoring of existing custody.

With no position, evaluate initial entry only when capital, reference, execution,
and risk admission pass. Initial entry has no range-exit waiting period.

While the position is inside its range, leave it alone. No in-range recentering,
width changes, fee-only harvesting, discretionary top-ups, or forecast signals.
Track fees without harvesting on a separate schedule. Safety exits remain allowed.

On first observed exit, persist its canonical block/hash/time and range identity.
The lower tick boundary is inside; the upper boundary is outside. Returning
inside clears the timer and ordinary-action confirmations. A later exit starts
a new timer. After 300 seconds continuously observed outside, allow evaluation
every 30 seconds. A rejection does not restart the exit timer.

Persist the timer across restart only when canonical range/state continuity can
be proven. A reorg, unaccounted observation gap, or replacement range invalidates
that proof; rebuild it from canonical observations or start a fresh interval.
Use block market time, not ingestion time. Do not infer continuous outside time
from an outage followed by one outside observation.

### 3. Construct one deterministic replacement

Set `anchor = floor(currentTick / tickSpacing) * tickSpacing`. For configured
even full span `N`, propose `[anchor - N/2 * spacing, anchor + N/2 * spacing)`.
Reject invalid tick bounds rather than changing width at the boundary. This one
centered placement is used for entry and eligible recentering; no range search.
Persist and display the full width to avoid half-width ambiguity.

Value all current wallet tokens plus released principal/fees. Exclude native gas,
exit reserves, and unrelated wallet funds. Deployment cannot exceed the configured
fixed cap or available strategy equity. Fees/surplus remain accounted inventory;
they do not automatically increase the fixed cap or authorized gas budget.

First calculate the exact mint possible without a swap, subject to the deployment
cap. Accept that construction if it satisfies the explicit deployment floor and
inventory limits. Otherwise solve for the smallest raw input swap that makes this
same range and deployment floor feasible. Direction follows the actual token
shortage, not a price prediction or independently imposed 50/50 target.

Use one approved direct route in v1. Quotes must include fee and price impact;
account for the swap's effect on the pool and mint. Bound the integer search,
verify its assumptions, and confirm feasibility with exact calldata simulation.
Unfilled quotes, broken monotonicity, a pool-price move outside the frozen range,
or no proven solution mean wait. Do not hide a guessed optimizer or broad route
search in the minimum-swap helper.

If inventory cannot fund active liquidity within limits, wait with existing
holdings. One-sided inventory cannot be made active around current price for
free. Do not move to a speculative one-sided range just to count a recenter.
Waiting continues to carry marked inventory risk and earns no inactive LP fees.

### 4. Apply cost and inventory admission

Admit the proposed action only if all are true:

- Complete quoted/simulated execution costs fit the per-action limit.
- Spent costs plus reserved in-flight costs fit rolling and campaign limits.
- Remaining spendable native balance covers the unfinished action and a complete
  exit, including approvals, collection, sale of residual assets, and cleanup.
- Swap input, quoted shortfall, slippage, deployment, LP share, and resulting
  inventory exposure fit their configured limits.
- Loss/drawdown and recenter-count limits permit another ordinary action.
- Contract identity, allowance, nonce, liquidity, reference, and source gates pass.

This is an affordability and risk gate. Do not require predicted fees, payback
time, future price scenarios, forecast keep-versus-move value, or a fraction of
recent fees as proof of profit. Swap principal is inventory conversion, not an
expense; count fee/shortfall once. Keep actual costs, conservative gas bounds,
and unavailable measurements distinguishable. A reserve is not already-spent gas.

Risk-triggered exit bypasses the ordinary five-minute wait, confirmations,
recenter-count limit, and discretionary spending allowance. It still requires
valid execution, canonical custody, bounded slippage, and its dedicated reserve.
If a safe exit is unavailable, persist the exposed halted state and reason;
never claim the campaign is closed or loosen execution bounds silently.

### 5. Confirm, execute, and recover

Require the same frozen range and swap direction to remain feasible on two
consecutive eligible observations. At the first, freeze exact raw input,
deployment bounds, output/liquidity minima, costs, provenance, and expiry. At the
second, revalidate that exact proposal; if it must change, start confirmation
again. Duplicate observations are not confirmations. No gas is paid to reject.

Use the real controller's staged lifecycle: required approvals, withdrawal and
collection for an existing NFT, optional swap, mint, and required cleanup. Let
canonical receipts govern transitions; research delay constants are not live
execution proof. Recheck admission before the first irreversible stage and the
remaining action's feasibility/reserve before each subsequent submission.

Returning inside before withdrawal cancels the ordinary recenter. After a stage
changes custody, resume from recorded balances and completed receipts. No second
swap after a completed swap. Mint failure may recover only the missing mint or
enter the guarded exit path. Finishing withdrawal must clear retired NFT liquidity
and reconcile actual Collect transfers, owed tokens, fees, and residual inventory.

Persist transaction intent and signed hash before broadcast. One pending nonce;
ambiguous broadcasts recover by hash. Repeated successful OR reverted receipts
are idempotent, including gas accounting. Fix the existing hybrid helper's
duplicate-reverted-receipt defect if reusing it; do not import that defect into
the live path. Receipt canonicality must be checked before marking any stage done.

After mint, clear the previous exit timer. There is no post-move cooldown. A
subsequent exit starts its own five-minute interval. Bounded spending and risk
limits control persistent churn. Policy changes require a new immutable campaign
configuration; they cannot silently reset incurred costs or pending custody.

## Implementation phases and acceptance

### Phase 0 — preserve state and freeze the contract

- [ ] Inventory dirty files, current service/release references, existing campaign
  state, and retained evidence. Runtime/custody claims require fresh reads.
- [ ] Record baseline checks and known failures. The last check in this conversation
  passed 629 tests; that is a dated baseline, not permission to skip validation.
- [ ] Freeze the RangeKeeper schema, state machine, accounting units, and explicit
  differences from the old forecast policy. Add a new policy discriminator.
- [ ] Record the selected initial pool profile and proposed limits, with provenance.

Acceptance: no unresolved algorithm semantics, implicit costs, default live
addresses, or inherited adaptive promotion gates.

### Phase 1 — asset-agnostic planner and configuration

- [ ] Implement a pure decision module under `src/strategy/rangekeeper/` (or the
  existing equivalent boundary), shared by dry-run and live callers.
- [ ] Implement generic market identity, fixed-range construction, inventory-only
  mint sizing, bounded minimum-swap solving, five-minute persistence, confirmation,
  cost admission, and priority safety decisions. No forecast imports in decisions.
- [ ] Add broadcast-disabled example configuration and reason-coded decision
  output with exact amounts, source, remaining budgets, and timer state.
- [ ] Version the new configuration and persisted state. Preserve old policy
  loading explicitly; do not reinterpret a legacy state as RangeKeeper.

Acceptance: identical immutable input frames produce identical decisions across
token ordering and decimals; no symbol-specific path changes behavior.

### Phase 2 — real execution, accounting, and recovery

- [ ] Extract or add a generic live adapter using the existing journal/signer/
  store/receipt infrastructure. Address the hardcoded identities in every live
  surface listed above, including allowance pairs and native-gas valuation.
- [ ] Reconcile token0/token1, base/quote, native gas, NFTs, and receipt deltas by
  verified addresses. Decode real token transfer and core pool collection events.
- [ ] Add RangeKeeper controller transitions and persisted budgets/timers. Lock
  per wallet/campaign so two workers cannot issue the same economic action.
- [ ] Implement bounded restart, failed-stage recovery, guarded stop/unwind, and
  closed-state proof. Repair reused duplicate-receipt accounting before launch.
- [ ] Emit independently valued net P&L, gross fees by token, gas, swap shortfall,
  exposure, drawdown, active/outside time, and every action/rejection reason.

Acceptance: the actual signing and reconciliation path is generic, with no
unexplained inventory changes or repeated completed action after any tested crash.

### Phase 3 — mechanical validation, with no old-strategy benchmark

- [ ] Test two verified asset profiles plus synthetic reversed token order,
  different decimals (including equal decimals), fee tiers/tick spacings,
  negative ticks, exact boundaries, and one-sided/idle inventory.
- [ ] Test five-minute expiry, brief returns, repeated rejected checks, restart,
  reorg/gap timer invalidation, two confirmations, and no in-range recentering.
- [ ] Test exact/minimal feasible swaps, maximum input, price-impact-induced range
  departure, deployment floors, cap rounding, and total inventory conservation.
- [ ] Test per-action/rolling/campaign cost reservations, duplicate/reverted gas,
  missing reference/gas prices, native exit reserve, losses, and safety priority.
- [ ] Test crashes before/after broadcast, receipt timeout, partial collection,
  failed mint after swap, repeated receipts, nonce conflicts, and custody-safe stop.
- [ ] Run bounded historical fixtures for accounting and state transitions only.
  Do not produce an old-versus-new performance study or search for winning widths.
- [ ] On a pinned fork, exercise the exact intended pool, size, wallet calldata,
  allowances, initial entry, recenter, recovery, and full exit/cleanup. Force error
  cases on the fork, not by intentionally wasting real-money transactions.
- [ ] Run `npm run check`, relevant database/controller integration checks, and
  release build/verification. Exercise the sealed release's actual CLI/config/state
  path in a bounded no-broadcast rehearsal; assertions in an isolated helper alone
  are insufficient.

Acceptance: accounting identities, recovery, and admission checks pass; production
calldata simulates at the intended size. A short rehearsal proves operation, not
profitability. No arbitrary multiweek paper wait is required for this v1 canary.

### Phase 4 — concrete live package and cost probes

- [ ] Produce a sealed release, private runtime-config template, new isolated
  state identity, service definition, exact preflight/start/status/stop/recovery
  commands, and one proposed activation record.
- [ ] The activation record names strategy/version, chain/pool/tokens, wallet,
  signer reference, release/config hashes, capital/native funding allocation,
  width/deployment/cost/risk limits, start window, bounded initial duration,
  maximum actions, cost-probe scope, and stop postconditions. Keep secrets out.
- [ ] Reuse applicable canonical cost receipts only after verifying exact pool,
  size, token order, spender, and execution-path relevance. Separate measured,
  fork-estimated, borrowed, and unavailable costs; old stage splits are not proof.
- [ ] Where exact live cost evidence is missing, prepare a bounded cost-probe
  lifecycle inside the same total capital cap. Fork rehearsal and hard native-gas
  bounds admit the probe; canonical probe receipts then supply measurements.
  This explicitly avoids requiring receipts from a never-before-run path before
  its first measurement. A probe is a funded action requiring the launch scope.
- [ ] Finish all reversible preparation before presenting any still-missing
  authorization. One concrete approval may cover the named probes and automatic
  progression to the bounded canary only if their predeclared gates pass.

Acceptance: the funded procedure is reviewable and runnable. Missing measurements
lead to named bounded probes, not invented cost values or an indefinite research
project. Probe failure blocks automatic progression and preserves custody.

### Phase 5 — authorized bounded launch and handoff

- [ ] With matching authorization, verify fresh balances, native reserve,
  allowances, contract identities, nonce, source/reference gates, and no existing
  unresolved custody. Do not adopt another campaign's NFT or state implicitly.
- [ ] Fund only the authorized remaining allocation, execute required probes,
  reconcile their receipts and expenses, then activate the fixed RangeKeeper
  configuration if measured costs fit the predeclared bounds.
- [ ] Observe the first real entry and all pending-stage outcomes through canonical
  reconciliation. Do not report success merely because systemd is running.
- [ ] Demonstrate at least one bounded real exit/cleanup through the probe or
  canary, record actual custody postconditions, and follow the activation record's
  explicit running-versus-closed endpoint. Any later entry is included in its cap.
- [ ] Enforce the named duration/action/cost/loss bounds, defaulting to guarded
  unwind at expiry. Continuous unattended operation beyond that bounded scope
  requires its own explicit continuation scope, not an implicit unlimited retry.
- [ ] Hand off exact release/config/state identities, receipt hashes, reconciled
  funds/costs, observed behavior, remaining budget, current exposure and allowances,
  stop commands, and any unresolved facts.

Acceptance: either the authorized bounded real-money campaign runs with reconciled
custody and an explicit endpoint, or a concrete failed gate is reported with its
custody state. No universal-profit claim or silent capital increase.

## Deliverables and repository hygiene

- RangeKeeper v1.0.0 pure planner, generic live adapter, versioned configuration
  and persisted state, exact decision records, and recovery tests.
- Operator algorithm/runbook and a factual readiness report with cost evidence.
- Verified sealed release and concrete activation/probe/canary record.
- Funded execution receipts and current custody/accounting handoff once authorized.

Commit narrow logical changes. Preserve current dirty work and all frozen study
outputs. Existing historical code/config hashes may use explicit original Git
pins through `scripts/maintenance/validate-research-manifests.mjs`; never rewrite
old outcome hashes to pretend they were generated by the new strategy. Update
registries and manifests deliberately when their maintained inputs change.
Do not modify memory files, unrelated campaigns, or production runtime state as
part of documentation/implementation preparation.

## Ready-to-paste instruction for Sol

> Implement `docs/plans/rangekeeper-v1.0.0-sol-2026-09-21.md` in `/root/conc-liq`.
> Build RangeKeeper v1.0.0 as an asset-agnostic, fixed-width, exit-only LP policy
> with a five-minute exit wait, minimum necessary optional swaps, and explicit
> cost/inventory limits. Remove forecast dependence from this policy. Preserve
> the current dirty work and existing campaigns. Do not benchmark against the
> current algorithm or require the old adaptive paper evaluation period. Complete
> the generic real-execution path, accounting/recovery tests, exact-pool fork
> rehearsal, sealed release, and concrete bounded launch package. The objective
> is real-money operation within the 250 total cap. Complete all preparation
> before requesting any missing authorization for the named wallet/pool/probes;
> if that exact scope is already authorized, proceed within it. Reconcile every
> funded action, preserve the exit reserve, and finish with an auditable runtime
> and custody handoff.
