# Chain and risk-evidence exit review — 10 September 2026

The practical change to investigate is separating permission to enter or transact from the decision to retain an existing LP position. Today `PaperStore.tick` passes the five-minute canary entry-readiness reasons into `advancePaper`; the guarded transaction engine turns those reasons into a persistent `exit_pending` state. An isolated infrastructure fault can therefore commit an exit even after its raw cause has recovered. Clearing a recovery window does not cancel the pending exit.

The counts discussed with the user cover sessions 5–51: 21 chain-related exits and six risk-evidence-only exits. These are cumulative across several releases. They are not 27 failures of the latest code. Session 52 subsequently exited on the inventory threshold, so it adds nothing to these buckets.

## What the records establish

All six risk-only cases are sessions **8, 18, 20, 21, 22 and 24**, before the [September 9 reliability release](lp-reliability-implementation-2026-09-09.md). That release introduced bounded ten-second reuse during an in-progress refresh, one SQL statement/clock for reference selection and canonical validation, and persisted exact failed predicates. No risk-only first-exit signal has occurred from session 28 through the current session 53. The older six did not save those detailed predicates, so their exact decision-time reads cannot be reconstructed from later canonical-validation rows. Do not claim that replay proves all six prevented.

Nine of the 21 chain cases precede the reliability release; 12 follow it. The old public-anchor problem is visible in #17 and #25: one public endpoint had zero confirmations at the chosen anchor despite a healthy monitor label. The September 9 anchor fix addresses that construction.

| Current-release chain group | Sessions | Recorded evidence |
|---|---|---|
| Private lag just beyond anchor adjustment | 32, 44, 46 | Lag 11, 11 and 14 blocks; private anchor depth 61, 60 and 55, below required 64; monitor otherwise healthy |
| Private syncing reports | 31, 36, 41 | Syncing signal with small block lag; one fault sample in #31/#36, three in #41 |
| Soft block lag | 38, 39, 47 | Maximum observed lag 32, 35 and 27 blocks in selected recovery windows |
| Reference quorum unavailable | 28, 49 | One fault sample each; availability failure must be distinguished from an observed conflicting hash |
| Larger multi-sample incident | 40 | Six fault samples, maximum lag 107 blocks, including anchor-read failure and soft time lag |

Session 49 also has a risk-evidence failure. Its saved predicate is `canonical_validation_age`: the selected snapshot was still marked canonical, but validation at 06:52:29.594 UTC was too old at the 06:54:35 exit signal. This is separate from the earlier refresh-selection race. A historical `canonical=true` is not proof that it remained recently validated at the decision.

The fresh read-only chain breakdown is archived in `data/lp-infrastructure-exit-review-2026-09-10/chain-exits.json`. It uses each first signal's stored `pendingSince`, the preceding six minutes of recorded health samples, and the production readiness helper's selected sample IDs. Fault counts describe observations in that selected window, not exact outage durations or hypothetical successful alternative anchor reads.

## Proposed next implementation

1. **Separate entry and holding decisions.** Preserve the existing full recovery proof for new entries and transaction preflights. An open position experiencing a transient infrastructure problem should enter an explicit holding/observation pause before any exit intent is committed. During unavailable data, retain the last accepted accounting state with its age visible; do not fabricate fresh marks, quotes or fees.

2. **Align the lag and anchor policies.** Currently the health monitor's default soft block-lag limit is 20 while anchor adjustment stops at 10. Use one explicit, shared bound. The user approved **30 blocks**, replacing the proposed 20-block candidate. Within that bound, choose an anchor at least 64 blocks behind every participating head, including the private node, and actually verify all hashes there. Keep the full 64-confirmation requirement. A historical deeper hash was not read merely because its height can be calculated, so counterfactual availability remains unproven until exercised.

3. **Bound pauses by the underlying incident.** Initial hypotheses: up to 60 seconds for a transient chain/RPC incident and up to 30 seconds for retrying a risk read/validation. Persist the first failure time so retries and restarts cannot extend it indefinitely. Measure raw failure duration separately from the monitor's recovery hysteresis and the entry policy's five-minute recovery window. Those windows alone should not keep requesting liquidation after the underlying fault has cleared. Existing RPC execution restrictions still apply during recovery.

4. **Refresh proof rather than relabeling stale evidence.** When current risk evidence fails, request a bounded fresh snapshot/canonical validation and reevaluate it. Keep the existing ten-second completed-snapshot overlap rule, including refusal to skip a newer completed failure. Never convert an old validation timestamp or successful status into a new one without a real check. Retain issuer, multiplier, oracle-content and price-band failures as substantive risk conditions.

5. **Retain hard failure handling.** Actual hash conflicts, revoked history, issuer pauses, unsafe multipliers and sustained/malformed evidence are not ordinary RPC jitter. A pause does not authorize trading on stale data or establish that the position is safe. Past the bounded pause, escalate to the existing applicable exit/halt behavior; execution still requires valid preflight evidence, and unrecoverable accounting gaps still invalidate the paper result.

Start with anchor consistency and the separate holding decision, then use stored incidents as deterministic regressions. Test retained positions through recovery, expiry and restarts; missing versus conflicting hashes; unchanged hard-risk exits; no fees invented during missing coverage; and equal carried cash/accounting. Report avoided exit intents separately from P&L: the full loss of a chain-exited session is not recoverable profit. No new four-strategy comparison is needed.

The user approved implementation with 30 blocks on September 10. See [implementation and deployment evidence](lp-holding-tolerance-2026-09-10.md). The USDG grace activated normally into session 54 at 12:06:07 UTC, carrying 949.059307 USDG from session 53; subsequent infrastructure policy changes must preserve that linked campaign.
