# Static paper MVP rollout package — 2026-09-27

This is the review package for a proposed cutover to the sealed static-paper
MVP. It records prepared files and the required order; it is not authorization
to migrate the production database, register the market profile, install units,
or start services. No such action has been performed.

## Candidate and prepared inputs

- Sealed release: build `d507e6dedb131a883cdeb5e23cc3fc220225eacf81b009d582545636e0772645`, source `5905b470999e139234a9d5ecd268ea131dde33f2`, staged at
  `/root/conc-liq/data/releases/d507e6dedb131a883cdeb5e23cc3fc220225eacf81b009d582545636e0772645`.
  The release's pinned Node verified its manifest (`--verify` returned
  `verified: true`).
- Private runtime environment: `/root/conc-liq/data/static-paper-mvp-runtime.env`,
  mode `0600`, SHA-256
  `69f8aa687cf10c3e6b3247c49bb1a5855ec7f21647190d210363c45121f14ea9`.
  Its launcher configuration hash is
  `74ae1d23bc52bb13a0476a03cc55dcd7a2fc3210f3ea0bec8be336f2ec22c875`.
  It preserves the existing dashboard's history and adaptive-paper state
  sources. Validation found no signer or live-broadcast capability in this
  environment; deployment binds to loopback on port 4174, which was free at
  preparation time.
- Operator credential handoff: plaintext exists only at
  `/root/conc-liq/data/static-paper-mvp-cutover-20260927/operator-password.txt`
  (mode `0600`, parent mode `0700`). The runtime environment contains the
  repository-compatible password hash. Neither value is included here.
- Supported AAPL profile: `/root/conc-liq/data/static-paper-mvp-cutover-20260927/aapl-market-profile.json`,
  mode `0600`, file SHA-256
  `00b4fad89adf91fcf5c4d93c77a068ca87fcb308246d74fd92ac625818d91882`,
  canonical profile hash
  `c8f6e18c61b1eb190d0ad07712d4a885df108a1adf7160c5174b586605b92c52`.
  It was built from the tested AAPL disabled RangeKeeper market profile and
  contains no signer, wallet, or broadcast authorization. It has not been
  registered in production. The candidate's existing `verifyMarketProfile`
  function was run read-only against the configured RPC and this exact file at
  `2026-09-27T07:16:00.948Z`: verification class
  `canonical_chain_and_independent_reference_v1`, chain 4663, block `73752931`,
  block hash `0xb8f405a98c4831b3cc17c0e33b8a2d9e1b093c7f667b823dcfe41bd8691ca5b2`,
  expected profile hash, and matching pool, token, manager, and quoter code
  hashes. Independent-reference proof hash:
  `4b17683f6341c1e294cc4db806382532da2cedee86b06cd4b1478045ebdfcbc2`. This
  read-only RPC validation did not access the production database or register
  the profile; repeat it during cutover because chain/reference state can
  change.
- Prepared service fragments are in
  `/root/conc-liq/data/static-paper-mvp-cutover-20260927/units` (directory
  mode `0700`; files mode `0600`). This is exactly seven existing service
  replacements plus the two new static-paper services. For the seven copied
  fragments, the release path in `ExecStart` and `WorkingDirectory` now point to
  d507; commands, arguments, environment paths, and service hardening are
  preserved.

| Prepared service | SHA-256 |
|---|---|
| `conc-liq-dashboard.service` | `131690df4999f630a11a85b702e6193ab3aa9e5e00700207ba561d1c8f505a4d` |
| `conc-liq-tail.service` | `3d85fa4b40d5461577bed00950a29ed7461b6918802a5f69d3ce029699abb01a` |
| `conc-liq-rpc-health.service` | `d58e4985c231e51f55d029ca3c08eef2a34f6aa312b49b233084b5ae4b39031a` |
| `conc-liq-strategy-checkpoint.service` | `474d53659410c9b2b76b01d8ee939c99b5fa42f5a0f0bf74860a7fc3439f13c7` |
| `conc-liq-paper-assets-checkpoint.service` | `43cc9b9612884c5466f1deb0c264fbcb597cefb95c431666ce843a4b9a0b810c` |
| `conc-liq-perp-reference.service` | `d5e251bf2ec44c5f10efb38b7cb98f4681602dd48737dd218549b30d84a9ed99` |
| `conc-liq-accounting.service` | `d0915c65458628dd8d60e42a01cdcc80a7b4f42f70e123603a5cc4a02d8a4e0c` |
| `conc-liq-deployment-command.service` | `0aa9ce8c8ee20adac8c070e28b5c2103548eee6fdf5051650cb3bfcb387179cf` |
| `conc-liq-paper-operation-worker.service` | `139921b32b09516a13e9653a79e7a80832cf03758d5459fb96447b6a76b2c365` |

Original copies of the seven replaced fragments are preserved privately at
`/root/conc-liq/data/static-paper-mvp-cutover-20260927/original-units`
(directory/files mode `0700`/`0600`):

| Original service fragment | SHA-256 |
|---|---|
| `conc-liq-dashboard.service` | `48105420ee67d51c664292bc8b8eb19b9bb4d96b781e8817dd3595d357cdfbb6` |
| `conc-liq-tail.service` | `6b3555c5a6d89e1275efbf4890e63cb458bb5739f4dcb4da59e4d68608bd47f6` |
| `conc-liq-rpc-health.service` | `cf3fbd8693006706ed71fcc2c84122c4119855df9f1c27b70d0b03917748b9ac` |
| `conc-liq-strategy-checkpoint.service` | `59a34b035c48f6d36215f6dc369f6777fb3f17fb0f0d0b16883f2944e6067617` |
| `conc-liq-paper-assets-checkpoint.service` | `6c1c444b000fd92b3fd426d136887ba7cd397221e2a42b5a9b1e869b2868e3d4` |
| `conc-liq-perp-reference.service` | `c6f627e47d58948d2ec5cda8eaadd7af43d9737ef3defb5b1c2bb9a24bd2cf78` |
| `conc-liq-accounting.service` | `1192440ace483366a253f30c4937fbc699cbffecce6746cc7db2e199255fc213` |

The copied-unit diff changes only the sealed release path in `ExecStart` and
`WorkingDirectory`; command names, arguments, environment files, service
hardening, and restart policy remain unchanged. The two new units use the
reviewed loopback command and worker configuration. `systemd-analyze verify`
passed for the staged service files, with one unrelated
host `snapd.service` warning. No timer fragment is staged or changed. Timer
names and enabled/scheduled state must be rechecked immediately before any
approved cutover. The four existing scheduled service timers are
`conc-liq-strategy-checkpoint.timer` (about every minute),
`conc-liq-paper-assets-checkpoint.timer` (about every 30 seconds),
`conc-liq-perp-reference.timer` (about every five minutes), and
`conc-liq-accounting.timer` (hourly). Pause these timers during replacement;
resume their existing schedules only after compatible readers are active. Do
not manually launch their one-shot jobs during startup. Telemetry retention is
a separate daily checkout script on `conc-liq-telemetry-retention.timer`, not a
service replacement; it currently rejects migration history 11. The reviewed
guard-only candidate at
`/tmp/conc-liq-telemetry-compat-20260927/scripts/maintenance/prune-telemetry.mjs`
has SHA-256 `0a7d9dfb29015c17652dc947e0189a2f608472886fbe7db20e509d3dc541d8a5`
and commit `dc2fedeb1a5c21b2f5e39e7e17e3c12c0ee74461`. It preserves the pruning
body and accepts valid checksummed histories 3 and 11 while rejecting corrupt,
missing, future, or gapped histories on a clone. Cherry-pick that standalone
commit only while the retention timer is paused; resume it only after the
production migration head is verified compatible.

## Evidence and compatibility boundary

- [Production readiness report](static-paper-production-readiness-2026-09-27.md)
  is the source for the live service/timer inventory, database identity,
  campaign/action state, and operational readiness checks.
- [Migration compatibility report](static-paper-migration-compatibility-2026-09-27.md)
  records old-reader rejection, candidate-reader acceptance, and the isolated
  telemetry-retention guard review. Candidate d507 passed read-only dashboard,
  tail/indexer, RPC-health, strategy-checkpoint, perp-reference, and paper
  store smoke checks on a disposable upgraded clone. Evidence is at
  `/tmp/conc-liq-review-evidence/d507-reader-indexer-rpc-smoke-20260927.json`.
- Pre-migration backup evidence is
  `/root/conc-liq/data/static-paper-mvp-cutover-20260927/backups/backup-evidence.json`:
  custom dump size `1,723,478,308` bytes, SHA-256
  `a6a20cfae8fea534abb62a46ab5baae01292538a15aef0eb93f8fa4fdfb26706`.
  It is a consistent snapshot, not a guarantee that later writes are included.
  Revalidate its age, schema, and recovery point at cutover; refresh if it no
  longer covers the intended recovery point. Never automatically restore it
  over newer indexer or operation-journal rows.

The currently installed dashboard, tail, and RPC-health releases enforce schema
3 and reject schema 11. Candidate d507 accepts schema 11 and its indexer and
deployment schema gates passed on the rehearsal clone. Therefore, after the
migration, old schema-3 readers must remain stopped; rollback cannot simply
restart those builds. The staged existing-service replacements preserve their
original arguments and flags. The paper command and worker are new loopback-only
services. A registered profile and running units are not prerequisites for
performing the migration, but they are prerequisites for the operator workflow;
profile registration is a separate production database write and remains
unperformed.

## Unexecuted cutover sequence

Every command/action in this section is proposed and remains unexecuted.
Reconfirm the target database, backup recovery point, exact current timers,
profile hash, and staged file hashes immediately before separate cutover
authorization.

1. Stop the four service timers listed above and
   `conc-liq-telemetry-retention.timer` to prevent new jobs. Wait for current
   one-shot jobs and the retention job to finish within a bounded window; if a
   job remains, stop its service cleanly. Stop the three continuously active
   old services (`dashboard`, `tail`, and `rpc-health`). Confirm no old process,
   relevant transaction, or database session remains before migration. Do not
   enable or activate dormant legacy paper, live-pilot, adaptive, or RangeKeeper
   units.
2. With the retention timer paused, apply the standalone guard commit:
   `git -C /root/conc-liq cherry-pick dc2fedeb1a5c21b2f5e39e7e17e3c12c0ee74461`.
   Confirm the pruning body is unchanged. Clone validation already covers
   histories 3 and 11 plus corrupt-history rejection; do not run a mutating
   retention job during the cutover.
3. Install the seven prepared replacements and the two new paper service files
   from the staged `units` directory, then run `systemctl daemon-reload` and
   `systemd-analyze verify`. Keep the existing timer definitions and schedules.
4. Reconfirm the backup evidence and database identity, then apply the pinned
   migration (without a baseline override):

   ```sh
   RELEASE=/root/conc-liq/data/releases/d507e6dedb131a883cdeb5e23cc3fc220225eacf81b009d582545636e0772645
   "$RELEASE/bin/node" "$RELEASE/launch.mjs" \
     /root/conc-liq/data/static-paper-mvp-runtime.env migrate
   ```

5. Verify sequential schema migrations through 11 and run the candidate's
   read-only deployment schema check. Confirm the compatibility report's
   acceptance gates against the actual target database before starting readers.
6. Start only the three continuously active compatible readers (`dashboard`,
   `tail`, and `rpc-health`). Enable and start
   `conc-liq-paper-operation-worker.service` before
   `conc-liq-deployment-command.service` so both new services are supervised
   across boot. Verify process identities, loopback binding, authenticated
   operator access, and the worker lease. Do not expose the command service
   publicly.
7. Resume the four existing service timers and the telemetry-retention timer
   only after compatible readers are active and the migration head is verified.
   Keep their existing schedules; do not manually invoke one-shot jobs as
   startup checks.
8. Register the reviewed AAPL profile only under separate explicit approval
   naming the target database, profile hash
   `c8f6e18c61b1eb190d0ad07712d4a885df108a1adf7160c5174b586605b92c52`, chain
   4663, pool `0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D`, reference policy, and
   existing AAPL indexer stream/target set. The unexecuted command is:

   ```sh
   RELEASE=/root/conc-liq/data/releases/d507e6dedb131a883cdeb5e23cc3fc220225eacf81b009d582545636e0772645
   "$RELEASE/bin/node" "$RELEASE/launch.mjs" \
     /root/conc-liq/data/static-paper-mvp-runtime.env \
     deployments-profile-register \
     /root/conc-liq/data/static-paper-mvp-cutover-20260927/aapl-market-profile.json
   ```

   Verify the registered profile through the authenticated read-only API, then
   perform only the approved static-paper workflow. Keep signing and broadcast
   disabled.

If migration fails before commit, the pending migration batch rolls back as one
transaction; verify the actual head and checksums before considering any old
reader restart. After migration succeeds, do not restart schema-3 readers.
Before any accepted operation, restore prior unit/configuration state only with
a schema-compatible release. After an operation exists, preserve post-upgrade
journal rows and execution ownership; use a forward-compatible release or a
separately rehearsed full restore. Do not overwrite newer indexer/operation
state with the pre-migration backup.
