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
production data. Sealed and deployed acceptance evidence will be recorded below.
