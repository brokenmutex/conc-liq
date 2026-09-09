# LP reliability implementation — 9 September 2026

Implements the first stage of the [improvement plan](lp-improvement-plan-2026-09-09.md). A newer in-progress risk refresh no longer forces rejection of a completed snapshot that is still admissible. Fallback lasts at most ten seconds from the oldest outstanding refresh after that completion; newer starts cannot extend it. The latest completed failure is never skipped. Canonicality, 30-second validation freshness, 180-second source/observation freshness, issuer checks and the configured price band all remain required.

The source snapshot, selected attempt, canonical validation and evaluation clock now come from one SQL statement. A validation committed after the worker began but before that statement is not misclassified as future evidence. Paper observations retain the selected IDs, statuses, timestamps, snapshot digest, reference evaluation and failed predicates. Quotes and entry simulations retain before/after reference evidence; rejected reference preflights retain the complete gate result in the execution journal. Exit requirements and already pending exits are unchanged.

Reference anchors now always subtract the configured confirmation depth from the slowest usable public head. The bounded ten-block private adjustment remains. A slow public head itself cannot substitute for a 64-confirmed anchor. Historical-read failure still fails quorum; no confirmation rule is reduced.

At 08:02:31 UTC, a bounded read-only capability check obtained the same block-58388598 hash from the private node and both configured public references. Their respective depths were 69, 64 and 69 blocks. This is endpoint capability evidence at that time, not a permanent availability guarantee.

Validation: TypeScript passes; all **273 unit tests** pass. The isolated PostgreSQL reference test covers bounded overlap, the SQL clock, immutable saved validation, expiry, failed-attempt precedence, successive starts and canonical revocation. The isolated paper lifecycle passes with ordinary and initialized-boundary fee accounting, including concurrent cancellation and coverage deferral. No schema migration is needed; diagnostic evidence is stored in existing JSON columns.

Runtime activation is recorded below when completed. Existing open paper sessions must close under their original release and carry their net cash explicitly across the upgrade.

The upgrade exposed a second operational bug: `SELECT id::text ... ORDER BY id` sorts the output alias as text. Once session 27 existed, the stop path compared it with textual maximum 9 and spun while holding session 27's row lock. The command was terminated and the timer briefly paused; ordering now explicitly uses `paper_sessions.id`. The recovery latest-session check had the same expression and was corrected. An isolated lifecycle regression crosses from one-digit IDs to session 100 and verifies stop returns that session. The lifecycle also passes with initialized boundaries and automatic reentry enabled.

The corrected control path requested session 27's exit at 08:13:10 UTC, retaining its original policy and runtime. The original worker processed the backlog within its existing source-age limits and closed the session at **974.985604 USDG** net cash. No invalidation or capital reset was used to complete the stop.

## Activation

At 08:17:18 UTC, session **28** explicitly continued #27 with **974.985604 USDG**, the same ±20 raw ticks, 80% allocation, 60% inventory exit and ±5% true-price band. The paper worker and health monitor now use sealed release `dd0fb92a59d105191985975a715819d31ce96c783e6494d178725913daa16f7a`, source `2882ee0`. No schema or private environment change was required.

The [08:24:36 UTC activation check](lp-reliability-activation-2026-09-09.json) validates the full carried-cash ancestry and confirms saved reference evidence on session 28. It was still waiting at that check. The latest healthy monitor sample had matching hashes and depths 72/64/72 on private/reference 1/reference 2. The comparison remains a separate service and cohort.
