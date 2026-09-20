# Research evidence

These files support [the active LP proposal](../active-lp-strategy-proposal-2026-09-07.md). They contain descriptive observations, an exact observed-fee reconciliation and a bounded range/churn screen. Guarded strategy net performance remains unmeasured. See [milestone results](../active-lp-historical-milestone-2026-09-07.md).

September 8 adds the [self-financing portfolio sensitivity](../active-lp-portfolio-replay-2026-09-08.md) and `portfolio-economic-sensitivity.json`. This stage carries actual wallet and LP inventory across actions, with modeled fee allocation and hypothetical operation costs, across the seven budgets and ±10–±50 tick ranges. It supersedes the earlier lack of a research portfolio ledger; it does not fill the measured live cost-model fields. Full action/mark series and source/code fingerprints live under ignored `data/lp-portfolio-2026-09-08/`.

The user clarified the current width focus as [±10–±50 raw ticks around the price](../active-lp-tick-half-width-screen-2026-09-07.md), giving total widths of 20, 40, 60, 80 and 100 ticks. The frozen selections and compact run manifests retain both the corrected and superseded interpretations. Their full deterministic outputs were removed after verified file-only replays and remain recoverable through `research/manifests/active-lp-tick-half-width-2026-09-07/pruned-artifacts.json` and `research/manifests/active-lp-tick-width-2026-09-07/pruned-artifacts.json`. Percent-width artifacts below are also historical baselines.

- `observations.json`: checkpoint data, session 4 state/events and classified transaction costs. Capture timestamps are recorded inside; the cost refresh is separate from the checkpoint snapshot.
- `summary.json`: calculations from that fixed observation file. Reproduce with `python3 notes/active-lp-research-2026-09-07/analyze.py` from the repository root. Floating point is used only for descriptive statistics; it is not the trading ledger.
- `history-coverage.json`: exact event counts and sparse first-block timestamp bounds from one PostgreSQL repeatable-read, read-only transaction at its recorded timestamp. The replay worker advances separately; its count is not an independent proof of event completeness.
- `history-coverage.sql`: principal read-only coverage queries used for the historical snapshot. Results will change as ingestion advances. Run against the configured local database without printing its connection string.

All timestamps are UTC. Event ingestion timestamps are not historical block timestamps. The event collection substantially predates the synchronized strategy checkpoint collection.

The subsequent [reference and cost audit](../active-lp-reference-cost-audit-2026-09-07.md) reconstructs the August oracle publications and audits 70 historical receipts. See `reference-cost-audit-summary.json` and `freshness-sensitivity.json`: the five-minute limit on both price feeds admits no observations in this window. Session-aware freshness is a proposed research change; live settings remain unchanged.

The portfolio replay now tests an explicit session-aware reference scenario. Weekend rounds and four token snapshots are archive-verified under `data/lp-weekend-2026-09-07/`; operational freshness settings remain unchanged. Its final economic mark is before Sunday reopening because the captured reopening observations lack a new NVDA publication.

## Reproduce the portfolio sensitivity

Use new output names when replaying: the runner writes manifests and results exclusively to avoid overwriting evidence. The manifest freezes assumptions before scoring and records source and implementation hashes. These commands read frozen files only:

```bash
.tools/node/bin/node --import tsx scripts/lp-portfolio-replay.mjs \
  data/lp-research-2026-09-07/size-sweep-timestamps.json \
  data/lp-reference-2026-09-07/backfill/references.json \
  data/lp-portfolio-repeat/weekday.json 250,500,1000,2000,3000,4000,5000

.tools/node/bin/node --import tsx scripts/lp-portfolio-replay.mjs \
  data/lp-research-2026-09-07/weekend-timestamps.json \
  data/lp-weekend-2026-09-07/backfill/references.json \
  data/lp-portfolio-repeat/weekend.json 250,500,1000,2000,3000,4000,5000 \
  2026-08-16T21:59:00Z
```

`scripts/lp-portfolio-report.mjs` independently reconciles every action's raw wallet balances and checks that the 1,000 USDG cases reproduce in the full size sweep before generating the repository report. Its canonical inputs and exclusively-created report paths are fixed in the script.

## First historical milestone

The [portfolio-size experiment](../active-lp-strategy-proposal-2026-09-07.md#user-selected-portfolio-size-experiment) now has a completed [seven-size capacity sweep](../active-lp-size-sweep-2026-09-07.md), using the new file-only `sizes` command. Total budgets are **250, 500, 1,000, 2,000, 3,000, 4,000 and 5,000 USDG**, with 80% nominal LP deployment, 20% reserve and the fixed ±5% reference tolerance. The August 10–12 window produced 196 valid capacity/geometry combinations and 28 tick-grid exclusions. Guarded economic results remain unavailable. The existing `screen` command and `range-screen-v1` artifacts preserve the original July 21–23, 1,000 USDG diagnostic.

- `size-sweep-selection.json`: window and size grid fixed before candidate results.
- `size-sweep-v1.json.manifest.json`: compact fingerprints and verified coverage for all sizes, policies, and widths. The full deterministic placements and segment distributions were removed after a byte-identical replay; recovery and the receipt are in `research/manifests/active-lp-size-sweep-2026-09-07/pruned-artifacts.json`.
- `size-sweep-reference-probe.json` and `size-sweep-economic-gaps.json`: successful archive probe, insufficient freshness/continuous risk evidence and missing measured rebalance/exit costs.

- `coverage-verification.json`: exact HyperSync-versus-database raw log comparison for blocks 15,511,376–17,511,376, including timestamp/source fingerprints. The matching header set is under `data/lp-research-2026-09-07/development-timestamps.json`.
- `fee-reconciliation.json`: both NVDA pools replayed from initialization through saved accounting block 53,589,223; global fees, captured ticks and captured positions all match. This is observed-chain evidence, not counterfactual LP profit.
- `range-screen-v1.json.manifest.json`: window, source fingerprints, widths, decision grid and geometric action assumptions fixed before producing results.
- `range-screen-v1.json`: all 32 requested combinations; four infeasible tick-grid combinations excluded, 28 structural comparisons. Fees, costs, net alpha and rank remain unavailable. The ±5% independent-reference gate rejects entry because the July window has no independent reference inputs in this source.

The frozen raw source is `data/lp-research-2026-09-07/source.jsonl.gz` (approximately 250 MiB). Its `.sha256` sidecar fingerprints the **uncompressed JSONL bytes**, not the gzip container. The first record contains the immutable source manifest and chain fee snapshots; event records retain decoded arguments and raw topics/data; the last record records counts. Do not edit either raw input. The live database may advance; replaying these files reproduces the saved audit.

From the repository root, run the following commands with the workspace Node. Output files are created exclusively: use a new output path when repeating a run. `capture` and `timestamps` load the local `.env`; neither loads sibling project settings. `reconcile` and `screen` use files only.

```bash
# Reproduce against preserved input; these output paths must not already exist.
.tools/node/bin/node --import tsx scripts/lp-research.mjs reconcile \
  --input data/lp-research-2026-09-07/source.jsonl.gz \
  --output data/lp-research-2026-09-07/reconciliation-repeat.json

.tools/node/bin/node --import tsx scripts/lp-research.mjs screen \
  --input data/lp-research-2026-09-07/source.jsonl.gz \
  --timestamps data/lp-research-2026-09-07/development-timestamps.json \
  --output data/lp-research-2026-09-07/screen-repeat.json

# Capture a new read-only source snapshot at the same saved accounting boundary.
# Capture timestamps/cursor/reference coverage can differ from the original.
.tools/node/bin/node --import tsx scripts/lp-research.mjs capture \
  --through-block 53589223 \
  --output data/lp-research-repeat/source.jsonl.gz

.tools/node/bin/node --import tsx scripts/lp-research.mjs timestamps \
  --input data/lp-research-repeat/source.jsonl.gz \
  --from-block 15511376 --to-block 17511376 \
  --output data/lp-research-repeat/timestamps.json
```

`capture` requires a saved fee-accounting checkpoint for both pools and an indexer cursor beyond the boundary. Reads are sequential in one read-only repeatable-read transaction; the script performs no schema setup. `timestamps` uses the existing native HyperSync client with ranges of at most 100,000 blocks per query and at most five million blocks per run. It verifies raw log identity/content and every event header. It has no live-node or archival-state fallback. This milestone used 22 bounded native query calls; pagination can issue additional underlying requests.

`screen` is restricted to dates before August 17. It saves its manifest before inspecting candidate results. One-minute occupancy and interval extrema are separate metrics. Recenter counts are delayed geometric range changes, not executable rebalance transactions, and cannot be multiplied by a made-up fee to obtain net performance.

## Solidity differential fixtures

`test/fixtures/v3-research-swap-steps.json` records 217 independent official Solidity `SwapMath.computeSwapStep` results. Ordinary tests read this fixture without network or Anvil. To regenerate it, prepare the pinned upstream source (if absent) and compile a tiny wrapper:

```bash
git clone https://github.com/Uniswap/v3-core.git data/lp-research-tools/v3-core
git -C data/lp-research-tools/v3-core checkout d0831dc6b8a318df3872b6d68f6de135c9f3ec29
mkdir -p data/lp-research-tools/v3-core/contracts/research
cat > data/lp-research-tools/v3-core/contracts/research/ResearchSwap.sol <<'SOL'
pragma solidity =0.7.6;
import '../libraries/SwapMath.sol';
contract ResearchSwap {
 function step(uint160 p,uint160 target,uint128 l,int256 remaining,uint24 fee)
  external pure returns(uint160,uint256,uint256,uint256) {
  return SwapMath.computeSwapStep(p,target,l,remaining,fee);
 }
}
SOL
/root/.foundry/bin/forge build --root data/lp-research-tools/v3-core \
  --contracts contracts --use 0.7.6 contracts/research/ResearchSwap.sol
.tools/node/bin/node --import tsx scripts/generate-v3-research-fixtures.mjs
```

The generator starts and stops an isolated, unforked Anvil on localhost port 18659 and uses a code override with `eth_call`; it has no upstream connection or transaction submission. `test/fixtures/v3-research-empty-liquidity.json` separately preserves the observed zero-liquidity traversal regression from the frozen database source.
