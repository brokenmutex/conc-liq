# conc-liq

Guarded Robinhood Chain concentrated-liquidity research, paper, and live-pilot
system for Uniswap v3 RWA/USDG pools.

The project combines exact event replay, risk/reference gates, LP accounting,
historical policy research, forward paper operation, a read-only dashboard and a
separately guarded live controller. Research and paper results never authorize
live execution. Checked-in live configuration remains broadcast-disabled.

## Safety boundary

- Exact token, tick, liquidity and fee math uses `bigint`.
- Missing reference, risk, coverage or cost evidence fails closed.
- Runtime services use immutable checksummed releases with pinned Node and
  configuration identity.
- Active paper state and live custody/accounting records are not disposable
  research output.
- A live stop requires the controller's guarded unwind and reconciliation;
  stopping systemd alone does not close custody.
- Never replay a completed swap or advance past an unresolved signed nonce.

See:

- [strategy and evaluation contract](docs/strategy/active-lp.md)
- [current research evidence](docs/research/current-evidence.md)
- [research register](docs/research/index.md)
- [runtime architecture](docs/architecture/runtime.md)
- [live-pilot runbook](docs/operations/live-pilot.md)
- [incident invariants](docs/incidents/index.md)
- [cleanup implementation plan](docs/plans/repository-cleanup-2026-09-19.md)

## Requirements

- Node.js 24; the local pinned installation is `.tools/node/bin/node`.
- PostgreSQL for runtime and integration workflows.
- Foundry/Anvil for owned-fork execution tests.
- Provider and database credentials in private environment files. Do not commit
  `.env` or files under `data/`.

```bash
export PATH="$PWD/.tools/node/bin:$PATH"
npm ci
npm run check
```

`npm run check` enforces repository boundaries, verifies research manifests,
type-checks the code and runs the unit suite. Database integration tests require
an isolated `TEST_DATABASE_URL`:

```bash
npm run test:integration
```

## Main commands

| Purpose | Command |
| --- | --- |
| Apply explicit schema migrations | `npm run db:migrate` |
| Continuous event tail | `npm run tail` |
| Strategy checkpoint | `npm run strategy:checkpoint` |
| Risk snapshot/gate | `npm run risk:snapshot`, `npm run risk:gate` |
| Accounting snapshot | `npm run accounting:snapshot` |
| Action-cost observation | `npm run action-cost:snapshot` |
| Dashboard | `npm run dashboard` |
| Historical replay | `npm run replay` |
| Baseline backtest | `npm run backtest:baseline` |
| Guarded paper controller | `npm run paper -- <command>` |
| Build sealed release | `npm run release:build -- /absolute/release-root` |

Operational commands should run through a verified sealed release. The source
checkout is for development and review, not production service execution.

## Repository layout

```text
src/                  application and domain code
test/                 unit, integration and exact fixtures
assets/evidence/      small named runtime evidence assets
config/               deployable configuration
ops/                  service templates and operator entrypoints
scripts/              release, operations and research tooling
research/manifests/   checked provenance and reproduction gates
docs/                 maintained architecture, strategy and runbooks
notes/                frozen historical evidence; not an active-work surface
data/                 ignored runtime state and bulk evidence
```

Runtime, tests and release construction must not read from `notes/` or `docs/`.
Named evidence needed at runtime belongs under `assets/`; exact test-only data
belongs under `test/fixtures/`.

## Current research boundary

The active four-book paper experiment uses NVDA and GOOGL selected books, an
exploratory MSFT fee-3000 book with borrowed cost assumptions, and a QQQ
holdout. Its persisted state remains execution-ineligible and
broadcast-disabled. The source tree now implements a fixed-token passive
benchmark, but the deployed sealed paper release predates it and the
independent-reference series remains unavailable. Do not interpret early P&L
versus cash as LP alpha.

The current strategy evidence requires at least three weeks spanning two
weekends, complete action costs and holdout discipline before a promotion
claim. Live operation requires a separate review and authorization.

## Historical evidence

The repository cleanup closed on 2026-09-20. Remaining files under `notes/`
and historical top-level research scripts are frozen legacy evidence, not a
backlog that blocks strategy development. New research belongs under
`research/`, maintained conclusions under `docs/research/`, and reusable
research tooling under `scripts/research/`.

No unique source, custody record, saved-state release or exact configuration
may be removed until its archive and restoration checks pass. A future change
to frozen material must still reproduce after its final script/config layout;
application tests alone are insufficient.

The pre-cleanup source recovery point is tag `pre-cleanup-2026-09-19`.
