# Four-candidate learning cohort — 9 September 2026

**Ended at user request on 9 September, 11:49 UTC / 14:49 Vilnius.** The comparison service is stopped and disabled. The transaction-paper campaign continues unchanged. The 24/72-hour review schedule below is historical and cancelled. See [end record](ended.json) and the [paper review](../lp-paper-review-2026-09-09.md); strategy selection is deferred until the research is digested.

This cohort implements the bounded comparison in the [improvement plan](../lp-improvement-plan-2026-09-09.md), after the risk-refresh, anchor and runner-recovery fixes. It is a new modeled cohort, separate from the transaction-paper campaign and its accumulated losses. No old invalid experiment is resumed.

| Candidate | Initial paper budget | Half-width | Management |
|---|---:|---:|---|
| A | 1,000 USDG | ±20 raw ticks | Exit/reentry |
| B | 1,000 USDG | ±30 raw ticks | Exit/reentry |
| C | 1,000 USDG | ±20 raw ticks | Recenter at 40% of directional half-width after one observation |
| D | 1,000 USDG | ±30 raw ticks | Same recenter rule |

Both active arms retain the ten-minute recenter cooldown and the 60% reference-valued inventory exit, which takes priority over recentering. All four retain the ±5% independent reference band, held-session reference rules, 80% target allocation, 1% initial liquidity-share limit and 50-bps swap bound. Widths and management are the only differences between these four candidates.

Every placement requires a quote no older than 90 seconds, movement of at most five raw ticks since the quote, and at least 72% of current portfolio value actually placed in LP. The complete modeled remove/swap/mint path is previewed before acceptance; a rejected placement leaves the accepted balances and costs intact. Required safety exits bypass entry admission caps. Counters record quote age, drift, allocation rejection, cooldown, persistence and inventory preemption.

## What the historical screen established

The [calibration](calibration.json) replays the frozen September 5–8 source across 13 six-hour windows, using eight for development and five for validation. It compares only the four proposed early rules: 40%/50% distance and one/two observations, at both widths with matching fixed controls. [Selection](selection.json) fixes the cohort parameters and review times.

Development coverage was thin: only two qualifying width/window pairs, both within one six-hour window. The 40%/one-observation rule was the only rule with a development recenter (one), and its median paired alpha difference was zero. It is selected to exercise the management hypothesis, not because profitability or an optimum was established.

In validation it executed **17 recenters** across the two widths and had median paired alpha **0.750886 USDG worse** than the matching fixed controls. Its median active alpha was **−9.050451 USDG** per qualifying cell. The other early rules also underperformed their controls. These negative results are retained; active recentering is not promoted to the transaction-paper worker.

The cohort also tests a **1.25 USDG round-trip scenario-gas cap**. At 2× the frozen gas inputs it admits no LP entries, so there is no invested stress-validation result to rank. Staying in cash under that cap is not evidence of a profitable LP strategy. Historical current-risk fallback admissibility is unavailable; the historical screen uses checkpoint reference evidence and the earlier capture-plus-30-second decision clock. Forward observations now use actual worker time and current-risk evidence.

## Cost boundary and review

The gas inputs remain the canonical, frozen fork estimates from session 6. Entry, swap, remove, mint, exit and revoke charges are all debited, but **fresh transaction-specific gas quotes and the proposed six-hour rolling-median gas-admission gate are not implemented by this comparison**. The fixed scenario cap must not be described as that fresh-cost gate. The selection file records `missingFreshCostGate=true`. This is a limitation for profitability/adoption, not a hidden zero cost.

The transaction-paper worker remains on its existing width and entry-policy settings with the deployed reliability fixes; the experimental entry-quality and recenter hypotheses run only in the four modeled arms. Comparing their P&L directly with the worker requires reconciling capital, decision timing, hypothetical liquidity dilution and actual fork gas. The worker continues its conserved cash campaign; each modeled candidate starts independently at 1,000.

Status includes marked NAV and a separate hypothetical liquidation NAV/alpha: the latter includes a current modeled inventory-sale quote and reserved frozen gas, against the common marked holding benchmark. An unavailable liquidation quote produces an unavailable liquidation result. These remain modeled values, not actual cash settlements or fresh measured gas.

The runner saves immutable local review artifacts on its first poll after **24 and 72 hours**, including portfolio state, source/evidence history, data-pause coverage and whether each active arm has at least ten recenters. Reviews never automatically select a winner or retune a policy. A terminally stopped worker remains visibly failed; it cannot produce later scheduled reviews until separately audited. At least two overnight windows and a separate new weekend observation are still required. The 72-hour review is a decision point, not a promise of optimal parameters.

The previous version-1 comparison remains archived at its original path and invalid status.

Validation before activation: TypeScript and all **282 unit tests** pass. The new checks exercise earlier recentering with inventory priority, allocation/age/drift/scenario-cost rejection without ledger changes, liquidation execution drag, immutable scheduled reviews, and pause recovery. A real CLI subprocess check confirms terminal status 2 survives the process lock wrapper and can be handled by `RestartPreventExitStatus=2`.

## Activation and first observations

The cohort started **2026-09-09 08:47:33.517 UTC / 11:47:33.517 Europe/Vilnius**, under sealed release `85c5c7a5629047cb8a4d112283a331d90caf5f5678e04e2c2b27116b64b25f72` from commit `2ec4cf9`. At activation, `conc-liq-experiment.service` was enabled and polled every 15 seconds. State is `data/lp-comparison-2026-09-09/forward-v2.json`; adjacent `.status.json` and `.status.md` files now record the ended status.

The [activation snapshot](activation.json) records the pinned runtime, selection hash, immutable state-copy hash, initial actions, decision evidence and eight post-start checkpoint decisions through the check at **08:56:53 UTC**. All four arms had one entry, an open position, no exits and no recenters. Their entry was processed at **08:50:08.890 UTC**, using checkpoint 3205 from **08:49:23 UTC**. Each incurred **0.501937 USDG** in modeled entry gas. Actual modeled LP allocation was **78.6718%** for the two ±20 arms and **79.1544%** for the two ±30 arms. Initial performance is too short to compare management.

The local immutable review files were scheduled for the first running poll after the following times; both reviews are now cancelled:

- **10 September 08:47:33 UTC / 11:47:33 Vilnius:** reliability and decision coverage.
- **12 September 08:47:33 UTC / 11:47:33 Vilnius:** initial economics and recenter coverage.

The current release has a startup diagnostic defect: checkpoint 3203 is dated **3.517 seconds before cohort creation**. It correctly produces no order but is counted as one missed decision, with **60.271 seconds** accumulated as a startup pause. The activation audit separates this pre-start accounting observation from post-start missed decisions (zero at that check). Raw counters remain intact; do not silently subtract later pauses or infer 100% scheduled availability. Review heartbeat gaps as well as checkpoint decisions. Automatic review artifacts retain the raw counters and need this explicit classification when analyzed. Fix the classifier for a future runtime boundary; do not modify this open cohort's pinned runtime or ledger to improve its statistics.

A brief stop was attempted while investigating that counter. All four entries arrived before the stop completed; the empty-state assertion failed before any archival or reset write. The same state and runtime resumed, with positions, benchmark and all debited costs preserved. Subsequent source checkpoints advanced normally.

## Transaction-paper follow-up

The [read-only follow-up](paper-followup.json), checked at **08:57:18 UTC**, validates the full session 5–29 evidence and cash-continuation chain. Session 27 closed under its original runtime at **974.985604 USDG**; session 28 explicitly continued that amount under the reliability release. Session 28 then closed at **973.985271 USDG**, and automatic reentry opened session 29 with exactly that budget. The campaign's then-current modeled NAV was **973.055960 USDG**, versus holding **992.808529 USDG**, for alpha **−19.752569 USDG**. These are later marks, separate from the original audit cutoff.

Session 28's first exit signal at **08:38:30 UTC** followed health sample **40212**, at **08:36:20.999 UTC**: `reference_1` failed its latest RPC fetch, leaving the required two-reference hash quorum unavailable. The remaining private/reference depths were 64/65 blocks. Subsequent available references had at least 64 confirmations. This is an observed endpoint-availability failure and recovery-window exit, not a recurrence of the old zero-depth anchor selection bug. Required quorum and recovery safeguards remain enforced. Endpoint failures can therefore still cause turnover; the reliability deployment does not establish that infrastructure exits have been eliminated.

Fresh comparable round-trip quotes (including blocked-admission periods) and the proposed six-hour/20-observation rolling-median gate remain unfinished. Matching model and transaction-paper accounting must reconcile before any promotion. Future research design and implementation are deferred while the papers are digested; this cohort is ended.

## End record

The end manifest was recorded at **11:49:17.325806 UTC** after stopping and disabling `conc-liq-experiment.service`. The last worker update was **11:48:18.798 UTC**, using source **11:46:44 UTC**. Original state and status were copied to `data/lp-comparison-2026-09-09/ended-2026-09-09/`, with SHA-256 hashes in [ended.json](ended.json). The raw worker ledger remains byte-identical; its `running` field describes its last observation, while the end manifest and adjacent status files record the operator-ended state. Do not resume this cohort.

| Candidate | Last marked NAV, USDG | P&L, USDG | Alpha vs holding, USDG | Recenters |
|---|---:|---:|---:|---:|
| ±20 exit/reentry | 995.362184 | −4.637816 | −1.868882 | 0 |
| ±30 exit/reentry | 996.501007 | −3.498993 | −0.730059 | 0 |
| ±20 active | 992.639267 | −7.360733 | −4.591799 | 1 |
| ±30 active | 995.790055 | −4.209945 | −1.441011 | 1 |

All four modeled positions were open at the last observation. These are frozen marks, not cash liquidation results; the archive retains hypothetical liquidation estimates separately. No closing orders or fees were synthesized. The roughly three-hour sample has insufficient recenter, overnight and weekend coverage to establish a winner. The [final operations check](../lp-paper-review-2026-09-09/operations-check.json) at **11:55:10 UTC / 14:55:10 Vilnius** confirmed the archived ledger hash remained unchanged, the comparison stayed disabled, and independent transaction-paper session 31 remained open under its unchanged release with its timer enabled and active.
