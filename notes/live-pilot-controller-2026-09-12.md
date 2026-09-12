# $250 live controller and recovery validation

The live controller is deployed and enabled alongside the unchanged $5,000 paper campaign. A complete real LP lifecycle has passed; current results and continuation are recorded at the end of this runbook. At the final predeployment wallet check, **2026-09-12 14:19:14 UTC**, the operator held **299.927111 USDG, 0.004907 ETH, no NVDA or NFTs, and latest/pending nonce 0**. No real transaction had yet been submitted at that checkpoint. Deployment and first live receipts are recorded separately below when completed.

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

**68 focused unit tests pass**, plus TypeScript checking. Tests include authorization bounds, signature fields, receipt reconciliation, reserve protection, false NFT ownership, wrong nonce/hash, native/token balance discrepancies, reverted gas, and the established holding policy.

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

## Publishing RPC correction

The initial signed approval at nonce 0 was rejected by the private RPC with **`publishing transactions not supported by this endpoint`**. The controller retained its hash and did not advance to a swap. Mainnet custody and nonce remained unchanged during diagnosis.

Publishing now uses a separately configured `PILOT_BROADCAST_RPC_URL`, set to `https://rpc.mainnet.chain.robinhood.com`; archive reads, risk checks and canonical receipt reconciliation continue through the private RPC. The publishing client must independently match chain 4663 and the intent's source block hash. This endpoint is listed in [Robinhood's network documentation](https://docs.robinhood.com/chain/connecting/). An empty, invalid byte-string probe verified transaction publication support without creating a transaction. Public endpoints are rate-limited; this pilot sends one transaction at a time.

The explicit `retry-approval` operation revalidates fresh admission, unexposed entry custody, nonce, signed envelope, whitelist, amounts, current simulation and native affordability before resending the **identical signed approval**. It cannot replace or re-date a swap, mint or withdrawal. The fork regression `data/live-pilot-controller-publisher-retry-2026-09-12.json` passed rejected-publisher recovery at the same hash/nonce, followed by entry and complete exit: nine confirmed transactions. Ten additional dashboard/release tests pass.

## First real attempt and corrected exposure clock

The publishing retry succeeded at **14:45:38 UTC**, using the original approval hash and nonce 0. Its one-time bootstrap timer stopped itself and started the live worker. The public RPC independently confirms all five receipts in [the first recovery evidence](live-pilot-first-recovery-2026-09-12.json).

The initial swap bought 0.432011537030058711 raw NVDA for 94.805546 USDG. Before minting, the holding guard incorrectly anchored its initial health history to campaign creation at 14:24, including time spent waiting in cash for publishing and gas conditions. It latched a historical chain-pause expiry. The controller then sold back to USDG and revoked the remaining allowance; it did not mint an NFT.

The unwind finished at **14:47:34 UTC** with **249.908479 USDG managed cash**, the unchanged **49.927111 USDG reserve**, zero NVDA and zero allowances. All five transactions succeeded. The cash shortfall was **0.091521 USDG** and actual gas converted at receipt-block prices was **0.116834 USDG**: **0.208355 USDG total cost**. Cash shortfall includes swap fees and intervening price movement; it is not entirely gas or pure slippage.

The corrected guard starts its initial holding history at the receipt that actually acquired inventory. Waiting cash has no holding clock. The regression test includes a long pre-entry history gap and a later real 60-second outage: the old gap is ignored, but the real post-entry outage still latches its exit. The 30-block tolerance and pause limits are unchanged.

Live service release: `13906048c5ec6d01949f5427dbb9f612ee9140f8f4c2b152f53302926a8557cf`, source `532568dc989e6497ee92b3f4307b1ff4fc397a7b`. Dashboard release: `ea9fac3500f21e18840a18f09aad982c9780f5252fa5983f86c9eb37e62c31fb`, source `c93f805f2a3f65d80682c0c433cbba02c75e7859`. Paper service remains on release `61717c21ee5f915dbf6e2c0876875c54d77c97c9ede98507af4c23dbe5496d83`, session 59. All deployed unit files, release manifests and the previous dashboard unit are retained in `data/live-pilot-deployment-2026-09-12/`.

The corrected live worker was resumed with its existing capital and ten-minute cooldown; earliest new entry is **14:57:34 UTC**, subject to admission. The subsequent full LP validation is recorded below. The five-transaction recovery above verifies swapping, allowances, receipts and gas; it did not itself include liquidity provision.

## Completed real LP lifecycle and continuous continuation

[Completed validation evidence](live-pilot-completed-validation-2026-09-12.json) independently matches all ten LP-cycle receipts to the public RPC. [The first position snapshot](live-pilot-first-mint-2026-09-12.json) independently verifies ownership and liquidity of **NFT 1145652**, range **222390–222430** (the agreed ±20 raw ticks around the aligned center).

At 15:00:54 UTC the position held **249.762129 USDG of principal**, **0.069008 USDG of idle inventory**, and **0.000504 USDG of uncollected fees**, using the pool price for valuation. The protected 49.927111 USDG is excluded from these numbers. Its holding checks had no latched exit reason. The one-time operator validation then requested an exit; this was not a strategy timeout or inventory cap.

The withdrawal mined successfully at 15:01:31 UTC. A brief node incident triggered RPC recovery hysteresis before the receipt was committed; the worker retained the same hash and reconciled it at 15:03:46 UTC. It then sold the withdrawn NVDA and cleared both remaining allowances. There was no repeated withdrawal, swap or nonce. NFT 1145652 remains owned, with **zero liquidity and zero owed tokens**, independently verified through the public RPC.

The full LP cycle finished at **15:05:13 UTC** with ten successful transactions and no reverts. It collected **0.000443 USDG and 0.000002421964339439 raw NVDA** in fees. Its cash shortfall, including market movement and swap fees net of earned fees, was **0.150110 USDG**; actual receipt-valued gas was **0.548067 USDG**. The complete LP validation cost **0.698177 USDG**. The earlier fork estimate came from different prices and gas conditions and is not a constant execution cost.

Across both real attempts, **15 transactions succeeded, zero reverted, and zero remain pending**. Managed cash is **249.758369 USDG**, separate reserve **49.927111 USDG**, and native gas balance **0.004645460923712 ETH**. Total cash shortfall **0.241631 USDG** plus total receipt-valued gas **0.664901 USDG** gives **0.906532 USDG total validation cost**. There are no active NFT positions or remaining allowances at this closed checkpoint. This is an execution-validation expense, not evidence of strategy profitability.

The worker is **enabled, running and resumed for automatic re-entry**, carrying its actual remaining inventory. Its existing ten-minute cooldown makes the next entry eligible at **15:15:13 UTC / 18:15:13 Vilnius**, provided current admission passes. There is no capital reset or top-up. The one-time initial-approval bootstrap timer disabled itself after success. The dashboard serves real portfolio marks, receipts, paid gas, reserve and re-entry timing; its rendered output was checked against the live API. Paper session 59 and the frozen research timers continue independently.

Natural live recentering has not occurred yet. Both directions passed the owned-fork controller tests, but that is not a substitute for observing the first real range crossing. Expired, unresolved signed economic transactions remain blocked for explicit reconciliation; automatic fee replacement is not implemented. Continue monitoring those boundaries before considering a larger allocation.
