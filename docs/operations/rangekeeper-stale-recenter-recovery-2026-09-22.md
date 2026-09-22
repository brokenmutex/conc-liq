# RangeKeeper stale recenter recovery — 2026-09-22

## Incident and custody

Campaign `31802d63-9ec8-423c-bc1b-f781f8b44f92` withdrew NFT `1271827` in confirmed transaction `0x8c26b1c834cd58c854a7af55b3185b1eba4853dc14a1c63acb424376d69dd4a1` (nonce 356). The approved replacement range then became stale. The pinned worker threw a `RangeKeeperStaleCandidateError` after the withdrawal and systemd repeatedly restarted it. At the stop boundary the saved state was `phase=recenter`, `withdrawDone=true`, `swapDone=false`, with no active NFT or pending signed action. Canonical reads showed the retired NFT owned by the operator with zero liquidity and zero owed tokens, and the withdrawn inventory in the wallet.

The old service was stopped without requesting an exit. No state, signed intent, receipt, or release was deleted. Unrelated dirty hybrid/adaptive files were left in place.

## Recovery builds and evidence

| Source | Sealed build | Purpose |
| --- | --- | --- |
| `6f7f9be` | `6e722fb6b13c3639acb2d2c1507294125f95127095a42cbdef7bd26f308a895a` | Discard stale post-withdraw proposals and require fresh confirmation and fork simulation. |
| `73d0f12` | `749152f97977e5cfcf0b992c4d8238caf4ff786919a69e16a744f28a0c90d899` | Apply the remaining action budget to the recovery preview. |
| `9fa30ba` | `622eee8b4bd3f28a20b2fd637fb27f0718f75fc1ce79b29b7f096af5622482d5` | Handle an unsigned mint price-check failure after a confirmed swap. This is the installed build. |

Each build was made from a clean detached worktree and verified with its pinned Node launcher. Before each stopped-worker migration, `stale-recenter-preflight` checked the exact campaign and previous build, unchanged stored config, empty pending outbox, confirmed last economic stage, canonical wallet/NFT custody, and the former pilot's closed state. Each `migrate-stale-recenter` appended its proof and updated the same campaign's build identity; it did not change strategy limits, capital baseline, receipts, or active custody. Preflight and migration outputs are retained privately under `data/rangekeeper-stale-recenter-{preflight,migration}{,2,3}-2026-09-22.json`. The pre-recovery unit is retained at `data/conc-liq-rangekeeper-before-stale-recovery.service`.

The first recovered candidate passed two fresh canonical observations and a local fork simulation. Approvals at nonces 357–359 confirmed, followed by the swap at nonce 360 (`0xd4e83b79894d5cfe4a3c4fae97e724dba42b86a9bb37bbbfca77e342df192165`). The worker recorded `swapDone=true`; it did not repeat the withdrawal or swap. A later mint estimate failed the router's price slippage check before signing, so there was no failed mint transaction or consumed nonce. The final build handled that pre-signing condition and submitted a feasible mint at nonce 361 (`0x540e4673c025fccc43d27e91967262e27079b802768e5c449740bd5c07e69538`). Its canonical receipt succeeded.

## Verified final state

At 19:48:47 EEST, the installed service was active on build `622eee8b…5622482d5` with zero restarts since that start. The saved campaign was `phase=holding`, `desired=running`, `lastReason=inside_range`, `candidate=null`, `swapDone=false`, and `withdrawDone=false`. NFT `1274982` was owned by the operator, with on-chain liquidity `6752845059143753` in `[217940,217980)` while the pool tick was `217953`. The ledger retained campaign ID and recorded three economic actions and two recenter completions. Cleanup approvals at nonces 362–364 confirmed; all six tracked allowances were zero and the pending action count was zero. The dashboard detail API showed the position open with liquidity, 26 receipt events, and recorded performance history. Independent-reference gaps remain explicitly unavailable in that view.

`npm run check` passed 684 tests on the final source, including the post-withdraw and post-swap recovery regressions. The final source commit is `9fa30ba`; the live unit points to its sealed build. Rolling back to an older worker without first reconciling this campaign's later signed actions and build identity is unsafe.
