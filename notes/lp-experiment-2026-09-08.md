# Bounded active-LP learning experiment — September 8, 2026

The experiment screens 20 NVDA/USDG candidates against one reconstructed market stream, then runs four modeled portfolios prospectively against the same incoming checkpoints. The existing transaction-simulated paper campaign has a separate lifecycle; its current stopped status is recorded below. No wallets or upstream broadcasts are used.

## Frozen questions and accounting

The base grid is 250/1,000 USDG × ±10/20/30/40/50 **raw tick half-widths** × fixed-with-exit/reentry or inventory-aware recentering. Each candidate starts entirely in USDG cash and must pay for acquiring NVDA. The 80% deployment target, 60% reference-valued NVDA exit threshold, ±5% pool-and-range reference bound, 1% initial added/historical liquidity limit, 50 bps swap slippage limit, initialized boundary admission, 24-hour position limit and 10-minute reentry cooldown are shared.

Recenter candidates require two observations beyond 70% of the distance from their entry center toward a boundary and at least ten minutes since placement. They freeze new bounds and a quote, then remove, minimally buy/sell inventory needed by the new range, and remint at a later checkpoint. Available balances constrain minting. Failed preflights cannot create free fills; completed modeled operations remain charged, and leftover inventory remains owned. Guard/inventory exits liquidate to cash and require recovery/cooldown before entry. Risk exits are not cancelled simply because the risk condition later clears, matching the continuous paper lifecycle.

All candidates accrue fees through range crossings on the observed market path, with hypothetical added-liquidity dilution and protocol fees removed. Mint funding rounds up; withdrawn principal rounds down. Candidate actions do not alter other candidates or the canonical market book. Market price, liquidity, tick and both global fee-growth counters must reconcile exactly at **every checkpoint**. The initial tick book is reconstructed from historical Mint/Burn events; the indexer and replay must cover the source block and target set.

Portfolio cash pays every modeled operation. The cost matrix is frozen from session 6's successful local-fork transaction evidence: acquisition/approval, mint/approvals, removal/collection, sale/approval and allowance clearing. Baseline uses these estimates and full modeled fees; conservative sensitivity doubles costs and halves fees. These are **cost scenarios**, not historical gas quotes or measured mainnet expenses. Active recentering costs are composed from those operations, not measured full recenter executions.

The paper-compatible acquired-inventory passive comparator is retained, and both pool-spot and independent-reference NAV are reported. For **cross-candidate ranking**, an additional common passive comparator purchases 40% NVDA from the same initial USDG budget after a delayed quote, pays acquisition costs, and holds those tokens permanently. This prevents range-dependent starting inventory from changing the scoring benchmark. Live experiment balances never reset between exits/reentries. Independent six-hour historical cells each start a new funded trial, clearly separated from continuous forward performance.

Checkpoint collection normally precedes quorum confirmation. Decisions therefore use a frozen **capture-plus-30-seconds** clock and only health samples available by that clock. A still-unconfirmed source is skipped, matching the paper worker's confirmation wait. Other health failures remain risk findings. The prospective runner waits until that decision time has actually arrived, rejects stale/missed decisions and never fills the past after restart. This approximates worker scheduling; it does not reproduce variable real invocation times or every current-risk preflight. The same `continuous_bounded_v1` reference evaluator and published round timestamps used by paper are applied to each stored risk snapshot.

## Historical screen and interpretation

The frozen source contains **2,075 checkpoints and 362,846 events**, from September 5 at 12:32:48 UTC through September 8 at 13:14:28 UTC. All sources have canonical checkpoint evidence. After the fixed decision delay, 1,769 checkpoints pass the health evaluation. There are 13 chronological six-hour blocks (the first/last may be partial): eight development and five validation blocks, with two cost/fee scenarios per candidate, or **520 evaluated cells**. Adjacent blocks are correlated and cover only one weekend; they are not 13 independent market regimes. Validation was used to choose the next experiment, so the prospective period is the untouched comparison.

A qualifying cell needs valid accounting, at least 30 observations, and at least 30 minutes invested. Checkpoint-weighted active/outside/cash seconds are approximate occupancy measures, not exact intraminute time in range. No candidate has a positive median validation alpha in either cost scenario. Gas and repeated infrastructure exits are substantial; the model separately totals direct infrastructure exit costs and subsequent reentry costs, while retaining both in total P&L. Changing only width does not establish a profitable strategy.

The shortlist is designed for paired learning rather than four similar historical winners:

| Candidate | Purpose |
|---|---|
| 1,000 USDG, ±20 ticks, exit/reentry | Current-policy control |
| 1,000 USDG, ±30 ticks, exit/reentry | Width alternative favored by the conservative screen |
| 250 USDG, ±30 ticks, exit/reentry | Capital-size comparison against the same width |
| 1,000 USDG, ±20 ticks, recenter | Management comparison against the control |

Their baseline validation median alpha versus the common passive comparator was approximately −0.818%, −0.840%, −2.547% and −0.935% per qualifying block, respectively. These are modeled block returns, not forecasts or annualized returns. The ±30 fixed candidate fares better than ±20 under the conservative cost/fee scenario, while ±20 is slightly better in the baseline validation median. This supports comparing a region of parameters, not declaring an optimum.

Using session 6's actual observation times as a calibration case, the model ended with **999.967128 USDG**, versus paper's **999.967410 USDG**: a difference of **−0.000282 USDG**. Its immediate entry mark differed by approximately 0.005258 USDG. Small differences remain from modeled mint funding, hypothetical fee dilution and rounding of converted transaction costs. One successful reconciliation does not validate all recenter paths or large market moves.

## Running and reviewing

The implementation is [the runner](../src/experiment/runner.ts), [the portfolio ledger](../src/experiment/portfolio.ts), [market reconciliation](../src/experiment/market.ts) and [the read-only DB adapter](../src/experiment/source.ts). It reuses existing exact swap and principal math. Runtime and plan hashes bind the forward state; an OS file lock excludes concurrent writers. State and the action ledger are committed together by atomic file replacement. Each new decision rechecks prior checkpoint canonicality and the frozen cost-source evidence. Invalid evidence or a missed forward decision stops the experiment and suppresses performance output. There is no automatic reset that erases losses.

Workspace commands for capture/screen use `.tools/node/bin/node --import tsx src/lp-experiment.ts`. Capture requires `DATABASE_URL`; use the private runtime file without printing its contents. Frozen files are never overwritten:

```text
capture 2026-09-05T12:30:00Z 2026-09-08T13:15:00Z data/lp-experiment-2026-09-08/source.json
screen data/lp-experiment-2026-09-08/source-v2.json data/lp-experiment-2026-09-08/screen-release.json
```

The deployed `conc-liq-experiment.service` owns the continuous forward writer. Its pinned launcher starts with `lp-experiment watch /root/conc-liq/data/lp-experiment-2026-09-08/forward-lag10-v1.json`. `systemctl stop conc-liq-experiment.service` stops the modeled experiment; restarting after missed decisions cannot retroactively resume it. Its state, complete modeled action ledger, latest JSON report and readable Markdown report are under that path. The existing paper campaign is operated through its own pinned `paper stop` command.

`lp-experiment status STATE_PATH` reads the latest report without database or network access. Inspect cumulative P&L, common-benchmark alpha, cost totals, infrastructure churn, occupancy and inventory together. Review at fixed session boundaries, keeping candidate definitions frozen through the next overnight/weekend sample. A changed hypothesis requires a new experiment file and plan, not edits to the existing portfolio state.

Validation: TypeScript and 266 tests passed, including ten new experiment tests for cash/cost conservation, fee/depth reconciliation, delayed decisions, shared benchmarks, liquidity admission, recenter persistence, restart equality, idempotent processing, runtime mismatch, source revocation and missed-decision rejection. Historical reconstruction verified all source intervals. Bounded local-fork probes separately assess the selected entry/exit geometries; they do not turn the prospective modeled portfolios into transaction-faithful recenter simulations.

## Activation and small-lag handling

At 14:06:13.424 UTC on September 8, a fresh prospective comparison was initialized and `conc-liq-experiment.service` enabled with release `64fd6f986ac9bdf345511d5afb3a664f6c0e6598651d2cfd75402b966799b301` (source `f9fb846`). The four candidates above share the corrected RPC monitor described in [small node-lag handling](lp-node-lag-2026-09-08.md). The original historical source and screen remain frozen under the old monitor evidence; no historical hashes or classifications were changed.

The earlier `forward.json` initialization at 13:57:34.749 UTC had not started its worker before the lag investigation. A normal tick marked it invalid for `missed_forward_decision`, with zero entries and zero actions. It remains preserved. The new `forward-lag10-v1.json` is a separately identified prospective trial, not a backfill or reset of invested portfolios. The first start attempt for this new file failed before creation because event coverage had not caught up; a later attempt succeeded.

Bounded geometry probes are preserved in `entry-exit-probes.json` and `entry-exit-probes-lag10.json`. The first obtained a 1,000/±20 quote but subsequent calls were blocked by chain readiness. The second obtained another quote but later execution and the other geometries were unavailable because event coverage had not caught up. There are **no newly verified ±30 transaction round trips**. Existing session-6 evidence calibrates the 1,000/±20 accounting; the four forward portfolios remain modeled scenarios pending further fork validation.

The original transaction-simulated campaign is currently terminal at invalid session 7, with inventory preserved and cumulative NAV unavailable after its preflight consistency failure. Automatic reentry correctly does not reset it. The forward comparison is independent of that campaign and is not a continuation of its money or performance record.

Update at 14:21 UTC: [the paper recovery audit](paper-recovery-2026-09-08.md) accepted session 7's previously saved exit and resumed the independent paper campaign as session 8 with 995.136631 USDG. The four modeled portfolios retained their existing state, runtime and plan.
