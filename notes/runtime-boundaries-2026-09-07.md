# First architecture refactor: schema and release boundaries

This implements stages 0–1 of the [architecture review](architecture-review-2026-09-07.md).
Implementation was isolated on `refactor/runtime-boundaries` in
`/root/conc-liq-runtime-refactor`, then activated at the idle session boundary
at 11:42 UTC. Services now run the pinned release; no new paper session was started. The dashboard redesign and
strategy-contract extraction remain subsequent slices.

## Changes

- Routine stores and entrypoints now call `assertReady()`, a read-only migration
  history/checksum check. Replay startup and dashboard startup also check schema
  compatibility. Workers never apply the frozen schema SQL.
- `db:migrate` is the only application entrypoint that performs schema changes.
  A transaction, advisory lock, five-second lock timeout and sixty-second
  statement timeout bound migration work. Each applied version records a
  checksum and method. Unknown versions, missing versions and changed checksums
  stop workers rather than prompting an implicit repair.
- Version 1 freezes the previous schema. On an empty schema it creates the
  baseline. On an existing unversioned schema it requires `--baseline`, compares
  catalog structure, and registers the existing schema without rerunning legacy
  data updates or constraint drops. Version 2 adds nullable runtime identity
  columns to paper sessions and execution evidence. Old rows remain unchanged.
- New paper sessions record build ID, configuration hash and Node version.
  A tick checks those identities before any simulated execution. Execution
  evidence records the same identity, and new-session evidence with a missing
  or different identity is rejected. Older closed records remain readable.
- Release building copies compiled code, dependencies, Node and Anvil binaries,
  configuration manifests, UI assets and the two currently required rehearsal
  artifacts into a separate, sealed directory. A manifest hashes its contents.
  The launcher verifies the release before each invocation and uses its pinned
  binaries. No application `src/`, `.env`, wallet keys or shared `node_modules` symlink is
  installed into a release.
- The service renderer produces reviewable units with explicit release paths,
  preserving all accounting/perpetual job arguments and timers. It does not
  install units or start services. All generated workers read one explicitly
  selected private runtime environment file, rather than inheriting sibling
  project settings with different precedence.

The existing paper strategy, 24/7 reference policy, order contents and integer
performance calculations are unchanged. A release/configuration mismatch is an
operational error, not a new strategy exit signal or a fabricated fill.

## Verified legacy schema differences

A read-only comparison of the current database with a fresh schema found:

- older combined range-simulation and weekend-assessment checks that predate
  fields subsequently protected by additional named checks;
- an additional historical perpetual fallback constraint;
- duplicate equivalent check definitions left by earlier additive migrations.

Column types, nullability, defaults and index definitions matched. The baseline
verifier accepts either the fresh frozen catalog or **one exact reviewed legacy
catalog digest**, recorded in `src/storage/legacy-baseline.ts`. Its constraint
fixture is in `test/fixtures/legacy-schema-constraints.json`. Constraint names
and duplicate identical constraints do not affect the canonical comparison;
constraint definitions and validation status do. Unrecognized differences fail
and roll back the entire migration. No existing constraints are weakened,
removed or automatically reconciled during registration. Schema fingerprints
use PostgreSQL's catalog formatting; a major PostgreSQL upgrade requires a
separate review, rather than accepting an unexplained new digest.

## Regression and integration checks

Run from this checkout with Node 24:

```bash
export PATH=/root/conc-liq/.tools/node/bin:$PATH
npm run check
# Supply TEST_DATABASE_URL through a private environment, not shell history.
npm run test:integration
```

The 81-transition fixture from closed paper session 4 preserves every recorded
status/action, reason list and monetary result, including final NAV 996.580017
USDG, P&L −3.419983 USDG and alpha −1.290882 USDG. It uses original states and
execution measurements, with swap paths reconstructed from indexed events.
Persistence time substitutes for decision time; it does not claim to reconstruct
an unrecorded preflight risk snapshot or replay RPC. Policy parsing preserves
its original hash despite PostgreSQL JSON key ordering.

The stable integration harnesses use random temporary schemas and remove them
in `finally` blocks. They require `TEST_DATABASE_URL` explicitly and never use
public application tables as fixture templates. The lifecycle harness uses
synthetic collector rows and a stub executor, retaining real constraints on
paper tables; it is a mechanics test, not measured trading performance.
Migration tests use the complete real schema, including a reconstruction of the
reviewed production constraint variant. They cover atomic drift rejection,
legacy-row preservation, read-only checks and readiness under application-table
locks. The lifecycle audit covers duplicate ticks, restart, failed exit retry,
concurrent cancellation, revoked canonicality and runtime/evidence identity.
Unit cases retain the existing missing, collecting, failed and stale risk
behavior without relaxing its policy.

## Build and review a release

Commit the reviewed source first. Builds reject dirty tracked or untracked
source. The installed dependency tree is copied and content-hashed, rather than
resolved again during the build; test the same tree before building.

```bash
npm run release:build -- /root/conc-liq-releases
# The command prints the content-addressed release directory.
/release/path/bin/node /release/path/launch.mjs --verify
node scripts/render-release-units.mjs /release/path /private/runtime.env /tmp/conc-liq-units
systemd-analyze verify /tmp/conc-liq-units/*.service /tmp/conc-liq-units/*.timer
```

Use the printed absolute path in place of `/release/path`; the renderer accepts
simple absolute paths without spaces or systemd specifiers. No mutable `current`
symlink is used in generated `ExecStart` or `WorkingDirectory` values.

Create a dedicated mode-0600 runtime environment file with the existing intended
application settings. Set `DATABASE_URL`, `INDEXER_STREAM_KEY`,
`RH_INDEXER_RPC_URL`, provider roles and history settings explicitly. Preserve
the bounded provider settings and disabled full historical accounting. Do not
copy unrelated sibling-project credentials or wallet settings. The launcher
owns Node/Anvil/PATH settings and rejects reserved overrides. Any JSONL or other
writable output path must point outside the sealed release directory.

The configuration fingerprint covers the entire dedicated file's parsed
key/value mapping, including private endpoint settings, but only its hash is
stored in the database. Comments/order do not change it. Any value change,
including a dashboard-only option or credential rotation, requires a deliberate
session/configuration boundary in this first conservative implementation.
Environment values are not printed by release building or unit rendering.

A release smoke test starts and cancels a synthetic session in an isolated
schema and verifies that configuration drift cannot execute it:

```bash
# TEST_DATABASE_URL and TEST_RELEASE_DIR must be provided privately.
node test/integration/release.mjs
```

This test uses a loopback RPC address with no server and no checkpoints. It
performs no chain calls and proves the compiled launcher/migrator/session path,
not live fills or receipt economics.

## Activation boundary and rollback

Activation is a separate operational step; this change does not activate itself.
Use a terminal paper session boundary and confirm no simulation is in progress.
Pause the existing writers/timers for the explicit migration so the old code
cannot queue its startup DDL concurrently. Keep the previous service files and
release/configuration available for rollback.

1. Verify the exact release and reviewed private configuration, including the
   explicit private-node route and authenticated reference roles.
2. Run `/release/path/bin/node /release/path/launch.mjs /private/runtime.env migrate --baseline`
   for this existing unversioned database. A fresh database omits `--baseline`.
3. Install the reviewed generated units, reload systemd, then resume the intended
   collector/monitor/dashboard services and timers. Do not blindly enable jobs
   that were deliberately disabled.
4. Check schema readiness, provider agreement, event coverage and fresh
   checkpoints before explicitly starting the next paper session with
   `/release/path/bin/node /release/path/launch.mjs /private/runtime.env paper start`.
   The timer advances that session; it does not create recurring sessions.
5. Record the session's policy hash, build ID and configuration hash. Observe
   the first checkpoint and decision; no wallet or broadcast is enabled.

Existing unversioned active sessions must finish on their original code; the new
worker will refuse to invent their missing build provenance. Cancellation can
still be requested, but an entered position needs its matching runtime to
perform the later simulated exit. Historical readers may inspect closed legacy
records without assigning them a new runtime identity.

The version-2 additions are nullable and additive. Before a new session starts,
rollback to the prior compatible service release does not require deleting
columns, migrations or ledger history. Once a new session exists, preserve and
use its pinned runtime to finish/cancel it; do not resume it under old source
code that lacks runtime checks. Future schema changes must append migrations and
declare a compatibility window; the current implementation intentionally rejects
unknown versions. A rollback never rewrites a policy hash or trading history.

## September 7 activation evidence

[Recorded rollout checks](runtime-boundaries-evidence-2026-09-07.json) identify
source commit `3ba0a8e` and build
`baf8904628469d4b071581514a7b7eb9a066740b081a49ed7d6b972b0df8e4b6`.
Schema versions 1 and 2 committed at 11:42:13 UTC. Version 1 used verified
baseline registration. The old paper rows retain null runtime metadata;
session 4 retains its original policy hash and −3.419983 USDG result.

At 11:44:59 UTC the RPC monitor, tail, dashboard and all four previously active
timers were active. RPC health was healthy, replay was advancing, checkpoint
599 covered block 56,807,996, the dashboard returned HTTP 200 with canonical
legacy-session evidence, and the paper timer completed with no active session.
The targeted checkpoint and perpetual jobs had successful exit status. The
hourly accounting job had a failure before this rollout; its timer was restored
without forcing additional historical work. This slice does not claim that
preexisting accounting issue is resolved.

Validation passed: typechecking, 209 unit tests, the isolated migration and
lifecycle audits, compiled-release migration/start/tick/config-drift/stop smoke
test, and systemd unit verification. systemd emitted an unrelated existing
`snapd.service` warning about `RestartMode`; no generated conc-liq unit was
rejected. The dedicated mode-0600 configuration preserves the project settings
and explicitly supplies the private-node route. No conflicting overlapping
project/sibling environment values were found; unrelated sibling credentials
were not copied.

Previous installed units are saved under
`/root/conc-liq/data/runtime-rollout-2026-09-07/previous-units/`. The deployed
private environment is `/root/conc-liq/data/runtime-refactor.env`; its contents
are deliberately excluded from Git and the evidence report.
