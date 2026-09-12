# $250 live controller and recovery validation

The tested controller now supports a real NVDA/USDG pilot alongside the unchanged $5,000 paper campaign. At the final predeployment wallet check, **2026-09-12 14:19:14 UTC**, the operator held **299.927111 USDG, 0.004907 ETH, no NVDA or NFTs, and latest/pending nonce 0**. No real transaction had yet been submitted at that checkpoint. Deployment and first live receipts are recorded separately below when completed.

## Execution and accounting

- Initial allocation 250 USDG; freeze the remaining **49.927111 USDG** as a reserve outside the strategy. Later management spends only carried strategy inventory. No replenishment from the reserve.
- Preserve the agreed 24/7, ±20 raw tick range, full allocation, outside-range recentering, net-only swaps, no inventory cap, ±5% reference band and 30-block holding tolerance. Keep five-minute entry recovery, 64-block quorum confirmation, 50 bps transaction limits and ten-minute automatic re-entry cooldown.
- `src/live-pilot/controller.ts` and `store.ts` implement the production ledger in the separate `live_pilot_v1` PostgreSQL schema. The earlier `PilotJournal` remains a preparation prototype; its signature verifier is reused, but its tables are not the runtime ledger.
- A wallet advisory lock and one-pending-action index prevent competing workers. Persist the intent before signing, and the exact signed bytes/hash before sending. A restart cancels only an unsigned preparation. A signed transaction retains its nonce until its canonical receipt is reconciled; an RPC acknowledgement is not completion.
- Semantic authorization checks contracts, tokens, spenders, recipients, inventory, range, minimum amounts, deadlines and gas. Current wallet, pending nonce, reference band, range and simulated call are checked again before submission.
- Every receipt must agree with the actual wallet balance changes, nonce, native gas, allowances, NFT ownership, range and liquidity. Decrease plus collect is atomic. Collected fee income is collection minus withdrawn principal. Retired NFTs keep zero liquidity and owed tokens; a mint's NFT ID comes from its receipt.
- Actual native gas is `gasUsed * effectiveGasPrice`, converted using ETH/USDG oracles at that receipt's block. The full Nitro gas charge is counted once. Missing conversion remains unavailable. Holdings are marked from wallet tokens, NFT principal and simulated collection of actual accrued fees. No paper dilution adjustment is applied to real liquidity. Value after paid gas excludes future exit costs.
- Position marks retain source time/block, range, balances, fees, gas and the US market-session classification. Raw marks preserve gaps and boundaries for later analysis; no interpolated boundary profit is presented.

## Failure behavior

A receipt timeout does not permit a new nonce or a second swap. Lost acknowledgements recover from the stored hash. Receipts beyond confirmed quorum depth wait; a mismatched receipt block hash waits. Accepted-state reorgs, unexplained wallet/NFT changes and a reverted transaction halt management.

`recover-exit` accepts only a fully reconciled reverted receipt with unchanged canonical custody and no pending transaction. It resumes withdrawal/sale/allowance cleanup with further entries stopped. It cannot clear an ambiguous signed transaction, unexplained deposit/transfer or reorg. Automatic fee replacement and same-nonce cancellation are not implemented; an expired signed transaction that has no proven receipt remains blocked for explicit reconciliation. Never delete that journal row or advance the nonce to bypass it.

Stale checkpoint/risk data prevents adding exposure, while its holding pause is recorded and can become an exit intent. Chain outages retain the incident clock even when RPC is unavailable; recovery does not erase an elapsed pause. An exit still needs readable, quorum-verified chain state. A minimum native recovery reserve prevents a new management action from using the last available gas.

## Validation evidence

**65 focused unit tests pass**, plus TypeScript checking. Tests include authorization bounds, signature fields, receipt reconciliation, reserve protection, false NFT ownership, wrong nonce/hash, native/token balance discrepancies, reverted gas, and the established holding policy.

The signed-controller owned-fork integration uses a random temporary test key, an independent disposable database schema, and a read-only upstream proxy. It never signs or broadcasts a real-wallet transaction. Counterparty balances are synthetic and exist only on the owned fork; pool movements are executed through the real router to cross the actual test position.

- `data/live-pilot-controller-final-2026-09-12.json`: **21 confirmed transactions**, entry, two opposite-direction recenters and complete exit; three owned NFTs; both fee tokens collected. Stops before signing, after signed persistence, after broadcast and before receipt commit recover without a repeated economic action. Lost acknowledgement, delayed confirmation, mismatched receipt hash, concurrent-worker exclusion and an unrelated wallet change are covered.
- `data/live-pilot-controller-revert-2026-09-12.json`: a router fault injected after successful preflight produces a real reverted fork receipt. The controller charges gas, halts, refuses ordinary resume, then performs explicit exit recovery and allowance cleanup. Two successful transactions and one reverted transaction; all nonces and native fees reconcile.
- `test/fixtures/live-pilot-reconciliation.json`: selected public test-account receipts and snapshots from the first successful recenter regression. These are fork evidence, not real pilot returns.
- At 14:19:14 UTC, the live gas valuer passed both feed policies at block 61,171,534: 0.0001 ETH valued to 0.254229 USDG. This is a conversion check, not a gas cost or profit forecast.

Reproduce with a new output filename:

```bash
.tools/node/bin/node --import tsx --test --test-isolation=none test/live-pilot*.test.ts test/paper-execution.test.ts test/paper-holding.test.ts
.tools/node/bin/node --import tsx test/integration/live-pilot-controller.mjs data/runtime-refactor.env data/pilot-recenter-new.json
.tools/node/bin/node --import tsx test/integration/live-pilot-controller.mjs data/runtime-refactor.env data/pilot-revert-new.json revert
```

## Operations

The checked-in pilot configuration remains broadcast-disabled for preparation. An active private configuration uses the same strategy with `broadcastEnabled: true`, the public operator address and an absolute `.env` signer reference. The key is read locally from the mode-600 file and is never included in configuration, ledger rows, process environment, status exports or fork subprocesses.

The CLI is `src/live-pilot.ts` (development wrapper `scripts/live-pilot.mjs`): `init`, `tick`, `run`, `status`, `exit`, `resume`, `stop`, `recover-exit`, followed by the private runtime env and pilot configuration paths. `exit` and `stop` unwind and disable re-entry; `resume` respects the ten-minute closed-position cooldown. Stopping systemd alone stops the worker and leaves custody as recorded; use the exit command to unwind.

Production uses a sealed release and a separate `conc-liq-live-pilot.service`. The read-only dashboard consumes the sanitized `PILOT_STATUS_PATH` export through `/api/live-pilot`; it has no transaction controls. The paper runtime and frozen research timers retain their existing releases/configuration.
