# September 18 research reproduction status

Date: 2026-09-19

Status: final-layout replay passed; the authorized September 18 note purge is complete

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

The five study-specific runners now live under `scripts/research/`. The shared
`scripts/sim-source.mjs` remains at its transitional path because an older,
separately frozen study still imports it. All eleven deterministic units reran
from a fresh isolated archive restore after this relocation and every
normalized digest matched.

W4.2 and W4.3 no longer block note cleanup. Their exact non-replayable source
files and the original cursor log are hash-retained under
`research/evidence/strategy-redesign-2026-09-18/`. Future cursor probes require
an explicit output and bounded sampling parameters via
`scripts/research/capture-indexer-cursor-probe.mjs`. Future health distributions
require explicit inclusive time bounds via
`scripts/research/bounded-health-distributions.sql`. A future run is correctly
classified as a new observation, not a reproduction of September 18.

The scoped purge removed 33 dated note files. Six frozen arm configurations
were promoted into the study manifest; 27 superseded conclusions,
deterministic derivatives, report helpers, duplicated evidence files, and
obsolete deployment snapshots were removed. Their exact historical blobs are
byte- and hash-verified against the tagged pre-cleanup commit by
`research/manifests/strategy-redesign-2026-09-18/pruned-artifacts.json`.
Research evidence, archive objects, manifests, receipts, active runtime state,
and custody/accounting evidence remain excluded. The exact commands, fixed
time bounds, input hashes, normalized output hashes and gate state are in
`research/reproduction/strategy-redesign-2026-09-18.json` and are enforced by
`npm run check:repository`.

The archive's immutable manifest and restore receipt are under
`research/archives/`. The 185,163,776-byte object is intentionally ignored at
`archive/79dbb9dffb5304fc53c1a86192d1cd2dc722eca222b7338b062f04f5794d241a.tar.zst`.
The restored-input replay receipt is retained beside the archive manifest.
