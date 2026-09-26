# Static paper MVP cutover inventory — 2026-09-26

Inventory finalized: **2026-09-26 14:52:19 UTC** (unit-state samples at
14:48:35–14:52:19 UTC). Source checkout: `/root/conc-liq`,
HEAD `caabeb7fc1b28e5ebade63ea03804a68943092bc`, with unrelated and in-flight
dirty changes present. This is a read-only operational snapshot, not a cutover
record or authorization. Environment-file contents, database URLs, wallet
addresses, RPC endpoints and credentials are intentionally omitted.

## Installed services and sealed identities

The active dashboard, tail and RPC-health units are on separate sealed source
commits. Each release manifest was verified against its installed files using
`scripts/release-files.mjs`; the process is not running the current checkout.

| Unit | Observed state / process | Pinned build | Sealed source commit | Runtime config identity |
| --- | --- | --- | --- | --- |
| `conc-liq-dashboard.service` | active/running, PID 3556318; `/etc/systemd/system/conc-liq-dashboard.service`; no drop-ins; `dashboard` entry | `3106f1c5e5b248e2ee2dfc8037274ca6728df7d2447a07553a41f3350fc1ba23` | `bf775c5e943855b41c037d205ca0c4a8e465a98a` | `data/dashboard-live-pilot.env`, SHA-256 `4669148b331548efa5f73bf15578582846b5855f2576979cb94c695f77d2c111` |
| `conc-liq-tail.service` | active/running, PID 2955021; `/etc/systemd/system/conc-liq-tail.service`; no drop-ins; `tail` entry | `3a9515a575ade5d9270be55a3e84766441ccd471154da23dc80970c65971d531` | `b3b14d832281b23846f83ffb9cf8e5fb9b2c5ea8` | `data/runtime-refactor.env`, SHA-256 `4fc0b2c97a3b5cf098a4b2e11f8573699618a4e3cfc64ad444435af87c556c8f` |
| `conc-liq-rpc-health.service` | active/running, PID 2948832; `/etc/systemd/system/conc-liq-rpc-health.service`; no drop-ins; `rpc-health` entry | `c70210f303b5dade42b2c760342488cad700fa8c6a36d548a437fb498fc93b7c` | `4e0cc26cb8aa12174811ea23b92be1ff90a7f3f4` | `data/runtime-refactor.env`, same hash as tail |
| `conc-liq-live-pilot.service` | inactive/dead; unit exists; no drop-ins | `9ef631bf07b6cde8a90cbe01152b9c66a9f67f57e25f8579ded02505baf20fca` | `a691635737baeb8eda9b263b89404ec61a93d666` | `data/live-pilot-runtime.env`, SHA-256 `b2c30cd4ae993956c23f002f482bf3508d5bc92e8f9a823767badda572f8e399` |
| `conc-liq-rangekeeper.service` | inactive/dead; unit exists; no drop-ins | `17c46693608d69a8447c8b1cfe9cfcf57307becf66a00fef373e5811c11c1219` | `295ce917a0d7c870fcc435237d4ad3461571c2a5` | `data/rangekeeper-v1-runtime.env`, SHA-256 `b46116364f7d407d4eb4519d387c8acc3705ea92961de23ca8660eb870284c1a` |
| `conc-liq-rangekeeper-live.service` | not installed | — | — | — |

The active paper command and operation-worker units
(`conc-liq-deployment-command.service` and
`conc-liq-paper-operation-worker.service`) are **not installed**. No active
static-paper worker was observed. The paper-assets checkpoint timer was active
and the strategy-checkpoint timer was waiting; their one-shot services were
inactive at the final sample. These are maintenance/checkpoint units, not
evidence that the new campaign worker is supervised or ready.

All five installed release manifests report Node `v24.20.0` and passed exact
manifest/file verification. The checkout HEAD is not the source commit of any
active service. The dashboard build predates the new deployment-command runtime
and cannot establish its readiness or API behavior.

## Database and deployment state

The four service environment files point to the same database identity
(redacted-URL SHA-256 prefix `87ba0e8351732af5`): database `conc_liq`, schema
`public`, role `root`. Queries ran in `BEGIN READ ONLY` transactions with
statement timeouts. No URL or environment value was printed.

`public.schema_migrations` contains versions **1–3**, with v1 registered as
`verified_baseline` and v2/v3 applied. The current checkout defines 11
migrations. The public schema contains none of
`deployment_campaigns`, `deployment_operations`, or
`deployment_wallet_reservations`; those relations are absent, not empty. Thus
this database snapshot cannot establish current campaign lifecycle, unresolved
operations, or live wallet reservations. No count of zero campaigns or
reservations is inferred. Applying migrations is an explicit outstanding
production gate and was not attempted.

## Predecessor worker and custody evidence

Both predecessor execution units were inactive at inventory time. This proves
only that those processes were stopped; it does **not** prove wallets, tokens,
allowances, signed transactions, nonces or external balances are clear.

Read-only local records are historical and do not settle current custody:

- `data/live-pilot-active.json` is a private mode-0600 config last modified
  2026-09-14. It identifies an NVDA/USDG live-pilot config with
  `broadcastEnabled: true` and a nonzero initial-capital setting. The associated
  runtime is now inactive, but the config is not a current custody observation.
- `data/live-pilot-status.json` is a cached status snapshot computed
  2026-09-21 13:24:51 UTC (`broadcastEnabled: true`, 50 cached action entries,
  100 cached marks). It is too old to assert current activity or closure.
- `data/live-stall-2026-09-14/current-custody.json` records state phase `closed`,
  empty pending state, and `closedAt` 2026-09-14 16:02:51 UTC. The paired
  `receipt-evidence.json` is an earlier 15:49 UTC observation with phase `exit`.
  These are archived records, not fresh canonical chain reads.
- `data/rangekeeper-emergency-stop.json` is dated 2026-09-21 and has phase
  `exit`. `data/rangekeeper-exit-final.json` says
  `complete_exit_reconciled`, last modified 2026-09-21 14:39 UTC. These local
  terminal labels still require fresh canonical reconciliation before claiming
  no predecessor exposure or signing risk.
- The configured RangeKeeper file is last modified 2026-09-22 and still names
  an AAPL/USDG continuous campaign. The corresponding service is inactive.

The fresh production custody gate therefore remains **unknown / not verified**.
Required evidence includes a current canonical position and token-balance scan,
allowance state, pending/signed transaction and nonce reconciliation, receipt
reconciliation for predecessor actions, and a documented campaign adoption or
retained read-only projection decision. Do not stop, adopt, migrate or hide
predecessor records based on this inventory.

## Intended MVP scope and release gates

The scoped first operator milestone remains static/manual **paper** only:
existing Research view and supported registered pools; centered tick half-width
setup; guarded open, pause/resume, close-retain and close-convert; shared
Positions metrics, charts, activity and history. RangeKeeper and all live
commands stay unavailable until their own gates pass. Historical predecessor
positions and operational records must remain visible.

The plan's current MVP-5 acceptance boundary still requires one clean pinned
artifact containing MVP-1 through MVP-4, both canonical static/manual paper
lifecycles through the actual browser and command/worker processes, economic
restart recovery with exact-once accounting, desktop/mobile closure parity,
manifest/unit verification, database restore rehearsal and a concrete operator
cutover record. The earlier isolated PostgreSQL restore used a synthetic V3
fixture; it proves restore mechanics only. It is not canonical economic or
sealed-artifact evidence. The browser/recovery harnesses currently under
development are not recorded here as passed acceptance.

Production authorization is **pending**. This inventory grants no authorization
to migrate the production database, install/start/stop services, enable paper
or live commands, adopt predecessor campaigns, fund, sign, broadcast or change
strategy. Before a later cutover review, close the missing database-schema and
campaign-state visibility gap, obtain fresh canonical predecessor custody and
signed-action evidence, complete the clean sealed MVP-5 acceptance gates, and
record the existing required authorization boundary for the exact proposed
change.

## Evidence provenance

Observed facts above came from `systemctl show`/unit inventory, exact release
manifest verification, SHA-256 identities of environment/config files without
reading their values into output, read-only PostgreSQL transactions, and
timestamped local state-file metadata/selected non-secret fields. No RPC call,
database mutation, migration, service action, signer access or broadcast was
performed.

## Candidate static-paper cutover proposal — 2026-09-26

This is a proposed sequence for a later, explicitly approved paper-only
cutover. It is not an executed change, and every release-dependent command
below remains unproven until the clean sealed MVP-5 gates pass and supply an
exact build ID and source commit. The production authorization boundary above
still applies. The proposed private runtime environment file is
`/root/conc-liq/data/static-paper-mvp-runtime.env`; it has not been created.

The proposal targets the current `public` schema at versions 1–3, with v1
already recorded as `verified_baseline`. The candidate release's migration
command must therefore apply versions 4–11 without `--baseline`. Before that,
the operator must establish fresh custody/ownership for predecessor campaigns,
resolve the current database and campaign visibility gap, and verify that the
old dashboard and any other retained readers tolerate schema 11. No predecessor
execution owner may be stopped, adopted or hidden on the basis of the inactive
unit sample alone.

After MVP-5 produces its clean commit, build and capture its JSON build result
from that exact checkout:

```sh
PATH=/root/conc-liq/.tools/node/bin:$PATH npm run release:build -- /root/conc-liq/releases
```

Set `BUILD_ID` and `RELEASE` from the returned `buildId` and release path; do
not infer either from a directory name or current checkout state. Verify the
artifact with its own pinned Node:

```sh
"$RELEASE/bin/node" "$RELEASE/launch.mjs" --verify
```

Before rendering, prepare the private environment file through the approved
secret/configuration process with mode 0600 and owner `root`. It must contain
the reviewed loopback command origin, operator password hash, database and
read-only RPC configuration, the approved `PAPER_FORK_RPC_URL` source used by
the temporary owned local fork, registered-profile/indexer identity, and the
explicit line `DEPLOYMENT_PAPER_OPERATION_WORKER=1`. `PAPER_FORK_RPC_URL` is
required for the owned-fork setup cost sampler and close-convert preview. Its
upstream must be the approved read-only source RPC: `openPaperFork` runs a
separate local Anvil fork at the reviewed source block; all
simulated mutations terminate locally. This is distinct from the command's
canonical `ROBINHOOD_READ_HTTP_URL`. The worker opt-in flag must be in this file:
`launch.mjs` strips inherited application environment values and constructs
`CONC_LIQ_RUNTIME_IDENTITY.configHash` from this private file. A rendered
systemd `Environment=` value would be stripped before worker startup and would
not be part of that identity. The renderer leaves the worker flag to the
private file. Do not print the file or its secret values; record only its path
and a separately captured SHA-256.

Create a database backup before migration using the approved secure mechanism
to populate `DATABASE_URL` in the protected operator shell, then run:

```sh
umask 077
pg_dump --format=custom --no-owner --no-privileges \
  --file="$BACKUP_FILE" --dbname="$DATABASE_URL"
pg_restore --list "$BACKUP_FILE" >/dev/null
```

Record the backup path, size, timestamp and SHA-256. Confirm the target identity
and registered baseline using read-only queries before proceeding. Once the
exact production migration is separately approved, apply it using the release
launcher and private environment file; do not pass `--baseline`:

```sh
"$RELEASE/bin/node" "$RELEASE/launch.mjs" \
  /root/conc-liq/data/static-paper-mvp-runtime.env migrate
```

Then verify `schema_migrations` contains the expected sequential versions
through 11 and run the store's actual read-only schema check with the pinned
Node and the private environment file (this does not migrate):

```sh
(cd "$RELEASE" && "$RELEASE/bin/node" --input-type=module - \
  /root/conc-liq/data/static-paper-mvp-runtime.env <<'NODE'
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {DeploymentStore} from './dist/src/deployments/store.js';
const env=parseEnv(readFileSync(process.argv[2],'utf8'));
const store=new DeploymentStore(env.DATABASE_URL);
try { await store.assertReady(); process.stdout.write('deployment_schema_ready\n'); }
finally { await store.close(); }
NODE
)
```

Register only a reviewed supported market profile, if it is absent, using the sealed
release CLI and the separately protected profile file:

```sh
"$RELEASE/bin/node" "$RELEASE/launch.mjs" \
  /root/conc-liq/data/static-paper-mvp-runtime.env \
  deployments-profile-register /secure/operator-input/profile.json
```

The registration CLI mutates the production catalog. Run it only after
separate explicit production authorization names the target database and the
exact profile contents/hash, chain/pool, reference policy and indexer stream/
target set. Migration or service authorization alone does not authorize this
write. Capture only the returned profile ID/hash and verification class. Once the
command service is approved and started, verify that exact profile through its
authenticated read-only `GET /api/market-profiles` response before any setup.
The registration command verifies canonical chain and independent-reference
evidence but performs a database registration write, so it is an explicitly
authorized cutover action, not a preflight read.

Render and validate the candidate unit files without installing or starting
them:

```sh
PATH=/root/conc-liq/.tools/node/bin:$PATH \
  node scripts/render-release-units.mjs "$RELEASE" \
  /root/conc-liq/data/static-paper-mvp-runtime.env "$UNIT_STAGE"
systemd-analyze verify "$UNIT_STAGE"/*.service "$UNIT_STAGE"/*.timer
```

Review the rendered `ExecStart`, absolute release and environment paths,
loopback binding, restart policy, and worker's private-file flag requirement.
Only after separate authorization for these exact service changes, install
the two rendered deployment-command and paper-operation-worker units, run
`systemctl daemon-reload`, enable/start the operation worker, then the command
service, and verify both active process identities. `/healthz` is only a
liveness response; authenticate to the loopback origin and verify the
registered profile ID/hash in `GET /api/market-profiles`. Separately verify
the actual worker lease using this read-only query, with `DATABASE_URL` loaded
through the approved protected mechanism:

```sh
psql "$DATABASE_URL" -XAtqc "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=4663::oid AND objid=18728::oid AND objsubid=2 AND mode='ShareLock' AND granted)"
```

Require `t`; an active unit or `/healthz` alone is not worker readiness. Leave
public dashboard, tail, RPC-health,
live-pilot and RangeKeeper services unchanged unless a separate reviewed action
authorizes otherwise.

Rollback is conditional on execution ownership and schema compatibility. Before
any accepted operation, a failed startup may be rolled back to the captured
prior unit/config state only after checking the old readers against schema 11.
After any accepted operation exists, do not simply stop the worker or restore
the pre-migration database: keep a compatible pinned worker available to
reconcile the same operation, preserve every post-upgrade journal row, and
choose a forward-compatible release or explicitly rehearse a full restore with
ownership established. If old execution ownership is still unknown, rollback
and campaign adoption remain blocked. None of these proposal commands were run
as part of this inventory.
