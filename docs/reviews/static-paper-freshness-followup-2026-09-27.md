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

Before paper service replacement, the instrumented
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

Source `cfc8043ed631218b3b593d5e2de4b99d8aec676d` passed the clean full check:
**907 tests in 85 suites**, repository validators and typecheck. Four added
freshness cases passed in the nine-test reader suite. Pinned Node v24.20.0
built and verified final artifact
`bf4dcea90d07aa70acb3757b7efc6aa161a5c3ce4b945699891f2c399affcb54`.
Its runtime-file delta from cda contains only `dist/src/deployments.js` and
`dist/src/deployments/paper-replay-head-frame.js`. The cda pass above remains
evidence for cda only.

The final artifact's recovery/restore gate passed, campaign
`72fca221-92df-4a6f-881e-345544538028`, conversion
`af7bd35e-519f-4964-a1f4-6bfbe7ceffea`. Same-key HTTP 202 reconciliation recovered
the accepted operation after response loss, preview expiry and worker lease
loss. The actual sealed worker restarted in **3.518s** with identical runtime
inputs. Preparation took **60.358s**, ending at source age **77.472s**; terminal
replay's final anchor completed at **157.737s**, below the unchanged 180-second
limit. Exactly one terminal mark and three modeled conversion ledger rows
were recorded, with zero paid-gas rows. Desktop/mobile parity passed.

Canonical backup/restore independently matched one campaign, two operations,
three marks, six ledger rows, five accounting rows and 18 model identities;
sequences, constraints, indexes and append-only rejection checks passed.
Restore evidence hash:
`a55ce83b79d20f13dd77352fb6324f370ce1f694f5f215884a28aa07898e3825`.
The temporary restore database and archive were removed by the helper.

The same artifact's browser retain gate passed setup, open, subsequent
valuation, pause/resume and retain-close, campaign
`95330764-1021-4e71-aeab-0ede18813932`, retain operation
`0753d9c0-e9af-47c3-a3c2-d944df981f37`. First-session and closed-history API and
desktop/mobile views matched persisted evidence; there was one terminal mark
and zero paid-gas rows. Both runs used actual sealed processes, isolated
writes and read-only canonical source access, with no signer or broadcasts.

Ordinary conversion also passed, campaign
`76f3c092-fefd-40ef-bc23-526086806cdb`, conversion
`a40c8314-5c24-4f6b-a3b0-2fd1f19603a4`, with one terminal mark, three modeled
conversion ledger rows, zero paid-gas rows and desktop/mobile parity. Its
terminal final anchor completed at source age **116.083s**.

The changed-anchor restart gate passed its rejection assertions, campaign
`9e91c831-200e-4f31-b801-f3d3b7652e13`, operation
`cdb8d2fc-5f8d-49d0-bc54-32373cf79d60`. One test-proxy response changed the saved
source anchor; the restarted worker reported
`paper_operation_canonical_or_evidence_invalid`. Converted terminal marks,
operation ledger rows and V3 accounting rows were all zero. This is
`fault_injected_rpc_response_process_boundary` evidence, not an observed chain
reorganization. All four final gates exited zero against the same verified bf4
artifact. Logs, structured summaries and `gate-results.json` are retained under
`data/static-paper-freshness-2026-09-27/fresh-selection/`.

## Applied paper service replacement

At **18:30:35 UTC**, command ingress was stopped and production was rechecked:
zero deployment campaigns, operations and marks. Worker/dashboard then stopped
cleanly and the worker readiness lease was released. The three bf4 units were
installed; the new worker held its database-scoped readiness lease at
**18:30:39 UTC**, before command/dashboard startup. No migration, profile write,
production campaign, signer or broadcast was involved. Tail remains on cda;
its code is identical to the tail code in bf4.

| Service | Installed release | Unit SHA-256 |
| --- | --- | --- |
| Command | `bf4dcea9…` | `c37a732173cc4fea9569041758382fbf29b0bfb6a01c24c5136f56c23646a287` |
| Paper worker | `bf4dcea9…` | `d785e1b3202fe5586e4eb01d2d61b90e40532cbd3ed530ffbe6f98db95cc2667` |
| Dashboard | `bf4dcea9…` | `6150b782ffa9dec24f30ea4916732ec8057a086f86d8951c19323be950ca8962` |

Command and worker use the same private file
`data/static-paper-mvp-shared-review-2026-09-27.env`, mode 0600, file hash
`ac874eb387b9f3ad72389b6d4624f9bf82cf70b1c079177c2dfb0cd61891aae6`,
runtime config hash
`4a67b9777fff565e6cd352f2997016e5836d71e43190b401d1122e9f63124e91`.
This freezes the exact identity needed by V2/V3 paper accounting. Dashboard
keeps its prior arguments and private configuration, whose unchanged file hash
is `4669148b331548efa5f73bf15578582846b5855f2576979cb94c695f77d2c111`.
Actual executable, working directory, arguments and private file/unit hashes
were checked after startup. These are reconstructed process inputs, not a
runtime identity endpoint. Evidence: `fresh-selection/paper-cutover.json`.

Local dashboard and public Funnel root, health, Research and Positions APIs
returned HTTP 200, with 15 research pools and 14 predecessor positions. The
public operator established its passwordless session; Research, Positions,
strategy and market-profile APIs returned 200. Static/manual paper is supported;
RangeKeeper paper and both live capabilities remain unavailable. The existing
AAPL profile is draft-available, while direct deployment remains unavailable.
Desktop 1440px and mobile 390px Research/Positions checks had no horizontal
overflow, JavaScript exception or required JS/CSS asset failure. The only
mutating request observed was the empty session handshake; no campaign was
created. Evidence and four screenshots: `readonly-20260927T183238Z.json` and
matching images in the parent evidence directory.

One initial dashboard GET exceeded a 15-second probe timeout; the original
probe did not retain its exact path. The subsequent timed local/public checks
all passed (Research 2.408s local and 0.082s public). A missing optional
`/favicon.ico` returns 404 and is retained as a cosmetic finding; the smoke
script initially rejected this network log entry, then classified it separately
while preserving all application, required-asset and write-audit assertions.
These observations do not establish a sustained latency bound.

The isolated database `conc_liq_freshness_review_20260927` (OID 2313731) was
removed only after confirming no fixture schemas, other backends or local
public tables remained. Its five foreign tables referenced canonical data
read-only. Both temporary restore databases were also confirmed absent. Logs,
original units and private evidence remain retained. All four deployed services
were active with zero recorded restarts after verification.

Original units remain available for application rollback while deployment
campaign/operation counts remain zero. Once work is accepted on bf4, preserve
its exact build/config and journal; do not replace its worker with an older
runtime or restore the historical backup over later records.

The next milestone is the first human-operated AAPL/USDG paper campaign from
setup through retain-close and comparison with these harness expectations.
This rollout did not perform that campaign or complete RangeKeeper/live gates.
Shared provider throttling remains an availability risk; source freshness still
fails closed when a sufficiently young complete cursor cannot be obtained.


## September 28 production follow-up

The [first production paper browser run](static-paper-first-production-campaign-2026-09-28.md)
completed the retain lifecycle on this deployed artifact. It also found that
the suggested native allocation has no repricing headroom: the original draft
remained unopened, while a replacement using 0.0011 simulated native units
completed with unchanged policy limits. The linked record distinguishes this
assistant-operated production demonstration from independent human usability
assessment and defines the bounded default-setup follow-up.
