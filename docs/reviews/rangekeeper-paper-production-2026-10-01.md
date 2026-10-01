# RangeKeeper paper production launch — October 1, 2026

One AAPL/USDG RangeKeeper paper campaign is active with a nominal $250 allocation.
It opened through the deployed setup, confirmation, and acceptance APIs; the
supervised worker booked the opening and recorded a later canonical observation.
Automatic recentering is not implemented. This campaign observes its opening
position until an operator requests retained close.

## Runtime and campaign

- Campaign: `0fb38df7-442a-4b43-b90c-6bd4fcef3878`.
- Opening operation: `6cee58bc-8954-4744-965a-221cbdb171b7`, succeeded at
  `rangekeeper_paper_open_recorded`.
- Market profile: `a8e7096f-17c3-452c-a72f-8fa962e586d2`, matched exactly to the
  configured AAPL profile, including its reference policy.
- Release: `d8bd4a84cf5f6075b9ad3487e4a04a8c8eb300f89e6715b4a82e45ee774d66b9`.
- Runtime source: `aff6fe9fdccd67afe0e95f3c582972f967f72398`.
- Command/worker runtime config hash:
  `efd838c07c244bfd827909093ca3333e82dc928d4aa4a1a88c453d652f19e1c4`.
- First confirmation source: block `77619600`; second source: `77619897`.
  The confirmed-source interval was 30 seconds; the original 90-second guard
  was preserved.
- First post-open observation: mark `207`, block `77620334`.
  Kernel `pending`, `entryAllowed`, and `executionReady` are false.
- A subsequent worker pass persisted mark `208` at block `77620960`, confirming
  observations continued after the initial launch check.
- At the initial post-launch check, lifecycle was `active`, range state was
  `inside`, and there were two marks and one succeeded operation. These are
  time-sensitive runtime facts, not a promise of later range occupancy.

The reviewed virtual allocation was 153.011865 USDG, 0.294952378819174757 AAPL,
and 0.001224142090968 native units. The native allocation covers the reviewed
opening bound plus the larger of the retained-exit bound or configured reserve,
with a 20% cushion. These are paper balances; no wallet funding or live trade
was performed.

## Release and validation

Before rollout, the production deployment tables held zero campaigns and zero
operations. A scoped custom-format backup of the deployment tables and the
exact three service unit files was saved privately under
`data/backups/rangekeeper-paper-20261001/`.

Only the sealed release path changed in the dashboard, deployment-command,
and paper-operation-worker units. Runtime environment files were preserved.
No schema migration was required. Both HTTP health endpoints and the worker
readiness lease passed; all three services remained active with zero automatic
restarts at the post-launch check.

Release evidence includes 1,051 passing tests, retained-close/replay PostgreSQL
integration, and the [sealed canonical lifecycle](rangekeeper-paper-lifecycle-2026-10-01.md).
That lifecycle proves opening, observation continuity after worker restart,
operator retained close, and open/closed desktop/mobile views. It does not
claim recovery from interruption during an accepted operation.

The actual production campaign passed the shared API and local desktop/mobile
browser probe. The public operator page also showed the same active campaign,
persisted history, and retained-close review control at desktop and mobile sizes.
The obsolete `/prototype` route returned 404. Read-only browser checks did not
submit any lifecycle operations.

Net value, P&L, LP fees, and paid execution costs remain unavailable. Owned-fork
gas evidence is provisional and is not paid gas or profitability evidence.
The remaining autonomous trading work is scoped in the
[recenter follow-up](../plans/rangekeeper-paper-recenter-followup-2026-10-01.md).

Safe launch and browser events are preserved in the
[production evidence JSONL](evidence/rangekeeper-paper-production-2026-10-01.jsonl).
Disposable test databases, private test environment files, and the task's clean
build worktree were removed. Sealed releases, production backups, unrelated
worktrees, and the pre-existing `.claude/` directory were preserved.
