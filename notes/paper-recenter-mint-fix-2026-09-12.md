# Recenter failures: narrow-range token composition

Session 59 had 68 recorded recenter preflight failures at the morning checkpoint on September 12: 65 `Frozen recenter mint minimum unavailable` and three `Recenter liquidity share exceeded`. Its position stayed open throughout. The former check compared each minted token amount with a quote made at an earlier checkpoint. With a ±20 raw-tick range, a small price change alters the required token ratio enough to fail that check, even when the swap exchange rate remains within the accepted limit.

## Correction

New recenter intents use `bounded_net_swap_v1`. The decision still fixes the target range, source price, swap direction, maximum available input inventory, minimum exchange rate and 90-second quote lifetime. At the later execution source, the existing integer net-swap solver recalculates only the amount needed to deploy the inventory in that fixed range. The original minimum exchange rate is applied proportionally, rounded up, to the new input amount. Both the execution-source price and the post-swap price must stay inside the frozen 50-bps band. Mint token minima then follow the actual executable mix. Direction changes, excessive input, unfavorable exchange rates, quote expiry, inactive target ranges, reference failures and insufficient pool depth still reject.

This replaces a frozen token-composition constraint with a bounded execution rule. It does not remove swap protection or imply a same-source fill: the decision still precedes the execution checkpoint. Historical intents retain their original behavior. The 2% pool share cap, full token allocation, ±20 raw ticks, 24/7 operation, no inventory cap and no routine timeout remain unchanged.

## Historical validation

Nine exact recorded failure sources were replayed on owned Anvil forks using the recorded position and fee inventory. Only pinned read-only calls reached the upstream chain; no paper-session records or real balances were altered. Adaptive limits were derived from the earlier quote observation, not the later execution source.

| Observation | Direction | Original replay | Revised replay |
|---|---|---|---|
| 3499 | Buy NVDA | Mint minimum rejected | Completed |
| 3501 | Buy NVDA | Mint minimum rejected | Completed |
| 3713 | Sell NVDA | Mint minimum rejected | Completed |
| 3715 | Sell NVDA | Mint minimum rejected | Completed |
| 3717 | Sell NVDA | Mint minimum rejected | Completed |
| 4315 | Buy NVDA | Mint minimum rejected | Completed |
| 3572 | Buy NVDA | Pool share rejected | Pool share rejected |
| 3578 | Buy NVDA | Pool share rejected | Pool share rejected |
| 3590 | Buy NVDA | Pool share rejected | Pool share rejected |

For observation 3499, the needed buy changed from **1,378.091590** to **1,036.510753 USDG**. The revised mint left only token rounding dust. This illustrates why increasing slippage or dropping mint minima alone would not meet the full-deployment intent.

These are individual mechanics replays with historical inventory, not a counterfactual campaign or a claim about improved earnings. Six of 65 mint-minimum failures were sampled; the remaining failures are not claimed as replayed successes. Full local inputs/results are in `data/paper-recenter-fix-2026-09-12/`.

## Preserving the open position during deployment

`paper-upgrade --session ID --from-build SHA256` explicitly adopts a verified new release for an open, valid session under the same stream advisory lock as the worker. It requires the expected latest session and previous build, identical configuration and Node version, and fully valid canonical history. The operation leaves the position, NAV, fees, gas, original benchmark, policy and prior observations untouched. It discards an outstanding recenter quote and appends a runtime transition with the prior-state hash, timestamp, execution-run cutoff and observation cutoff.

Evidence readers use that ordered transition history to require each execution's original runtime before the boundary and the new runtime afterward. Historical proofs are never relabeled. The old worker refuses the upgraded session. Only a release containing transition-aware evidence validation may read/run the upgraded session; rollback requires another explicit compatible transition rather than silently reverting its identity.

The deployment procedure pauses the paper timer, waits for the current worker to finish, saves the old session and service files, upgrades using the new sealed launcher, switches the paper/dashboard units and resumes the timer. This avoids a forced cash exit and preserves the current campaign. No schema migration is required. Existing cash-exit handoff remains suitable for policy or configuration changes; this operation permits code changes only.

## Checks

96 focused paper/dashboard tests and TypeScript typecheck passed. New unit checks cover full deployment after changed token mix, preserved exchange-rate floors, input budgets, excessive price moves and legacy-intent compatibility. The disposable PostgreSQL upgrade test verifies worker-lock exclusion, configuration/latest-session guards, exact accounting preservation, old/new proof provenance, old-worker rejection and tampered-cutoff rejection. Existing recenter evidence and lifecycle tests cover canonicality, cash accounting and preflight concurrency.

Fresh quote-to-later-source fork checks also passed for both buy and sell directions using the actual new quote generator, with six recenter calls and a separately accounted four-call exit preview in each case. The upgrade integration was first exercised on an isolated copy of session 59's real history, then made self-contained with synthetic proof rows for repeatable regression testing.

## Activation

The paper worker and dashboard moved to sealed build `8c405515575267ad9837340c469b23993e7c160cda5b7a3ee7843dc5f8a4549c`, source `ff410b1430a484c252513e301b20acbced342e81`, at **2026-09-12 07:33:32 UTC**. Session **59** remained open. NAV immediately before and after the handoff was exactly **5,028.792722 USDG**. The full state was compared: the position, fees, cost ledger, benchmark and policy were preserved. Runtime history now records the boundary after execution run 366 and observation 4572. An existing pending recenter quote would be discarded; no forced exit, entry or rebalance was introduced.

The new dashboard returned HTTP 200 with valid campaign attribution and execution provenance. The paper timer and existing validation timers remained active; other worker releases were unchanged. [Activation evidence](paper-recenter-fix-2026-09-12/activation.json) and [sampled replay summary](paper-recenter-fix-2026-09-12/replay-summary.json) are checked in. Detailed source inventories, pre/post-upgrade snapshots and complete fork results remain in the local data directory. Forward effectiveness still needs the next natural range crossing; individual replays do not establish an improved long-run return.

The first fresh post-upgrade checkpoint (**07:33:46 UTC**, processed by **07:34:01 UTC**) advanced normally: session 59 stayed open, tick 222418 was inside 222410–222450, no decision or monitor reasons were present, and the 1,085-mark report remained valid. NAV was **5,028.804602 USDG**. No new recenter had yet been required.
