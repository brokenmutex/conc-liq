# LP infrastructure recovery — 12 September 2026

The live worker's two exits after the initial validation were infrastructure exits, not range recenters. The 30-block holding tolerance, 60-second chain pause and 30-second risk pause remain unchanged.

## Evidence and causes

[Incident extract](lp-infrastructure-incidents-2026-09-12.json) records the raw health window and phase transitions.

- At 15:34:50 UTC the private node was 142 blocks behind, triggering `private_block_lag_hard`; the sampled incident peaked at 313 blocks / 33 seconds. This was a real lag beyond the agreed tolerance. The controller retained its exit intent until chain reads recovered and finished the exit at 15:39:19 UTC.
- After automatic re-entry, the risk retry clock started at 15:59:31.951. The last canonical validation was 15:59:02.806; the next scheduled proof arrived at 16:00:02.895, beyond the 30-second retry budget. The live worker lacked the paper worker's explicit refresh path, so it exited at 16:00:03.996 even though current risk had then recovered. Late proof must not erase an expired deadline; the fix requests proof promptly.
- The live holding guard also unnecessarily depended on fee-event indexing coverage. Actual NFT custody/fee marks do not need paper event replay. Holding now uses a fresh canonical, identity-checked checkpoint while entry retains its original covered-checkpoint gate.
- Paper session 59 was invalidated at 15:37:26.832 with `source_stale_or_worker_missed_decision`, last accepted source 15:33:17. Its execution evidence and observation canonicality still validate. The dashboard attempted ancestry validation on an already invalid session and replaced the actual failure with `paper_continuation_history_invalid` and a new timestamp on each read.

## Changes

The live worker now requests one bounded read-only risk refresh per incident. If only canonical validation aged out, it validates the selected snapshot's block hash; otherwise it recollects risk using the existing confirmed-source collector. It rereads current health/risk after the attempt. Retry failure, restart, late recovery and issuer/price faults retain their existing exit semantics. The shared refresh implementation is also used by paper execution; no signer enters that path.

After a recorded infrastructure pause, paper management waits for a fresh checkpoint rather than evaluating a stale queued checkpoint. It retains the pending exit, reads the complete covered interval at recovery, and still invalidates if the original 900-second maximum gap is exceeded. Ordinary unexplained stale decisions remain invalid. The dashboard preserves an existing invalid session's actual reason and timestamp.

The current session's interruption is already beyond that 900-second bound. Session 59 is preserved as invalid, with its complete pre-restart row backed up in `data/paper-session-59-before-restart-2026-09-12.json`. Recovery starts a separate paper campaign at the agreed 5,000 USDG and unchanged strategy; it does not fabricate an exit, carry an unproven cash balance, or combine the restart with session 59's return.

## Validation

- TypeScript checking passes.
- 73 focused pilot, execution, holding and preflight tests pass, including independent live refresh, retained deadlines, refusal to refresh through chain/issuer faults, indexer independence and bounded fresh-source waiting.
- Isolated PostgreSQL lifecycle tests pass, including preservation of the original dashboard invalidation reason/time.
- The holding/boundary PostgreSQL variant passes: persisted incident clocks, exact interval resumption, explicit validation retry, issuer exit and history revocation.
- 10 dashboard/release tests pass.

The node infrastructure itself has not been changed. Sustained lag and failed risk refreshes can still trigger exits. Natural live recentering remains a separate validation milestone.

## Deployment and verification

Live, paper and dashboard units now use verified sealed release `468e93cdbfaecd978f75cde895ba82c7a2ca48034d9995ebbe894ee2c9273301`, source `44f679bdaf037dfe208f2676280b2ecf20d92253`. Before/after units and the manifest are saved in `data/lp-infrastructure-deployment-2026-09-12/`. No strategy limits or wallet configuration changed.

Paper session **60** started at 16:32:43 UTC as a separate 5,000 USDG campaign. Session 59 and its recorded failure are retained. Admission still requires the complete healthy window and a confirmed checkpoint.

The old live worker began another risk pause at 16:32:09.061 before deployment. Its original deadline elapsed before new proof at 16:32:53.897, so the new worker correctly retained that exit; it did not clear an inherited timeout to keep a position open. The withdrawal, sale and allowance cleanup completed at **16:35:27.806 UTC**. Managed cash is **249.401724 USDG**, the reserve is **49.927111 USDG**, NVDA and active LP liquidity are zero, and cumulative paid gas is **1.723102 USDG**. Net managed capital including that gas is **247.678622 USDG**; the difference from 250 includes launch validation and all subsequent activity. There are no unresolved transactions at this checkpoint. Automatic re-entry remains enabled, earliest 16:45:27.806 UTC, subject to admission.

A real, read-only canonical refresh completed in **69 ms** at 16:34:33 UTC for risk run 19738 / block 61250368. The fresh stored hash matches the expected hash. This verifies the shared production refresh path without a trade; regression tests verify its deadline and failure behavior. Evidence is in `data/live-risk-canonical-refresh-2026-09-12.json` and the post-deployment status samples.

The original private-node incident was not a slow HTTP response: private probes answered in 4–6 ms while the reported head froze at 61215380 and both reference heads advanced. The downstream symptom is a node head-progress stall. Its upstream cause (such as block ingestion or node execution) remains unproven and requires node-side telemetry; widening the 30-block tolerance would not fix that cause.

Paper session **60 entered successfully at 16:38:28 UTC**, execution run 372 (quote 371), and is open. Initial marked NAV is **4,998.276380 USDG** after modeled entry economics/reserve. Both dashboard APIs respond successfully. This is a new paper campaign, independent of preserved session 59.
