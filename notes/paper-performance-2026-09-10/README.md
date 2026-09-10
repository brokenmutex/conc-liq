# New paper sessions: 10 September 2026

The frozen audit covers **06:33:52 UTC / 09:33:52 Vilnius**, with a separate operational refresh at **06:41:02 UTC / 09:41:02 Vilnius**. The previous comparison point is the [9 September management audit](../lp-management-audit-2026-09-09/README.md), captured at 12:02:45 UTC. Paper policy and runtime remain unchanged; the four-strategy comparison remains stopped and disabled.

## Outcome

**18 sessions completed since the previous audit: #31–48.** Session 31 was already open at the previous cutoff; new session IDs are #32–49. Among the completed group, two earned positive P&L (#31 and #46), and three had positive session alpha (#31, #40 and #46).

| Completed group #31–48 | USDG |
|---|---:|
| Starting carried cash, before #31 | 970.067291 |
| Ending carried cash, after #48 | 953.975606 |
| **P&L across the complete cycles** | **−16.091685** |
| Marked fee income | 8.887153 |
| Estimated gas | 10.929497 |
| Entry and exit execution drag | 7.424620 |

The new complete-cycle decomposition reconciles to the micro-USDG: benchmark market movement **−3.536221**, LP inventory relative to holding **−3.088511**, marginal fee value **+8.887164**, entry/exit drag **−7.424620**, and gas **−10.929497**. Marginal fees in the additive decomposition differ from separately rounded fee marks by 0.000011 USDG.

At the frozen cutoff, campaign NAV was **953.975606**, holding **988.165877**, and campaign alpha **−34.190271 USDG**. Compared with the previous audit's open-position mark, NAV declined **17.411957 USDG** and alpha deteriorated **14.545248 USDG**. These changes differ from the −16.091685 complete-cycle result because part of session 31 was already included in the previous mark.

At the later 09:41 Vilnius check, **session 49 was open**, with fresh heartbeat and valid cash ancestry. Campaign NAV, including this open position and its costs/reserve, was **953.375560 USDG** (−4.662444% from the original 1,000), holding **988.178371**, and alpha **−34.802811 USDG**. This later mark is separate from the frozen completed-session audit.

## Each newly completed session

All values below are USDG, except holding minutes. Session alpha uses that session's acquired-inventory comparator; it must not be summed into campaign alpha. Causes describe the first exit signal, not every subsequent pending-exit observation.

| Session | Holding min | P&L | Session alpha | Fees | Gas | First exit cause |
|---|---:|---:|---:|---:|---:|---|
| 31 | 192.5 | +1.809354 | +1.992185 | 2.698254 | 0.656433 | Syncing/recovery |
| 32 | 13.3 | −0.852121 | −0.507607 | 0.300406 | 0.727158 | 11-block lag/depth |
| 33 | 2.0 | −3.032631 | −1.401630 | 0.099258 | 0.677979 | Inventory |
| 34 | 6.1 | −1.846535 | −0.911442 | 0.162282 | 0.636450 | Inventory |
| 35 | 4.1 | −2.044658 | −1.077099 | 0.177985 | 0.628848 | Inventory |
| 36 | 23.6 | −1.017836 | −0.352465 | 0.624004 | 0.635223 | Syncing/recovery |
| 37 | 6.1 | −0.056353 | −0.542509 | 0.335744 | 0.623191 | USDG reference stale |
| 38 | 25.6 | −0.891754 | −0.499463 | 0.266695 | 0.635509 | 32-block lag/recovery |
| 39 | 22.6 | −0.009453 | −0.063412 | 0.637926 | 0.641784 | 35-block lag/recovery |
| 40 | 99.5 | −0.114851 | +0.258111 | 0.985919 | 0.620814 | Larger lag/recovery |
| 41 | 20.5 | −0.120856 | −0.179940 | 0.496050 | 0.627986 | Syncing/recovery |
| 42 | 259.0 | −1.890540 | −0.728014 | 0.482250 | 0.590646 | Multiplier transition |
| 43 | 17.4 | −1.455306 | −0.716730 | 0.146515 | 0.562658 | Inventory |
| 44 | 27.7 | −1.041752 | −0.608551 | 0.098616 | 0.564616 | 11-block lag/depth |
| 45 | 16.4 | −1.502950 | −0.678090 | 0.218540 | 0.547668 | Inventory |
| 46 | 178.1 | +0.401524 | +0.100374 | 0.809996 | 0.530255 | 14-block lag/depth |
| 47 | 20.6 | −0.590186 | −0.483410 | 0.106442 | 0.513108 | 27-block lag/recovery |
| 48 | 55.3 | −1.834781 | −0.810827 | 0.240271 | 0.509171 | Inventory |

## What the new evidence changes

**Inventory exits remain costly, but are not proven unnecessary.** The six inventory-triggered sessions lost **11.716861 USDG**, including **3.562774 USDG** in gas. Four signals (#34, #43, #45, #48) occurred inside the range; #33 and #35 had already crossed the NVDA-heavy boundary. Signal exposure ranged from **60.01% to 76.58%**, reflecting price movement between decisions. Thus the earlier finding that every inventory signal was in-range does not extend to this new group. Removing 60% would change future inventory risk; the entire loss in these sessions is not an estimate of recoverable profit.

**The ten chain exits have distinct mechanisms.** The production readiness helper reproduces every recorded first chain failure from frozen health samples:

- #32, #44 and #46 each have an isolated **11-, 11-, or 14-block** private lag while the monitor still labels the sample healthy. Their private confirmation depths are **61, 60 and 55 blocks**, below the paper worker's 64-block requirement. The anchor adjustment explicitly includes the private head only through ten blocks of lag. This is the boundary just beyond that tolerance, not evidence that an ordinary 0–10-block lag failed the same rule. All three subsequently wait through the five-minute recovery evidence requirement.
- #31, #36 and #41 followed private-node syncing reports, even though reported lag was small or zero.
- #38, #39 and #47 followed 32-, 35-, and 27-block lag events. #40 had a larger multi-sample lag episode with time-lag and anchor-read failures. The monitor's recovery state and paper's recovery window extend the impact beyond the initial event.

The chain bucket lost **2.427931 USDG**, with **6.152886 USDG** in gas. This warrants a separate review of tolerated lag, confirmation depth and recovery behavior; changing the inventory cap cannot remove these exits. No health policy was changed by this audit. Exact sample IDs, faults and reproduced gates are in [update.json](update.json).

**The multiplier guard reacted to a recorded scheduled change.** In #42, the source snapshot switched from no pending transition to a scheduled onchain UI multiplier of **1.000775159164630595**, effective **10 September 00:00:30 UTC / 03:00:30 Vilnius**. The worker signaled exit at 23:51:18 UTC and completed it at source time 23:52:00 UTC. By #43's quote and entry, the onchain and registry multipliers matched at the new value and the pending flag was false. The [source evidence](multiplier-evidence.json) confirms this sequence. It does not identify a real-world corporate-action cause or establish that every possible transition is handled correctly.

**Underfilled entries persist.** Six new completed sessions (#32, #33, #34, #35, #42, #45) placed less than 72% of their budget into LP, against the unchanged 80% target. Their actual allocations ranged from **51.23% to 70.44%**. The entry-quality rules tested in the ended comparison were never promoted to the transaction-paper worker. Longer holding alone is not sufficient: #42 held about 259 minutes, earned only 0.482250 USDG in fees, and lost 1.890540 USDG.

The updated evidence therefore supports examining exposure management, entry allocation and chain-exit behavior separately. It establishes no better inventory cap, width, capital size or profitable replacement strategy. Paper parameters remain at the existing ±20 raw ticks, 80% target allocation, 60% inventory exit and ±5% reference band.

## Verification and reproduction

The new source validates the full session 5–49 evidence/cash chain. All **26 previously closed sessions** have identical states, policies and runtime identities to the previous frozen audit. The performance reporter verifies **947 new fee-accrual intervals**, gas accounting and the full inventory/execution P&L decomposition. The [independent Python check](confirmation.json) verifies all **45 captured sessions, including 44 closed cash reconciliations** and the waiting cash balance of #49 at capture time. No new full-market event reconstruction or counterfactual strategy comparison was performed in this update.

The verifier was extended to accept a cash-only waiting/entry-pending session without inventing an entry fill or NAV. Empty exit-reason lists now remain unclassified instead of being silently labeled reference failures; the older #27 operator exit remains separately documented in the prior audit. Both the prior open-position snapshot and the new cash-only snapshot pass the updated verifier.

Full records are in `data/paper-performance-2026-09-10/source.json`, with its SHA-256 sidecar. [Session metrics](session-metrics.json) contain every action-cost decomposition and saved preflight failure; [update.json](update.json) pins source/script hashes and the incremental comparison. [Operations](operations-check.json) confirms the unchanged runtime and the ended comparison's unchanged ledger hash.

```sh
.tools/node/bin/node --import tsx scripts/paper-performance-audit.mjs capture data/runtime-refactor.env /tmp/paper-update-source.json
.tools/node/bin/node --import tsx scripts/paper-performance-audit.mjs report /tmp/paper-update-source.json /tmp/paper-update-metrics.json
python3 scripts/verify-paper-performance.py /tmp/paper-update-source.json /tmp/paper-update-metrics.json /tmp/paper-update-confirmation.json
.tools/node/bin/node --import tsx scripts/paper-session-update.mjs data/lp-management-audit-2026-09-09/paper-source.json /tmp/paper-update-source.json /tmp/paper-update-metrics.json /tmp/paper-update-summary.json
```

Use new output paths for subsequent captures; existing frozen evidence is not overwritten. No signer, broadcast, paper restart, policy update or comparison restart is part of this work.
