# Sealed paper command review — eaa73f6 — 2026-09-26

This is a historical review of the artifact named below. For the subsequently
deployed release and completed gates, see the
[September 28 dashboard feedback review](dashboard-feedback-2026-09-28.md)
and the [current paper runbook](../operations/static-paper-mvp.md).

## Review identity

This is a review-only source and process check. It does not authorize a release, operation admission, production migration, service installation, or activation.

| Item | Identity / result |
| --- | --- |
| Reviewed source commit | `eaa73f6b7dada94f9d57fe4d022661ec821e54ce` (`Exclude design fixtures from dashboard runtime and sealed releases`) |
| Sealed build ID | `a78b2dc0137197afd86ae23ff180d3f8e8b51137b07f86cedbcb5f1de197b6b8` |
| Sealed release path | `/tmp/conc-liq-review-releases-eaa73f6/a78b2dc0137197afd86ae23ff180d3f8e8b51137b07f86cedbcb5f1de197b6b8` |
| Rendered unit directory | `/tmp/conc-liq-review-units-eaa73f6` |
| Clean source worktree | `/tmp/conc-liq-review-eaa73f6`, detached at the reviewed commit |
| Node version | `v24.20.0` |
| Current documentation head | `66de677` is a docs-only follow-up and is not part of the sealed runtime identity |

The worktree was clean for the build and check. Hash-pinned ignored research fixtures were linked into that worktree only for repository reproduction checks. Their identities are listed in [the prior review record](sealed-paper-command-review-2026-09-26.md). `node_modules` was linked for tooling and was not included in source status.

## Verification

- `npm run check` passed on the clean worktree: repository validation, typecheck, and **828/828** unit tests.
- `npm run release:build -- /tmp/conc-liq-review-releases-eaa73f6` produced the sealed build above and recorded the exact source commit.
- The sealed `launch.mjs --verify` returned `verified: true` for that build ID.
- A manifest check found **zero** files under `dashboard/preview/` or `dashboard/prototype/`.
- `scripts/render-release-units.mjs` rendered the command and paper worker units against that release and reported `installed: false`.
- `systemd-analyze verify` passed for the rendered units and timers. It printed the host's existing `/lib/systemd/system/snapd.service` warning that `RestartMode` is unknown to this systemd version.
- `npm run test:integration:paper-worker-process:sealed` passed with `TEST_EXPECTED_RELEASE_COMMIT=eaa73f6b7dada94f9d57fe4d022661ec821e54ce`.

The initial sealed process harness authenticated a loopback operator session, served registered-profile and Positions reads, kept lifecycle admission unavailable without the worker lease, then completed pause and resume through the actual sealed `launch.mjs deployments` and `launch.mjs deployments-paper-worker` processes. Stopping the worker released the readiness lease and disabled lifecycle admission; restarting it restored readiness. Desktop and mobile Positions views showed the terminal stages and left economics unavailable.

The harness used a local error-only JSON-RPC endpoint and made zero RPC requests because pause/resume require none. It created and dropped a temporary PostgreSQL schema. It loaded no signer, wrote no marks or ledger entries, installed or started no systemd units, and touched no production schema.

## Separate source-mode economic flow

The opt-in `test:integration:static-paper-canonical-flow` run completed static/manual open through retain-close with a real configured canonical read RPC, actual verified market profile, actual six-stage owned-fork gas sample, source replay and importer, authenticated HTTP routes, a spawned source worker, and Positions API projection. It recorded a later principal-only valuation and completed `paper_open_recorded` and `paper_close_retain_recorded`; the `gas_paid` ledger remained empty and paid gas/fee capture stayed unavailable.

That run was performed in the shared source checkout at `e69208f` while unrelated files were dirty. It is source-mode evidence, not evidence from the sealed build above. It seeded the isolated static/manual draft directly and did not exercise setup-draft HTTP admission. The follow-up sealed run below adds open and retain-close; convert-close remains unproved.

## Follow-up sealed canonical open → retain run

The opt-in `test:integration:static-paper-canonical-flow:sealed` harness was
added in source commit `e443151` and passed against the exact sealed artifact
above (`eaa73f6` / build ID
`a78b2dc0137197afd86ae23ff180d3f8e8b51137b07f86cedbcb5f1de197b6b8`). The
test process performed actual market-profile verification, six-stage
owned-fork gas sampling, canonical report replay and provisional profile
import. It then launched the sealed artifact's actual
`launch.mjs deployments` and `launch.mjs deployments-paper-worker` entrypoints
with the same mode-0600 isolated runtime environment and exercised authenticated
HTTP preview/admission and Positions reads.

Open completed at `paper_open_recorded`; a later principal-only valuation was
visible, followed by retain-close at `paper_close_retain_recorded`. Positions
reported the closed lifecycle, terminal operation status/stage, and unavailable
paid gas/fee capture. The isolated `gas_paid` ledger count was zero. The run
loaded no signer, broadcast no transaction, touched no production schema, and
dropped its temporary schema and runtime environment after completion. Gas
report hash: `92cad4b810216019f220057eaee06061fd922074df9ec4a6ad54f658f90acb1e`.

The harness checkout was not a clean source tree and its sampler/import code
ran from that checkout; only command and worker execution came from the pinned
eaa73f6 artifact. The draft was directly seeded, so this does not yet validate
authenticated setup-preflight/draft-admission. It also does not validate
convert-close, production migration, installation, cutover, or activation.

## Superseded artifact

An earlier artifact built from `a9904c0` had build ID `ba0723eee0d523bb930df5089baeaab4dbbc481442daaf8b0f8744ad3237f793`. Review stopped after a release audit found that the prototype preview route and design fixtures were present. That artifact was superseded by `eaa73f6`; it was not verified or used for the sealed process run.

## Remaining gates

- The initial sealed run proves command authentication, read APIs, pause/resume admission, worker lease visibility, worker restart, and lifecycle Positions projection. The follow-up canonical run separately proves sealed open/retain operation paths, but its calibration/import ran from the harness checkout and its draft was directly seeded. Neither run proves convert-close or recovery after an economic worker restart.
- The source-mode and follow-up sealed open/retain runs do not yet prove authenticated setup-preflight/draft admission through the complete setup form; that is a separate harness gate.
- No production migration, signer use, custody action, transaction submission, service installation, or activation was performed. Production authorization and remaining F1–F5 evidence gates remain separate; W1–W7 are the distinct implementation workstreams.
