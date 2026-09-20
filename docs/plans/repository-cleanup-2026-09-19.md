# Repository cleanup and evidence-retention plan

Date: 2026-09-19

Status: implementation in progress after review; first study-level note purge
completed after verified archival and post-layout reproduction

Scope: repository documentation, research artifacts, ignored workspace data,
scripts, configuration, service definitions, build output and local toolchains

## Outcome

Reduce the repository to maintained product code, explicit operational
configuration, compact reproducibility manifests and a small set of current
documents. Historical bulk evidence should remain auditable without remaining
in the Git working tree, and active or custody-relevant state must never be
removed as part of a general cleanup.

This is not a Git-history rewrite. A file removed from the current tree remains
recoverable from the pre-cleanup commit. Unique raw evidence also needs a
hash-verified archive before its working copy can be removed.

## Inventory snapshot

The snapshot below was taken from a clean working tree at commit `b796052`,
with `main` fourteen commits ahead of `origin/main`.

| Area | Current size/count | Observation |
| --- | ---: | --- |
| Workspace | 8.6 GiB | Almost all growth is ignored local data, not source code. |
| `data/` | 8.0 GiB, ignored | Mixes active runtime state, unique captures, derived replays, old releases, screenshots and temporary results. |
| `notes/` | 37.9 MiB, 379 tracked files | Mixes prose, manifests, full result sets, charts, screenshots and executable scripts. |
| Markdown under `notes/` | 77 files, 0.87 MiB | Small in bytes but fragmented and frequently superseded. |
| JSON under `notes/` | 214 files, 28.2 MiB | Several full outputs are checked in alongside compact summaries and hashes. |
| Images under `notes/` | 24 PNG/SVG files, 6.3 MiB | Includes old dashboard screenshots and duplicate render formats. |
| Code under `notes/` | 22 Python/MJS/shell/SQL files | Reproduction and diagnostic code is stored as documentation. |
| `scripts/` | 110 tracked files | Operational commands and one-off research pipelines share one flat directory. |
| `.tools/` | 383 MiB, ignored | Includes the operational Node installation and a 176 MiB report virtual environment. |
| `node_modules/` | 133 MiB, ignored | Rebuildable from the lockfile. |
| `dist/` | 3.0 MiB, ignored | Rebuildable compiler output. |
| Git loose objects | 23.9 MiB | Removing current files will not remove their historical objects; no history rewrite is justified. |

No byte-identical duplicate was found inside `notes/`. The duplication is
semantic: full and compact outputs, multiple report formats, repeated
snapshots, and chains of superseded narrative documents.

## Classification rules

Every candidate must receive exactly one disposition before deletion:

1. **Retain**: current source of truth, active state, custody/accounting record,
   migration, compact immutable manifest, or non-reproducible evidence.
2. **Promote**: durable knowledge that belongs in a maintained architecture,
   operations or strategy document.
3. **Move**: useful code, fixture or configuration stored in the wrong area.
4. **Archive**: inactive but unique or expensive-to-reproduce evidence. Store it
   outside the repository with hashes and a repository manifest.
5. **Purge**: cache, generated presentation output, obsolete duplicate, or
   reproducible derivative whose canonical input and generator are retained.

An unknown classification means retain. File age, an apparently stale filename,
or a zero-reference text search is not sufficient proof that a file is dead.

## Hard exclusions

The following are outside the purge set until their specific lifecycle ends:

- `data/adaptive-paper-restart-2026-09-18/`, including the current snapshot,
  four mark journals, status file and pre-migration snapshot. These files were
  still updating during this review.
- Current database migrations and schema checks.
- Live-pilot transaction, receipt, nonce, recovery and custody evidence. The
  controller is closed, but the material remains an accounting/audit record.
- The active indexer and adaptive-paper configuration, plus any exact config
  hash referenced by retained campaign evidence.
- Release manifests or a release directory still referenced by an installed
  service, retained snapshot, migration history, recovery record or frozen
  research runner. Historical retention does not establish rollback readiness.
- Raw captures that cannot be regenerated deterministically, until a second
  copy and its checksum have been verified.
- `.env`, runtime environment files, signer material and provider credentials.
  These must not be copied into a general research archive.
- Exact bigint test fixtures and the golden fixtures introduced by the
  architecture refactor.

## `notes/` cleanup

### Target structure

`notes/` should not remain a runtime dependency or an unbounded evidence store.
The intended end state is:

```text
docs/
  architecture/       maintained architecture and data contracts
  operations/         current runbooks only
  strategy/           current objectives, policies and evaluation contract
  research/           concise conclusions and an indexed study register
  incidents/          concise incident register and durable lessons
  plans/              proposals awaiting or recording implementation

research/manifests/   compact immutable input/output hashes and provenance
test/fixtures/        small fixtures required by automated tests
scripts/
  operations/         supported operator commands
  research/           supported capture/replay/verify/report pipelines
  maintenance/        inventory, archive and cleanup checks
```

Historical detail removed from the current tree remains available at a tagged
pre-cleanup commit and, for external evidence, through the content-addressed
archive recorded in `research/manifests/`.

### Promote and consolidate

Create maintained documents instead of leaving readers to reconstruct the
current design from a chronological sequence:

- `docs/strategy/active-lp.md`: the agreed objective, passive-hold benchmark,
  inventory/crossing semantics, reference policy, complete-cost requirement and
  promotion gates.
- `docs/research/current-evidence.md`: the durable conclusions from fee
  calibration, residual ranges, session scheduling, the pool universe and
  execution-defect work. It must distinguish measured results, hypotheses and
  unavailable evidence.
- `docs/architecture/runtime.md`: current schema/release boundaries, runtime
  topology and the proposed modular-monolith target.
- `docs/operations/live-pilot.md`: the custody-safe stop/recovery procedure and
  links to immutable campaign evidence.
- `docs/research/index.md`: one row per study with status, conclusion document,
  manifest, dataset identifier, code version and superseding study.
- `docs/incidents/index.md`: one row per incident with impact, durable invariant,
  resolution commit and archived detailed record.

The September 18 W0-W5 reports should become one research synthesis plus small
per-study manifests. Earlier notes that are explicitly superseded should be
represented by a line in the research or incident index rather than remain as
first-class current documentation.

### Move before deleting

The following current dependencies prove that `notes/` cannot be bulk-deleted:

- Move `notes/canary-evidence-2026-09-06/local-lifecycle.json` to a named release
  or test fixture. The dashboard, a unit test and the release builder read it.
- Move `notes/paper-execution-evidence-2026-09-07/round-trip.json` to a release
  fixture. The dashboard, integration test and release builder read it.
- Move `notes/paper-execution-evidence-2026-09-07/restored-exit.json` to
  `test/fixtures/`; an integration test reads it.
- Move the 22 executable files under `notes/` to `scripts/research/archived/` or
  `scripts/diagnostics/` if they still reproduce retained evidence. Delete a
  script only after its study manifest identifies a supported replacement or
  declares the study non-reproducible from the current tree.
- Move frozen selection plans and evidence amendments used by replay scripts to
  `research/manifests/<study>/`. Update consumers before removing the old path.

After these moves, production code, tests and release construction must have no
path dependency on `notes/`.

### Archive, then purge, bulk tracked artifacts

The first high-value candidates are generated outputs, not authored prose:

- `notes/active-lp-research-2026-09-07/tick-width-screen-v1.json` — 5.55 MiB.
- `notes/adaptive-lp-universe-study-2026-09-13/summary.json` — 4.75 MiB.
- `notes/active-lp-research-2026-09-07/tick-half-width-screen-v1.json` — 3.23 MiB.
- `notes/active-lp-research-2026-09-07/portfolio-economic-sensitivity.json` — 1.81 MiB.
- `notes/adaptive-residence-cap-sweep-2026-09-17/width-replay-2026-09-17.json` — 1.58 MiB.
- `notes/lp-recenter-study-2026-09-11/results.json` — 1.21 MiB.
- `notes/active-lp-research-2026-09-07/size-sweep-v1.json` — 1.02 MiB.
- Large copied `summary.json`, `inclusion.json`, `reconstruction.json`, CSV and
  session-metric files when the compact conclusion, immutable input hashes and
  generator are retained.

For each study, retain in Git only:

- a concise human conclusion;
- the frozen plan and any pre-result amendment;
- source, config and implementation hashes;
- a compact headline/verification summary;
- a reproduction command and archive object identifier.

The full output, action series and intermediate tables belong in the external
artifact bundle. If an output cannot be reproduced because its source is unique,
archive both source and output rather than deleting either.

### Purge redundant presentation formats

Keep at most one checked-in chart format per chart, and only when it materially
supports a retained document. Candidate format pairs include:

- `adaptive-lp-universe-study-2026-09-13/{cross-asset-alpha,adaptive-vs-fixed40}.{png,pdf}`;
- `adaptive-lp-long-study-2026-09-13/{capacity-alpha,weekly-alpha}.{png,pdf}`;
- `adaptive-lp-study-2026-09-13/net-alpha.{png,pdf}`;
- `adaptive-lp-agility-2026-09-14/agility-comparison.{png,pdf}`;
- `live-performance-2026-09-14/performance.{png,svg}`;
- `paper-performance-2026-09-09/performance.{png,svg}`;
- `lp-hours-and-allocation-2026-09-10/tick-excursions.{png,pdf}`.

Prefer SVG for maintained charts when it renders correctly; otherwise keep PNG.
Generated PDFs should not remain merely as alternate renderings. Old dashboard
desktop/mobile screenshots should be archived with their audit bundle or
removed if their JSON checks and current visual tests preserve the relevant
fact.

### Narrative candidates

Do not delete narrative notes one by one without first extracting durable
lessons. Process them in cohorts:

- Early review/design chain: project review, architecture review, dashboard
  audit, historical-data policy and runtime-boundary notes.
- Legacy paper chain: initial live-paper session, execution-realism correction,
  transaction simulation, narrow trial, reentry, recovery, holding tolerance,
  recenter and fee-dilution notes.
- Live incident chain: native-credit halt, mint-slippage halt, withdrawal stall,
  allowance work and the controller record.
- Strategy research chain: the September 7 proposal and screens, inventory and
  allocation studies, adaptive studies, W0-W5 reports and restart record.

Each cohort produces one current document and one index/timeline. The detailed
dated files can then be removed from the current tree because the pre-cleanup
tag and evidence archive retain their full history. Notes that document a still
supported recovery procedure remain until that procedure is represented and
tested in the maintained runbook.

Expected result: reduce `notes/` from 37.9 MiB to a temporary compatibility
stub, then remove it once `rg 'notes/'` finds no runtime, test, script, release
or maintained-document dependency. A 30–37 MiB working-tree reduction is
realistic; Git history will intentionally retain the old objects.

## Ignored `data/` cleanup

The ignored data tree offers the largest disk recovery, but it also contains the
highest-risk evidence. Apply lifecycle labels before considering deletion:

| Class | Examples | Disposition |
| --- | --- | --- |
| Active runtime | Current adaptive state and journals | Retain in place; back up consistently. |
| Custody/accounting | Live ledger, receipts, nonces, recovery and final state | Archive twice, retain compact manifest indefinitely. |
| Unique source capture | HyperSync pages, archive-state snapshots, raw event sources | Content-addressed archive; remove locally only after verified restore. |
| Derived replay output | Full action arrays, scenario matrices, rendered charts | Purge after generator, input hashes and compact result are retained. |
| Superseded intermediate | `source-v1` beside a validated `source-v2`, failed attempts, repeated renders | Purge after provenance proves it is not an input to a retained result. |
| Sealed release | Deployment and release directories | Retain active and rollback releases; archive or purge older builds after service-path audit. |
| Preview/test output | Dashboard screenshots, local fork output and temporary checks | Purge when no longer an acceptance fixture. |

The major archive candidates include the 2.7 GiB adaptive-universe study, the
751 MiB portfolio study, the 553 MiB small-budget study, the 532 MiB asset
expansion study, the 523 MiB agility study, and the 460 MiB reference study.
These should be packaged per study, not deleted piecemeal.

Some especially large files need an explicit provenance decision:

- `data/lp-reference-2026-09-07/reference-logs.json` — 456 MiB, likely unique
  source evidence: archive, do not directly purge.
- `data/lp-cap-study-2026-09-11/market.json` — 370 MiB: determine whether it is
  a source capture or a deterministic projection.
- `data/lp-portfolio-2026-09-08/{weekday,weekend}-all-v1.json` — 653 MiB
  combined: likely derived output and a strong purge candidate after replay
  reproduction.
- `data/lp-experiment-2026-09-08/source-v1.json` and `source-v2.json` — about
  419 MiB combined: archive the canonical source; remove the superseded copy
  only after its relationship to v2 is proved.
- `data/lp-research-2026-09-07/source.jsonl.gz` — 250 MiB: unique frozen source,
  archive and retain its uncompressed-content hash.
- `data/stock-agnostic-allowance-releases/` — 311 MiB: inspect installed service
  targets and rollback requirements before pruning releases.

The archive manifest must include relative path, byte length, SHA-256, data
classification, source block/time bounds, producing commit, config hash,
reproduction command, encryption status and archive location. A restore drill
must re-hash an extracted bundle before the local copy is removed.

Never place ignored environment files into an unencrypted archive. Build the
file list from an allowlist rather than archiving `data/` wholesale.

## Scripts, configuration and services

### Scripts

The flat set of 110 scripts should be inventoried by supported workflow rather
than by textual references alone:

- Keep and document operational release, migration, dashboard validation and
  live-controller commands.
- Group supported research scripts by `capture -> replay -> verify -> render`.
- Convert recurring pipelines into named package commands with argument and
  output contracts.
- Move one-off diagnostics beside an incident manifest or remove them after the
  durable test/regression fixture exists.
- Review the currently unreferenced candidates first:
  `audit-lp-fees-and-swaps.mjs`, `audit-lp-gas-estimates.mjs`,
  `lp-experiment-reconcile.mjs`, `lp-gas-regime-sensitivity.mjs`,
  `lp-weekend-reference.mjs`, `observe-paper-holding.mjs`,
  `paper-recenter-fork-check.mjs`, `render-agile-lp.py` and
  `verify-inventory-study.py`.

"Unreferenced" here means no basename reference outside `scripts/`; it is a
review queue, not proof of dead code. Before removal, check package entrypoints,
systemd commands, shell history/runbooks, imports and the producing commit.

### Configuration

Keep only deployable current configuration in `config/`. Move historical exact
policies to campaign manifests or an archive only when retrievable exact config
bytes and their verified hashes remain available.

Initial review candidates are:

- `paper-nvda-ticks20-offhours.json`, which had no repository basename
  reference in the inventory scan;
- `adaptive-3000-tier-probe.json`, superseded for current research by the
  price-ladder probe and restart policy;
- `adaptive-paper-60m.json`, superseded operationally by the restart config but
  still required to reproduce the previous campaign;
- the dated 1,000/5,000 USDG paper configs after all associated sessions have
  immutable config copies or hashes.

Do not collapse historical configs into the current file. A campaign must
continue to resolve its exact original policy.

### Service definitions and releases

Audit installed unit paths and active release IDs before touching `ops/` or
release bundles. The legacy paper service/timer and experiment service are
cleanup candidates only if no installed unit, rollback procedure or current
runbook uses them. Retain the active tail, checkpoint, risk, accounting,
dashboard and adaptive-paper definitions until their replacement is deployed
and verified.

The audit must also inspect retained snapshots, runtime migration histories,
recovery records and frozen research runners. A release needed to interpret or
resume historical state remains protected even when no installed unit points to
it. Record recovery/audit retention separately from rollback compatibility with
the current database and persisted state.

Replace release-builder dependencies on `notes/` before pruning evidence. A
release should carry named runtime assets, not dated documentation paths.

## Build and local-tool cleanup

Safe recurring purge candidates are `dist/`, Python `__pycache__/` directories
and transient `.tools/*.log` files. They are ignored and reproducible.

`node_modules/` is rebuildable from `package-lock.json`, but deleting it is only
useful as an occasional disk reset and should not be part of every cleanup.

Do not purge `.tools/node/`: current README instructions and several service
definitions use that exact path. The 176 MiB `.tools/inventory-report-venv/`
can be rebuilt, but retained research instructions currently reference it.
First add a pinned report dependency specification and a reproducible setup
command; then it becomes a safe local cache.

## Execution sequence

### Phase 0 — approve policy and freeze a recovery point

1. Review the decision points at the end of this document.
2. Finish or explicitly checkpoint the active adaptive-paper experiment; do not
   stop or migrate it merely for cleanup.
3. Record the clean commit and create a pre-cleanup tag.
4. Capture installed unit targets and every release identity referenced by
   retained snapshots, migration histories, recovery records and research
   runners. Classify recovery/audit retention separately from rollback
   compatibility.
5. Generate a machine-readable inventory with path, size, hash, tracked state,
   reference count and proposed disposition.

No deletion occurs in this phase.

### Phase 1 — remove `notes/` from runtime paths

1. Move the three known release/test fixtures.
2. Update dashboard, tests and release builder to the new paths.
3. Add an automated check forbidding production imports or file reads from
   `notes/` and `docs/`.
4. Run unit, integration and release-smoke tests.

This should be a behavior-preserving commit.

### Phase 2 — establish maintained documents and manifests

1. Add the strategy, architecture, operations, research and incident indexes.
2. Consolidate durable conclusions without changing policy claims.
3. Add the research-manifest schema and validate all retained manifests.
4. Move supported reproduction code out of `notes/`.
5. Fix README and package-description drift; make README a short entrypoint,
   not an append-only project diary.

### Phase 3 — archive and prune tracked research artifacts

Process one study at a time:

1. Classify source versus derivative files.
2. Build an allowlisted content-addressed archive.
3. Verify archive hashes and perform a restore drill.
4. Declare whether reproduction uses the original checkout or a migrated
   runner. Preserve original code/config manifests in either case.
5. Commit the manifest and replacement documentation, but do not delete the
   corresponding evidence until Phase 4 finishes.

Do not combine multiple unrelated studies in one removal commit.

### Phase 4 — organize or retire scripts, configs and units

1. Build the supported-workflow registry.
2. Move scripts into operations, research and maintenance groups.
3. Replace historical config paths with manifest references.
4. Remove dead scripts/configs only after their replacement and consumers are
   verified.
5. Audit installed units before removing legacy service definitions.

After the final script/config layout, restore each pending study's archived
inputs, run the declared original checkout or migrated runner, and compare its
compact result. Only then may Phase 3 remove that study's local evidence. A
study that cannot pass retains both inputs and outputs with an explicit
reproduction limitation. Application tests do not satisfy this research gate.

### Phase 5 — reclaim ignored disk data

1. Exclude active state, environments and secrets.
2. Archive unique sources and custody evidence.
3. Verify compact results against archived inputs.
4. Delete deterministic derivatives, previews, failed attempts and retired
   releases according to the approved retention policy.
5. Emit a before/after disk and restore report.

This phase should occur after the repository manifests exist, not before.

## Acceptance gates

- Active adaptive-paper state and all four mark streams remain continuous.
- Live custody/accounting evidence and exact nonces/receipts remain recoverable.
- `npm run check` passes.
- PostgreSQL integration tests pass against a disposable database.
- A sealed release builds and passes its smoke check.
- Runtime, tests and release code contain no `notes/` dependency.
- Every removed unique artifact has a verified archive manifest and successful
  restore record.
- Every removed derivative has retained inputs, generator/version and a compact
  verified result, or is explicitly marked non-reproducible and archived.
- Current documents contain no stale claim that the project is only a read-only
  observer or that the active policy is a 60-minute policy.
- `config/` contains current deployable configuration; historical policy
  identity remains resolvable from campaign manifests.
- No policy, signer, broadcast setting, service state or database schema is
  changed merely to accomplish cleanup.
- Cleanup commits are narrow and independently reversible.

## Proposed automated guardrails

Add checks that fail when:

- production or release code reads from `notes/` or `docs/`;
- a tracked evidence object exceeds an agreed size without an allowlist entry;
- a research report lacks source/config/code hashes and an evidence class;
- a generated file appears in `notes/`;
- a script is added without an owner category and usage entry;
- an active campaign references a missing config or manifest;
- ignored runtime snapshots contain unbounded arrays beyond the configured
  retention limit.

## Review decisions

The implementation should not start until these choices are approved:

1. **Artifact destination:** approved: content-addressed compressed bundles in
   the repository-local, Git-ignored `archive/` directory, with manifests in
   Git. This user-selected retention policy survives repository cleanup but not
   host/disk loss or a fresh clone; receipts must preserve that limitation.
2. **Historical prose:** recommended: consolidate durable knowledge and remove
   detailed dated notes from the current tree, relying on the pre-cleanup tag
   and archive for full history.
3. **Chart policy:** recommended: at most one checked-in format per maintained
   chart; no alternate PDF renderings.
4. **Release retention:** choose the number of rollback releases to keep after
   proving no installed service references older bundles.
5. **Raw-data retention:** choose whether verified raw provider captures remain
   locally cached after archival or are restored only on demand.
6. **`notes/` end state:** recommended: eliminate the directory after its
   runtime dependencies, code, manifests and durable prose have moved to their
   owned locations.

## Recommended first pull requests

1. Inventory and manifest tooling; no deletion.
2. Move the three runtime/test fixtures out of `notes/`, activate the zero-new-
   dependency check, and validate unit, integration and release behavior.
3. Add maintained strategy/research/operations indexes and consolidate W0-W5.
4. Archive and remove the first self-contained study's bulky derived outputs as
   a proof of the retention workflow.

This ordering proves recoverability and severs unsafe dependencies before any
material purge.

## Codex review suggestions — 2026-09-19

The overall direction is sound: archive before pruning, preserve active and
custody-relevant state, keep commits narrow, exclude secrets, and avoid a
Git-history rewrite. The following are review suggestions, not authorization
to delete artifacts or change services. The two substantive gaps should be
resolved before pruning begins.

### P1 — Include saved-state dependencies in release retention

The sealed-release retention rule and service-path audit do not explicitly
protect releases pinned by retained snapshots, migration history or recovery
records. At review time, the protected file
`data/adaptive-paper-restart-2026-09-18/state.pre-runtime-migration-2026-09-19.json`
pinned build
`9fed9384c13f3dd8d3e1592581cd0432112e66b4c161afb051266fec6ff5c166`,
which no installed `conc-liq` unit referenced. The current state's migration
history also records that build. `src/runtime/identity.ts` requires matching
build ID, environment configuration hash and Node version when resuming state.

Suggested change: inventory release dependencies from retained snapshots,
migration histories and recovery records as well as installed services. Retain
or archive and restore-verify the required release bundles before removing
their local copies. Distinguish a historical runtime retained for recovery or
audit from a rollback release verified compatible with the current database
schema and persisted state; retaining an old directory alone does not establish
rollback readiness.

### P2 — Verify research reproduction after the final script layout

Phase 3 verifies evidence before Phase 4 reorganizes scripts. Later path and
import changes can invalidate that verification while application tests still
pass. For example, `scripts/adaptive-lp-long-study.mjs` reads another study's
manifest and checks every recorded code path and hash;
`scripts/lp-small-budget-replay.mjs` likewise validates the code map in
`prepared.json`. These are cross-study and exact-code dependencies, not just
links in documentation.

Suggested change: declare for each retained study whether reproduction uses
its original checkout or a migrated runner. Preserve original manifests and
hashes; record any migrated runner and its equivalence evidence separately.
Require a restored-input replay and compact-result comparison after the final
script/config layout changes, before deleting the corresponding local
evidence. A study that cannot meet this gate must retain its archived inputs
and outputs and explicitly state its reproduction limitation. Application
unit, integration and release-smoke checks do not replace this research gate.

### Smaller corrections

- Replace "immutable config copies or hashes" with "retrievable exact config
  bytes plus a verified hash." A campaign manifest must resolve the original
  policy through an archive object or a precise Git commit and path; a hash
  alone cannot restore it.
- The first proposed pull request adds the `notes/` dependency check before
  the second removes known dependencies. Introduce the check with an explicit
  baseline allowlist that forbids new dependencies, then remove those entries
  with the fixture move; alternatively activate enforcement in the fixture
  move itself.

Review scope: code, retained state and installed service definitions/status were
inspected read-only. The adaptive-paper service was running and the current
snapshot and four mark journals existed. No cleanup or service changes were
performed as part of the review.

## Review resolution and implementation log

The user authorized implementation after the review. The P1 and P2 suggestions
and both smaller corrections are accepted as mandatory gates.

Implemented foundation:

- tagged commit `b796052` as `pre-cleanup-2026-09-19`;
- moved the three runtime/test fixtures out of `notes/`;
- added an enforced production/test/release documentation-path boundary;
- added checked research manifests with explicit original-checkout versus
  migrated-runner provenance and post-layout verification state;
- added release-retention inventory tooling that reads saved state, migration
  history, installed units, private environment hashes and frozen research
  runner release references without exporting secrets;
- added maintained strategy, research, architecture, operations and incident
  documents.
- added `scripts/workflows.json`, which classifies and hashes all 110 top-level
  scripts, preserves 88 exact reproduction inputs, identifies 13 supported
  operational entrypoints and queues nine candidates for retirement review;
- made the workflow registry an enforced repository check, so a top-level
  script cannot be added, removed or changed without a deliberate provenance
  update.

No active state, service, release, custody evidence, raw research input or bulk
artifact has been deleted. The user-approved local `archive/` destination is
configured. The September 18 study passed its final-layout reproduction gate;
only its explicitly scoped, manifest-covered note copies and deterministic
derivatives are now eligible for pruning.

Implementation checkpoint:

- `5b86c5c` moves runtime evidence to owned assets/fixtures and activates the
  documentation-path and research-manifest checks.
- `1a880cc` adds maintained documentation, the machine-readable cleanup
  inventory and the release-retention inventory.
- `npm run check` passes TypeScript checking and all 582 unit tests.
- A clean sealed release built from `1a880cc` and independently verified its
  manifest as build
  `7d2746d3c4180c4c7aaea483fadd835d6a84badea8ac2b298103c970212d92eb`;
  the temporary smoke release was then removed.
- Database integration tests pass against an isolated disposable database,
  which was removed after the run.
- Rebuildable local `dist/`, Python bytecode and five stale `.tools/*.log`
  artifacts were removed. No runtime dependency or research evidence was part
  of that cache cleanup.
- Script movement and deletion remain deferred. The registry freezes the
  current transitional layout so post-layout research replay can be evaluated
  without silently changing recorded code paths or hashes.
- The September 18 W0-W4 deterministic bundle was replayed after the layout
  freeze: eleven complete normalized JSON outputs matched. Commands, fixed
  bounds, input hashes, comparison rules and known representation-only
  exceptions are checked in under `research/reproduction/`.
- The bounded PostgreSQL research inputs now have a 185,163,776-byte
  content-addressed archive and a successful isolated restore drill. The
  declared PostgreSQL integration suite also passes in a disposable database.
- All eleven deterministic units reproduce their recorded normalized digests
  from the isolated archive restore. Explicit database adapters are proven
  byte-equivalent to the original runners except for connection selection.
- The September 18 study is authorized for scoped pruning after all eleven
  units matched from a fresh isolated restore following relocation of its five
  study-specific runners into `scripts/research/`. The verified object remains
  in the user-approved same-host, Git-ignored `archive/` directory. Exact
  W4.2/W4.3 time-dependent evidence is hash-retained in
  `research/evidence/`, and maintained replacements require bounded parameters
  for future observations. The local archive policy does not protect against
  host/disk loss. Research evidence, archive objects, manifests, receipts,
  active runtime state, and custody/accounting evidence remain protected.
- The authorized September 18 cohort has now been pruned: 33 dated files left
  `notes/`, six exact frozen arm configurations moved under the study manifest,
  and 27 superseded conclusions, deterministic derivatives, report helpers,
  duplicated evidence files, and obsolete deployment snapshots were removed.
  `research/manifests/strategy-redesign-2026-09-18/pruned-artifacts.json`
  verifies every removed blob against the tagged pre-cleanup commit. The eleven
  normalized result digests remain replayable without retaining generated JSON
  in the working tree.
- All seven tracked PDF charts were redundant alternate renderings and have
  been removed while their referenced PNG siblings remain. The cleanup ledger
  at `research/manifests/repository-cleanup-2026-09-20/pruned-presentations.json`
  records both sides by byte length and SHA-256 and verifies each removed PDF
  against the tagged pre-cleanup commit. Original frozen renderers remain
  unchanged for historical study reproduction.
- The two remaining tracked PNG/SVG chart pairs were visually checked through
  a browser render. Their reports now embed the smaller scalable SVGs, and the
  redundant PNGs are covered by the same verified presentation ledger.
- The superseded 5.6 MiB total-width screen was reproduced from its frozen
  file-only source, timestamps, selection, and current frozen runner. All 140
  candidates matched after excluding one declared prose-only manifest field.
  Its full derivative was removed; the compact original manifest, conclusion,
  exact inputs, normalized digest, command, and replay receipt remain checked
  by `research/manifests/active-lp-tick-width-2026-09-07/pruned-artifacts.json`.
- The corrected 3.23 MiB half-width screen was then reproduced from the same
  frozen source with its corrected selection. Both its result and compact
  manifest were byte-identical. The full derivative was removed while its
  conclusion, compact manifest, exact inputs, and replay receipt remain.
