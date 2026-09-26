# Sealed paper command review — eaa73f6 — 2026-09-26

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

The sealed process harness authenticated a loopback operator session, served registered-profile and Positions reads, kept lifecycle admission unavailable without the worker lease, then completed pause and resume through the actual sealed `launch.mjs deployments` and `launch.mjs deployments-paper-worker` processes. Stopping the worker released the readiness lease and disabled lifecycle admission; restarting it restored readiness. Desktop and mobile Positions views showed the terminal stages and left economics unavailable.

The harness used a local error-only JSON-RPC endpoint and made zero RPC requests because pause/resume require none. It created and dropped a temporary PostgreSQL schema. It loaded no signer, wrote no marks or ledger entries, installed or started no systemd units, and touched no production schema.

## Separate source-mode economic flow

The opt-in `test:integration:static-paper-canonical-flow` run completed static/manual open through retain-close with a real configured canonical read RPC, actual verified market profile, actual six-stage owned-fork gas sample, source replay and importer, authenticated HTTP routes, a spawned source worker, and Positions API projection. It recorded a later principal-only valuation and completed `paper_open_recorded` and `paper_close_retain_recorded`; the `gas_paid` ledger remained empty and paid gas/fee capture stayed unavailable.

That run was performed in the shared source checkout at `e69208f` while unrelated files were dirty. It is source-mode evidence, not evidence from the sealed build above. It seeded the isolated static/manual draft directly and did not exercise setup-draft HTTP admission. The sealed process harness still does not cover economic open, retain-close, or convert-close.

## Superseded artifact

An earlier artifact built from `a9904c0` had build ID `ba0723eee0d523bb930df5089baeaab4dbbc481442daaf8b0f8744ad3237f793`. Review stopped after a release audit found that the prototype preview route and design fixtures were present. That artifact was superseded by `eaa73f6`; it was not verified or used for the sealed process run.

## Remaining gates

- The sealed run proves command authentication, read APIs, pause/resume admission, worker lease visibility, worker restart, and lifecycle Positions projection only. It does not prove sealed economic open/retain-close/convert-close paths, their source freshness, or recovery after an economic worker restart.
- The source-mode open/retain run does not validate the complete setup-draft review/admission form or a sealed release's economic routes.
- No production migration, signer use, custody action, transaction submission, service installation, or activation was performed. Production authorization and remaining F1–F7 evidence gates remain separate.
