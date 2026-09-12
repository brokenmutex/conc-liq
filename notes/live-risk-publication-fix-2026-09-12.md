# Live risk-publication race — 12 September 2026

## Incident

The 17:45:44 UTC exit was caused by inconsistent observation clocks. The live guard captured `now=17:45:43.781` before its database reads. Risk run 19877 completed at `17:45:44.006`, 225 ms after that clock, and was selected by the risk query at `17:45:44.011`. Canonical validation was still pending. The holding guard interpreted the selected snapshot as future-dated relative to its earlier clock and latched `paper_current_risk_evidence_invalid` instead of starting the bounded risk pause.

The recorded failed checks were `selected_canonicality_unproven` and `canonical_validation_age`; there was no observed hash conflict. The selected run's expected and observed hashes matched when validation completed at `17:45:49.319`. The position was nevertheless withdrawn because exit intent is latched.

## Fix

- Live holding evaluation and chain freshness now use an observation clock captured after reading risk evidence. The request-start time remains labelled separately in entry-reference evidence.
- Evidence timestamps are compared with their own database read clock, bounded by the caller's observation time. A truly future-dated record cannot become acceptable merely because it is processed later.
- When the only failures concern canonical proof or its age, the live worker immediately validates the selected risk run. It does not collect another snapshot and recreate the publication window. Other missing/stale evidence still requires the full refresh.
- Pending validation remains a pause. One retry per incident, persisted retry state, the original 30-second risk deadline, latched expired exits, and hard exits for observed hash/identity/issuer/price faults remain intact.

The production change is restricted to the live worker. The shared holding helper is included in its release, but paper and dashboard services continue using their existing sealed releases. Capital remains 250 USDG, half-width remains 20 raw ticks, node tolerance remains 30 blocks, and all other strategy settings remain unchanged.

## Validation

`test/fixtures/live-risk-publication-race.json` contains the actual pre-exit holding state, current health sample, checkpoint, pending risk snapshot and source snapshot. URL fields are redacted. Deterministic database-read timing reproduces publication during guard execution.

The focused suite passed 86 tests, followed by an additional passing regression for mixed stale-snapshot / validation failures (87 total). Coverage includes the recorded race, immediate selected-run validation, failure/restart persistence, late proof, genuine future timestamps, hash conflicts and the distinction between proof refresh and full snapshot refresh. TypeScript checking passes.

The isolated PostgreSQL holding/boundary lifecycle also passes: pause before RPC, unchanged accounting, persisted incident clock, exact resumption, no duplicate fills/costs, explicit validation retry, issuer exit and history revocation. It uses a separate temporary schema and stub executor.

Deployment evidence and a fresh monitoring baseline are retained under `data/live-risk-publication-deployment-2026-09-12/`. No historical P&L or incident state is reset.

## Deployed and observed

The live worker switched at **18:39:51 UTC** to sealed release `82352d198092375a90fbf445314067afcc16c2d19f4bb0b2e40d26defdb0ac11`, source `2600cc76d3e575ac8d341c4e3143e556a7019684`. The same campaign and NFT **1146954** remained open. Active configuration and policy hashes match the pre-deployment baseline; paper and dashboard unit files are unchanged.

Seven samples over **18:39:51–18:42:51 UTC** show no exit intent, no additional transactions, and no additional gas. Net value moved from the pre-deployment baseline **246.918760** to **246.919587 USDG**. Incremental collected/claimable fees valued at the final spot are **0.000145 USDG**. These are observations from a short operational check, not a profitability result. Historical campaign economics remain intact and the live worker remains running.

Evidence: `data/live-risk-publication-deployment-2026-09-12/verification.json`, `before.json`, `observations.jsonl`, before/after unit files and the release manifest. Use that baseline for subsequent post-fix performance comparisons. Restoring `live-before.service` and restarting only the live worker rolls back the software while retaining journal/custody state; never reset or recreate the campaign during rollback.
