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
