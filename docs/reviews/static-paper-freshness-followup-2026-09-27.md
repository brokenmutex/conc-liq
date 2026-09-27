# Static paper freshness follow-up — September 27

The operator instructed continuation after the [terminal recovery
checkpoint](static-paper-terminal-replay-followup-2026-09-27.md). This follow-up
targets the measured source-age budget while preserving the 180-second limit,
current-time verification, preview expiry and canonical replay requirements.

## Measured cause and scoped repair

Read-only inspection found HyperSync HTTP 429 retries in all 47 sampled tail
cycles lasting 59–117 seconds. The inspected journal window contained 1,420
retry events, including 1,026 waits of 41–45 seconds. Snapshot and canonicality
work after replay took milliseconds in the inspected slow cycle. Each distinct
event block previously required its own HyperSync metadata query in addition
to the historical log query and endpoint checks.

Continuous tail indexing now supplies its existing live read client for event
headers. Historical logs and endpoint checkpoints remain on the historical
transport; all event hashes, timestamps, history boundaries, confirmation depth,
reorg overlap, RPC health checks, the eight-reader concurrency limit and
512-header chunk bound remain. The optional header client is wired only by the
tail runner; ordinary historical backfills retain their current routing.

A bounded read-only probe compared eight recent persisted indexer headers with
the existing live client: every hash and timestamp matched in 461ms total.
Exact prior fee cursor/tick/event queries took milliseconds through both direct
PostgreSQL and the isolated foreign tables (190 ticks and three events). A
separate historical fee probe took 879ms for the prior frame and 4,210ms for
the canonical interval, with 60 RPC calls. These measurements do not establish
new lifecycle or recovery acceptance.

Opt-in preparation and sampler phase timings now expose the remaining budget
without changing execution order, pacing, report hashes, replay counts or
acceptance predicates. The canonical fixture retains bounded, allowlisted
timings on success and failure. Private evidence is under
`data/static-paper-freshness-2026-09-27/`; no environment values or provider
credentials are included in the review.

## Validation and rollout

Source `9781d3dd51a394d459f69b9eb51c802081b3be8c` passed the clean full check:
**903 tests**, repository validators and typecheck. The focused history tests
passed 18/18. Pinned Node v24.20.0 built and verified artifact
`cda961d0fb0a94acfdeaf5ae3c14de307eca1a653a2e02022e57e420ecc81be6`.

The exact artifact's bounded real-chain routing probe covered blocks
`74136360`–`74136615`: three events and three live header reads passed the
historical log/boundary and event hash checks. Its store was an in-memory
adapter; no database writes occurred. The probe took 16.564s including a
14-second provider retry. Evidence: `sealed-header-routing-probe.json`.

The tail service was stopped cleanly and restarted on cda at **18:02:05 UTC**,
preserving its existing arguments and private configuration file. No schema
change was needed. The installed unit hash is
`c4d80401aa41ea8f2c16ed777a7846a53c9f1435e5d5359b6cacc2da24719650`;
the unchanged environment file hash is
`4fc0b2c97a3b5cf098a4b2e11f8573699618a4e3cfc64ad444435af87c556c8f`.
Actual executable, working directory and arguments match the staged inputs;
this is reconstructed process evidence, not an emitted identity endpoint.
The original unit and application-only rollback remain in the private evidence
directory. Startup validation hit provider rate limits; afterward a fast cycle
completed in 2.697s, but shared provider throttling still caused roughly
50-second pauses. The routing fix reduces request amplification; it does not
establish that the provider quota is sufficient for uninterrupted indexing.

Paper command, worker and dashboard services remain unchanged. The instrumented
cda recovery/restore run **passed**, campaign
`74fc36c4-e7fc-48b8-a740-e7e06b248688`, conversion operation
`6dc3f804-eec0-4178-85a6-c2fc76956e9c`. After response loss, preview expiry and
worker lease loss, same-key reconciliation returned the same accepted operation;
the actual sealed worker restarted in **3.770s**. It completed
`paper_close_convert_v3_reconciled` with one terminal mark, three modeled
conversion ledger rows and zero paid-gas rows. Desktop/mobile parity and
isolated backup/restore passed; signer was unloaded and broadcasts were zero.
Log: `canonical-recovery-restore-sealed.log`; compact evidence:
`recovery-summary.json`.

The selected source was **26.394s** old at frame capture. Preparation took
65.910s overall: fee replay 6.019s, owned-fork sampling 35.115s (restore 25.534s),
gas registration 6.486s and preview persistence 13.309s. Terminal replay used
the same source and completed its final anchor check at source age 172.232s.
These measured timings explain why beginning with the prior 87-second-old
source left insufficient room. They do not establish a worst-case latency bound.

## Fresh source selection follow-up

Conversion preparation now requests a complete canonical source no older than
30 seconds before starting expensive replay. The cheap cursor/header loop
waits for advancement instead of repeatedly reading an unchanged stale header.
It rechecks the selected frame's age after full reads and stays within the
existing 60-second wait budget. The general reader retains its 180-second
limit; preview lifetime, current-time verification and accepted source bindings
are unchanged. Failure to obtain a suitable source remains unavailable.

This source change needs a new verified artifact and exact-artifact recovery,
restore, ordinary conversion, retain and changed-anchor gates before paper
service replacement. The cda recovery pass remains evidence for cda only.
