# Saved paper exit recovery and overlap-coverage deferral — September 8, 2026

Session 7's original exit simulation completed at 13:36:41.593 UTC on checkpoint 2096 / block 57730617. Execution run 13 was saved at 13:36:41.630 UTC as failed, with its successful result nested under `snapshot.preflight`, because the subsequent consistency check returned `paper_source_changed_during_preflight`. No accepted exit observation was written, so automatic reentry correctly stopped.

## Diagnosis

The indexer calls `rewind` on every overlap scan, deleting/replacing overlapping events and moving the coverage cursor backward in a separate transaction before the replacement batch commits. At the incident, the next replacement batch completed at 13:36:41.880 UTC, shortly after the paper consistency check at 13:36:41.630. Earlier and later validations agree on the exit block hash. Current canonical evidence for the session and ancestors is intact.

Live 100 ms sampling reproduced the temporary cursor regression twice in 20 seconds: at 14:13:49.369 and 14:13:59.353 UTC, indexed coverage temporarily fell to block 55296692 while replay coverage remained near 57752900. This explains how a perfectly valid exit could encounter `covered=false`. The old error combined multiple checks and did not persist which one failed; attribution of this specific incident to the overlap race is strongly supported, not directly logged proof of that exact boolean.

The worker now distinguishes temporary coverage loss from source/hash/history/target-identity failure. It records the discarded preflight as `paper_event_coverage_deferred`, retains the previously accepted state and costs, and waits for the next fresh checkpoint. It skips the discarded execution key to avoid duplicate simulation or a unique-key collision. The next mark includes the full interval from the last accepted checkpoint, including swap path and boundary fee continuity. Existing source-age and maximum-gap limits still apply; source identity or canonicality changes remain invalidating. Failed consistency checks now record their component booleans.

## Recovery evidence and limits

The recovery command accepts only an already recorded successful exit simulation wrapped in the specific old consistency failure. It requires the last accepted state to be exit-pending, the saved invalid state to be exactly its invalidated copy, and the exit source to follow the existing exit signal. It rechecks policy/runtime identity, canonical source and ancestor history, complete event coverage, original five-minute health readiness, original source-age limits, historical boundary data via the node, fee continuity, exact inventory, allowances, native gas budget and transaction cost totals.

Using the ordinary paper transition function and the original run timestamp reproduces the full recorded exit inventory and closes the position at **995.136631 USDG** after all recorded costs. Session-7 P&L is **−4.830779 USDG**. Recovery does not manufacture a new historical quote or simulate a missed past action. It reconciles the simulation that was already completed and recorded then. No fees accrue after that recorded exit. These remain local-fork paper proceeds and estimated costs, not actual chain transactions or realized trading profit.

`paper-recover audit SESSION_ID FAILED_RUN_ID PLAN_PATH` creates a reviewable, hashed plan without DB writes. `apply` recomputes the evidence in a transaction and requires matching runtime, source/evidence hashes and every plan field. Because the DB has a unique `(session, checkpoint, action)` key, recovery updates the existing run to succeeded while preserving its **complete original failed row**, the invalid session and input evidence under `snapshot.recovery`. The recovered observation retains the original run time; the recovery envelope separately records the actual repair time. No original failure evidence is deleted. Reentry is durably stopped at repair and requires explicit continuation from conserved net cash.

Files under `data/paper-recovery-2026-09-08/` retain the pre-repair run, live coverage samples, independent reconstruction and audit plan. The checked-in accounting fixture omits transaction storage overrides and is a regression fixture, not independent performance validation. The CLI does not run entry/exit simulations or broadcast; its only RPC work corroborates historical boundary state.

## Validation

TypeScript and 272 unit tests pass. New recovery cases verify exact preserved losses and unchanged input evidence, and reject changed fees, costs, balances, runtime, failure provenance, sources, missed timing and unhealthy/unsupported history. The isolated PostgreSQL lifecycle also reproduces coverage retraction during exit, verifies unchanged balances/costs, no duplicate retry, and a successful next-checkpoint exit. Existing canonical-revocation, concurrent-stop, restart, cooldown and automatic-continuation cases remain covered.

## Activation

Recovery applied at **14:21:04.037 UTC**. Run 13 is now accepted, with its complete original row retained under `snapshot.recovery.beforeRun`; canonical JSON hashes of the original disk backup and retained DB row match (`bf2935ab90411a84585e5fdbaf56b7681ac50e79587c32d5a89782c73a920e2f`). Session 7 is closed with zero LP liquidity and zero NVDA, after 0.816984 USDG total session costs.

Only the paper worker moved to release `8f3133ff828884314864e99e7600e09c06d24b8130d76e2f2e7ff62b7ac8a82d`, source `83cfa1c`. No schema migration was needed. Explicit `paper start --policy config/paper-nvda-ticks20-continuous.json --after 7` created session **8** at **14:21:27.825 UTC** with **995.136631 USDG**, the same ±20 raw ticks and continuous-reentry policy. The paper timer resumed; the experiment and health services remained running on their own pinned releases.

At the initial activation check, the chain `[5,6,7,8]` validated, with campaign P&L **−4.863369 USDG** and total modeled gas costs **2.521487 USDG**. Session 8 was waiting for its first eligible checkpoint. [Activation evidence](paper-recovery-activation-2026-09-08.json) records the verified accounting and retained failure hash.
