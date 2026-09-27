# Static paper MVP migration compatibility review — 2026-09-27

## Finding

The production database is at verified migration head 3. The static paper candidate is sealed as build `d507e6dedb131a883cdeb5e23cc3fc220225eacf81b009d582545636e0772645` from source `5905b470999e139234a9d5ecd268ea131dde33f2`; it expects schema through version 11. A production-derived, schema-only rehearsal applied migrations 4–11 successfully and the candidate's dashboard, indexer, RPC-health, strategy-checkpoint, perp-reference, and paper-store readers/writers passed bounded smoke checks.

This is not a production cutover authorization. Migration 11 is incompatible with the three currently installed dashboard/tail/RPC-health builds: each requires an exact three-row history and rejects version 11. The currently enabled telemetry-retention timer also rejects any history other than `[1,2,3]`. Both incompatibilities must be addressed before the schema migration. The intended narrow route is to stage the same reviewed candidate for all active/scheduled same-database consumers, preserve each existing config and argument list, and prepare the separate guard-only telemetry script update. Then migrate once, with a coordinated service transition and recovery point. Do not migrate while an old reader or timer can run against schema 11.

## Evidence and boundaries

The production identity was confirmed read-only as database `conc_liq`, role `root`, schema `public`, OID `16385`, on the same local postmaster/port as the installed services. Its migration rows are contiguous versions 1–3 with methods `verified_baseline`, `applied`, `applied`; checksums match the candidate's migration registry:

| Version | Checksum | Method |
| --- | --- | --- |
| 1 | `21b11698602d31fa939a8697820d7a352c257acefcd1ad9b4029dff06a7d8775` | `verified_baseline` |
| 2 | `91d39f64b0fd6b7a48e41c8018a9ad2c870fab8a5bd752045c479d3318e38521` | `applied` |
| 3 | `d00b267b96980422b53910ff08f09a73fbde1bf307d3bae65b30d3bdbe088cc7` | `applied` |

The private schema-only snapshot is `/tmp/conc-liq-review-evidence/production-public-schema-20260927.sql`, SHA-256 `c27d8eca7aa4a1fae4dbaddd77f4db9e0614629162bf537ad50ea5cc4a9a74dd`. Migration metadata is in `/tmp/conc-liq-review-evidence/production-public-schema-migrations-20260927.txt`. The public schema ACL was matched in the clone after restore; that clone-only ACL adjustment did not touch production. Production has existing dashboard/indexer rows, including about 64 paper sessions and approximately 15k replay-position rows. Deployment campaign, operation, and reservation relations were absent at snapshot time. No row contents or credential values were exported for this review.

Root captured and verified the consistent custom-format full backup at `data/static-paper-mvp-cutover-20260927/backups/conc_liq-before-paper-migration-20260927.dump`, mode `0600`, size `1,723,478,308` bytes, SHA-256 `a6a20cfae8fea534abb62a46ab5baae01292538a15aef0eb93f8fa4fdfb26706`. The archive listed and fully decoded successfully. It is a preparation-time recovery point; later writes are not included. This review did not restore the full archive or verify a full-data restore. Revalidate the recovery point and schema at cutover; do not treat routine indexer writes alone as invalidating a consistent backup.

## Migration rehearsal

The disposable database `conc_liq_schema_rehearsal_20260927` used a production-derived `public` schema and the exact production migration rows 1–3, without production table data. On PostgreSQL 14.24, using the application role `root`, candidate `npm run db:migrate` applied versions `[4,5,6,7,8,9,10,11]`. A rerun applied no versions. The evidence is in:

- `/tmp/conc-liq-review-evidence/schema-rehearsal-v3-to-v11-20260927.log`
- `/tmp/conc-liq-review-evidence/schema-rehearsal-rerun-20260927.log`

Review of migrations 4–11 found additive creation of paper/deployment tables, indexes, functions, triggers, and constraints. They do not alter, drop, or rename the existing version-3 tables. Version 8 adds indexer event timestamp coverage relations; version 11 adds position-manager transfer history relations. The migration runner verifies known checksums, takes a schema-scoped advisory lock, and executes the complete pending batch in one transaction with bounded lock and statement timeouts. On failure before commit, the whole pending batch rolls back to the prior head; verify head 3 and checksums before deciding what to do after any failure or uncertain connection outcome. Do not manually delete migration history or remove newly-created objects.

The version-4–11 migration SQL does not alter, drop, or rename `v3_strategy_pool_checkpoints`, `v3_strategy_checkpoint_runs`, `asset_risk_snapshots`, or `risk_snapshot_runs`. Their retention target/witness columns and join/time columns (`checkpoint`, `snapshot`, `checkpoint_run_id`, `run_id`, `captured_at`, `observed_at`, and parent `id`) have the same types/nullability in the production snapshot and upgraded clone. The schema-only rehearsal does not prove data-dependent backfill behavior, production-scale lock duration, full-data restore, or every scheduled job against representative production rows. The exercised migrations are additive, but the cutover still needs a fresh preflight of migration head/checksums, active leases/jobs, service identities, and backup recoverability.

## Reader compatibility and bounded smoke

Against the upgraded clone, actual `assertSchemaReady` functions from the installed sealed builds failed closed:

| Consumer | Installed build | Required history | Result at v11 |
| --- | --- | --- | --- |
| Dashboard | `3106f1c5e5b248e2ee2dfc8037274ca6728df7d2447a07553a41f3350fc1ba23` | exactly 3 | rejected |
| Tail | `3a9515a575ade5d9270be55a3e84766441ccd471154da23dc80970c65971d531` | exactly 3 | rejected |
| RPC health | `c70210f303b5dade42b2c760342488cad700fa8c6a36d548a437fb498fc93b7c` | exactly 3 | rejected |

The candidate build passed base schema readiness, indexer timestamp schema readiness, and deployment schema readiness at v11. Its dashboard repository read `positions`, `snapshot`, and `research`; the indexer store committed one synthetic event/checkpoint/cursor/timestamp-coverage row; the RPC-health store wrote and read one synthetic healthy sample. Strategy-checkpoint, perp-reference, and paper stores passed readiness. All synthetic writes were confined to the disposable clone. Detailed evidence:

- `/tmp/conc-liq-review-evidence/schema-reader-compatibility-v3-to-v11-20260927.json`
- `/tmp/conc-liq-review-evidence/d507-reader-indexer-rpc-smoke-20260927.json`

These checks do not exercise external RPCs, a live timer invocation, real indexer replay, production service supervision, or production data writes.

## Installed same-database consumers

The bounded unit inventory identified these active services and enabled recurring jobs on the same database:

| Consumer | Current artifact / entry | Existing arguments and configuration |
| --- | --- | --- |
| Dashboard service | build `3106f1c…1ba23`, `dashboard` | existing dashboard config; preserve `HISTORY_SOURCE` and `ADAPTIVE_PAPER_STATE_PATH` when deriving the candidate environment |
| Tail service | build `3a9515a…d531`, `tail` | existing `runtime-refactor.env` |
| RPC-health service | build `c70210f…93b7c`, `rpc-health` | existing `runtime-refactor.env` |
| Strategy checkpoint timer | build `c70210f…93b7c`, `strategy-checkpoint` | `runtime-refactor.env`, `--rwa NVDA --fee 500` |
| Paper-assets checkpoint timer | build `c70210f…93b7c`, `strategy-checkpoint` | `paper-assets-checkpoint-2026-09-13.env`, no extra arguments; confirmed same database identity |
| Perp reference timer | build `c70210f…93b7c` | `perp-reference snapshot`, then `perp-basis --rwa NVDA --fee 500` |
| Accounting timer | build `3a9515a…d531` | `runtime-refactor.env`; `accounting --if-new-source`, `principal --if-available`, `nft --if-configured`, `backtest --if-available`, `action-cost --lookback-blocks 50000 --max-per-class 25` |
| Telemetry retention timer | checkout script `scripts/maintenance/prune-telemetry.mjs` | `.env`, `--retain-days 7`; current guard requires exactly history `[1,2,3]` |

The candidate artifact includes the command entrypoints used above. Before cutover, mechanically compare every staged unit's executable, environment-file path, command, and flags with the inventory; do not broaden permissions or enable new commands. The candidate has not yet been installed or started as a service.

Cap-validation and recenter-validation timers were enabled but expired one-shots last run on September 14; RangeKeeper was enabled-on-boot but inactive and unscheduled at inventory time. Telemetry retention is separate from the sealed release and remains a production compatibility blocker until the staged guard update is applied during the approved cutover. The guard-only change was committed separately as `dc2fedeb1a5c21b2f5e39e7e17e3c12c0ee74461`; its candidate script SHA-256 is `0a7d9dfb29015c17652dc947e0189a2f608472886fbe7db20e509d3dc541d8a5`. Its diff adds the frozen checksum registry import and validates only exact contiguous checksum histories of length 3 or 11; pruning SQL/body is unchanged. With Node `v24.20.0`, `--dry-run --retain-days 7 --verify-sample 0` accepted both valid histories on the disposable v11 clone. It rejected a modified checksum, missing migration, future version, and partial/gapped history before reaching target queries; each rejection was `Unexpected migration history`. Synthetic migration metadata was restored to exact rehearsed v11 afterward. Both valid dry-runs found zero eligible rows and pruned zero rows. Evidence is in `/tmp/conc-liq-review-evidence/telemetry-guard-valid-v3.log`, `telemetry-guard-valid-v11.log`, `telemetry-guard-bad-checksum.log`, `telemetry-guard-missing.log`, `telemetry-guard-future.log`, and `telemetry-guard-partial.log`. No actual retention/pruning execution was performed. The disposable rehearsal database was dropped after these checks; its absence was verified. Do not substitute disabling retention indefinitely for compatibility.

## Cutover, rollback, and forward recovery

1. Before the separately authorized cutover, re-check production database identity, schema migration rows/checksums, absence of a migration/worker lease, deployment relation counts, and all enabled/current same-database units. Confirm candidate artifact identity and its immutable release verifier; stage the same reviewed candidate for the dashboard, tail, RPC-health, and the listed active/scheduled jobs. Stage the reviewed retention-guard update. Preserve each existing config file, env semantics, entry command, and arguments. No secret values need to be copied into review logs.
2. Confirm the chosen consistent full backup and recovery procedure meet the cutover recovery point. The recorded preparation backup is verified as an archive but has not been restored as a full database. Establish whether the cutover-time snapshot remains an acceptable recovery point; refresh it only if the recovery point is unsuitable, not automatically for each indexer write.
3. At cutover, quiesce same-database consumers under the approved operational procedure, verify no relevant lease/transaction is active, apply the candidate's explicit migration command once, and verify contiguous checksummed history through 11. Bring up candidate consumers only after schema readiness checks pass. Observe service health and the bounded dashboard/indexer/RPC checks before resuming scheduled work.
4. If the migration transaction fails, use the migration runner's rollback and investigate while services remain quiesced. If migration succeeds but a candidate consumer fails, prefer a forward code/config correction or restore a compatible candidate consumer. The old v3-only readers cannot safely be reactivated on schema 11.
5. A full pre-migration database restore after post-migration application/indexer writes would erase those later writes. Do not use it as an automatic rollback. Any restore requires a separately reviewed recovery point and explicit reconciliation of writes/actions since that point. No broad reverse DDL or hand-edited migration history is proposed.

No production migration, unit replacement/restart, retention run, or database write was performed for this review. Production cutover, activation, signer/broadcast capability, and live trading remain outside this preparation.
