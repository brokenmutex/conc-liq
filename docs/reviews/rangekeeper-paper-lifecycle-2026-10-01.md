# RangeKeeper paper lifecycle evidence — October 1, 2026

## Result

The canonical paper lifecycle passed against a verified sealed release. The
release manifest build ID is
`d8bd4a84cf5f6075b9ad3487e4a04a8c8eb300f89e6715b4a82e45ee774d66b9`, pinned
to source commit `aff6fe9fdccd67afe0e95f3c582972f967f72398`. The lifecycle
harness itself is committed as `7051382`.

The sealed fixture campaign/setup draft was
`728e187b-4a56-4164-afe2-f86cd326913d`; its open operation was
`1afd6bc8-c6ee-44b3-9a1a-0d5ed46bc3e5` and retain-close operation was
`5f684623-6bb1-4129-ad5c-ba4364d041b7`. The first and confirming open sources
were blocks `77614354` and `77614652`; retained-close preview used block
`77615117`. The open, observation-continuity, and close records produced four
marks in closed dashboard history.

The test registered a verified AAPL market profile in an isolated PostgreSQL
schema, then used the actual production command API for setup preflight and
draft admission. It created a setup draft (HTTP 201), recorded two canonical
observations, accepted an open through
`/api/deployments/:id/rangekeeper/open-operations`, and verified worker booking
at `rangekeeper_paper_open_recorded`. After an observation was persisted, the
worker process was stopped and restarted; the new worker persisted a newer
observation for the same campaign, demonstrating observation continuity across
restart. This did not interrupt or recover an in-flight operation. The
production retain-preview and close
acceptance routes completed the retained close, and the shared deployment
history survived a fresh store projection.

The sealed command and worker were launched through the release's verified
`launch.mjs`; both passed the 30-second readiness bound. Confirmation waited
for the confirmed-chain timestamp required by the 30-second minimum decision
interval and remained inside the configured 90-second observation-gap bound.
No freshness limit or risk parameter was widened to make the flow pass.

The read-only browser probe verified the actual dashboard at desktop and mobile
sizes with the campaign open and closed. Open and closed views showed the same
campaign and persisted activity; the open view exposed the retained-close review
control, and the closed view did not. Net value, P&L, fees, paid costs, and
modeled fee/cost ratios remained unavailable in the rendered views and
performance aggregates. Closed history contained four marks and remained
visible after restart.

The harness used canonical read-only RPC and owned local Anvil forks for
execution simulation. It loaded no signer and broadcast zero transactions.
RangeKeeper paper observation remains non-actionable: automatic recentering is
not implemented, no recenter candidate is persisted, and the worker does not
execute recenter actions. Retained close is an operator-requested terminal
action. The verified release is deployed to the command, dashboard, and paper
worker service units. The first bounded paper campaign is now active; see the
[production launch record](rangekeeper-paper-production-2026-10-01.md).

## Cleanup verification

The sealed harness dropped its generated `rk_lifecycle_*` schema in its
`finally` cleanup. A read-only catalog query found no remaining lifecycle
schemas in the dedicated disposable test database. The lifecycle command and
worker children exited, no owned Anvil fork remained, and the harness's
`conc-liq-rk-lifecycle-sealed-*` temporary directory was absent. The same
verified release now runs the three deployed service units with their stable
runtime environment paths; these are expected service processes, not leaked
harness children. The coordinator later removed the disposable lifecycle
database after confirming it had zero active connections; the sealed artifacts
and unrelated worktrees were preserved.

The [sanitized sealed-run JSONL](evidence/rangekeeper-paper-lifecycle-2026-10-01.jsonl)
records the setup response, source blocks/hashes, accepted operation IDs,
post-restart observation, dashboard checks, and final `lifecycle_passed`
result. The release artifact and evidence log are evidence for this paper lifecycle
only; the subsequent production launch is recorded separately and does not make
autonomous recentering available.
