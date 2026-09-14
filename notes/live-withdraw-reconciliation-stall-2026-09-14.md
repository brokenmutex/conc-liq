# Live withdrawal reconciliation stall — 2026-09-14

Read-only diagnosis at 2026-09-14T15:50:09.521Z. No controller requests, database edits, service restart, deployment or transactions were performed.

## Confirmed cause

The worker is stuck reconciling successful withdrawal `9190bbf1-ef9b-4059-bc4b-d295d240c7a4`, transaction `0xccf6b605e20edf1c87b743063d6f5e17c17e2bf4e62a9232b344d8cec21349ca`, block `62855343` at **13:48:23 UTC / 16:48:23 Vilnius**. It first failed reconciliation at 13:48:45.086 UTC and continued retrying approximately every five seconds. More than 1,200 matching failures were present by 15:48 UTC.

`src/live-pilot/reconcile.ts:79` asserts exact equality between the wallet transfer and the position-manager Collect event. A read-only replay of the live receipt and its historical snapshot reproduces that exact assertion failure:

| Evidence | USDG raw units |
| --- | ---: |
| Position manager Collect | 201704356 |
| Canonical pool Collect | 201704354 |
| ERC-20 wallet transfer delta | 201704354 |
| Historical wallet balance delta | 201704354 |

Difference: **2 raw units = 0.000002 USDG**. NVDA collection matches at 423276323724852 raw units. Pool collection is bound to the manager, operator recipient, and ticks 222800–222840. The canonical receipt succeeded.

This is consistent with documented Uniswap V3 periphery/core rounding behavior. The position-manager event reports its requested/owed collection amount; the pool can return slightly less. The upstream [Collect interface](https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/INonfungiblePositionManager.sol) explicitly documents that reported amounts can differ from transfers because of rounding. The [manager implementation](https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol) emits the requested amounts after receiving the actual pool amounts.

## Current custody and journal

At confirmed block 62927008 (2026-09-14T15:50:02+00:00):

- Operator USDG: **295.003756**, including the existing excluded reserve; this is gross wallet balance, not profit or managed NAV.
- Operator NVDA: **0.000423276323724947**.
- Nonce: **250**; the withdrawal used nonce 249.
- NFT **1164733** has **zero liquidity**. At the receipt block, both NFT tokens-owed fields were also zero.
- The database action remains `signed` with no persisted receipt because reconciliation fails before `store.finish`. The controller cannot advance to the next action.

The service is active under release `11be421b9e15d23235951d99548573e0e1b98e4bcaa92dee5c127bd681821ddf`, started at 08:40:10 UTC. The adaptive-width research commit `2507620` was not deployed to this service.

A later RPC interruption at about 15:46 UTC temporarily put the controller in `guard_wait` and failed checkpoint jobs. The health gate returned to healthy at 15:48:14 UTC; the same withdrawal assertion immediately resumed. RPC recovery therefore does not resolve this accounting stall. The journal state is now `exit`, while the unresolved withdrawal retains priority.

## Required correction

Bind and decode the canonical pool Collect event, match its actual amounts exactly to transfer logs and wallet deltas, and reconcile manager-reported amounts separately. Retain exact nonce, custody, allowance, recipient, NFT and gas checks. Account for actual fee income and separately record the manager/core rounding difference. Do not introduce a generic balance tolerance or repeat the successful withdrawal.

Before recovery, use this receipt as a regression fixture and validate the correction. The normal journal should reconcile the existing transaction exactly once, then continue from current custody through its existing guards. No repair was applied during this diagnosis.

## Evidence

- `data/live-stall-2026-09-14/receipt-evidence.json`: SHA-256 `fd627f9b6c6fb0cd63fd9a8f50033f2952d09fd33c278b05d30d07186fd08597`
- `data/live-stall-2026-09-14/reconciliation-evidence.json`: SHA-256 `f9606b6224cea8c52df5225bed55fc25673fbec2b4e71248fd4af893e3cd0667`

## Correction and pre-deployment validation

The correction decodes Collect only from the canonical NVDA/USDG pool and requires exactly one event bound to the position manager, operator recipient, and the withdrawn NFT's range. Pool amounts must equal token transfer deltas and historical balance changes exactly. The manager request must cover those actual proceeds. Its difference is recorded in `facts.collectionProof.roundingDifference`; actual proceeds minus released principal determine collected fees. No generic rounding tolerance is applied. Nonce, gas, reserves, allowances, NFT identity and zero remaining liquidity/owed tokens remain strict.

For this receipt the recorded actual fees are **145718 USDG raw units** and **423276323724852 NVDA raw units**, with a manager/core difference of **2 USDG raw units**, and gas **13738601980000 wei**. This corrects reconciliation of an already completed transaction; it does not submit a replacement withdrawal.

Validation before release:

- Typecheck and all **543 workspace tests** passed, including the exact canonical receipt and mismatched pool, owner, recipient, range, amounts, wallet, allowance and remaining-position cases.
- Replayed all **246 historically confirmed live actions** against the new reconciliation: 136 approvals, 45 swaps, 33 mints and 32 withdrawals; zero failures. Output: `data/live-stall-2026-09-14/historical-replay.json`.
- `test/integration/live-withdraw-rounding.mjs` uses an isolated database schema, the canonical receipt and archive snapshots, and no signer/broadcaster. Simulated crashes before and after the atomic journal commit, then verified one confirmation, one receipt mark, one gas/fee charge, and rollback of duplicate completion. Zero signatures or broadcasts.
- The active strategy and finite allowance configuration are unchanged. Release deployment and service restart were explicitly requested by the operator after diagnosis.
