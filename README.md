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

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RH_RPC_URL` | Robinhood public mainnet RPC | EVM JSON-RPC endpoint |
| `RWA_SYMBOLS` | `GLD,SPY,QQQ,NVDA,AAPL,GOOGL,MSFT` | Canonical assets to discover |
| `UNISWAP_V3_FEE_TIERS` | `100,500,3000,10000` | Factory fee tiers to query |
| `ROBINHOOD_ASSETS_URL` | Robinhood asset registry | Canonical RWA metadata |
| `SNAPSHOT_JSONL_PATH` | `data/snapshots.jsonl` | Local fallback store |
| `DATABASE_URL` | unset | Optional PostgreSQL connection |
| `HTTP_TIMEOUT_MS` | `10000` | Registry request timeout |
| `RPC_TIMEOUT_MS` | `15000` | JSON-RPC request timeout |

## Next slice

The next phase is a reorg-aware event indexer and accounting model: backfill v3
`Swap`, `Mint`, `Burn`, and fee-growth inputs; reconcile canonical oracle and
corporate-action state; then produce exact historical strategy inputs. It
should remain shadow-only until backtests and accounting prove net LP alpha
after divergence loss and execution costs.

## Source-of-truth addresses

- Uniswap v3 factory: `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`
- Nonfungible Position Manager: `0x73991a25c818bf1f1128deaab1492d45638de0d3`
- Canonical USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`

Addresses must be rechecked against the official Uniswap deployment page and
Robinhood token registry before enabling any future execution path.
