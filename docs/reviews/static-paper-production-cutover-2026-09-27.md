# Static paper production cutover — 2026-09-27

The operator approved the exact [rollout package](static-paper-rollout-package-2026-09-27.md)
with “go” after the production approval request. That authorization covered the
schema migration, seven existing service replacements, two new paper services,
temporary timer suspension, retention guard update, and exact AAPL profile
registration. It did not authorize live trading or opening a campaign.

## Applied changes

The reviewed runtime source is `5905b470999e139234a9d5ecd268ea131dde33f2`, sealed
build `d507e6dedb131a883cdeb5e23cc3fc220225eacf81b009d582545636e0772645`, installed
under `/root/conc-liq/data/releases/` plus that build ID. Its manifest, staged
unit hashes, private environment/profile hashes and original unit copies were
reverified immediately before cutover. The full preparation backup still
matched SHA-256 `a6a20cfae8fea534abb62a46ab5baae01292538a15aef0eb93f8fa4fdfb26706`.
Its approximately 40-minute-old consistent recovery point was retained for
this additive migration; later writes are not included. It is not an automatic
rollback over newer production data.

Five timers were stopped. All associated one-shot jobs were already inactive;
the three continuous readers then stopped cleanly. PostgreSQL reported no
remaining application sessions or advisory locks before migration. No dormant
predecessor service was started or adopted.

The reviewed retention guard was applied as main commit `39d4ab1` (the staged
commit was `dc2fedeb1a5c21b2f5e39e7e17e3c12c0ee74461`). Its final script hash is
`0a7d9dfb29015c17652dc947e0189a2f608472886fbe7db20e509d3dc541d8a5`. The pruning
body is unchanged; no manual retention run was performed.

Exactly nine service files were installed and systemd reloaded. Unit validation
passed, with only the previously observed unrelated `snapd.service` warning.
Existing commands, environment files, arguments and timer definitions were
preserved; the seven existing services changed release paths only.

At **07:36:48 UTC**, the pinned migration command committed versions 4–11 to
database `conc_liq`, schema `public`, OID `16385`, without a baseline override.
The candidate's actual deployment and indexer schema checks passed against the
resulting contiguous, checksummed 1–11 history. Campaign and operation counts
were both zero immediately after migration.

The compatible RPC-health, tail and dashboard services started, followed by
the paper worker and command service. Both new units were enabled for boot.
All five timers resumed with their previous schedules. Old schema-3-only
readers must not be restarted against this upgraded database.

## Registration and readiness

The approved AAPL profile was freshly verified and registered as
`a8e7096f-17c3-452c-a72f-8fa962e586d2`, profile hash
`c8f6e18c61b1eb190d0ad07712d4a885df108a1adf7160c5174b586605b92c52`.
The registration's canonical source was block `73765597`, hash
`0xa922258df5e6492463502e0f7f3db5af36f73de19d9dbadc46eb04415ba34ad6`.
Its verification class is `canonical_chain_and_independent_reference_v1`.

All five continuous processes were independently checked against the d507
executable/launcher paths and their intended environment files, with zero
restarts. The actual worker advisory readiness lease was present. The command
service listens only on `127.0.0.1:4174`; `/healthz` returned `ok`.

The tail resumed indexing and replay. A transient historical-provider HTTP 429
recovered through the existing retry policy; subsequent cycles completed.
Strategy and paper-assets checkpoints and the reference collector recorded
successful post-cutover writes. No manual invocation of scheduled jobs was
used as a startup test.

Independent checks confirmed the registered profile hash and active status,
zero campaigns/operations/open reservations/accounting rows, and unchanged
closed predecessor records. Both checkpoint jobs and the reference job exited
successfully after resumption. The hourly accounting and daily retention jobs
were not yet due; their post-cutover executions remain unobserved.

Authenticated browser verification passed at 07:40:51 UTC. The profile API
returned the expected profile identity with `draftAvailable=true`; dashboard,
Research and Positions APIs returned 200. Research contained 15 pools and
Positions returned 14 historical records. Desktop (1440 px) and mobile (390 px)
views rendered without horizontal overflow or browser exceptions. Only login
and logout changed session state; no setup, draft, preview or economic operation
was submitted. Logout revoked the session, and a subsequent profile request
returned 401. The temporary browser process/profile was cleaned up.

The profile listing's `deploymentAvailable=false` and
`fresh_preflight_and_execution_unavailable` are its unconditional catalog
boundary in `listMarketProfiles`, not a failed cutover health check. A fresh
parameterized setup review remains required before a paper operation can be
admitted; the read-only verification did not attempt that review.

## Evidence and remaining boundary

Local execution evidence is retained under
`data/static-paper-mvp-cutover-20260927/execution/`, including before-unit state,
the migration and registration logs, and `process-identities.json`. Credentials,
cookies and CSRF values are excluded from this record. The operator password
remains in the protected handoff file named in the rollout package.
Independent inventory is in `independent-post-cutover-inventory-20260927.json`;
browser evidence is in `operator-readonly-verification-20260927.json` with four
`operator-*-20260927.png` screenshots. These evidence files are mode `0600`.

No campaign or economic operation was created by the cutover. Paper estimates
remain provisional, and runtime readiness does not establish profitability or
future reference/cost availability. The next product step is the operator's
first static/manual paper workflow. RangeKeeper and live execution remain later
work. Preserve all post-migration data and use compatible forward recovery if
a service needs repair.
