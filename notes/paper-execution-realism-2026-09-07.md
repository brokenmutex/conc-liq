# Paper execution realism — September 7, 2026

Historical correction at 07:06 UTC. The subsequent [transaction simulation
implementation](paper-transaction-simulation-2026-09-07.md) supersedes the
missing-simulator status below; this note preserves the original audit.

The user requires paper performance to be as close as possible to the intended
real trades before using real wallets. The first paper runner did not meet
that requirement: it charged 1 USDG for entry, 1 USDG for exit, and a flat 10 bps
inventory haircut. It sized the LP from pool spot without buying the NVDA via
an executable route. Renaming these values "modeled costs" did not make them
transaction evidence.

## What the current data proves

The September 7 audit found 2,339 stored whole-transaction cost observations
across the tracked pools: 658 mint, 664 exit, 902 swap, 67 rebalance, 41 collect,
and 7 mixed transactions. The NVDA/USDG 0.05% pool has 971 observations with
matching indexed transaction/block hashes: 264 mint, 253 exit, 408 swap,
11 rebalance, 28 collect, and 7 mixed transactions. This is a collected sample,
not all chain activity or a guarantee of future costs.

NVDA mint transaction fees ranged from 86,429,068,992,000 to
7,241,905,289,192,000 wei; exits from 29,069,533,416,000 to
3,359,994,813,472,000 wei. These are actual whole-transaction charges, computed
as receipt gas used times effective gas price. Bundled actions, different
positions and different gas prices make the sample inappropriate as a flat
fee for a new order. The dashboard now reads these measurements directly,
with pool/stream/chain and indexed inclusion checks, counts, block ranges and
collection times. It keeps them in ETH instead of inventing a USDG price.

The existing September 5 cost model has a 2.966159 USDG entry P90, based on
three comparable mint observations plus approvals. Exit and rebalance costs
remain unavailable. That is dated calibration evidence, not the price of a
paper round trip or a current executable quote.

## Correction

New sessions require `executionBasis: transaction_simulation`. Fixed entry,
exit and slippage overrides are rejected. The current DB-only worker lacks
the required simulator and therefore records input readiness without opening
positions, debiting assumed charges or reporting P&L. This applies to guarded
and research modes. The dashboard calls out that missing capability.

The old policy format and accounting tests remain for reproducibility; their
spot fills and zero-impact fee estimates are illustrative only. The first
session had no position and no performance result at the audit boundary. At
07:06:07 UTC it was closed before entry, preserving its policy hash and all
107 observations. Session **2** started at **07:06:07.782 UTC** with the new
policy. The 15-second worker timer remains active; its heartbeat and the
dashboard were verified. No funded wallet or mainnet transaction was used.

## Next implementation, without another infrastructure detour

Extend `src/canary-rehearse.ts` and the existing unsigned canary-call builders:

1. Freeze an order and its amount/slippage constraints at decision time. At a
   later fresh state, simulate the actual USDG-to-NVDA swap, approvals and LP
   mint. Fund only the explicit starting paper balances on the owned local
   fork. Preserve calldata, amounts, source hash/time, allowances and return
   values. Failed calls must not become successful paper fills.
2. Estimate the intended transactions on the Robinhood node with the paper
   account state overrides, or combine locally measured execution with an
   independently verified parent-data estimate. Local Anvil receipt gas alone
   omits the parent-data component. Arbitrum's total estimate already includes
   that component: do not add it twice. See the official
   [Offchain Labs gas estimation example](https://github.com/OffchainLabs/arbitrum-tutorials/blob/master/packages/gas-estimation/scripts/exec.ts).
3. Keep ETH gas debits as an explicit ledger. A USDG conversion requires a
   timestamped, quality-checked ETH/USDG price. Quote the expected exit at entry
   for its reserve, then replace it with a fresh execution estimate at exit;
   apply only the difference in reserves so costs are not deducted twice.
4. Simulate decrease/collect and the return swap to USDG at exit. Inventory
   valued at spot is a mark, not liquidation proceeds. Swap quotes supply
   venue fee and impact; a configured slippage tolerance is not a cost to
   subtract again. Track order delay and failure/retry scenarios separately.
5. Compare the resulting estimates with comparable actual transaction
   receipts. Report which amounts are observed, simulated, or unavailable.
   A paper trade has no mainnet receipt, so its inclusion, gas and price remain
   estimates. Hypothetical LP fees also need honest treatment of liquidity
   dilution and the changed swap path; observed fee growth alone is not exact
   counterfactual income.

Run simulations only for prospective execution actions, using bounded current
state reads. HyperSync supplies historical events/receipts. This change does
not need an archival-node prerequisite or wallet signing/broadcasting.

Validation and activation evidence is stored alongside this note in
`paper-evidence-2026-09-07/`. This is a correction to the readiness milestone;
it does not claim that realistic paper trading is already implemented.

Validation passed: TypeScript checking and all **187** unit tests; isolated
PostgreSQL audits for session restart/journal/canonicality behavior and receipt
cost scope, inclusion, exact integer precision and duplicate-event handling;
and Playwright desktop/mobile checks of the live session, unavailable P&L and
costs, historical ETH fee table, reset behavior and absence of browser errors.
