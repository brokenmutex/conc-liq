# Concentrated-liquidity observer

This repository starts the Robinhood Chain Uniswap v3 liquidity automation
project with a deliberately read-only observer. It verifies the configured
chain and canonical contracts, resolves selected RWAs through Robinhood's live
asset registry, discovers their USDG pools through the official v3 factory,
and records block-pinned pool state.

There is no private-key configuration, signer, transaction construction, or
capital-moving path in this phase.

## What one observation verifies

- RPC chain ID is Robinhood Chain mainnet (`4663`).
- The official Uniswap v3 factory and position manager have bytecode.
- Canonical USDG has bytecode and reports the expected symbol.
- Every selected RWA comes from Robinhood's registry, is active, has bytecode,
  and matches its registry symbol and decimals on-chain.
- Each pool comes from `factory.getPool(RWA, USDG, fee)` and independently
  reports the expected tokens and fee.
- All reads use one pinned block, avoiding a mixed-state snapshot.
- Protocol-sized integers remain decimal strings; JavaScript floating point is
  never used for liquidity or `sqrtPriceX96`.

The default research universe is `GLD,SPY,QQQ,NVDA,AAPL,GOOGL,MSFT` across the
100, 500, 3000, and 10000 fee tiers. Discovery does not imply that a pool is
safe or profitable.

## Setup

Node 24 LTS is workspace-local because this machine did not have Node installed:

```bash
export PATH=/root/conc-liq/.tools/node/bin:$PATH
npm install
cp .env.example .env
```

Run checks:

```bash
npm run check
forge build
```

Run one live, read-only observation:

```bash
set -a
source .env
set +a
npm run observe
```

Without `DATABASE_URL`, the snapshot is appended to the ignored
`data/snapshots.jsonl` file. A dedicated RPC provider should replace the public
endpoint before continuous collection.

## PostgreSQL

Set `DATABASE_URL` to enable PostgreSQL persistence. The observer applies the
idempotent schema on startup; it can also be applied explicitly:

```bash
npm run db:migrate
npm run observe
```

Every run stores its complete immutable JSON snapshot, with pool fields also
materialized for indexed SQL queries.

## Historical v3 event indexer

The tracked `config/indexer-pools.json` manifest contains the 15 selected
RWA/USDG pools that had nonzero active liquidity in both the imported verified
pool snapshot and this repository's first live observation. Each target pins
its factory creation block. Startup fails unless every pool still matches the
canonical factory, RWA, USDG, fee, bytecode, and `PoolCreated` evidence.

For historical work, point `RH_INDEXER_RPC_URL` at a private or archival read
node. The sibling `arb-robinhood` environment already contains the private
Robinhood read-node URL; keep that value outside this repository.

On the current host, reuse that untracked read endpoint without copying it:

```bash
set -a
source /root/arb-robinhood/.env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
```

Exercise decoding without writing data:

```bash
npm run backfill -- --dry-run --from-block 1672833 --to-block 1672833
```

Run a bounded PostgreSQL batch:

```bash
npm run db:migrate
npm run backfill -- --max-chunks 25
```

The indexer:

- records raw and decoded `Initialize`, `Mint`, `Burn`, `Collect`, `Swap`,
  `Flash`, observation-cardinality, and protocol-fee events;
- keys logs by transaction hash and log index and preserves canonical ordering;
- commits each log range, end-block checkpoint, and cursor atomically;
- verifies saved checkpoint hashes on restart and rewinds with overlap;
- halves ranges after provider failures and grows quiet ranges gradually; and
- never submits a transaction.

Changing the target manifest fails closed for an existing cursor unless the
operator supplies an explicit safe `--from-block`. The default 64-block
confirmation depth is an operating parameter, not a claim of L1 finality.

## Deterministic v3 state replay

Replay the canonical event stream into derived pool, initialized-tick, and
core-position state:

```bash
npm run replay
```

Each 25,000-event batch updates derived rows and the replay cursor in one
PostgreSQL transaction. A killed process resumes after its last committed log.
The cursor also pins the last applied event's block hash; if indexed history
changes behind it, replay fails closed and requires an explicit rebuild:

```bash
npm run replay -- --rebuild
```

Bound work when exercising checkpoint/resume behavior:

```bash
npm run replay -- --rebuild --max-batches 1
npm run replay -- --max-batches 1
```

The strict reducer reconstructs and checks:

- pool `sqrtPriceX96`, tick, and active liquidity;
- initialized-tick liquidity gross and signed liquidity net;
- core positions keyed by pool, owner, lower tick, and upper tick;
- observation-cardinality targets and packed protocol-fee settings; and
- cumulative event-reported mint, burn, and collection amounts.

Every Swap must agree with the liquidity implied by all crossed tick-net
deltas. Position and active-liquidity underflows abort the batch. A zero-value
Collect against an absent core position is treated as a valid no-op; a
nonzero unknown-position collection fails.

Reconcile every reconstructed pool, initialized tick, and core position
against historical `eth_call` state at the replay completion block:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run reconcile
```

Event logs alone do not expose global fee-growth accumulators, per-tick
fee-growth-outside values, or current position `tokensOwed`. The replayer does
not label those values exact or infer them from collection cash flows.

## Private RPC quorum circuit

Run the low-rate health monitor before starting the tail or accounting workers:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run rpc:health -- --once
```

The monitor compares the private head with two public references, then requires
the references to agree on a shared hash at least 64 blocks behind the fastest
reference. A matching reference group supplies a conservative maximum reference head. The
circuit degrades above 20 blocks or 5 seconds of lag and opens immediately above
100 blocks or 30 seconds, when the private node cannot serve or disagrees with
the reference-confirmed anchor, on a reported sync, a stalled private head,
excessive latency, missing quorum, or failed private reads. Both `degraded` and
`open` stop bulk work.

Recovery is deliberately sticky: twelve consecutive clean samples are required
before the state returns from `half_open` to `healthy`. Tail and fee-accounting
clients use zero transport retries and check the persisted circuit before every
private RPC request, with a two-second cache to bound database load. A missing
or older-than-30-second health sample also closes the gate. The health monitor's
own fixed load is four small private calls and three calls to each reference per
sample; it does not request logs or contract state.

Install the monitor first. The tail and accounting units require it:

```bash
sudo install -m 0644 ops/conc-liq-rpc-health.service /etc/systemd/system/
sudo install -m 0644 ops/conc-liq-tail.service /etc/systemd/system/
sudo install -m 0644 ops/conc-liq-accounting.service /etc/systemd/system/
sudo install -m 0644 ops/conc-liq-accounting.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now conc-liq-rpc-health.service
journalctl -u conc-liq-rpc-health.service -f
```

Only start or enable the bulk units after the monitor reports `healthy`. Setting
`RPC_HEALTH_GATE_ENABLED=false` is an explicit diagnostic bypass; do not use it
for unattended or production collection.

## Exact core-position fee accounting

Capture the missing fee state directly from every pool at one exact replay
completion block:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run accounting:snapshot
```

The collector opens a repeatable-read snapshot of replayed state, verifies its
block hash against the private node before and after collection, and reconciles
all pool, initialized-tick, and core-position liquidity through block-pinned
contract reads. It then applies Uniswap v3's canonical uint256-wrap fee-growth
inside formula and Q128 flooring. Zero-liquidity positions are also read because
they can retain stored `tokensOwed`; newly pending fees are calculated only for
active positions whose boundary ticks remain initialized.

Each run is immutable in `v3_fee_accounting_runs`, with exact raw-token rows in
`v3_pool_fee_accounting`, `v3_tick_fee_accounting`, and
`v3_position_fee_accounting`. `claimable` is the sum of the pool's stored
`tokensOwed` and newly accrued pending fees at that block. This is Uniswap core
position-key accounting: multiple NFTs using the same position-manager owner
and range are aggregated by the pool, so the data is not per-NFT or per-user
attribution. Raw amounts are not USD value, inventory PnL, or a profitability
claim.

The snapshot is deliberately outside the ten-second tail cycle because the
current universe requires thousands of historical calls per capture. Run it
manually, or install the isolated hourly checkpoint timer:

```bash
sudo install -m 0644 ops/conc-liq-rpc-health.service /etc/systemd/system/
sudo install -m 0644 ops/conc-liq-accounting.service /etc/systemd/system/
sudo install -m 0644 ops/conc-liq-accounting.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now conc-liq-rpc-health.service
sudo systemctl enable --now conc-liq-accounting.timer
systemctl list-timers conc-liq-accounting.timer
journalctl -u conc-liq-accounting.service -f
```

The timer first invokes `--if-new-source`, which checks the exact replay block
and hash before making accounting RPC calls. It then reconstructs principal,
captures any configured position NFTs, and attempts the newest stable-position
interval baseline described below. The NFT step is a successful no-op until IDs
are configured. Database uniqueness constraints make every step idempotent and
resolve concurrent manual/timer races. The timer is persistent across downtime,
and a failed capture does not stop the canonical tail.

At the 2026-09-04 live row count, a full fee-accounting checkpoint occupies
about 4.5 MB in PostgreSQL, or roughly 3.2 GB/month at this cadence before
bloat. Monitor table growth before increasing frequency; there is intentionally
no automatic data deletion.

The implementation follows Uniswap's official
[`Tick.getFeeGrowthInside`](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/Tick.sol),
[`Position.update`](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/Position.sol),
and periphery
[`PositionValue.fees`](https://github.com/Uniswap/v3-periphery/blob/main/contracts/libraries/PositionValue.sol)
semantics.

## Exact liquidity-principal reconstruction

Materialize the token amounts represented by every active core position in the
newest accounting checkpoint:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run principal:reconstruct
```

Use `--run ID` for one accounting run or `--all` to backfill every checkpoint
that does not yet have the current principal schema version. The command
revalidates each source block hash against the private node before saving and is
idempotent for an already reconstructed run.

The implementation reproduces Uniswap's canonical
[`TickMath.getSqrtRatioAtTick`](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol)
and
[`LiquidityAmounts.getAmountsForLiquidity`](https://github.com/Uniswap/v3-periphery/blob/main/contracts/libraries/LiquidityAmounts.sol)
integer semantics, including its floor rounding. It records whether each
position is below, inside, or above its range and persists exact raw-token
principal in `v3_principal_accounting_runs`,
`v3_pool_principal_accounting`, and
`v3_position_principal_accounting`.

Principal excludes stored and pending fees, zero-liquidity positions, USD
valuation, and ownership attribution beyond the aggregated Uniswap core
position key. It is an exact composition snapshot, not PnL or execution
evidence; all run rows are explicitly execution-ineligible.

At the 2026-09-04 live row count, the derived principal tables add about
0.87 MB per checkpoint. Together with exact fee accounting, the hourly cadence
is roughly 3.8 GB/month before PostgreSQL bloat; the same no-auto-deletion policy
applies.

## Per-NFT position monitoring

Track the exact state of one or more canonical Uniswap V3 Position Manager NFTs
at the newest immutable accounting checkpoint:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run nft:snapshot -- --token-id 123
```

Repeat `--token-id` for multiple NFTs, or set comma-separated
`NFT_POSITION_TOKEN_IDS` in the ignored `.env`. The CLI flag overrides the
environment list. A configured NFT must belong to the monitored RWA/USDG pool
universe; anything else fails closed. `--accounting-run ID` selects a specific
checkpoint, and `--if-configured` makes an empty configuration a safe no-op for
the hourly service.

Unlike core-position accounting, this reader uses each NFT's individual
Position Manager fee-growth checkpoint and stored fees. It block-pins ownership,
range, liquidity, token decimals, exact principal, newly pending fees, and total
claimable fees to the accounting source block. Rows are immutable and
idempotent in `v3_nft_position_snapshots`; the dashboard shows human-readable
token amounts while retaining exact raw units in tooltips.

This is read-only attribution, not performance accounting: it does not yet know
deposit basis, withdrawals, collected-fee history, mark-to-market value,
divergence loss, gas, or net PnL. Every row is execution-ineligible, and the
repository still has no signer or transaction path.

## Static range-policy simulator

Compare multiple centered ranges over two immutable accounting checkpoints
using the same starting USDG budget and an explicit operator-supplied cost:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run range:simulate -- \
  --rwa NVDA \
  --fee 500 \
  --budget-usdg 1000 \
  --cost-usdg 2 \
  --half-widths 1,2,5,10,20,50
```

The half-width values are counts of the pool's canonical tick spacing. The
command defaults to the newest two accounting runs; use `--from-run ID` and
`--to-run ID` to pin an older interval. USDG inputs accept at most six decimal
places and are converted to exact raw units without floating point.

For each candidate, the simulator:

- centers an aligned range at the first checkpoint;
- finds the maximum liquidity supported by the common budget using canonical
  floor-rounded principal math, retaining any rounding remainder as idle USDG;
- proves the full indexed Swap tick path remained inside the range;
- applies the observed endpoint global-fee-growth delta to candidate liquidity;
- values end principal and fees in USDG at the ending pool spot price;
- subtracts the configured cost once; and
- reports divergence versus holding, absolute USDG P&L, and net LP alpha versus
  holding the same post-entry token inventory.

A range crossed by the observed path is stored as `excluded`; the simulator
does not invent its in-range duration or fees. Completed candidates are ranked
by net LP alpha. Runs and candidates are immutable and idempotent in
`v3_range_simulation_runs` and `v3_range_simulation_candidates` and appear in
the dashboard.

This is a normalized shadow screen, not a profitability or execution claim.
Principal arithmetic and observed fee-growth deltas are exact, but the
counterfactual assumes the candidate did not change the observed price path or
dilute fee growth. Valuation uses pool spot rather than a fresh Chainlink mark;
the configured cost is not an estimate; and this first interval primitive does
not rebalance, compound fees, or model entry swaps. Every result remains
execution-ineligible.

## Stateful range-policy replay

Chain the certified interval primitive across multiple immutable accounting
checkpoints while carrying the policy's position and earned token inventory:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run policy:replay -- \
  --rwa NVDA \
  --fee 500 \
  --budget-usdg 1000 \
  --entry-cost-usdg 1 \
  --rebalance-cost-usdg 1 \
  --trigger-percent 50 \
  --half-widths 1,2,5,10,20,50 \
  --lookback 6
```

The default lookback is six checkpoints. Every replay window is bounded to
2–64 checkpoints. To reproduce an immutable window, replace `--lookback` with
`--from-run ID --to-run ID`; all matching checkpoints between those endpoints
are included.

Each policy starts from the same post-entry capital and inventory. Fees accrue
in exact raw token units and remain idle until a checkpoint trigger recenters
the range. A recenter ideally recomposes the full pool-spot value into the new
range and charges the explicit per-rebalance cost. The unchanged post-entry
inventory is the passive-holding benchmark. The replay reports total endpoint-
valued fee accrual, costs, recenter count, maximum checkpoint drawdown,
absolute P&L, and net LP alpha versus that benchmark.

Every interval must prove that its complete indexed Swap tick path stayed
inside the range active during that interval. A crossing stops that candidate
at the first uncertifiable checkpoint; no partial in-range duration or fee is
invented. Runs, candidates, and per-interval audit steps are immutable and
idempotent in `v3_range_policy_replay_runs`,
`v3_range_policy_replay_candidates`, and `v3_range_policy_replay_steps`.

This remains a normalized shadow model. It assumes zero market impact, no
self-dilution, ideal spot recomposition, and checkpoint-only trigger decisions.
Pool spot is not an oracle mark, and operator-supplied costs are illustrative
rather than measured gas, approval, mint, burn, collect, or swap costs. Results
remain execution-ineligible and are not pool recommendations.

## Block-pinned oracle calibration

Compare each replay checkpoint's V3 spot price with the independent Chainlink
RWA/USD and USDG/USD basis:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run oracle:calibrate -- \
  --rwa NVDA \
  --fee 500 \
  --from-run 2 \
  --to-run 7
```

Use `--lookback COUNT` instead of explicit endpoints for the newest 2–64
accounting checkpoints. The command source-hashes the current canonical
Robinhood asset registry and Chainlink feed directory, verifies the pool's RWA
address and decimals, then reads both oracle rounds and the RWA token's
multiplier/pause state at every historical checkpoint block.

Both pool and oracle prices are stored as exact floor-rounded x18 USDG per RWA
values. The oracle basis divides Chainlink's multiplier-adjusted RWA/USD answer
by USDG/USD; it deliberately does not apply `uiMultiplier()` a second time.
Signed pool deviation is stored in parts per million.

A mark is valid only when both rounds are positive, complete, description- and
decimal-matched, and within the strict `RISK_MAX_PRICE_AGE_SECONDS` ceiling at
that historical block. Token state must also be readable, unpaused, and outside
a multiplier transition. Invalid marks retain their observed price and reason
for diagnosis but are stored as `excluded` and cannot be treated as a valid
valuation input. Runs and marks are immutable and idempotent in
`v3_range_oracle_calibration_runs` and
`v3_range_oracle_calibration_marks`; all remain execution-ineligible.

## Stable-position fee interval baseline

Compare two exact accounting checkpoints and persist a conservative raw-token
fee benchmark:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run backtest:baseline
```

By default, the command compares the newest two accounting runs. Use
`--from-run ID --to-run ID` for an explicit interval. Both endpoint block hashes
are re-read from the private node before the result is accepted, and rerunning
the same pair returns the existing immutable baseline.

The benchmark includes only core positions that had positive liquidity at both
endpoints and no `Mint` or `Burn` event in the open-closed interval
`(fromBlock, toBlock]`. This includes excluding zero-liquidity `Burn` pokes,
because they update the position's fee-growth checkpoint. For every remaining
position, unchanged liquidity and fee-growth checkpoints are required, and the
exact increase in newly pending token 0 and token 1 fees is summed per pool.
Any inconsistency or pending-fee decrease fails the whole baseline closed.

Results are stored in `v3_stable_fee_baseline_runs` and
`v3_stable_fee_pool_baselines`. They are a partial stable-position sample in raw
token units: not total pool revenue, per-NFT attribution, USD value, inventory
PnL, or evidence that a range policy would have been profitable. Every row is
explicitly execution-ineligible.

## Continuous confirmation-safe tail

Run one complete index-to-replay cycle:

```bash
npm run tail -- --once
```

Run continuously at the configured poll interval:

```bash
npm run tail
```

The worker holds a PostgreSQL advisory lock so only one tail process can own a
stream. Each cycle advances the reorg-aware event index to the current safe
head, then replays exactly the newly committed canonical events. Transient
failures back off exponentially; five consecutive failures stop the process,
and the service start limit prevents an unbounded restart loop. If a source
reorg invalidates the last applied replay event, only the derived replay tables
are automatically rebuilt from the canonical event index.

Install the repository-owned service on this host:

```bash
sudo install -m 0644 ops/conc-liq-rpc-health.service /etc/systemd/system/
sudo install -m 0644 ops/conc-liq-tail.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now conc-liq-rpc-health.service
sudo systemctl enable --now conc-liq-tail.service
systemctl status conc-liq-tail.service
journalctl -u conc-liq-tail.service -f
```

The service imports the ignored local `.env` and the sibling private-node
environment at process start. The RPC value is never copied into tracked
configuration.

## Oracle, halt, and corporate-action risk snapshots

Capture the current confirmation-safe risk inputs independently:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run risk:snapshot
```

The collector fetches Robinhood's asset registry and Chainlink's live
Robinhood feed directory on every attempt. It also fetches Robinhood's official
Stock Tokens market-policy page and verifies its current 24/7 statement. Every
source records the URL, fetch time, and SHA-256 of the exact response bytes. It
never hardcodes feed proxy addresses.
All token and feed reads are pinned to the same confirmation-safe block:

- registry status and all market/extended/overnight trading capabilities;
- registry current and pending multipliers;
- token `uiMultiplier()`, `newUIMultiplier()`, `effectiveAt()`, and
  `oraclePaused()`;
- feed bytecode hash, decimals, description, and full `latestRoundData()`;
- positive-answer, complete-round, future-timestamp, and freshness checks; and
- the USDG/USD quote feed used by every RWA/USDG pool.

Chainlink's token price already includes Robinhood's UI multiplier, so the
collector verifies multiplier consistency but never multiplies the feed answer
again. The effective freshness limit is the smaller of the directory heartbeat
and `RISK_MAX_PRICE_AGE_SECONDS` (five minutes by default).

Every successful snapshot and per-asset result is immutable in
`risk_snapshot_runs` and `asset_risk_snapshots`. Every attempt first creates a
`risk_snapshot_attempts` row and ends as `succeeded` or `failed`; downstream
code must reject a stale snapshot or one not backed by the newest successful
attempt. Risk failures do not increment the canonical tail's circuit breaker
or stop index/replay. The continuous tail attempts this collection once per
`RISK_SNAPSHOT_INTERVAL_MS`.

Evaluate the latest persisted evidence through the reusable read-only gate:

```bash
npm run risk:gate
```

The gate requires the newest collection attempt to have succeeded, its snapshot
to be no older than `RISK_GATE_MAX_SNAPSHOT_AGE_SECONDS`, and the snapshot block
hash to have been revalidated against the private node within
`RISK_GATE_MAX_CANONICALITY_AGE_SECONDS`. The indexed and replayed cursors must
also cover that block. It then preserves every denial from the underlying
snapshot. A new attempt temporarily closes the gate until its snapshot is
committed atomically. The tail refreshes canonicality independently every cycle,
so a stopped or disconnected tail closes the gate even before snapshot expiry.

The execution eligibility flag is deliberately stricter than collection
success. Robinhood's official current Stock Tokens page describes these assets
as available 24/7, so the fetched and hashed policy resolves the former generic
calendar ambiguity; this is distinct from Classic Stock Tokens and their older
schedule. If that statement disappears, the collector restores
`market_session_unverified`. Registry capabilities, token pause state, corporate
actions, and oracle freshness remain dynamic checks. As of the 2026-09-03
verification, Chainlink's Robinhood directory had no GLD token-price feed and
its sequencer-feed directory had no Robinhood Chain entry, so the gate remains
closed. This repository still has no transaction path.

Sources: [Robinhood oracle and corporate-action behavior](https://docs.robinhood.com/chain/oracles-and-price-feeds/),
[Robinhood Stock Tokens 24/7 policy](https://robinhood.com/rhj/stocktokens/),
[Chainlink Robinhood tokenized-equity feeds](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood),
and [Chainlink L2 sequencer feed availability](https://docs.chain.link/data-feeds/l2-sequencer-feeds).

## Lightweight synchronized strategy checkpoints

Capture pool state and oracle valuation at the exact block owned by a risk
snapshot without running the full tick-and-position accounting scan:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run strategy:checkpoint -- --rwa NVDA --fee 500
```

The optional paired `--rwa`/`--fee` arguments restrict both risk collection and
pool reads to one exact manifest target while retaining the full canonical
target-set hash. Without them the command reads every manifest pool. Every
private-node request is quorum-gated with transport retries disabled. The
command first stores the normal confirmation-safe risk snapshot. It then reads
`slot0`, active liquidity, and both global fee-growth accumulators at that same
block. Token-decimal reads are deduplicated by RWA address. Pool/oracle prices
use the exact calibration math, and a mark is
excluded when either oracle is missing, invalid, or stale; the token is paused
or changing multiplier; decimals disagree; liquidity is zero; or the pool is
locked.

Runs are immutable in `v3_strategy_checkpoint_runs` and
`v3_strategy_pool_checkpoints`, reference their source `risk_snapshot_runs`
row, and remain explicitly execution-ineligible. Valuation validity is not a
live-trading authorization: sequencer, registry, market-policy, canonicality,
and freshness gates still apply independently.

The continuous tail can attach this lightweight capture to its existing risk
cadence. It is disabled by default; set `STRATEGY_CHECKPOINT_ENABLED=true` only
after reviewing the added RPC load. With the current 15-pool manifest, each
capture adds 60 pool calls plus one decimals call per distinct RWA, instead of
the roughly 11,000 calls needed by full accounting.

The repository also includes a five-minute, single-pool timer for the current
NVDA/USDG 0.05% research target. It preserves the strict 300-second oracle age:
weekend or otherwise stale marks are stored as excluded rather than relaxed.

```bash
sudo install -m 0644 ops/conc-liq-strategy-checkpoint.service /etc/systemd/system/
sudo install -m 0644 ops/conc-liq-strategy-checkpoint.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now conc-liq-strategy-checkpoint.timer
systemctl list-timers conc-liq-strategy-checkpoint.timer
```

## Shadow-only weekend perpetual reference

Capture the current trade[XYZ] `xyz:NVDA` HIP-3 market context directly from
Hyperliquid's public info API:

```bash
set -a
source .env
set +a
npm run perp-reference -- snapshot
```

The snapshot records oracle, mark, mid, impact prices, volume, open interest,
source-response hash, and conservative research-quality checks. It also records
the expected New York pricing mode. The source is structurally shadow-only:
every row has `execution_eligible=false`, and PostgreSQL enforces that invariant.
Passing the quality checks cannot authorize a liquidity action.

An independent five-minute timer is available for continuous snapshots and a
stored comparison with the newest NVDA/USDG strategy checkpoint. It uses only
Hyperliquid's public API and PostgreSQL; it does not call the private Robinhood
RPC or couple its failure state to the chain observer:

```bash
sudo install -m 0644 ops/conc-liq-perp-reference.service /etc/systemd/system/
sudo install -m 0644 ops/conc-liq-perp-reference.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now conc-liq-perp-reference.timer
systemctl list-timers conc-liq-perp-reference.timer
```

Backfill completed hourly candles and assess scheduled internal-price weekends:

```bash
npm run perp-reference -- backfill --days 120
```

For U.S. single-name equities, the assessment treats Friday 20:00 through
Sunday 20:00 `America/New_York` as the scheduled internal-price window. A
weekend is complete only when the preceding external-session candle, every
hourly internal candle, and the Sunday reopen candle are present. It reports
weekend movement, the correction at the close of the first full external-price
hour, maximum excursions, direction agreement, volume, and trades. Candle opens
are deliberately not used as reopen evidence because they are mechanically
continuous with the preceding trade. Partial current weekends, gaps, holidays,
and unscheduled source outages are excluded or remain explicit limitations.

This source is a perp-market signal, not an independent cash-equity oracle.
During scheduled closed sessions its oracle is endogenous to the trade[XYZ]
order book. The snapshot therefore does not apply the Robinhood Stock Token
`uiMultiplier`, Stock Token basis, or USDG/USD conversion; those remain required
before this evidence can enter any guarded execution policy.

### Multiplier-adjusted pool basis

Run the stored-data join directly:

```bash
npm run perp-basis -- --rwa NVDA --fee 500
```

The join requires a matching canonical checkpoint, active and tradable registry
state, stable on-chain multiplier, no corporate action or oracle pause, positive
pool liquidity, an unlocked pool, a quality-passing perp snapshot, and bounded
source age and timestamp skew. It takes the median of the HIP-3 oracle, mark,
and mid, converts the underlying-share USD price into Stock Token USD as
`underlying × uiMultiplier / 1e18`, then divides by USDG/USD to produce exact
x18 USDG per token. The USDG round must remain structurally valid, within both
its published heartbeat and the configured age cap, and inside the depeg bound.

Strictly fresh Chainlink remains the primary reference. When that primary mark
is unavailable, a passing join is labelled either an external-session or
internal-weekend *shadow candidate*. Large pool/perp deviation, stale or skewed
sources, missing canonicality, multiplier transitions, and stale USDG evidence
all reject the candidate. PostgreSQL permanently enforces
`execution_eligible=false`; this series is evidence for later policy replay,
not authorization to rebalance.

## Oracle-marked policy replay

Replay range policies from the lightweight synchronized checkpoints without
making any RPC calls:

```bash
set -a
source .env
set +a
npm run oracle-policy:replay -- \
  --rwa NVDA \
  --fee 500 \
  --budget-usdg 1000 \
  --entry-cost-usdg 1 \
  --rebalance-cost-usdg 1 \
  --trigger-percent 50 \
  --half-widths 1,2,5,10,20,50 \
  --lookback 60
```

The default window is the newest 60 strategy checkpoints and the hard maximum
is 256. Use `--from-checkpoint ID --to-checkpoint ID` instead of `--lookback`
to pin an immutable historical window.

The loader fails closed unless every selected checkpoint has a matching stored
canonical block-hash proof, the pool identity and target-set hash remain
unchanged, and the event indexer covers the final checkpoint. It reconstructs
each interval's complete indexed Swap tick envelope. An invalid oracle mark or
a tick path that crosses the active range stops the candidate before the model
can invent a valuation, fee, or in-range duration.

Candidate inventory is carried in exact raw token units. Principal composition
and idealized recenter swaps use V3 pool spot because those actions depend on
the pool. NAV, fee value, drawdown, absolute P&L, and the unchanged post-entry
inventory benchmark use only the synchronized multiplier-adjusted oracle mark.
The replay reports both absolute USDG P&L and net LP alpha versus that passive
holding benchmark; candidates are ranked by the latter.

Results and per-interval inventory steps are immutable and idempotent in
`v3_oracle_policy_replay_runs`, `v3_oracle_policy_replay_candidates`, and
`v3_oracle_policy_replay_steps`. This remains a counterfactual shadow model:
costs are operator inputs, self-impact and self-dilution are absent, triggers
are checkpoint-only, and rebalancing assumes ideal spot recomposition. Every
result is explicitly execution-ineligible and the command has no signer or
transaction path.

## Joined-reference policy replay

Run the stricter replay only over checkpoints whose multiplier-adjusted
pool/reference join passed every quality gate:

```bash
npm run joined-policy:replay -- \
  --rwa NVDA \
  --fee 500 \
  --budget-usdg 1000 \
  --half-widths 20,50 \
  --trigger-percent 50 \
  --lookback 60 \
  --min-passing-checkpoints 60 \
  --min-window-hours 48 \
  --min-weekend-fallback-checkpoints 1 \
  --min-external-fallback-checkpoints 1
```

The numeric values above define an illustrative research scenario, not a live
policy recommendation. The command requires every scenario and evidence
threshold explicitly. It selects fresh Chainlink primary marks and uses a
normalized perp mark only when the stored join labelled it a quality-passing
external-session or internal-weekend fallback candidate. It also records the
passing/rejected row counts and rejection-reason histogram for the selected
block window.

Unlike `oracle-policy:replay`, costs cannot be supplied on the command line.
The loader requires one pool-specific stored cost model with measured entry,
rebalance, and exit costs. Entry is charged once, rebalance cost is charged per
recenter, and exit cost is charged once after the final checkpoint. Candidates
whose remaining NAV cannot pay the measured exit are excluded. Results are
ranked by net LP alpha versus unchanged post-entry inventory, after all three
cost classes, and stored idempotently in `v3_joined_policy_replay_runs`.

The command reads PostgreSQL only after its additive migration. It makes no RPC
calls, has no signer or transaction path, and every stored replay remains
`execution_eligible=false`. Missing passing marks, insufficient time/session
coverage, incomplete indexer coverage, or an incomplete cost model stop it
without storing a successful replay.

## Measured action-cost observations

Build a stratified sample of real, confirmation-safe transactions touching the
monitored pools:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run action-cost:snapshot -- --lookback-blocks 50000 --max-per-class 25
```

The command groups indexed V3 events into whole transactions and labels them as
mint, exit, collect, rebalance, swap-only, or mixed bundles. It samples the most
recent transactions within each class, then verifies every transaction and
receipt against the indexed canonical block before storing exact `gasUsed`,
`effectiveGasPrice`, total fee in wei, calldata size, destination, selector,
and Nitro's `gasUsedForL1`. When that component is present, the stored fee is
split exactly into parent-data and child-execution portions. P50 and P90 gas and
fee observations are persisted for each class.

These are whole-transaction observations. A transaction containing burn,
collect, swap, and mint is a rebalance bundle; its fee is never attributed to
one event. Unknown event mixtures remain `mixed`, and all rows are explicitly
execution-ineligible. The hourly accounting service refreshes a bounded
50,000-block sample while the private-node quorum circuit is healthy.

Convert one stored run into USDG raw units with independent, block-pinned
Chainlink ETH/USD and USDG/USD reference prices:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run action-cost:value -- --action-cost-run <ID>
```

Omit `--action-cost-run` to use the newest run. Each historical block hash is
revalidated before conversion, both oracle rounds must pass positive-answer,
metadata, completed-round, and freshness checks, and costs are rounded up to
avoid understatement. Historical accounting accepts the last completed round
only within the feed directory's declared heartbeat, capped at one day by
default; this is deliberately separate from the 300-second live execution-risk
ceiling. A missing L1 split never gets reconstructed:
the valid total is retained while both components remain unavailable. Invalid,
stale, unreadable, or noncanonical marks are stored as excluded with their
evidence. Per-class P50 and conservative P90 USDG costs are persisted, but do
not yet replace replay inputs until contract/selector comparability and approval
coverage are proven. The valuation reader is sequential and paced by default,
and every private RPC request passes through the quorum health circuit.

Assess one valued sample against the canonical Nonfungible Position Manager:

```bash
npm run action-cost:assess -- --valuation-run <ID>
```

The assessment derives selectors from exact function signatures and accepts
only direct `mint`, `increaseLiquidity`, `decreaseLiquidity`, or `collect`
calls whose pool-event mix is consistent. Position Manager `multicall` remains
opaque because the receipt snapshot did not retain its inner calldata. Calls to
routers, pools, or unknown Position Manager selectors are excluded. A
zero-liquidity `Burn` emitted while collecting fees is explicitly allowed in
the `collect` consistency rule; the event-mix label alone is not treated as
proof that liquidity was removed. Comparable, opaque, and excluded costs are
stored separately and all remain execution-ineligible.

Measure the separate one-time approval setup path:

```bash
set -a
source /root/arb-robinhood/.env
source .env
set +a
export RH_INDEXER_RPC_URL="$ROBINHOOD_READ_HTTP_URL"
npm run approval-cost:snapshot -- --lookback-blocks 20000 --max-per-token 10
```

This scans only canonical `Approval` events whose indexed spender is the
canonical Position Manager, across USDG and the enabled RWA token set. It then
verifies the containing transaction and receipt, decodes a direct
`approve(address,uint256)` call, matches owner/spender/value to the event, and
reads `allowance` at blocks N-1 and N. Only a proven zero-to-nonzero transition
is comparable to first-time canary setup. Replacements, resets, permits,
routers, multi-approval transactions, and unreadable historical state are
stored with exclusion reasons. The fee is attributed to the whole approval
transaction, kept in exact wei with the Nitro fee split when available, and is
never substituted across tokens that lack observations. Log ranges adapt down
on provider limits, candidate reads are sequential and paced, and every RPC
request uses the quorum health circuit.

Value only the proven setup calls at their historical oracle marks:

```bash
npm run approval-cost:value -- --approval-cost-run <ID>
```

The valuation uses the same canonical ETH/USD and USDG/USD reference-feed
checks, upward rounding, one-day accounting ceiling, sequential reads, and
per-request health gate as action-cost valuation. Source-excluded approval
shapes are copied into the valuation artifact without making oracle calls.
Results remain token-specific: downstream code may add the RWA and USDG P90
setup costs only when both exist, but may not substitute another token's gas.

Resolve a pool-specific measured entry model:

```bash
npm run cost-model:resolve -- \
  --rwa NVDA --fee 500 \
  --action-assessment-run <ID> \
  --approval-valuation-run <ID>
```

The resolver matches direct initial mints to the exact pool address, requires
separate same-token RWA and USDG approval samples, and sums their nearest-rank
P90 USDG costs. It records low sample counts as warnings. Entry can be marked
measured while rebalance remains unavailable: no rebalance value is emitted
until the exact decrease/collect/swap/mint execution path has comparable
evidence. A resolved cost model is still analysis evidence, not transaction
authorization.

## Read-only operator dashboard

The dashboard turns the PostgreSQL state into a continuously refreshed view of:

- indexer/replay block and hash agreement;
- recent canonical V3 activity grouped by block range;
- replayed pool, initialized-tick, and active core-position coverage;
- the latest exact core-position fee snapshot and recent checkpoint history;
- the latest exact active-position principal and range distribution;
- the latest exact owner, range, principal, and claimable fees for configured
  Position Manager NFTs;
- the latest normalized static range-policy comparison, including excluded
  paths, explicit costs, absolute P&L, and LP alpha versus holding;
- the latest stateful multi-checkpoint replay, including certified progress,
  recenter count, drawdown, total illustrative costs, and net LP alpha;
- the latest block-pinned pool/oracle basis, including feed ages, multiplier
  guards, signed spot deviation, and explicit excluded marks;
- the latest stable-position interval benchmark, its coverage exclusions, and
  exact raw-token accrual by pool;
- the latest per-asset risk gate and recent collection attempts; and
- the exact registry, feed-directory, and market-policy source hashes behind the
  risk view.

It requires `DATABASE_URL`, opens every PostgreSQL connection in read-only mode,
has no mutation routes, and refuses to bind to a non-loopback address. It shows
only captured fee state in raw token units; it does not infer values between
captures or claim token inventory, position value, or PnL.

Run it interactively:

```bash
set -a
source .env
set +a
npm run dashboard
```

From another machine, create a tunnel and then open
`http://127.0.0.1:4173` in a browser:

```bash
ssh -L 4173:127.0.0.1:4173 <server>
```

Install the repository-owned service on this host:

```bash
sudo install -m 0644 ops/conc-liq-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now conc-liq-dashboard.service
systemctl status conc-liq-dashboard.service
journalctl -u conc-liq-dashboard.service -f
```

`DASHBOARD_ACTIVITY_WINDOW_BLOCKS` and
`DASHBOARD_ACTIVITY_BUCKET_BLOCKS` are chain-height windows, not wall-clock
claims. The browser refresh interval controls only presentation; the tail
worker remains the owner of collection and replay.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RH_RPC_URL` | Robinhood public mainnet RPC | EVM JSON-RPC endpoint |
| `RWA_SYMBOLS` | `GLD,SPY,QQQ,NVDA,AAPL,GOOGL,MSFT` | Canonical assets to discover |
| `UNISWAP_V3_FEE_TIERS` | `100,500,3000,10000` | Factory fee tiers to query |
| `ROBINHOOD_ASSETS_URL` | Robinhood asset registry | Canonical RWA metadata |
| `ROBINHOOD_MARKET_POLICY_URL` | Robinhood Stock Tokens page | Current 24/7 policy evidence |
| `CHAINLINK_ROBINHOOD_FEEDS_URL` | Chainlink Robinhood RDD | Current canonical feed metadata |
| `SNAPSHOT_JSONL_PATH` | `data/snapshots.jsonl` | Local fallback store |
| `DATABASE_URL` | unset | Optional PostgreSQL connection |
| `HTTP_TIMEOUT_MS` | `10000` | Registry request timeout |
| `RPC_TIMEOUT_MS` | `15000` | JSON-RPC request timeout |
| `RISK_MAX_PRICE_AGE_SECONDS` | `300` | Strict feed-age ceiling |
| `RISK_GATE_MAX_SNAPSHOT_AGE_SECONDS` | `180` | Maximum persisted risk-snapshot age |
| `RISK_GATE_MAX_CANONICALITY_AGE_SECONDS` | `30` | Maximum age of private-node block-hash validation |
| `RH_INDEXER_RPC_URL` | falls back to `RH_RPC_URL` | Private/archive event-read endpoint |
| `INDEXER_CONFIRMATION_DEPTH` | `64` | Blocks withheld from the scan tip |
| `INDEXER_REORG_OVERLAP` | `256` | Canonical history replayed on resume |
| `INDEXER_INITIAL_CHUNK_SIZE` | `10000` | Initial `eth_getLogs` range |
| `INDEXER_MIN_CHUNK_SIZE` | `100` | Smallest retry range |
| `INDEXER_MAX_CHUNK_SIZE` | `25000` | Largest adaptive range |
| `RPC_HEALTH_REFERENCE_URLS` | Robinhood and BlockReq public RPCs | Independent comma-separated head references |
| `RPC_HEALTH_REFERENCE_QUORUM` | `2` | References agreeing at the confirmed anchor |
| `RPC_HEALTH_CONFIRMATION_DEPTH` | `64` | Shared anchor depth used for hash agreement |
| `RPC_HEALTH_SOFT_LAG_BLOCKS` | `20` | Block lag that degrades and pauses bulk reads |
| `RPC_HEALTH_HARD_LAG_BLOCKS` | `100` | Block lag that opens the circuit |
| `RPC_HEALTH_SOFT_LAG_SECONDS` | `5` | Time lag that degrades and pauses bulk reads |
| `RPC_HEALTH_HARD_LAG_SECONDS` | `30` | Time lag that opens the circuit |
| `RPC_HEALTH_RECOVERY_SAMPLES` | `12` | Consecutive clean samples required to recover |
| `RPC_HEALTH_POLL_INTERVAL_MS` | `10000` | Quorum probe cadence |
| `RPC_HEALTH_GATE_ENABLED` | `true` | Fail-closed protection for bulk workers |
| `RPC_HEALTH_MAX_SAMPLE_AGE_SECONDS` | `30` | Maximum gate sample age |
| `REPLAY_BATCH_SIZE` | `25000` | Events per atomic derived-state batch |
| `RECONCILE_CONCURRENCY` | `24` | Concurrent historical state reads |
| `ACCOUNTING_CONCURRENCY` | `4` | Concurrent block-pinned fee-state reads |
| `ACTION_COST_CONCURRENCY` | `4` | Concurrent guarded transaction/receipt batches |
| `ACTION_COST_VALUATION_CONCURRENCY` | `1` | Concurrent block-pinned action-cost marks, maximum 2 |
| `ACTION_COST_VALUATION_DELAY_MS` | `250` | Milliseconds of pacing after each valuation mark |
| `ACTION_COST_VALUATION_MAX_PRICE_AGE_SECONDS` | `86400` | Historical valuation ceiling; feed heartbeat can only tighten it |
| `APPROVAL_COST_INITIAL_CHUNK_SIZE` | `5000` | Initial confirmed-block range per approval log query |
| `APPROVAL_COST_MIN_CHUNK_SIZE` | `100` | Smallest approval log range after adaptive reductions |
| `APPROVAL_COST_DELAY_MS` | `250` | Milliseconds of pacing after each approval candidate |
| `APPROVAL_COST_VALUATION_DELAY_MS` | `250` | Milliseconds of pacing after each comparable approval mark |
| `APPROVAL_COST_VALUATION_MAX_PRICE_AGE_SECONDS` | `86400` | Historical approval valuation ceiling; feed heartbeat can tighten it |
| `NFT_POSITION_TOKEN_IDS` | unset | Comma-separated Position Manager NFT IDs to monitor |
| `TAIL_POLL_INTERVAL_MS` | `10000` | Successful index/replay cycle cadence |
| `TAIL_ERROR_DELAY_MS` | `5000` | Initial failed-cycle retry delay |
| `TAIL_MAX_CONSECUTIVE_FAILURES` | `5` | Circuit-breaker failure count |
| `RISK_SNAPSHOT_INTERVAL_MS` | `60000` | Independent risk-source cadence |
| `STRATEGY_CHECKPOINT_ENABLED` | `false` | Attach pool/oracle checkpoints to risk captures |
| `STRATEGY_CHECKPOINT_CONCURRENCY` | `4` | Concurrent lightweight pool readers |
| `HYPERLIQUID_INFO_URL` | Hyperliquid public info API | Shadow perp-reference endpoint |
| `PERP_REFERENCE_DEX` | `xyz` | HIP-3 deployment name |
| `PERP_REFERENCE_COIN` | `xyz:NVDA` | Exact shadow market |
| `PERP_REFERENCE_REQUEST_TIMEOUT_MS` | `10000` | Perp-reference request timeout |
| `PERP_REFERENCE_MAX_MARK_ORACLE_DEVIATION_PPM` | `5000` | Shadow mark/oracle quality ceiling |
| `PERP_REFERENCE_MAX_MID_ORACLE_DEVIATION_PPM` | `10000` | Shadow mid/oracle quality ceiling |
| `PERP_REFERENCE_MAX_IMPACT_SPREAD_PPM` | `10000` | Shadow impact-spread quality ceiling |
| `PERP_REFERENCE_MIN_DAY_NOTIONAL_USD` | `1000000` | Shadow rolling-volume floor |
| `PERP_REFERENCE_MIN_OPEN_INTEREST_NOTIONAL_USD` | `5000000` | Shadow open-interest notional floor |
| `PERP_BASIS_MAX_SOURCE_AGE_SECONDS` | `600` | Maximum age of pool block and perp observation |
| `PERP_BASIS_MAX_SOURCE_SKEW_SECONDS` | `360` | Maximum pool-block/perp timestamp skew |
| `PERP_BASIS_MAX_QUOTE_ORACLE_AGE_SECONDS` | `86400` | Hard cap applied below the USDG feed heartbeat |
| `PERP_BASIS_MAX_QUOTE_DEPEG_PPM` | `10000` | Maximum absolute USDG/USD deviation from one dollar |
| `PERP_BASIS_MAX_POOL_DEVIATION_PPM` | `20000` | Maximum absolute pool/perp shadow basis |
| `CANARY_MAX_CHECKPOINT_AGE_SECONDS` | `180` | Maximum synchronized checkpoint age accepted by canary preflight |
| `DASHBOARD_HOST` | `127.0.0.1` | Loopback-only dashboard listener |
| `DASHBOARD_PORT` | `4173` | Dashboard listener port |
| `DASHBOARD_REFRESH_MS` | `10000` | Browser snapshot refresh cadence |
| `DASHBOARD_ACTIVITY_WINDOW_BLOCKS` | `20000` | Recent activity lookback |
| `DASHBOARD_ACTIVITY_BUCKET_BLOCKS` | `500` | Activity chart bucket width |

## Guarded NVDA canary preflight

The first canary boundary is now a signer-free plan generator restricted to the
one canonical NVDA/USDG fee-500 pool. It reads one synchronized checkpoint,
requires the public-reference RPC circuit to be healthy, revalidates the source
block, factory mapping, Position Manager factory, pool identity/state, token
metadata, balances, and allowances at that pinned block, and performs both
`eth_call` and gas estimation. It cannot sign or send a transaction.

Every material policy input is required explicitly:

```bash
npm run canary:plan -- \
  --operator <address> \
  --budget-usdg <amount> \
  --budget-cap-usdg <amount> \
  --half-width-spacings <count> \
  --slippage-bps <bps> \
  --max-oracle-deviation-ppm <ppm> \
  --max-liquidity-share-ppm <ppm> \
  --ttl-seconds <seconds>
```

The command aborts before private-node reads if the RPC health sample is stale
or the quorum circuit is not healthy. Otherwise it stores the complete artifact
in `guarded_canary_plan_runs`, including exact calldata, source block/hash,
balances, risk evidence, simulation result, gas estimate, rejection reasons,
and a deterministic `approvalHash`. A `manual_approval_candidate` status means
only that all preflight checks passed. Every artifact remains
`executionEligible=false` and `broadcastAuthorized=false`; the approval hash is
not an approval and no private-key input exists.

Plans are intentionally short-lived. Any deadline expiry, new checkpoint,
changed balance/allowance, changed policy, or changed calldata requires a newly
generated artifact and hash. Range width and budget have no defaults because
the current replay sample is not strong enough to select them safely.

## Next slice

Accumulate quorum-guarded NVDA/USDG checkpoints and normalized `xyz:NVDA`
pool-basis observations across a complete weekend and after-hours window. The
joined historical replay is implemented and now fails closed until the exact
decrease/collect/swap/mint rebalance path and exit path have measured cost
evidence in a complete pool-specific model. Once a sufficiently long joined
series and that cost gate produce a stable bounded-budget/range result, add a
separate manual approval and broadcast wrapper that can consume exactly one
unexpired plan hash, record the receipt/NFT ID, and remain disabled by default.
The stable-position interval remains the fee-truth comparator, and costs remain
unavailable rather than inferred when evidence is weak.

## Source-of-truth addresses

- Uniswap v3 factory: `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`
- Nonfungible Position Manager: `0x73991a25c818bf1f1128deaab1492d45638de0d3`
- Canonical USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`

Addresses must be rechecked against the official Uniswap deployment page and
Robinhood token registry before enabling any future execution path.
