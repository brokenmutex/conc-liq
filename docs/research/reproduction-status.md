# September 18 research reproduction status

Date: 2026-09-19

Status: deterministic replay from the approved local archive passed; evidence pruning remains blocked

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

The bounded PostgreSQL inputs are now captured in a content-addressed archive.
The object contains nine allowlisted tables, restored into an isolated database,
matched every embedded file digest and row count, and passed its research data
contract. The declared PostgreSQL integration suite also passed in a separate
temporary database. Both temporary databases were removed after verification.
All eleven deterministic units were then rerun against the restored database;
every normalized digest matched. The database adapters are mechanically proven
byte-equivalent to the original runners except for the explicit connection
override and comments.

The user approved the repository-local, Git-ignored `archive/` directory as the
retention destination. The content-addressed object was moved there and its
byte length and SHA-256 were reverified. This clears the project's external
storage policy gate, but it is deliberately recorded as same-host storage: it
does not protect against disk or host loss and is not recoverable from Git.

This still does not clear the study for pruning:

- the final script/config layout has not completed its restored-input replay;
- W4.2's cursor probe is a wall-clock observation and its retained script has
  an obsolete temporary output path;
- W4.3's original health-distribution queries were not bounded by a frozen
  upper timestamp, so a current query would include later evidence;

The cursor log, health evidence and layout-dependent inputs and outputs
therefore remain protected. The exact commands, fixed time bounds,
input hashes, normalized output hashes and blocker states are in
`research/reproduction/strategy-redesign-2026-09-18.json` and are enforced by
`npm run check:repository`.

The archive's immutable manifest and restore receipt are under
`research/archives/`. The 185,163,776-byte object is intentionally ignored at
`archive/79dbb9dffb5304fc53c1a86192d1cd2dc722eca222b7338b062f04f5794d241a.tar.zst`.
The restored-input replay receipt is retained beside the archive manifest.
