# Live NVDA recenter mint halt — 13 September 2026

The live campaign `f8affe19-4d89-4132-b214-d67e5ad81331` halted at 09:18:58 UTC after the replacement mint reverted in block 61,844,790 (09:18:47 UTC). The actual call trace returns `Price slippage check` from the position manager. Transaction: `0xfe134e80f1d4e3645cc5343a6e5618231278dda076b95b3e7bf51d7c35e9f778`, nonce 99, action `46368c11-2fd4-4df6-b035-199dbdf89496`.

The preceding withdrawal, required swap and approvals all confirmed. The mint was prepared from block 61,844,699 at 09:18:38 UTC, tick 222562, for range [222540, 222580). At execution the pool was at tick 222565. The pool mint call inside the reverted transaction would have consumed 81.237381 USDG and 0.655719589933083303 NVDA. The position manager required at least 104.411675 USDG and 0.652440991983417901 NVDA. The USDG minimum failed. All nested token movements rolled back.

This is sensitivity of per-token mint minimums within a narrow range: about 0.0244% movement in the USDG-per-NVDA price changed the usable token ratio substantially. The current minimum is 99.5% of each token's amount calculated at the preparation state. The ±5% independent reference guard is a separate check and passed; this halt was not caused by inventory limits or the 30-block holding tolerance.

The receipt and wallet/NFT continuity reconciled. The reverted mint cost 0.00001826808732 ETH, valued at 0.045473 USDG using its receipt-block oracle evidence. The wallet retained 155.843795 USDG (including the 49.927111 reserve) and 0.655719589933083357 NVDA. There is no active LP position. The worker remains running but intentionally refuses new transactions after a reverted action. Automatic re-entry applies to completed sessions, not hard transaction halts.

Evidence is saved in `data/live-halt-2026-09-13-0918-actions.json` and `data/live-halt-2026-09-13-0918-trace.json`. Read-only diagnosis only; no recovery transaction or runtime change was made. AAPL and GOOGL paper campaigns remain open.

## Implemented recovery

The controller now retries only a canonically reconciled mint whose actual trace proves the position manager's own `Price slippage check` after one successful pool mint. The trace must match the saved sender, destination and calldata, contain no nested revert, and show at least one token amount below its signed minimum. Other errors and unavailable traces remain halted.

Recovery requires running intent, the same policy, no pending action, a confirmed canonical receipt, exact receipt/custody reconciliation, unchanged current wallet/allowances/NFT count and pending nonce, current contract identity, healthy admission, and the ±5% reference band. It then reprices the mint using the retained balances and checks the existing gas recovery reserve. Neither historical gas nor capital is reset or charged twice.

The completed swap remains completed. If the old range has been crossed, the retry selects a new ±20-tick range and uses the retained inventory without another swap; any unused amounts remain in the wallet. A separate authorization check rejects a recovery swap except during a requested/risk-driven exit. Successful mint reconciliation clears recovery state. There are at most three replacement mint attempts per management operation; a fourth recovery remains halted. Ordinary fresh entry after a completed cash exit also clears this state.

The existing 0.5% per-token minimum amounts are retained and recomputed at each new quote. This repair does not claim those minimums are an optimal execution-price tolerance. A mint can still revert during movement, but this specific verified failure now has bounded recovery. Every replacement uses normal preparation, preflight, signature, journal and receipt processing with a new nonce only after the failed nonce is consumed. It never replaces an unresolved transaction.

Recovery runs automatically from the hard-halt check. `recover-mint ENV CONFIG` provides the same verified state transition explicitly without sending a transaction; the regular worker performs the new mint. A `mint_recovery` ledger record contains the original action/hash, trace hash, failed amounts/minimums, retry count, current inventory and freshly checked plan. Source code: `src/live-pilot/mint-recovery.ts` and `PilotController.recoverMintLocked`.

## Validation

66 focused controller, native-credit and mint-recovery tests pass, including the actual incident trace and receipt snapshots. Tests reject wrong contract errors, nested failures, mismatched calldata/identity, pending actions, reorgs, changed custody/allowances/nonce, policy drift, unavailable admission and the retry cap. They verify no duplicate swap and no reset or duplicate charge of historical costs.

The owned-fork controller test (`test/integration/live-pilot-controller.mjs ... mint-retry`) executes entry, two recenter directions and exit. A real counterparty swap moves the pool three ticks after mint preflight, causing the actual position manager to revert. Automatic recovery reprices the mint, creates the replacement position without another swap, and completes subsequent management and exit. All consumed nonces are unique, the reserve is preserved, and final native balance reconciles exactly to paid gas. Evidence: `data/live-mint-recovery-fork-2026-09-13.json`. No mainnet transactions are sent by this test.
