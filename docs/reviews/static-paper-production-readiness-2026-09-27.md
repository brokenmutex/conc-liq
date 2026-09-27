# Static paper production readiness inventory — 2026-09-27

This is a read-only deployment-preparation snapshot. It does not authorize a database migration, service change, profile registration, signer use, or activation.

## Current database and paper boundary

The installed runtime environment files and the local backup target resolve to the same PostgreSQL instance: database `conc_liq`, schema `public`, database OID `16385`, port `5432`, and the same postmaster start time. The connection URL was not recorded. The coordinator completed one root-owned custom-format backup and verified its full archive decoding; its identity and recovery-point limits are recorded in the [rollout package](static-paper-rollout-package-2026-09-27.md). This inventory did not create another copy.

Public migration history is versions 1–3, with checksums matching the current repository's reviewed baseline. The repository contains 11 migrations. The new `deployment_*` relations (`deployment_campaigns`, `deployment_operations`, and wallet reservations) are absent from `public`, rather than empty. The two proposed deployment services are not installed. The paper-operation worker readiness lock is not held; the only observed advisory lock is the expected active tail stream lock.

The installed predecessor records are historical and closed: `live_pilot_v1` has one campaign in `closed` / `stopped`; `rangekeeper_v1` has two, also `closed` / `stopped`. Their persisted histories remain present (17,667 live-pilot marks and 4,449 RangeKeeper marks). Action ledgers contain 299 confirmed and 3 reverted live-pilot actions with receipts, 59 cancelled actions without hashes, and 88 confirmed RangeKeeper actions with receipts. No action is in prepared or signed state. No current static-paper deployment campaign exists in the public schema.

These records do not establish present on-chain custody. No predecessor adoption, wallet transfer, or stop is proposed for this paper-only rollout, and the new command/worker design has no signer or broadcast path. Accordingly, this inventory does not assert that predecessor wallets are empty, that every NFT is enumerated, or that offline signatures do not exist. Predecessor records and owner remain untouched. A block-pinned custody refresh is required before any later proposal to adopt or change predecessor ownership; that is outside this no-adoption cutover.

## Installed database consumers

All seven active or currently scheduled sealed-release services below connect to this same database. Their installed artifacts were checked against their release manifests; each has a single `/etc/systemd/system/<unit>.service` fragment and no drop-ins.

| Unit | Current activity | Installed command and environment | Release identity | Migration 11 status |
|---|---|---|---|---|
| `conc-liq-dashboard.service` | Active | `launch.mjs <dashboard-live-pilot.env> dashboard` | build `3106f1c5e5b248e2ee2dfc8037274ca6728df7d2447a07553a41f3350fc1ba23`, source `bf775c5e943855b41c037d205ca0c4a8e465a98a` | Requires exactly schema 3; must be replaced before migration 11. |
| `conc-liq-tail.service` | Active | `launch.mjs <runtime-refactor.env> tail` | build `3a9515a575ade5d9270be55a3e84766441ccd471154da23dc80970c65971d531`, source `b3b14d832281b23846f83ffb9cf8e5fb9b2c5ea8` | Requires exactly schema 3; must be replaced before migration 11. |
| `conc-liq-rpc-health.service` | Active | `launch.mjs <runtime-refactor.env> rpc-health` | build `c70210f303b5dade42b2c760342488cad700fa8c6a36d548a437fb498fc93b7c`, source `4e0cc26cb8aa12174811ea23b92be1ff90a7f3f4` | Requires exactly schema 3; must be replaced before migration 11. |
| `conc-liq-strategy-checkpoint.service` | Enabled, every minute | `launch.mjs <runtime-refactor.env> strategy-checkpoint --rwa NVDA --fee 500` | build `c70210f…`, source `4e0cc26…` | Requires exactly schema 3; must be replaced before migration 11. |
| `conc-liq-paper-assets-checkpoint.service` | Enabled, every 30 seconds | `launch.mjs <paper-assets-checkpoint-2026-09-13.env> strategy-checkpoint` | build `c70210f…`, source `4e0cc26…` | This is the same `strategy-checkpoint` entrypoint with a distinct environment, not a separate `paper-assets-checkpoint` command. It requires exactly schema 3 and must be replaced before migration 11. |
| `conc-liq-perp-reference.service` | Enabled, every five minutes | Two `ExecStart`s: `launch.mjs <runtime-refactor.env> perp-reference snapshot`; `launch.mjs <runtime-refactor.env> perp-basis --rwa NVDA --fee 500` | build `c70210f…`, source `4e0cc26…` | Requires exactly schema 3; must be replaced before migration 11. |
| `conc-liq-accounting.service` | Enabled, hourly | Five `ExecStart`s: `accounting --if-new-source`; `principal --if-available`; `nft --if-configured`; `backtest --if-available`; `action-cost --lookback-blocks 50000 --max-per-class 25` (each via `launch.mjs <runtime-refactor.env>`) | build `3a9515a…`, source `b3b14d8…` | Requires exactly schema 3; must be replaced before migration 11. |

The three installed release families were manifest-verified. Each bundles `assertSchemaReady` with `REQUIRED_SCHEMA_VERSION = 3` and requires exactly three migration rows with matching checksums. The current source compatibility guard permits only reviewed contiguous histories through version 11. Consequently, all seven listed services—not only the three long-running services—must have compatible replacements in place before migration 11.

The enabled daily `conc-liq-telemetry-retention.timer` is a separate current database consumer. It runs the checkout script `scripts/maintenance/prune-telemetry.mjs --retain-days 7` with `/root/conc-liq/.env`, not a sealed release. The script asserts migration history exactly `[1, 2, 3]` before updating two v3 telemetry child tables. It therefore also fails closed after migration 11 unless its compatibility guard and retained-row semantics are explicitly reviewed. Its existing exact-parent recovery checks and schema-specific behavior should remain covered; it is not one of the seven service replacements above.

## Other unit posture

The enabled `conc-liq-cap-validation.timer` and `conc-liq-recenter-validation.timer` are dated one-shot timers whose scheduled time was 2026-09-14; both show `next=n/a` and last triggered on that date. They are not currently scheduled work and should not be reactivated as part of this cutover. Timers for `paper-aapl`, `paper-googl`, generic `paper`, and `live-pilot-bootstrap` are disabled.

`conc-liq-rangekeeper.service` is enabled at boot but is inactive and has no timer. Record that boot posture during rollout planning; do not activate it. `conc-liq-paper.service`, `conc-liq-adaptive-paper.service`, and `conc-liq-live-pilot.service` are inactive. No predecessor controller service is currently active.

## Evidence and boundary

Read-only evidence was captured from `systemctl`, verified installed release manifests, and a PostgreSQL `BEGIN READ ONLY` audit with a bounded statement timeout. Environment values, database URLs, signer material, wallet addresses, RPC URLs, and raw transaction data were not included in this report. A private/redacted database snapshot is retained at `/tmp/conc-liq-production-readiness-private-20260927-db.json` with mode `0600`.

The compatibility cutover must account for the seven sealed consumers plus the separate retention timer. This report does not authorize changing any service, timer, database schema, or predecessor state.
