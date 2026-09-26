# Sealed paper command review — 2026-09-26

## Review identity

This is a review-only process check of source commit `fd86568de891c51654954881dc4e3bd7430653cb` (`Keep maintenance pagination fixture aligned with V3 terminal guard`). It is not a release authorization or a live/paper action enablement record.

| Item | Identity / result |
| --- | --- |
| Sealed build ID | `2b1b0c9a7c12b118a95a2037c17afc4aaa84e61da83a3ca28a8824bdacb015fe` |
| Sealed release path | `/tmp/conc-liq-review-releases-fd86568/2b1b0c9a7c12b118a95a2037c17afc4aaa84e61da83a3ca28a8824bdacb015fe` |
| Rendered unit directory | `/tmp/conc-liq-review-units-fd86568` |
| Renderer result | `installed: false`; command and operation-worker units rendered against the same build |
| Clean source worktree | `/tmp/conc-liq-review-c6e8d3b`, detached at `fd86568` during verification |
| Node version | `v24.20.0` |

The build was made from a clean detached worktree. Repository inputs ignored by Git were linked into that worktree only to satisfy the existing hash-checked reproduction gates; they were not copied into the sealed release inventory. The worktree's `node_modules` link was also ignored and used only for build/test tooling.

## Verification

- `npm run check` passed: repository checks, typecheck, and **806/806** unit tests.
- `npm run release:build -- /tmp/conc-liq-review-releases-fd86568` produced the build ID above and recorded the exact source commit.
- The release's pinned `bin/node launch.mjs --verify` returned `verified: true` for that build ID.
- `scripts/render-release-units.mjs` rendered `conc-liq-deployment-command.service` and `conc-liq-paper-operation-worker.service` and reported `installed: false`.
- `systemd-analyze verify` passed for all rendered service and timer files. It printed only the host's existing `/lib/systemd/system/snapd.service` warning about unknown `RestartMode`.
- `npm run test:integration:paper-worker-process:sealed` passed against the exact build and `TEST_EXPECTED_RELEASE_COMMIT=fd86568de891c51654954881dc4e3bd7430653cb`.

The sealed process test served authenticated market-profile and Positions reads, rejected profile reads without a session, kept lifecycle admission unavailable before worker readiness, and then completed pause and resume through the actual `launch.mjs deployments` and `launch.mjs deployments-paper-worker` processes. Stopping the worker removed the readiness lease and disabled admission; restarting it restored readiness. Positions API and desktop/mobile Chromium views exposed the succeeded operation stages while leaving unavailable economics unavailable.

The process fixture created and dropped a disposable PostgreSQL schema. It supplied a local JSON-RPC endpoint that returns errors; the pause/resume path made zero RPC requests. No signer loaded, no economic ledger rows or marks were written, and no systemd unit was installed or started. The worker readiness lease proves a connected database session, not economic-path correctness or supervised recovery guarantees.

## Hash-pinned ignored inputs for `npm run check`

These files are local, ignored research inputs. `npm run check` read them for existing reproduction and pruned-artifact validation. The listed byte counts and SHA-256 values were checked from `/root/conc-liq/data` during this review.

| Worktree path | Bytes | SHA-256 |
| --- | ---: | --- |
| `data/competitor-cluster-amc-2026-09-04/analysis.json` | 1,371,591 | `5233eadf080f0f7f53591dca08c4c69ad194e6ec940eee2e7874c2092040411f` |
| `data/live-cost-analysis-2026-09-17/ledger.json` | 14,071,189 | `a6b9db95b4998ea9cfc6da069cae5bcf03e420a25ca01b7ac52fb9d640a05b2f` |
| `data/live-cost-analysis-2026-09-17/routes.json` | 38,677 | `7784e74f8f953c244ed1116b7dfc758453546eb26bd513f2730f965ead646bf9` |
| `data/lp-portfolio-2026-09-08/weekday-1000-v1.json` | 47,303,208 | `ef1f81c1f79f26703c5e872d3aa28d0feeda539183e52d3d5fe091b3fa67e832` |
| `data/lp-portfolio-2026-09-08/weekday-all-v1.json` | 325,566,587 | `3c3fb64a6a20f6177b6823b4c28c6a01aba3b2715d2916b3e70adc302f851306` |
| `data/lp-portfolio-2026-09-08/weekend-1000-v1.json` | 52,286,668 | `803513b32a8a2dd343591c5da4ba8098bc6bcffc982b1a64933cafaa2ee2a6bb` |
| `data/lp-portfolio-2026-09-08/weekend-all-v1.json` | 359,279,816 | `ee36f88c69eaad11b49493b853d784ac9fecd997136d30f618daeea066068551` |
| `data/lp-research-2026-09-07/size-sweep-timestamps.json` | 1,784,620 | `88595db4707df74a6b8a278bf2a19565f4bd28c89cd0883fdd7921fc3d95947a` |
| `data/lp-research-2026-09-07/source.jsonl.gz` | 261,824,861 | `103b6fce486124c75221389141c7c08c61faa18314637dc91d9b55bf5ee3ff1c` |
| `data/lp-research-2026-09-07/source.jsonl.gz.sha256` | 65 | `e17262930504be6e064693a42dcde5c3d9c259740dca14d317ed4173042cb60f` |
| `data/lp-research-2026-09-07/weekend-timestamps.json` | 1,963,323 | `3fa09e09a951522002ae87f7b9af5e4814c7eed3a1c08d48d8cf45ea8938ddda` |
| `data/lp-weekend-2026-09-07/backfill/references.json` | 1,426,944 | `f85e66041452fdbedd68f586535f0fb5bc2a729098a0695e4243e1be027e15d6` |

The restored research database archive is a separate ignored input at `archive/79dbb9dffb5304fc53c1a86192d1cd2dc722eca222b7338b062f04f5794d241a.tar.zst`, **185,163,776 bytes**, SHA-256 `3021364cecaf3f5aa06c8359f26a152441b8faf9c1ac0fb7eac54f0071347190`. Its tracked receipt describes same-host, non-durable storage and does not authorize pruning.

## Remaining gates

- This process run covered pause/resume only. It does not prove static/manual or RangeKeeper open, retain-close, or convert-close economics, source-bound admission, or operation recovery for economic actions.
- No live signer, custody action, transaction submission, service installation, migration of an existing database, or production activation was exercised.
- Dashboard lifecycle parity was checked for the seeded operation stages and unavailable economics; the complete supported action set and closure history still need sealed-process coverage.
- A passing review build does not satisfy production authorization, restore/restart rehearsal for economic actions, or the remaining W2–W7 acceptance gates.
