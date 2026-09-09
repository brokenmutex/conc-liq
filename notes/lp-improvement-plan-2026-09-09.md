# LP paper strategy: confirmation and improvement plan

Prepared 9 September 2026. Status: **proposed work; no strategy, service or runtime changed**. The objective is to reduce unnecessary turnover and obtain a valid comparison of active LP policies, judged by net alpha against a common passive holding benchmark.

## What the evidence confirms

The [session audit](paper-performance-2026-09-09/README.md) is confirmed at its original cutoff, **06:47:20 UTC / 09:47:20 Europe/Vilnius**. A second implementation, [verify-paper-performance.py](../scripts/verify-paper-performance.py), reads the frozen raw records without importing runtime accounting code. Its [results](paper-performance-2026-09-09/confirmation.json) reconcile all 22 sessions' gas conversion, fee-token valuation, NAV/P&L identities, continuation funding and campaign benchmark. For the 21 closed sessions it also reconstructs net cash directly from simulated exit proceeds less entry/exit gas. These checks match to the micro-USDG.

| Confirmed observation | Interpretation |
|---|---|
| Sessions 5–25 lost **24.561769 USDG** from 1,000; fees **10.018826**, estimated gas **18.381092** | Fees did not cover gas, before execution drag or inventory effects. |
| The original exact accounting decomposition adds **8.737653 USDG** of entry/exit execution drag | Turnover is expensive. This second check verifies cash and gas independently; it does not independently repeat the first audit's v3 principal decomposition or all 876 fee-growth intervals. |
| Including open #26 at that cutoff, campaign NAV **975.202371**, holding comparator **992.926932**, alpha **−17.724561** | Both absolute return and value added versus holding were negative. Per-session alphas cannot be summed into campaign alpha. |
| First exits: six inventory, eight chain, seven risk/reference | **15/21 involved infrastructure/reference availability.** Syncing, excessive lag and genuinely stale prices still warrant safeguards. These are not 15 proven unnecessary exits. |
| Seven risk-refresh overlaps: #8, #14, #18, #20, #21, #22, #24 | The code rejects an unfinished latest attempt. Six had this as their sole first-exit reason; #14 also failed chain recovery. |
| #17 and #25: healthy monitor, private lag 3/1 blocks, slow public reference depth **0** | Replaying the saved samples through production readiness reproduces `chain_anchor_quorum_unproven`. The existing anchor selector and the 64-confirmation readiness rule disagree. |
| #8/#9 deployed about **39.2%/52.4%** of budget, versus an 80% target | A narrow frozen range and delayed entry can produce materially different exposure from the intended strategy. |
| The four-strategy experiment stopped after about four hours; **zero recenters** | It provides neither an overnight comparison nor evidence that fixed management beats recentering. |

The refresh mechanism is reproduced by the existing runtime test: a fresh canonical completed snapshot passes; selecting an otherwise identical `started` attempt rejects it. In the actual seven events, stored completion timestamps followed the decision timestamp by **4–1,767 ms**. Those are database transaction timestamps, not exact commit-visibility latencies. Earlier snapshot observation ages were 4.8–23.5 seconds, but historical canonical-validation ages were overwritten. Therefore, we cannot prove that a fallback was admissible in every event or calculate avoided losses from these records alone.

The anchor reproduction is stronger: current production code returns the recorded anchor, and the saved health window fails only the chain-anchor requirement within `chainEligible` for #17/#25. The readiness helper also returns an equity-hours label, which the continuous paper policy treats separately. A lower common anchor would satisfy depth arithmetic; obtaining matching historical hashes at that new anchor remains a separate required proof.

This is paper accounting based on local-fork execution estimates, not realized broadcast returns. The LP-versus-holding component in the original decomposition includes funding and mark effects; it does not isolate adverse selection. Removing an exit trigger changes future exposure, so its associated loss is not an estimate of recoverable profit.

Read-only follow-up: at **07:51 UTC**, all 21 closed records from the frozen audit still had identical states, policies and runtime identities. At **07:54 UTC**, #26 had closed at **975.425201 USDG** carried cash, losing **0.013030 USDG** in that session after a chain-recovery exit; #27 was open. The comparison service remained inactive, with `forward_source_unavailable`. These later observations are separate from the frozen totals above; #26's specific chain fault has not been diagnosed here.

## Work in priority order

| Order | Change | Acceptance evidence before proceeding |
|---|---|---|
| **1. Correct evidence handling** | Fix risk-refresh selection and reference-anchor depth agreement. Add immutable decision evidence. | Refresh races and bounded private lag pass when all other evidence passes; actual failures, stale data, hash conflicts and missing quorum still block. |
| **2. Restore continuous comparison** | Introduce a recoverable data-wait state, retain portfolio accounting, and make stopped/stale comparisons visible. Align model and transaction-paper decision inputs. | A delayed checkpoint and process restart preserve balances, accrued fees, costs and benchmark without fabricated orders or reset capital. |
| **3. Improve entry and recenter execution** | Requote drifting narrow entries, enforce actual allocation, screen expensive gas, and test earlier recenter triggers. | Preflight confirms the intended deployment and complete action costs; historical decisions use only information available at the time. |
| **4. Run a bounded paired experiment** | Compare 1,000 USDG at ±20/±30 raw ticks, each with fixed exit/reentry and active recentering. | Useful paired observations, exercised recenter logic, complete accounting and explicit out-of-sample results before selecting a winner. |

**1. Correct evidence handling.** During a new refresh, permit the most recent completed snapshot only when it remains canonical and passes all source, validation, issuer, oracle and price-band checks. Proposed in-flight allowance: at most **10 seconds**, further limited by the existing **30-second validation** and **180-second snapshot/source** ages. This is a test hypothesis, not a general extension of freshness. Never skip a more recent completed failure to find an older success. Missing, failed, over-age or revoked evidence retains existing rejection behavior. Prevent an unnecessary exit signal at its source; do not cancel an already pending exit merely because conditions later clear.

Persist the selected attempt ID/status, snapshot ID/hash, canonical validation as read, evaluation timestamp and exact failed predicates with each decision. Use a consistent decision clock; test a refresh or canonical validation completing during the read so ordinary scheduling does not look like a future timestamp. This closes the historical evidence gap found in this audit.

For health monitoring, obtain a common anchor at or below **the lowest participating usable head minus 64**, retaining one private node and two public references. Keep the established private-lag tolerance at **10 blocks**; a substantially lagging, syncing, stale or mismatching node must not gain eligibility from anchor adjustment. Verify public endpoints support the necessary historical block read. A head-only endpoint cannot silently stand in for a depth-confirmed reference. Record a distinct capability/quorum failure if the proof is unavailable. Account for the older anchor when choosing a sufficiently confirmed strategy checkpoint.

Required cases: private lag 0/1/10/11; public spread 63/64/67/84; missing historical blocks; hash mismatch; syncing; old/future timestamps; interrupted refresh; newer failed refresh; stale USDG; issuer pause; excessive true-price deviation. Preserve the five-minute recovery proof for genuine chain faults. Run targeted unit and isolated Postgres lifecycle checks before release.

**2. Restore continuous comparison.** Separate “no fresh decision is available” from “historical accounting is invalid.” After the decision-age limit is reached, enter `PAUSED_DATA`: place no new orders, retain open inventory and the pending-intent history, mark NAV freshness visibly, and continue polling. On recovery, reconstruct canonical events and fees in order. Do not execute skipped historical decisions. Expire stale entry/recenter intents and reevaluate at a fresh checkpoint; retain a pending safety exit's provenance and retry only through its normal fresh execution checks.

Only a bounded recoverable gap with complete canonical event/fee evidence may resume. The existing 900-second accounting-gap ceiling remains an upper bound, not permission to act on stale data. Revocation, changed source identity, unrecoverable coverage or a larger gap keeps the cohort invalid until audited recovery. Preserve accumulated P&L and disclose decision blackout time in both raw results and the comparison scorecard. Require at least **99% scheduled decision availability** as an initial quality gate; material interruptions remain visible rather than being removed to improve returns.

The observed source gap was 184 seconds; the next checkpoint was captured **4.689 seconds after** the service invalidated itself. Acceptance tests should cover this exact timing, a longer bounded delay, a gap exceeding 900 seconds, restart while paused, restart with an open position, and source revocation. This changes waiting/recovery behavior, not the 180-second age limit for new decisions. Expose last successful source, last worker heartbeat and terminal reason on the local status/dashboard; terminal invalidity must remain visible even when the process exits successfully.

The old comparison stays archived as invalid. Start a new versioned cohort; report its seed capital separately from the transaction-paper campaign's conserved cash. Before ranking, share or reconcile the reference and chain gates, source-availability clock, entry delays and action-cost definitions across the model and transaction-paper engine. The old model's lack of current-risk refresh gating means its P&L cannot explain the worker's infrastructure exits directly.

**3. Improve execution quality.** Begin with these bounded paper hypotheses, checked against historical source/capture clocks:

- **Entry freshness:** quote age no more than **90 seconds**, absolute center movement no more than **5 raw ticks**, and predicted deployed LP value at least **72% of budget** (90% of the 80% target). A failed check causes a fresh quote at a later eligible checkpoint. Bounds still align to spacing 10; five ticks is a drift-admission test, not a mint spacing. Preflight acquisition and mint together; log actual allocation, idle assets, reference-valued exposure and quote-to-entry latency. Check whether these limits cause entry starvation before adoption.
- **Cost admission:** evaluate a fresh round-trip gas estimate before entry. As an initial paper screen, defer entry above **1.5× the trailing median** of comparable valid round-trip quotes over the previous six hours, with at least 20 observations, or above **1.25 USDG** for these 1,000-USDG candidates. The fixed cap prevents an expensive regime normalizing itself into acceptance; validate these hypotheses on the development window and freeze them before the holdout. Collect quotes even while admission is blocked so the sample can recover. If the required evidence is missing, record no admission. Test #19's gas spike, and compare total net alpha including missed fee opportunities. Entry cost controls never delay an otherwise executable required safety exit.
- **Recenter earlier:** the current 70%-of-half-width trigger, two observations and ten-minute cooldown produced no actions. With roughly 80% deployed, inventory can reach the 60% guard before that trigger. Screen only **40% versus 50%** distance and **one versus two** consecutive observations, retaining the ten-minute cooldown. Use the same distance definition as the current model. Select one rule on development/validation data, then freeze it for both widths. Count opportunities blocked by inventory, persistence, cooldown, cost and freshness; if recentering still never runs, management remains untested.

Recenter from the assets actually held: remove/collect, swap only the required imbalance, remint, and charge every step. Check reference-valued exposure again at execution; a hard 60% inventory exit still takes priority. A proposed recenter must have a complete execution/cost path, including failure handling, before its result is rankable. Earlier intervention may reduce exits but may also spend more than it earns; historical net alpha must decide.

Keep the independent **±5% true-price band**, held-session reference rules, 60% inventory exit, 1% initial LP share limit and 50-bps slippage bound. Off-hours acceptance of a held equity reference does not imply acceptance of stale chain state or a stale USDG reference. Do not generalize the ten-block tolerance to all infrastructure failures.

**4. Compare four candidates, with one acquisition/cost convention.**

| Candidate | Starting modeled budget | Half-width | Management |
|---|---:|---:|---|
| A | 1,000 USDG | ±20 raw ticks | Exit to cash, then reenter |
| B | 1,000 USDG | ±30 raw ticks | Exit to cash, then reenter |
| C | 1,000 USDG | ±20 raw ticks | Earlier recenter rule, same hard exits |
| D | 1,000 USDG | ±30 raw ticks | Earlier recenter rule, same hard exits |

Use one captured market stream, one observation clock, common gating and a common passive holding benchmark for all four. Keep the original campaign benchmark visible separately. Report net alpha, absolute NAV, drawdown, fee income, all execution/gas costs, exits/day by reason, recenter count, in-range time, actual deployment and maximum inventory exposure. Mark stale values and reserves explicitly. Measure modeled-versus-transaction-paper discrepancies on the matching baseline; investigate them before attributing differences to strategy quality.

Run a **24-hour reliability checkpoint**, then a first **72-hour economic review including at least two overnight windows**. These are review points, not evidence that a policy is optimal. Require at least ten actually executed modeled recenters per active candidate as an initial coverage minimum; fewer means collect more evidence or report the management comparison as inconclusive. Reserve a new weekend window before making a weekend-specific conclusion. Do not retune during the comparison; corrections create a new version with an explicit boundary.

Rank net alpha after entry, rebalance, exit and inventory liquidation costs, using paired time windows. Publish daily results, not just the best session; replay the full policies offline with **2× action costs** and **50% fee income**, including changed admission and funding decisions. A promising candidate must have positive aggregate base-case net alpha in a held-out window and improved turnover economics without worse inventory breaches. Report stress losses and uncertainty explicitly; prefer the simpler rule if its advantage is small or unstable. These small samples support another paper stage, not a funded profitability claim.

**Do not expand the seven-size grid yet.** Once a width/management combination survives these checks, compare **250 versus 1,000 USDG** under that same rule and full size-dependent swap/share constraints. The partial 250 trial suffered the same modeled fixed gas as 1,000, so there is presently no evidence that it is economically preferable. Neither 1,000 USDG nor ±20 ticks is established as optimal.

## Delivery and verification

Deliver the work in small changes: (1) evidence selection and immutable diagnostics, (2) anchor/readiness agreement, (3) comparison recovery and clock/gate parity, (4) execution hypotheses and the frozen four-candidate plan. Stage the comparison once the first three are verified; record proposed policy additions as new experiment versions.

Use a sealed release built from the scoped commits. A transaction-paper session must close under its original runtime; prevent automatic reentry across the planned upgrade boundary, then explicitly continue its actual net cash under the new release. Do not reset losses, rewrite prior session identities or modify an open session in place. No funded signer or broadcast is part of this plan.

Confirmation performed for this document:

- Independent frozen-source verifier: **22 sessions, 21 closed cash reconciliations**, exact agreement on the totals above.
- Production anchor/readiness replay: **both #17 and #25 reproduced** with the recorded zero-depth public reference.
- Existing reference/runtime tests: **9 passed**, including the unfinished-refresh characterization and stale/issuer guard cases.
- Read-only current DB comparison: all frozen closed sessions unchanged; local service status confirms comparison stopped and paper timer active.

Reproduce the independent audit with a new output path:

```sh
python3 scripts/verify-paper-performance.py \
  data/paper-performance-2026-09-09/source.json \
  notes/paper-performance-2026-09-09/session-metrics.json \
  /tmp/paper-performance-confirmation.json
.tools/node/bin/node --import tsx --test test/paper-runtime.test.ts test/paper-reference.test.ts
```

The immediate implementation priority is **risk-refresh selection, reference-anchor consistency, then a recoverable and observable comparison runner**. Those changes make subsequent parameter learning interpretable; profitability still has to be demonstrated.
