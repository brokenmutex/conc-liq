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
sudo install -m 0644 ops/conc-liq-accounting.service /etc/systemd/system/
sudo install -m 0644 ops/conc-liq-accounting.timer /etc/systemd/system/
sudo systemctl daemon-reload
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
sudo install -m 0644 ops/conc-liq-tail.service /etc/systemd/system/
sudo systemctl daemon-reload
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
| `REPLAY_BATCH_SIZE` | `25000` | Events per atomic derived-state batch |
| `RECONCILE_CONCURRENCY` | `24` | Concurrent historical state reads |
| `ACCOUNTING_CONCURRENCY` | `24` | Concurrent block-pinned fee-state reads |
| `NFT_POSITION_TOKEN_IDS` | unset | Comma-separated Position Manager NFT IDs to monitor |
| `TAIL_POLL_INTERVAL_MS` | `10000` | Successful index/replay cycle cadence |
| `TAIL_ERROR_DELAY_MS` | `5000` | Initial failed-cycle retry delay |
| `TAIL_MAX_CONSECUTIVE_FAILURES` | `5` | Circuit-breaker failure count |
| `RISK_SNAPSHOT_INTERVAL_MS` | `60000` | Independent risk-source cadence |
| `DASHBOARD_HOST` | `127.0.0.1` | Loopback-only dashboard listener |
| `DASHBOARD_PORT` | `4173` | Dashboard listener port |
| `DASHBOARD_REFRESH_MS` | `10000` | Browser snapshot refresh cadence |
| `DASHBOARD_ACTIVITY_WINDOW_BLOCKS` | `20000` | Recent activity lookback |
| `DASHBOARD_ACTIVITY_BUCKET_BLOCKS` | `500` | Activity chart bucket width |

## Next slice

The next simulator gate replaces pool-spot marks and illustrative costs with
fresh multiplier-adjusted oracle marks plus measured approval, mint, burn,
collect, gas, and swap-cost observations. After that calibration, collect a
longer checkpoint series and require robust net LP alpha across adverse windows
before defining a manually approved, tightly bounded canary. The stable-
position interval remains the fee-truth comparator.

## Source-of-truth addresses

- Uniswap v3 factory: `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`
- Nonfungible Position Manager: `0x73991a25c818bf1f1128deaab1492d45638de0d3`
- Canonical USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`

Addresses must be rechecked against the official Uniswap deployment page and
Robinhood token registry before enabling any future execution path.
