# Dashboard immediate findings remediation — September 29, 2026

Follow-up to [the test report](dashboard-test-report-2026-09-29.md), limited to
its five immediate findings. Three Luna agents implemented separate areas;
the coordinator reviewed integration and added a real repository risk test.
The original findings report remains the record of the tested baseline.

## Changes

1. The Positions overview carries per-asset risk evidence and its observation
   timestamp, with the configured snapshot freshness limit. The current page
   shows eligibility, blocking reasons, market hours, corporate-action state,
   tradability and oracle state. Missing assets and stale or invalid timestamps
   remain explicitly unavailable. An asset snapshot is not action authorization.
2. The command service reclaims expired sessions and preserves valid sessions
   when its 32-session capacity is reached. Extra new handshakes receive
   `503 operator_session_capacity`. Existing browsers can continue working;
   a new browser may need to wait for expiry or an explicit session release.
3. Retry connection performs a real session handshake and reloads market
   profiles and saved drafts. A failed forced handshake clears the browser's
   ready state. Original request bodies and idempotency keys remain preserved
   during the existing one-time renewal/retry path.
4. An All-recorded history selection makes retained campaign evidence available
   beyond the fixed chart windows. Closed campaigns select this view by default.
   Receipt lists expose the selected window's full returned activity. Existing
   bounded mark reads remain in place; exceeding a bound reports unavailable
   history instead of silently truncating it.
5. Retain and convert controls have distinct preview, review, confirmation and
   reconciliation identities, visual treatments and outcome descriptions.
   Accessible labels include the asset and campaign. Paper conversion copy
   continues to describe modeled outcomes.

## Verification

Baseline `npm run check` passed 936 tests across 85 suites. The combined change
passes repository checks, typecheck and all 939 tests across 85 suites. The risk
integration passes, and the reliability browser run passes 40 checks with no
browser exceptions. The final usability browser run passes 44 checks with no
browser exceptions and no horizontal overflow at 1440px or 390px. A timing race
in the new history test was corrected by waiting for the detail's time controls
to mount; the corrected harness passed on rerun.

Reproduce using `PATH=/root/conc-liq/.tools/node/bin:$PATH` and a local
`TEST_DATABASE_URL` for the integration checks:

- `npm run check`
- `npm run test:integration:dashboard-risk`
- `npm run test:integration:dashboard-usability-browser`
- `npm run test:integration:dashboard-reliability-browser`

The new risk test uses an isolated schema and the real repository SQL. It
checks missing snapshots, configured freshness, latest-run selection, blocked
flags and reasons, nullable feed data, additional asset symbols and preservation
of old evidence timestamps. Browser assertions for fixed defects are inverted;
unrelated defect assertions remain explicit.

A read-only repeatable-read check against retained production evidence compared
All-recorded with the 30-day window. Mark and event counts, and every session's
raw net P&L, fees, gas and swap attribution, matched. All-recorded ends exactly
at each campaign's recorded closure:

| Campaign | Marks | Events | Closed at (UTC) |
| --- | ---: | ---: | --- |
| `live-f8affe19…` | 17,360 | 361 | September 15, 05:50:33.059 |
| `live-rk-470e5f84…` | 1,008 | 34 | September 22, 02:23:56 |
| `live-rk-31802d63…` | 3,338 | 54 | September 23, 13:23:36 |

Logs are retained privately in `data/dashboard-remediation-2026-09-29/`.
After validation, no `dashboard_risk_*`, `track1b_*` or `track2_*` test schemas
remained, and the public deployment campaign count was zero.

## Remaining scope

Findings 6–12, the backlog and outstanding coverage in the original report are
separate follow-up work. The authorized release checkpoint adds the R7 asset
coherence gate: `npm run test:integration:dashboard-release-coherence -- RELEASE
DASHBOARD_URL COMMAND_URL [PUBLIC_URL]`. It verifies the manifest and compares
each service's supported document routes and shared JS/CSS dependencies against
the sealed bytes. Its `--self-test` must reject a mismatched module.

The command service and paper worker must move together: close-convert V3
completion requires the worker runtime identity to match the campaign's saved
identity. The checkpoint preserves configuration and execution policy, requires
empty production campaign/operation tables before cutover, and does not migrate
production data.

## Release checkpoint

On September 29 at 08:55:30 UTC, the dashboard, deployment-command service and
paper-operation worker moved together to sealed build
`463e2eef44ff5ab5d29fc0ed864013e8a16a0a751758701c0344f797af9ba22b`, built from
source `905c8e91766bd29a2415f565fc27c3590008adde` (fixes commit `56fea67`).
Only the release paths in the three systemd units changed. Both environment
file hashes and the public Funnel mapping match their captured baseline.

The isolated checkout passed repository checks, typecheck and 939 tests.
Its fixture directory links were removed before the clean release build.
The sealed manifest verifies. Risk integration and the 44-check usability and
40-check reliability browser suites also passed against the sealed compiled
modules and dashboard assets, with no browser exceptions. Their harness copies
replace only TypeScript source imports with sealed JavaScript URLs; original
and derived hashes are recorded. Isolated schema fixtures simulate the chain
observation boundary; these runs do not claim new canonical economic evidence.

The R7 gate passed 17 private route/asset comparisons against the sealed server
factories before cutover, then 27 comparisons across the installed dashboard,
command service and public Funnel after cutover. The gate's negative fixture
rejects mismatched JavaScript and checks discovery of imported dependencies.
The persisted-policy compatibility check passed; there were no matching paper
policies and no paper snapshot, so this is not additional paper-history coverage.

Post-cutover inspection confirmed the actual processes' build, executable and
working directory, unchanged configuration hashes, zero automatic restarts,
schema readiness, and the worker's PostgreSQL readiness lease. Production
deployment campaigns and operations remained empty, and the isolated test
schemas were removed. The tail and RPC-health services stayed active. No
production migration or economic operation was performed.

The public Chromium check reached both `/` and `/operator`, displayed all seven
asset risk rows, observed automatic session creation and a second real session
handshake on Retry, and returned to the ready state. A retained closed
RangeKeeper campaign selected All by default and exposed all 54 recorded
receipts. Desktop 1440px and mobile 390px had no page horizontal overflow; the
mobile risk table scrolls within its own panel. There were no browser exceptions
or failed network transfers. The one console resource error was the existing
`/favicon.ico` 404, retained explicitly in the evidence. The only browser POSTs
were two empty-body `/api/session` requests; no campaign or operation was created.
Public close actions could not be exercised with an empty deployment table;
their acceptance is covered by the isolated sealed browser suite above.

Private evidence, exact previous units for rollback, candidate units, harness
provenance and verification logs are retained in
`data/dashboard-remediation-release-2026-09-29/`. Rollback requires restoring all
three saved unit files together; their previous sealed build remains available.
Work stops at this release checkpoint. Findings 6–12 and the remaining report
coverage are unchanged follow-up scope.
