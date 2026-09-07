# Research evidence

These files support [the active LP proposal](../active-lp-strategy-proposal-2026-09-07.md). They contain descriptive observations, not completed strategy backtests.

- `observations.json`: checkpoint data, session 4 state/events and classified transaction costs. Capture timestamps are recorded inside; the cost refresh is separate from the checkpoint snapshot.
- `summary.json`: calculations from that fixed observation file. Reproduce with `python3 notes/active-lp-research-2026-09-07/analyze.py` from the repository root. Floating point is used only for descriptive statistics; it is not the trading ledger.
- `history-coverage.json`: exact event counts and sparse first-block timestamp bounds from one PostgreSQL repeatable-read, read-only transaction at its recorded timestamp. The replay worker advances separately; its count is not an independent proof of event completeness.
- `history-coverage.sql`: principal read-only coverage queries used for the historical snapshot. Results will change as ingestion advances. Run against the configured local database without printing its connection string.

All timestamps are UTC. Event ingestion timestamps are not historical block timestamps. The event collection substantially predates the synchronized strategy checkpoint collection.
