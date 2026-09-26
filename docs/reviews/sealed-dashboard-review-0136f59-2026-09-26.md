# Sealed dashboard review — 0136f59 — 2026-09-26

## Exact review identity

| Item | Identity |
| --- | --- |
| Source commit | `0136f59ee28854318b11ee0c95900defd3f0e639` |
| Build ID | `0647108747b0e2e649c539cc00f54c3ad3939a3805ae674ffa7fec34ab220e11` |
| Release directory | `/tmp/conc-liq-review-releases-eaa73f6/0647108747b0e2e649c539cc00f54c3ad3939a3805ae674ffa7fec34ab220e11` |
| Clean detached worktree | `/tmp/conc-liq-review-0136f59` |
| Rendered units | `/tmp/conc-liq-review-units-0136f59` |
| Node | `v24.20.0` |

This artifact is for review. No production migration, service installation,
activation, funding, signer use or transaction submission follows from it.

## Completed checks

- The clean worktree passed repository validation, typecheck and **832/832**
  unit tests. The shared checkout passed **836/836** tests; that checkout
  included unrelated dirty research prerequisites and is separate evidence.
- Ignored research inputs were linked only for existing reproduction checks,
  using the same files documented in
  [the earlier review](sealed-paper-command-review-2026-09-26.md).
- The builder required clean source and recorded the exact commit above.
  The pinned release Node returned `verified: true` from `launch.mjs --verify`.
- The manifest contains zero `dashboard/preview/` or
  `dashboard/prototype/` paths. Its complete dependency inventory matches the
  previously reviewed `a78b2dc0137197afd86ae23ff180d3f8e8b51137b07f86cedbcb5f1de197b6b8`
  artifact.
- Unit rendering reported `installed: false`. `systemd-analyze verify`
  passed; the host's existing snapd `RestartMode` warning remains. The rendered
  runtime-env path is a review placeholder, not an installed configuration.

The first build attempt correctly rejected an ignored dependency-directory
self-symlink that escaped the release. Removing that self-symlink allowed the
build; no dependency file content changed.

## Runtime evidence boundaries

The [eaa73f6 review](sealed-paper-command-review-eaa73f6-2026-09-26.md)
records the earlier artifact's sealed pause/resume, lease loss, restart and
desktop/mobile checks, plus its separate canonical economic flow. These are
not process results for this new build.

This source includes the covered replay-head selector for static conversion
and the private, one-shot RangeKeeper simulation capability. Their focused
and RPC checks do not prove canonical conversion booking, production-default
RangeKeeper preparation or HTTP admission. Both paths remain unavailable.

The later canonical conversion fixture exposed a replay-selector query against
`v3_replay_pools.tick_spacing`, which that schema does not contain. This
artifact predates its correction and cannot prove a working conversion preview.
The conversion HTTP acceptance callback remains absent.

Actual command/worker economic flow, setup HTTP admission, browser parity and
recovery for this exact artifact must be recorded separately as they pass.
