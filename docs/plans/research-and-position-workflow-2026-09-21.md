# Research and position management workflow

Date: 2026-09-21. Status: accepted direction, superseded for implementation by
[the Sol implementation plan](research-and-positions-sol-2026-09-21.md).

User scope amendment: support **static/manual and RangeKeeper only**, in paper
and live. Legacy evaluations and adaptive-width strategies are outside the new
product. Preserve historical evidence and custody without building compatibility
features for retired strategies. The linked implementation plan is authoritative.

## Recommendation

Build this workflow incrementally. It makes the existing research and execution
work usable as one product: compare opportunities, prepare a deployment, manage
it, and use its measured outcome to inform the next allocation. The largest
missing capability is a common campaign lifecycle behind the dashboard.

The objective should be net profit on allocated capital under explicit risk and
cost limits. Show absolute net P&L and performance against matched passive
inventory separately, so market appreciation is distinguishable from value
added by LP management. Positive historical alpha is not a universal activation
gate: RangeKeeper has its own agreed operating and admission rules. Research
rankings must not silently add a forecast gate to that strategy.

## Reviewed implementation

Source baseline: `b38c839`. Existing unrelated working-tree changes were present
in adaptive/hybrid research and were preserved. This is a source and runbook
review, not a fresh audit of running services, wallet custody, or deployed builds.

| Area | Existing foundation | Gap for this workflow |
| --- | --- | --- |
| Research | `src/dashboard/research.ts`, `dashboard/research.js`: pool flow, LP fees after protocol cut, liquidity depth, share, range occupancy proxy, six reference widths; 1h/6h/24h/7d | 15m selection, arbitrary capital/range, reliable marginal economics, explicit coverage and persistent pool universe |
| Pool universe | Latest strategy checkpoints in the last six hours supply research identities | A known pool without a recent checkpoint can disappear; registry-backed listing should retain it with stale/unavailable status |
| Economics | Fixed 1,000 USDG reference; bucket-based no-rebalance fee model | `modeledNetQuote` is modeled fees less mint/exit medians across valid cost rows, without pool/size/age scoping; it is not full net P&L or independent-reference alpha |
| Positions | Shared current/history UI, charts, activity and strategy dialogs for legacy paper/live, adaptive paper and RangeKeeper | Viewing is unified; lifecycle control is not. Some status labels conflate out-of-range with a pending recenter |
| Dashboard API | `src/dashboard/server.ts` accepts GET/HEAD only; repository connections are read-only | Authenticated commands, durable operation records, progress and recovery views |
| Paper | Legacy start/tick/stop; adaptive start/tick/watch/status/runtime migration | Adaptive runner has no general close command or per-deployment registry; strategy/mode parity needs explicit work |
| Live | RangeKeeper has generic verified pool profiles, planner, staged execution, durable intents, receipts, preflight, stop and recovery | CLI/config/service oriented; immutable campaign identity and constrained migration; no general active-position width edit |
| Multiple deployments | Both live stores enforce unique operator per campaign table and use wallet locks | Fresh repeat campaigns and concurrent allocations need lifecycle/storage work; shared-wallet allocation is a separate extension |
| Portability | RangeKeeper profiles carry token addresses/order/decimals, chain and venue identity | Legacy paper/research still assume USDG; legacy live assumes NVDA, and wallet lock namespaces still embed chain 4663 |

Research currently reads seven days of events and caches the result for five
minutes by default. Before adding interactive parameter sweeps, separate reusable
pool statistics from candidate computations and introduce incremental aggregates.
Define exact trailing-window boundaries: selecting 15m should not silently mean
the latest partial clock-aligned bucket. Coverage and freshness are distinct.

The newer RangeKeeper source is the preferred first live integration. Its plan
file still says ready for implementation, whereas source and operational runbooks
show subsequent implementation and revisions; source takes precedence here.

## User workflow

### 1. Research: choose a candidate for the next allocation

List every registered pool, with discovery/verification/indexing state, latest
source time, and supported paper/live capabilities. Default to verified pools,
but keep inactive, stale and unsupported pools discoverable. Discovery freshness
must be visible; registered pools are not necessarily every pool on the chain.

Provide 15m, 1h, 6h, 24h and 7d windows. Keep a small comparison table and put
deeper evidence in a selected-pool view:

- Volume, swaps, LP fees after protocol cut, active liquidity and depth by price.
- Recent versus longer-window activity, realized price variation, large moves,
  and market-session/weekend breakdowns where relevant to the asset.
- User-capital share of active liquidity, dilution, likely range occupancy and
  capital capacity; total TVL alone does not describe fee competition.
- Pool/reference deviation, reference availability, event completeness and
  observed duration. Missing data is unavailable, never zero activity.
- Optional advanced diagnostics: buy/sell imbalance, concentration of flow and
  liquidity providers, and post-swap reference price movement where covered.

A candidate panel takes capital, starting inventory, width and strategy. It
shows actual rounded price bounds, full width, token requirements, remaining
cash, gas/exit reserves, and pool-specific cost evidence. Recalculate liquidity
share at each size rather than scaling a 1,000 USDG result linearly.

Separate three questions: what the pool earned, what this candidate would have
earned over covered history, and what a forward scenario assumes. A detailed
candidate replay should include inventory changes, costs and matched passive
hold; the existing bucket approximation remains a screening tool. Show base and
stress scenarios and break-even fees when inputs support them. A past-flow
break-even estimate is not a promised holding time or strategy admission rule.

Include retaining cash or current holdings as a candidate. Compare allocations
over the same horizon, with explicit missing evidence. Offer transparent sorting
by net scenario result, costs, risk and evidence quality before attempting an
automatic best-pool score. A seven-day screen alone cannot establish a durable
advantage, and protected research holdouts must remain outside strategy tuning.

Selecting a candidate creates a saved deployment draft carrying the pool,
strategy/version, parameters and research snapshot into Positions.

### 2. Positions: create and manage a deployment

One creation flow selects paper/live, verified pool, capital or existing token
inventory, wallet, strategy and limits. Provide an exact preview followed by
one deliberate live authorization. A long-running worker executes the accepted
operation and reports progress independently of the browser connection.

Every deployment has a stable campaign ID across replacement NFTs, a versioned
configuration, a capital ledger, a cost ledger and a visible operation history.
Closing and reopening must preserve history without overwriting prior campaigns.
One allocation can own successive NFTs; an NFT is not the campaign identity.

Show portfolio allocated/available capital, reserves and aggregate asset exposure,
then per-campaign NAV, net P&L, passive comparison, fees, paid costs, estimated
exit costs, inventory, range, time outside, and management decisions. Paper and
live use the same layout, with modeled and measured evidence clearly identified.

Actions should have distinct meanings:

- Pause discretionary management while monitoring, reconciliation and configured
  safety behavior continue. Pausing does not remove exposure.
- Close liquidity and retain the withdrawn tokens, when supported.
- Close and convert to the selected quote asset, showing conversion costs.
- Change width or strategy through a previewed, versioned transition preserving
  inventory, cumulative costs, benchmark and history. V3 bounds require replacing
  liquidity; a width edit is an economic operation, not an in-place NFT edit.
- Clone as paper or create a linked live deployment from paper parameters;
  live always gets a fresh preflight and a distinct performance record.

Show range state separately from operation state: outside/waiting, proposal
rejected, submitting, transaction pending, confirming, reconciling and blocked.
Display the actual reason, stage age and permissible next action. A halt must
retain custody visibility. Exit completion requires reconciled postconditions.

### 3. Strategies: small versioned catalog

Start with static/manual range and RangeKeeper as the intended supported choices.
Static/manual still needs a lifecycle wrapper. RangeKeeper has the best existing
live foundation; its paper adapter must be implemented and validated before
claiming parity. Following the accepted scope amendment, adaptive strategies and
legacy evaluations are excluded from the new catalog and runtime.

Each strategy declares supported modes/markets, parameter schema, defaults,
mandatory limits, behavior outside the range, permitted operations, required
data, and evidence maturity. Use the same decision kernel for new paper/live
implementations with distinct execution adapters. Bind every campaign to a
version; publishing a new strategy does not modify running campaigns.

## Architecture and operational simplification

Keep the existing TypeScript/PostgreSQL modular monolith. Add a narrow application
layer between the UI and engines:

`Research / Positions -> deployment commands -> persistent operations -> workers -> ledgers -> dashboard`

Reuse exact V3 math, verified pool profiles, risk/reference checks, transaction
journals and receipt recovery. Adapt existing campaign readers; avoid a wholesale
rewrite or automatic migration of active custody.

The new command boundary needs authentication, request-origin/CSRF protection,
authorization, duplicate-request protection and stale-preview rejection. An
accepted preview is bound to campaign revision and limits; workers revalidate
current execution inputs. Signer access stays in the execution worker, with
approved contract and budget limits enforced there as well.

Separate installing software from creating positions. A reviewed sealed release
supports many persisted configurations through workers/supervision; ordinary
position creation should not need a code edit, rebuild or handcrafted service.
Reuse still-valid contract/profile checks with explicit invalidation rules, while
quotes, balances, nonces and execution admission remain fresh. Preserve release,
schema and state compatibility checks.

For the first live version, use one active campaign per wallet and reserve its
capital. Permit sequential campaigns with retained history. Several simultaneous
campaigns in one wallet require explicit allocation, nonce coordination and
cross-campaign accounting and should follow later. Verify exclusivity across
legacy and new engines, not merely within each campaign table.

This removes avoidable preparation and coordination work. Chain inclusion,
required source confirmations and genuine admission failures still take time.
Measure preparation, queue, quote, signing, inclusion and reconciliation latency
separately so subsequent optimization addresses the actual bottleneck.

## Delivery and effort

Planning estimates for one experienced engineer familiar with this repository,
working predominantly on this scope. These are engineering days, include tests
and integration, and are not commitments. Existing execution edge cases and
campaign migration are the principal uncertainties.

| Increment | Deliverable and completion condition | Effort |
| --- | --- | --- |
| 1. Lifecycle foundation | Stable campaign/operation contracts, strategy capabilities, explicit states and capital ownership; existing views preserved | 3–5 days |
| 2. Paper vertical slice | Research draft -> configurable paper deployment -> visible operation history -> close, with persisted restart and duplicate-request behavior; initial supported strategy adapter | 6–9 days |
| 3. Research decision support | Requested windows, registry-backed pool list, arbitrary capital/width, aggregates, coverage, scoped costs and bounded candidate replay | 5–8 days |
| 4. First live workflow | RangeKeeper open/stop through authenticated UI, fresh preview, durable commands, receipt progress, recovery and sequential campaign history | 7–12 days |
| 5. Complete management | Versioned width/strategy changes, retain-inventory exit, pause semantics, portfolio exposure, alerts and parity for the chosen supported strategies | 7–12 days |

Total: approximately 28–46 engineering days, budgeted as **6–10 working weeks**.
A useful paper workflow is roughly **2–3 weeks**; the first constrained live
workflow roughly **4–7 weeks**, depending on research scope and execution defects.
These figures exclude prolonged forward strategy evaluation, new chains/DEXs,
arbitrary token support and concurrent campaigns sharing a wallet.

Keep adapters for market identity, reference policy, execution and accounting
explicit now. Estimate a second chain or protocol separately after selecting it;
generic profiles alone do not make deployment portable.

Prioritize the paper vertical slice and live open/close usability over a broad
strategy marketplace or automatic capital rotation. Thereafter add data/range/
cost alerts and a fair paper-versus-live comparison using the same specification.

## Verification and acceptance

Review baseline: 35 existing tests passed across `dashboard.test.ts`,
`dashboard-research.test.ts`, and `dashboard-positions.test.ts`. This validates
the existing covered behavior, not the proposed lifecycle or production readiness.

Implementation gates should include window-boundary and missing-data checks,
capital/rounding correctness, common paper/live decision fixtures, authorization,
duplicate commands, concurrent wallet requests, restart after signing, failed
mint after successful swap, width-transition failure, and complete close
reconciliation. Every supported deployment must appear in the common list,
charts, costs and history from its first action, including incomplete entry.

The first concrete milestone is: choose a covered pool and amount in Research,
save a strategy draft, open paper, inspect its decisions and costs, and close it
from Positions without editing files or restarting a service. The live milestone
adds bounded authorization and canonical execution/recovery to that same flow.
