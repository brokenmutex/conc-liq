# September 18 research reproduction status

Date: 2026-09-19

Status: deterministic replay passed; evidence pruning remains blocked

The post-layout audit reran every deterministic JSON-producing unit in the
September 18 W0-W4 bundle. Frozen-release units used build
`ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf`.
Migrated-runner units used an isolated build of original checkout
`b796052648f3feddd8d368cc987351ab6e55366c`.

All eleven units matched their retained complete result after only their
declared normalization:

- W0 live fee calibration and exit-rule restatement;
- W1 full and warmed residual studies plus the source-policy port check;
- W2 full and warmed session/forecast studies;
- W3 fixed-window universe screen and both independent fee-3000 ladders;
- W4.1 entry-bound before/after replay.

The comparison hashes canonical JSON while preserving array order. Generation
timestamps and isolated checkout paths are excluded. Three pre-commit outputs
also omit additive representation fields subsequently emitted by their
committed runners: `sourcePolicy=false` and `summary.residuals`. Those fields
are ignored only where declared; the outer residual counter, actions, economic
results and all other fields remain compared.

This does not clear the study for pruning:

- the historical PostgreSQL inputs have no restorable content-addressed
  snapshot;
- W4.2's cursor probe is a wall-clock observation and its retained script has
  an obsolete temporary output path;
- W4.3's original health-distribution queries were not bounded by a frozen
  upper timestamp, so a current query would include later evidence;
- database integration tests still require a disposable `TEST_DATABASE_URL`;
- no durable artifact destination and successful restore drill exist.

The cursor log, health evidence, database-backed inputs and all dependent
outputs therefore remain protected. The exact commands, fixed time bounds,
input hashes, normalized output hashes and blocker states are in
`research/reproduction/strategy-redesign-2026-09-18.json` and are enforced by
`npm run check:repository`.
