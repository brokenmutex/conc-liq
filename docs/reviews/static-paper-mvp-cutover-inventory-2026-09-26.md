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
