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
not label those values exact or infer them from collection cash flows. Exact
fee accounting requires a subsequent swap-math/fee-growth implementation or
block-pinned contract state.

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
Robinhood feed directory on every attempt, recording the URL, fetch time, and
SHA-256 of the exact response bytes. It never hardcodes feed proxy addresses.
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

The execution eligibility flag is deliberately stricter than collection
success. As of the 2026-09-03 verification, Chainlink's Robinhood directory had
no GLD token-price feed and its sequencer-feed directory had no Robinhood Chain
entry. Those are persisted as unavailable evidence. Trading capabilities
describe whether each session is permitted; they do not prove which session is
currently open, so `market_session_unverified` also remains a global denial
reason until a canonical calendar/session source is added. This repository
still has no transaction path.

Sources: [Robinhood oracle and corporate-action behavior](https://docs.robinhood.com/chain/oracles-and-price-feeds/),
[Chainlink Robinhood tokenized-equity feeds](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood),
and [Chainlink L2 sequencer feed availability](https://docs.chain.link/data-feeds/l2-sequencer-feeds).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RH_RPC_URL` | Robinhood public mainnet RPC | EVM JSON-RPC endpoint |
| `RWA_SYMBOLS` | `GLD,SPY,QQQ,NVDA,AAPL,GOOGL,MSFT` | Canonical assets to discover |
| `UNISWAP_V3_FEE_TIERS` | `100,500,3000,10000` | Factory fee tiers to query |
| `ROBINHOOD_ASSETS_URL` | Robinhood asset registry | Canonical RWA metadata |
| `CHAINLINK_ROBINHOOD_FEEDS_URL` | Chainlink Robinhood RDD | Current canonical feed metadata |
| `SNAPSHOT_JSONL_PATH` | `data/snapshots.jsonl` | Local fallback store |
| `DATABASE_URL` | unset | Optional PostgreSQL connection |
| `HTTP_TIMEOUT_MS` | `10000` | Registry request timeout |
| `RPC_TIMEOUT_MS` | `15000` | JSON-RPC request timeout |
| `RISK_MAX_PRICE_AGE_SECONDS` | `300` | Strict feed-age ceiling |
| `RH_INDEXER_RPC_URL` | falls back to `RH_RPC_URL` | Private/archive event-read endpoint |
| `INDEXER_CONFIRMATION_DEPTH` | `64` | Blocks withheld from the scan tip |
| `INDEXER_REORG_OVERLAP` | `256` | Canonical history replayed on resume |
| `INDEXER_INITIAL_CHUNK_SIZE` | `10000` | Initial `eth_getLogs` range |
| `INDEXER_MIN_CHUNK_SIZE` | `100` | Smallest retry range |
| `INDEXER_MAX_CHUNK_SIZE` | `25000` | Largest adaptive range |
| `REPLAY_BATCH_SIZE` | `25000` | Events per atomic derived-state batch |
| `RECONCILE_CONCURRENCY` | `24` | Concurrent historical state reads |
| `TAIL_POLL_INTERVAL_MS` | `10000` | Successful index/replay cycle cadence |
| `TAIL_ERROR_DELAY_MS` | `5000` | Initial failed-cycle retry delay |
| `TAIL_MAX_CONSECUTIVE_FAILURES` | `5` | Circuit-breaker failure count |
| `RISK_SNAPSHOT_INTERVAL_MS` | `60000` | Independent risk-source cadence |

## Next slice

The next phase adds an exchange-session/calendar source and an explicit
freshness-aware risk-gate query, then uses the indexed/replayed state and risk
snapshots for range-policy backtests. It should remain shadow-only until
backtests and accounting prove net LP alpha after divergence loss and execution
costs.

## Source-of-truth addresses

- Uniswap v3 factory: `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`
- Nonfungible Position Manager: `0x73991a25c818bf1f1128deaab1492d45638de0d3`
- Canonical USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`

Addresses must be rechecked against the official Uniswap deployment page and
Robinhood token registry before enabling any future execution path.
