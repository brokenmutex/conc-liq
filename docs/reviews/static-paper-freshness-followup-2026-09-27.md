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

Source validation, sealed artifact identity, the real-header routing probe,
tail rollout and subsequent paper recovery/browser gates will be recorded here
as separate results. Prior artifact passes retain their original identity.
Production paper services remain unchanged while these gates are pending.
