# Test-suite audit — September 30, 2026

A complete, evidence-based inventory of every test entrypoint in the repository,
run against the checkout at `75d5644` (branch `agent/test-audit`, forked from
`main`). This is an audit, not a remediation: findings are reported, not
silently worked around. The one code change in this batch is documented in
[Fixes](#fixes-made) and is narrowly scoped to a description string, not test
logic.

## Verdict

Volume is not the gap the user already diagnosed it as: 953 unit tests and the
four dedicated browser suites (usability, reliability, research, risk) all run
clean and all still pass today. The gap is coverage shape, exactly as
hypothesized — every suite that runs in the gate proves a gate REFUSES
correctly; nothing in the gate proves a legitimate operation completes. The
one harness that would have proven it,
`test/integration/dashboard-setup-command-browser.mjs --complete-static-lifecycle`,
is not wired into any gate and is not even discoverable without reading the
file, and fails today for a reason that has nothing to do with the dashboard.

The single most consequential finding is not a stale assertion or a product
regression. It is a **test-hermeticity defect**: `paperOperationWorkerReady()`
reads a PostgreSQL advisory lock (`PAPER_OPERATION_READINESS_LOCK` =
`[4663, 18728]`) that is global to the physical database, not scoped to the
disposable schema each harness creates. Seven harnesses assume "fresh schema"
means "no worker attached." That assumption is false whenever a real paper
worker is attached to the same database — which is true right now, in this
environment, because `conc-liq-paper-operation-worker.service` is live and
holds that exact lock (verified directly against `pg_locks`, see
[§3.1](#31-the-line-297-question-stale-or-real)). Two of the seven suites
chained by `npm run test:integration` and the standalone
`test:integration:paper-worker-process` abort on this, and the un-gated
`dashboard-setup-command-browser.mjs` times out on it at the exact line named
in this audit's brief. All four failures are the same root cause wearing four
faces. This was independently rediscovered by the coordinator mid-audit and is
folded in here with the full evidence chain, including the fact that it is
*partially* documented already — in the wrong place.

## 1–2. Inventory and gate classification

"In gate" means: named in `docs/reviews/dashboard-test-report-2026-09-29.md`,
`dashboard-clean-deploy-2026-09-29.md`, `dashboard-follow-up-2026-09-29.md`, or
`dashboard-remediation-2026-09-29.md` as something actually run before a
production acceptance decision, on the acceptance-committing run — not
"exists and looks relevant."

### Unit suite

| Entrypoint | Covers | Requires | Duration | In gate? |
| --- | --- | --- | --- | --- |
| `npm test` (151 `*.test.ts` files, `node --import tsx --test`) | Every pure-function/module unit: accounting, paper engine, RangeKeeper, dashboard formatting, risk, oracle, cost models, etc. | Nothing external for ~150 of 151 files; one file (`hybrid-competitor-fixture.test.ts`) reads `data/competitor-cluster-amc-2026-09-04/analysis.json` | ~40–50 s, 953 tests / 85 suites | Yes — this is the "948 unit tests" line (see [§Run results](#run-results)) |

### `test/integration/` — 30 files

| File | Covers | Requires | npm script? | In gate? |
| --- | --- | --- | --- | --- |
| `migrations.mjs` | Schema migration v1→v11, idempotency, drift rejection | `TEST_DATABASE_URL` | via `test:integration` | Yes |
| `research-candidate-store.mjs` | Research candidate profile registry/hash | `TEST_DATABASE_URL` | via `test:integration` | Yes |
| `deployments.mjs` | Store, server, paper preview/cost/accounting, RangeKeeper paper confirmation — the largest integration file | `TEST_DATABASE_URL` | via `test:integration` | Yes |
| `paper-mark-id-order.mjs` | Mark ID ordering across accounting operations | `TEST_DATABASE_URL` | via `test:integration` and standalone | Yes |
| `paper-close-convert-prestate-gas-importer.mjs` | Gas prestate import for close-convert | `TEST_DATABASE_URL` | via `test:integration` | Yes |
| `paper-lifecycle.mjs` | Paper session lifecycle with stub executor | `TEST_DATABASE_URL` | via `test:integration` | Yes |
| `paper-reference.mjs` | Reference-price evidence/grace/revocation | `TEST_DATABASE_URL` | via `test:integration` | Yes |
| `dashboard-usability-browser.mjs` | U1–U4, D3 — empty states, task cost, keyboard/a11y, risk visibility | `TEST_DATABASE_URL`, Chromium | `test:integration:dashboard-usability-browser` | **Yes — the 46-check suite** |
| `dashboard-reliability-browser.mjs` | R1, R3–R5 — degraded deps, session contention, concurrency/idempotency, reload recovery | `TEST_DATABASE_URL`, Chromium | `test:integration:dashboard-reliability-browser` | **Yes — the 42-check suite** |
| `dashboard-risk.mjs` | Asset risk-eligibility projection | `TEST_DATABASE_URL` | `test:integration:dashboard-risk` | Yes ("sealed risk integration" — see caveat below) |
| `dashboard-research-browser.mjs` | Research refresh/staleness/capital-repricing UX | none (owns its own server) | `test:integration:dashboard-research-browser` | **Yes — the 9 Research browser cases** |
| `dashboard-scale-soak.mjs` | R2 (heap/DOM/listener soak) + P4/P6 (scaling) | `TEST_DATABASE_URL`, Chromium, real time (`SOAK_MINUTES`, default 120) | `test:integration:dashboard-scale-soak` (full) / `:dashboard-scale-smoke` (`SOAK_MINUTES=0`) | Partially — the 120-minute run backs R2/P6 in the follow-up doc; not part of the fast release gate |
| `dashboard-release-coherence.mjs` | Dashboard/command asset-route parity against a sealed manifest | `--self-test` (local fixture) or a real `RELEASE DASHBOARD_URL COMMAND_URL` | `test:integration:dashboard-release-coherence` | Yes, in its real-release form (R7 / the "17" and "27 asset comparisons") |
| `dashboard-setup-command-browser.mjs` | Setup review → draft save → open preview → pending-open recovery; `--complete-static-lifecycle` continues through accept/pause/resume/close | `TEST_DATABASE_URL`, Chromium | `test:integration:dashboard-command-browser`; lifecycle mode via `test:integration:dashboard-paper-lifecycle-browser` | **No.** Confirmed by grep: not named in any `docs/reviews/*.md` acceptance record. This is the file the task brief calls "rotted." |
| `paper-command-worker-process.mjs` | Real command+worker process pair, restart, readiness-lease release/reacquire | `TEST_DATABASE_URL`; `--sealed-release` variant needs a sealed build | `test:integration:paper-worker-process[:sealed]` | Non-sealed form: yes, historically (`implementation-review-2026-09-27.md:321`). Not named in any 09-29 acceptance doc. |
| `static-paper-canonical-flow.mjs` | Setup→open→UI accept, `--interrupt-conversion`/`--restore-rehearsal` recovery variants | `TEST_DATABASE_URL`, `.env` (owned-fork RPC config); sealed variants need a sealed build | 8 separate npm scripts, sealed and non-sealed | Sealed forms: yes, per `docs/operations/static-paper-mvp.md` |
| `static-paper-canonical-convert-flow.mjs` | Setup→open→UI convert-close, interruption/restore variants | Same as above | 6 npm scripts | Sealed forms: yes |
| `paper-close-convert-v3-booking.mjs` | V3 close-convert booking + `--restore-rehearsal` backup/restore drill | `TEST_DATABASE_URL` only | `test:integration:static-paper-restore` (with flag); no script for the bare mode | Not named in a 09-29 doc |
| `paper-close-convert-v3-canonical-worker.mjs` | Canonical V3 close-convert preview/worker replay against the real dashboard/command HTTP stack | `TEST_DATABASE_URL` (must be local socket), `.env`, Chromium | **none** | No — orphaned |
| `paper-close-convert-v3-indexer-preflight.mjs` | Indexer-coverage preconditions for the V3 terminal gate | `TEST_DATABASE_URL`, `.env` | **none** | No — orphaned |
| `paper-handoff.mjs` | The real operator-handoff script against isolated files with mocked DB/systemd | nothing external | **none** | No — orphaned |
| `paper-recenter-evidence.mjs` | Recenter-proof verification (moved/runtime/scope/valuation/revoked/duplicate/regressing) | `TEST_DATABASE_URL` | **none** | No — orphaned |
| `paper-runtime-upgrade.mjs` | Runtime/policy-hash upgrade migration incl. its own advisory-lock exclusion check | `TEST_DATABASE_URL` | **none** | No — orphaned |
| `rangekeeper-fork.mjs` | RangeKeeper against a real owned Anvil fork | `.env` (`PAPER_FORK_RPC_URL`), spawns a chain fork | **none** | No — orphaned; not run (see [§3.4](#34-not-run-and-why)) |
| `rangekeeper-paper-booking.mjs` | RangeKeeper paper booking against canonical anchors | `TEST_DATABASE_URL`, `.env`, `config/rangekeeper-v1-aapl-disabled.json` | **none** | No — orphaned |
| `rangekeeper-paper-fork-reads.mjs` | RangeKeeper reads against an owned fork | `.env`, real fork | **none** | No — orphaned |
| `rangekeeper-paper-owned-replay.mjs` | RangeKeeper owned-fork replay | `.env`, real fork | **none** | No — orphaned |
| `setup-draft-delete.mjs` | Draft tombstone, idempotency, dashboard filter, acceptance race | `TEST_DATABASE_URL` | **none** | No — orphaned |
| `release.mjs` | Sealed release artifact sanity (`bin/node launch.mjs`) | `TEST_DATABASE_URL`, `TEST_RELEASE_DIR` | **none** | No — orphaned; needs a built release, not run here |
| `live-pilot-controller.mjs` | Real signed test transactions on an owned fork | `.env`, real fork, a funded test key | **none** | No — orphaned; not run (see [§3.4](#34-not-run-and-why)) |
| `live-pilot-journal.mjs` | Concurrent reservation, idempotency, exact signed bytes, restart recovery | `TEST_DATABASE_URL` only, no signer/broadcaster | **none** | No — orphaned |
| `live-withdraw-rounding.mjs` | Exact live receipt rounding, restart-before/after-commit, duplicate-completion rollback | `TEST_DATABASE_URL` only, no signer/broadcaster | **none** | No — orphaned |

14 of these 30 files have **no `package.json` entrypoint at all** — they can
only be run by a contributor who already knows the exact file path. That is a
worse state than "not in the gate": a script with an npm name at least shows
up in `npm run` completion and grep of `package.json`; these do not show up
anywhere.

### `scripts/check-*.mjs` and `scripts/maintenance/check-repository-boundaries.mjs`

| Script | Covers | Requires | In `package.json`? | In gate? |
| --- | --- | --- | --- | --- |
| `scripts/maintenance/check-repository-boundaries.mjs` | No forbidden documentation-path literals in `src`/`test`/release scripts | nothing external | Yes, via `check:repository` | Yes (`npm run check`) |
| `scripts/check-dashboard-positions.mjs` | Browser check against a **running dashboard on a real port** (default `127.0.0.1:4174`) via a disposable Chromium on debug port 9224 | A dashboard instance already serving on the given URL | No | No — and see [§3.4](#34-not-run-and-why): its default target is the live production port |
| `scripts/check-dashboard-preview.mjs` | Same pattern, targets `/preview` | Same | No | No — same reason |
| `scripts/check-dashboard-release.mjs` | Loads a **sealed release's compiled `dist/`** and reconciles dashboard config/policy against it | A built release directory + env file | No | No — this *is* what "sealed risk integration" / "check-dashboard-release" acceptance runs use, per `docs/reviews/dashboard-remediation-2026-09-29.md`, but it is not itself scripted |
| `scripts/check-dashboard-position-accounting.mjs` | Read-only reconciliation of session P&L against lifetime totals, to the raw unit | `data/dashboard-live-pilot.env`, real production DB (read-only transaction) | No | No — this is the "accounting reconciles to the raw unit" claim in the 09-29 test report; it is a real check but has no discoverable entrypoint |
| `scripts/check-dashboard-setup-browser.mjs` | Isolated source-mode setup-form smoke: mock API + disposable Chromium | nothing external | No | No — **fails today, and is stale; see [§3.2](#32-a-second-rotted-harness-found-in-passing)** |

### Everything else matching `test*` in `package.json`

`npm run typecheck` and `npm run check` (`check:repository && typecheck && test`)
are the only other `test*`-named scripts; both are covered above.

## 3. What actually ran, and what it means

### 3.1 The line-297 question: stale or real?

**Verdict: neither. It is a third category — a test-hermeticity gap that
happens to be triggered right now by a real, correctly-behaving production
process.** The assertion is not stale (no formula or DOM shape changed) and it
is not catching a defect in the open-preview status path (the dashboard code
is doing exactly what it is supposed to do given the actual state of the
database it is pointed at). No code in `dashboard/tabs.js` or
`src/deployments/server.ts` was touched by this audit.

**The symptom.** Running
`TEST_DATABASE_URL='postgresql://root@localhost/conc_liq?host=/var/run/postgresql' npm run test:integration:dashboard-command-browser`
times out waiting for
`document.querySelector("#setup-open-status").textContent.includes("worker readiness")`
(now line 300, after the coordinator's `paperGasProfiles` merge shifted it by
3 lines from the line 297 named in the brief). The dumped browser state at
timeout shows the draft saved correctly, the native-allocation cushion
correct, and one open-preview request attempted — but `#setup-open-status`
never contains the readiness note.

**The mechanism, traced end to end:**

1. `dashboard/tabs.js:770–777` renders `#setup-open-status`. When a preview
   comes back `usable` but `!actionAvailable`, it appends "Open acceptance
   unavailable: the command service has not proven current worker readiness."
   — text that contains the substring "worker readiness".
2. The test's own mock `paperPreview` (line 149–161) **hardcodes**
   `actionAvailable:false, operationAcceptanceAvailable:false` for a fresh
   open preview — so by the mock's own intent, the note should always render.
3. But `src/deployments/server.ts:368–377` does not trust the mock's
   `actionAvailable` field. It recomputes it: `workerReady =
   await options.paperRetainWorkerReady()`, then
   `actionable = Boolean(openSaved && workerReady && options.paperOpenAcceptance)`,
   and overwrites the response with `{...result, actionAvailable: actionable,
   operationAcceptanceAvailable: actionable}`.
4. The test wires `paperRetainWorkerReady:()=>store.paperOperationWorkerReady()`
   (line 207) — the real store method, not a mock.
5. `src/deployments/store.ts:311–324` implements that method as an
   `EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND
   database=(SELECT oid FROM pg_database WHERE datname=current_database())
   AND classid=$1 AND objid=$2 AND mode='ShareLock' AND granted)` query — keyed
   only by **database**, with no schema or session qualifier of any kind.
   `PAPER_OPERATION_READINESS_LOCK = [4663, 18728]` (`store.ts:256`).
6. In this environment, `ps aux` shows a live
   `conc-liq-paper-operation-worker.service` process (pid 1014549, started
   13:14 today) attached to the same `conc_liq` database. Direct query
   confirms it: `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND
   classid=4663 AND objid=18728 AND mode='ShareLock' AND granted` returns
   **1**.
7. So `paperOperationWorkerReady()` returns `true` for *any* session on this
   database, including the harness's own freshly created, otherwise fully
   isolated `dashboard_command_<uuid>` schema. `workerReady` is `true`,
   `actionable` is `true`, the note is never appended, and the `waitFor` spins
   until its 16-second budget expires.

**Why this is not stale:** nothing about the DOM shape, element ID, or wording
changed. "worker readiness" is still exactly the substring the code emits, in
exactly the element the test polls.

**Why this is not a dashboard regression:** the dashboard is answering the
question it is actually being asked — "is a worker attached to this
database right now?" — correctly. There is, in fact, a worker attached to
`conc_liq` right now. The test's premise, "an isolated schema has no worker,"
was never true for this specific signal, because `PAPER_OPERATION_READINESS_LOCK`
was designed for a world with exactly one schema and one worker, and cannot
distinguish "the isolated test's own schema" from "the production schema
sitting one folder over in the same database."

**Historical proof this used to pass, unmodified:**
`docs/reviews/implementation-review-2026-09-27.md:320–321` records, on a
combined shared checkout, `dashboard-setup-command-browser.mjs
--complete-static-lifecycle` passing **21 browser checks** including
"open/pause/resume/retain-close," and `npm run test:integration:paper-worker-process`
passing with "one worker restart, released readiness lease" and measured
119 ms/115 ms pause/resume latency. Both runs necessarily happened against a
database with **no** live worker attached (or the assertion this audit is
diagnosing would have failed then too). The failure is new; the file is not.
Something about the *environment* changed between 09-27 and today, not the
test or the dashboard.

**This is also not unique to this file.** The identical failure signature
(`assert.equal(await store.paperOperationWorkerReady(), false)` →
`true !== false`) reproduces in:
- `test/integration/deployments.mjs:71` (chained first by `npm run
  test:integration`, so it currently blocks `paper-mark-id-order.mjs`,
  `paper-close-convert-prestate-gas-importer.mjs`, `paper-lifecycle.mjs`, and
  `paper-reference.mjs` from ever running via that composite script even
  though all four pass individually — see [§Run results](#run-results))
- `test/integration/paper-command-worker-process.mjs:84`

Four failures, one cause.

**The precondition is documented — but not where any of these four files, or
the top-level README, can see it.** `docs/operations/static-paper-mvp.md:220–223`
states explicitly: "these fixtures use disposable schemas, but worker
readiness and maintenance advisory locks span the database: serialize process
fixtures against one database. Keep independent synthetic regression work in a
separate disposable database when running it in parallel." And
`docs/reviews/sealed-paper-review-7c7f60b-2026-09-27.md:44–45` shows the
correct mitigation already practiced once: "the conversion tests use a
separate disposable database, `conc_liq_sealed_review_7c7f60b`, because worker
advisory locks span a database." That knowledge exists, is correct, and was
applied — for the sealed canonical-acceptance runbook only. It never made it
into: the header comments of `deployments.mjs`, `paper-command-worker-process.mjs`,
or `dashboard-setup-command-browser.mjs` (all three claim isolation via
"disposable schema" language and say nothing about the lock); the
`package.json` script names; or the README's one-line "Database integration
tests require an isolated `TEST_DATABASE_URL`" (`README.md:51`), which is the
only guidance a contributor reaching for `npm run test:integration` is likely
to see, and which is actively misleading given this lock's scope.

**Recommendation (not implemented here — this touches the production
readiness lease, which the coordinator has asked to own):** prefer a
fail-fast precondition check over rekeying the lock. Concretely: have each of
these four harnesses call `paperOperationWorkerReady()` (or the equivalent
`pg_locks` probe) immediately after creating its schema, before doing any
other setup, and abort with a one-line diagnostic — "a live worker already
holds the paper-operation readiness lock on this database; these harnesses
are not hermetic against a live worker; point TEST_DATABASE_URL at a database
with none attached" — instead of letting the failure surface deep inside an
unrelated assertion (line 71, line 84, or a 16-second browser timeout).
Rekeying `PAPER_OPERATION_READINESS_LOCK` itself to fold in the schema name
was considered and is **not** recommended: in production there is exactly one
schema and one worker, so schema-scoping the lock buys real production code
zero robustness while adding a moving part to a safety-critical acceptance
gate, purely to satisfy test scaffolding. A harness-side guard gets the same
diagnostic clarity without touching `store.ts`'s production semantics.

### 3.2 A second rotted harness, found in passing

While confirming the browser tooling was reproducible outside the gate-listed
suites, `scripts/check-dashboard-setup-browser.mjs` (also orphaned — no
`package.json` entry, no doc reference) was run and fails at its own
`setup-review-button` step:

```
Error: Timed out waiting for document.querySelector("#setup-preflight-title").textContent==="Sizing preflight available";
browser state: {"status":"Preflight unavailable: Enter all valid static/manual
limits in their displayed units before review.", ...}
```

**This one is stale**, and for a documented reason: the dashboard converted
its risk/cost-limit inputs to human-readable units (`dashboard-test-report-2026-09-29.md`,
finding "Capital fills editable human-unit suggestions"; also visible directly
in `dashboard-setup-command-browser.mjs:266–275`, which fills `'250'`,
`'10'`, etc.). `scripts/check-dashboard-setup-browser.mjs:14–17` still fills
the same inputs with raw base-unit magnitudes —
`'#limit-max-deployment','100000000000000000000'` and similar — which the
now-human-unit-validating form correctly rejects as out of range. This is not
fixed here because the file is not referenced anywhere, has no runner, and its
coverage (setup form → review → draft) is now a strict subset of what
`dashboard-setup-command-browser.mjs` already does more thoroughly and with
real schema isolation. It is listed in the [prune list](#5-prune-list) rather
than repaired.

### 3.3 Confirmed passing (real runs, this session)

| Harness | Result | Evidence |
| --- | --- | --- |
| `npm test` | **952/953 pass.** The one failure (`hybrid-competitor-fixture.test.ts`) is `ENOENT data/competitor-cluster-amc-2026-09-04/analysis.json` — the file exists at `/root/conc-liq/data/...` but this worktree deliberately has no `data/` symlink per its setup instructions. Not a real failure; confirmed by checking the file exists in the primary checkout. | `953 tests, 85 suites, duration_ms 48605` (first run), `37492` (post-merge re-run) |
| `npm run typecheck` | Pass, clean | exit 0 |
| `npm run check:repository` | First three of five validators pass (592 files, 106 scripts, 2 manifests); the fourth (`validate-research-reproduction.mjs`) fails on the same missing-`data/`-in-worktree issue (`data/live-cost-analysis-2026-09-17/ledger.json`, confirmed present in the primary checkout); the fifth never runs because the chain stops | environment artifact, not a defect |
| `test:integration:dashboard-usability-browser` | **46/46 pass**, matches the gate's documented count exactly | full check-name list captured |
| `test:integration:dashboard-reliability-browser` | **42/42 pass**, matches the gate's documented count exactly | `checks`/`findings` JSON captured |
| `test:integration:dashboard-risk` | Pass, 6 cases | `{"status":"passed",...}` |
| `test:integration:dashboard-research-browser` | **9/9 pass**, matches the gate's documented "9 populated Research browser cases" | `{"status":"passed",...}` |
| `test:integration:dashboard-release-coherence -- --self-test` | Pass, 2 cases | `{"status":"passed",...}` |
| `test:integration:dashboard-scale-smoke` (`SOAK_MINUTES=0`) | Pass (fast-path only; not the qualifying 120-minute run) | `r2Qualified:false, p6DurationQualified:false` — expected at 0 minutes |
| `migrations.mjs`, `research-candidate-store.mjs`, `paper-mark-id-order.mjs`, `paper-close-convert-prestate-gas-importer.mjs`, `paper-lifecycle.mjs`, `paper-reference.mjs` | All pass individually | run standalone since the chained `test:integration` script stops at `deployments.mjs` |
| `paper-handoff.mjs`, `setup-draft-delete.mjs`, `paper-recenter-evidence.mjs`, `paper-runtime-upgrade.mjs`, `live-pilot-journal.mjs`, `live-withdraw-rounding.mjs`, `paper-close-convert-v3-booking.mjs` (bare and `--restore-rehearsal`) | All pass — all 7 orphaned-but-runnable files tried | e.g. restore rehearsal created and cleanly dropped its own `conc_liq_restore_<uuid>` database |

### 3.4 Failing (real runs) and why

| Harness | Failure | Cause |
| --- | --- | --- |
| `test/integration/deployments.mjs` | `AssertionError` at line 71, `true !== false` | Global advisory-lock hermeticity gap, [§3.1](#31-the-line-297-question-stale-or-real) |
| `test/integration/paper-command-worker-process.mjs` | `AssertionError` at line 84, `true !== false` | Same |
| `test/integration/dashboard-setup-command-browser.mjs` (default and `--complete-static-lifecycle`, which never gets reached) | `waitFor` timeout at line 300 | Same |
| `scripts/check-dashboard-setup-browser.mjs` | `waitFor` timeout at the review step | Stale raw-unit fixture, [§3.2](#32-a-second-rotted-harness-found-in-passing) |
| `test/integration/static-paper-canonical-flow.mjs` (bare and browser-lifecycle forms) | `ENOENT .env` | Needs the production `.env` (mode 0600, at `/root/conc-liq/.env`), not copied into this worktree by design — copying production RPC/credential material into an audit worktree was judged out of scope without explicit instruction |
| `test/integration/static-paper-canonical-convert-flow.mjs` | `ENOENT .env` | Same |
| `test/integration/paper-close-convert-v3-canonical-worker.mjs`, `paper-close-convert-v3-indexer-preflight.mjs`, `rangekeeper-paper-booking.mjs` | `ENOENT .env` | Same (confirmed directly; `rangekeeper-paper-fork-reads.mjs` and `rangekeeper-paper-owned-replay.mjs` share the identical `.env` read pattern and were not separately re-confirmed to save time) |

### Not run, and why

- **Sealed variants** (`*:sealed`, `check-dashboard-release.mjs`): require a
  built release under `data/releases`, which the hard constraints in this
  task forbid touching.
- **`scripts/check-dashboard-positions.mjs`, `check-dashboard-preview.mjs`**:
  default target is `127.0.0.1:4174` — the live production dashboard port.
  Running them as shipped, without first standing up a private dashboard
  instance on a different port, would mean driving Chromium against the
  service the user is actively using. Not attempted.
- **`scripts/check-dashboard-position-accounting.mjs`**: needs
  `data/dashboard-live-pilot.env`, absent from this worktree by design; it is
  read-only against production by its own header comment, but could not be
  exercised without that file.
- **`dashboard-scale-soak.mjs` full 120-minute run**: exceeds a reasonable
  audit time budget; last real evidence is `dashboard-follow-up-2026-09-29.md`
  (`r2Qualified: true, p6DurationQualified: true`, 120.003 minutes, 121
  samples).
- **`rangekeeper-fork.mjs`, `live-pilot-controller.mjs`, `rangekeeper-paper-fork-reads.mjs`, `rangekeeper-paper-owned-replay.mjs`**:
  real owned-chain-fork tests requiring `.env` RPC configuration and (for
  `live-pilot-controller.mjs`) a funded signer. Same `.env` boundary as above,
  compounded by real network/fork setup that is meaningfully outside a
  read-only audit's scope without explicit authorization.
- **`release.mjs`**: needs `TEST_RELEASE_DIR`, i.e. a built release.

## 4. Individual assertion classification, summarized

| Assertion / file | Verdict | Basis |
| --- | --- | --- |
| `dashboard-setup-command-browser.mjs:300` ("worker readiness" note) | **Neither stale nor a regression — hermeticity gap** | [§3.1](#31-the-line-297-question-stale-or-real) |
| `deployments.mjs:71`, `paper-command-worker-process.mjs:84` | Same class, same cause | [§3.1](#31-the-line-297-question-stale-or-real) |
| `scripts/check-dashboard-setup-browser.mjs` limit inputs | **Stale** — pre-human-unit-conversion raw values | [§3.2](#32-a-second-rotted-harness-found-in-passing) |
| `dashboard-setup-command-browser.mjs:282–292` (20% native-allocation cushion) | **Already fixed**, prior to this audit (by the coordinator, per the task brief, and confirmed present on `main` before this audit branch was cut) | Read directly; formula matches `dashboard-follow-up-2026-09-29.md`'s "rounded-up 20% headroom" description |
| `hybrid-competitor-fixture.test.ts` `ENOENT` | **Environment artifact**, not a code or test defect | Fixture file confirmed present in the primary checkout; worktree setup intentionally omits `data/` |
| `validate-research-reproduction.mjs` `ENOENT` | Same | Same reasoning |

## 5. Prune list

Proposed only — nothing below was deleted.

| Candidate | Justification |
| --- | --- |
| `scripts/check-dashboard-setup-browser.mjs` | Stale (raw-unit fixture), orphaned, and its entire coverage is a strict subset of `test/integration/dashboard-setup-command-browser.mjs`, which is schema-isolated (this one is not — it fabricates a mock HTTP server with no DB) and far more thorough. Delete rather than repair. |
| `scripts/check-dashboard-positions.mjs`, `scripts/check-dashboard-preview.mjs` | Orphaned, undocumented, and dangerous as shipped (default target is the live production dashboard port). Either wire them to spin up their own private dashboard instance and add them to the gate, or delete; do not leave them runnable-against-production by accident. |
| `test/integration/paper-close-convert-v3-canonical-worker.mjs`, `paper-close-convert-v3-indexer-preflight.mjs`, `rangekeeper-paper-booking.mjs`, `rangekeeper-paper-fork-reads.mjs`, `rangekeeper-paper-owned-replay.mjs`, `rangekeeper-fork.mjs`, `live-pilot-controller.mjs`, `paper-handoff.mjs`, `paper-recenter-evidence.mjs`, `paper-runtime-upgrade.mjs`, `setup-draft-delete.mjs`, `live-pilot-journal.mjs`, `live-withdraw-rounding.mjs`, `release.mjs` | Each is a real, passing (where runnable) invariant check with **zero** discovery path — no `package.json` script, no doc reference. Per the stated rule ("every harness either runs in the release gate or should be deleted... an unrun harness rots silently"), each needs either an npm script + a place in a documented gate tier, or removal. Given several of these (`paper-handoff.mjs`, `setup-draft-delete.mjs`, `paper-recenter-evidence.mjs`, `paper-runtime-upgrade.mjs`, `live-pilot-journal.mjs`, `live-withdraw-rounding.mjs`, the bare mode of `paper-close-convert-v3-booking.mjs`) are cheap, self-contained, and currently pass, the lower-cost fix is almost certainly "give them a script and a gate tier," not delete — but that is a call for the user, not this audit. |
| `test/integration/dashboard-setup-command-browser.mjs` (non-lifecycle mode) | **Do not prune.** This is the file the task brief identifies as rotted from neglect, not from being redundant — its coverage (setup review → draft → open preview → pending-open recovery) is unique and its `--complete-static-lifecycle` mode is the closest thing that exists today to the missing full-lifecycle test in [§6](#6-the-missing-test-a-synthetic-full-lifecycle-monitor). Wire it into the gate once the hermeticity fix in [§3.1](#31-the-line-297-question-stale-or-real) lands; it should not need any other change to pass. |
| `dashboard-risk.mjs` | Currently run, currently passing, currently not documented anywhere as "in the gate" under that exact name — only inferred from "sealed risk integration." Cheap to keep; recommend just naming it explicitly in the next acceptance doc rather than pruning. |
| Duplicate coverage flag: `test/integration/paper-mark-id-order.mjs` is both chained into `test:integration` and has its own `test:integration:paper-mark-id-order` script | Harmless duplication (same file, two invocation paths), not worth pruning, but worth knowing about when reading `package.json`. |

## 6. The missing test: a synthetic full-lifecycle monitor

**What it must do.** One scheduled process that, against the real running
services (dashboard + command + paper worker, not an isolated schema), walks
the entire operator loop the four production defects broke: setup preflight →
draft admission → open preview → open accept → pause → resume → close
(retain), asserting at every step that the state the operator would see is
correct, not just that no gate blocked it. This is deliberately the inverse of
every suite audited above: it must prove completion, not refusal.

**Where it should live.** A new `scripts/monitors/paper-lifecycle-monitor.mjs`,
parallel to the existing `src/rpc-health.ts` / `conc-liq-rpc-health.service`
pattern already in `ops/` — a small standalone process, not a `test/`
harness, because it is meant to run continuously in production, not once in
CI. Pair it with `ops/conc-liq-paper-lifecycle-monitor.service` and
`ops/conc-liq-paper-lifecycle-monitor.timer`, mirroring
`ops/conc-liq-accounting.timer` / `.service`.

**Credentials.** A dedicated, minimally-scoped runtime env file (e.g.
`data/paper-lifecycle-monitor.env`), following the existing
`data/*.env` + `launch.mjs` pattern (`docs/operations/static-paper-mvp.md:186–191`):
mode 0600, its config hash recorded the same way other runtime env files are.
It needs exactly the operator HTTP origin/CSRF flow the dashboard itself uses
— no direct DB credential beyond what a read of its own campaign's rows
requires, no signer (paper only). Do not reuse the live pilot's or the main
dashboard's session; give the monitor its own operator identity so a failed
or hung monitor never contends with a human operator's session (this is
literally finding #2 from `dashboard-test-report-2026-09-29.md` — a 32-slot
session Map that evicts the oldest — so a misbehaving monitor is a plausible
way to re-cause that exact defect against a real operator).

**Avoiding production pollution — this is the hard part.** The monitor
*must* create a real paper campaign to prove anything, since the whole point
is testing the real worker's readiness lease and real acceptance path
end-to-end, not a mock. Proposed handling, in order of preference:

1. **Tag and filter, don't fake.** Add a `synthetic: boolean` (or a reserved
   wallet-address allowlist, cheaper to ship) marker recognized by
   `readDeploymentRows`/`deploymentPosition` and excluded from
   `/api/positions` and the dashboard's rendered totals — the same shape of
   exclusion `dashboard-clean-deploy-2026-09-29.md` and
   `dashboard-follow-up-2026-09-29.md` already use for fixture campaigns in
   soak/browser tests, just applied to something that runs against the real
   worker instead of a disposable schema. This keeps the monitor's campaign
   fully real (so the worker's actual acceptance path, actual accounting,
   actual RangeKeeper confirmation code all run) while making it invisible to
   the operator's UI and to aggregate metrics.
2. **Minimum capital, minimum lifetime.** Size the campaign at the
   `minDeploymentValue` floor already enforced by setup admission, and close
   it (retain, not convert — convert irreversibly swaps to USDG, which is
   unnecessary economic churn for a monitor) within the same run, target
   end-to-end under a few minutes so a stuck monitor doesn't accumulate open
   positions.
3. **Self-cleaning on every path, including failure.** On any step's failure,
   the monitor must still attempt to reach a closed/cancelled terminal state
   for whatever it created, the same discipline `dashboard-clean-deploy-2026-09-29.md`
   used for the authorized production cleanup (archive first, verify, then a
   single guarded transaction). A monitor that leaves half-open synthetic
   campaigns behind on every failure is worse than the problem it's meant to
   catch.
4. **Rate/circuit limit.** If N consecutive runs fail at the same step, stop
   creating new campaigns and alert loudly instead of continuing to hammer a
   broken acceptance path with real writes — this is exactly the retry
   discipline the dashboard's own idempotency-key handling already models
   (`dashboard-test-report-2026-09-29.md`'s "What holds" section).

**What it should assert, per stage** (each with a wall-clock timeout, since a
hang is as much a defect as a wrong answer):
- **Setup preflight**: `status==='available'`, costs `provisional`, native
  allocation suggestion present and non-zero.
- **Draft admission**: exactly one `deployment_campaigns` row created,
  `lifecycle='draft'`, config hash matches what was reviewed.
- **Open preview**: `usable` per the same client-side checks
  `dashboard/tabs.js` uses, and — this is the assertion the whole audit
  turns on — `actionAvailable` reflects the *monitor's own* worker-readiness
  probe done independently (not trusted blindly), so a readiness-signal bug
  like [§3.1](#31-the-line-297-question-stale-or-real) would be caught here
  directly rather than by accident.
- **Open accept**: operation reaches `succeeded` within budget; campaign
  `lifecycle='active'`.
- **Pause**: operation reaches `succeeded`; campaign `lifecycle='paused'`;
  Positions view (real `/api/positions` call) shows it correctly as paused.
- **Resume**: same, back to `active`.
- **Close (retain)**: operation reaches `succeeded`; campaign `lifecycle='closed'`
  or equivalent terminal state; final accounting reconciles (the same raw-unit
  check `check-dashboard-position-accounting.mjs` already does, reused here
  rather than reinvented).
- **End-to-end**: total wall time within a budget generous enough to not
  false-positive on ordinary load, tight enough to catch a hang before an
  operator would notice one by hand.

**Alerting.** Failure at any stage should distinguish "gate correctly refused"
(not an alert — that's the suites already in place doing their job) from
"a legitimate operation did not complete" (page-worthy). Reuse the existing
`rpc:health` quorum/hysteresis pattern's failure-classification approach
rather than inventing a new one.

This single monitor, run every 15–30 minutes against the real services, would
have caught all four of yesterday's production defects: it is, by
construction, the first thing in this repository that requires "legitimate
operation completes" rather than "gate refuses," which is precisely the shape
of coverage the diagnosis in the task brief says is missing everywhere else.

## Fixes made

None to test logic. The only change on this branch is this report. The
[stale native-allocation formula](#4-individual-assertion-classification-summarized)
mentioned in the task brief was already fixed on `main` before this audit
branch was cut, and this audit found no other assertion that met the "clearly
stale" bar for a fix — `scripts/check-dashboard-setup-browser.mjs` is stale
but orphaned and superseded (pruning candidate, not a fix target), and the
line-297 family of failures is explicitly not stale (see [§3.1](#31-the-line-297-question-stale-or-real)).

## Method and safety

All database work used disposable, randomly-named schemas
(`dashboard_command_<uuid>`, `deployment_test_<uuid>`, etc.) or, for the
restore-rehearsal test, a disposable whole database
(`conc_liq_restore_<uuid>`) that the harness created and dropped itself.
Verified after this session: no stray test schema remains (`information_schema.schemata`
query matched only the pre-existing production `rangekeeper_v1` schema, not
anything this audit created); `deployment_campaigns` row count is unchanged at
1 (see the coordinator dateline below; the audit neither created nor removed it); no test or database
credential was written into a committed file; `.env` and `data/dashboard-live-pilot.env`
were deliberately not copied into this worktree. No `systemctl` command was
run, no release was built, no file under `data/releases` or
`/etc/systemd/system` was touched, and no browser was pointed at the live
4173/4174 services. The live `conc-liq-paper-operation-worker.service`
process (pid 1014549) was observed via `ps`/`pg_locks` only — never signaled,
stopped, or otherwise disturbed, per the hard constraint against creating the
"production down" precondition rather than just documenting it.

## Outstanding — could not determine

- Whether `rangekeeper-paper-fork-reads.mjs` and `rangekeeper-paper-owned-replay.mjs`
  fail for the identical `.env` reason as their siblings, or for something
  else further in — only the `.env` read was confirmed for the two closest
  siblings (`rangekeeper-paper-booking.mjs`, `paper-close-convert-v3-indexer-preflight.mjs`);
  these two were not individually re-run to save time, on the strength of
  identical import/read patterns at the top of each file.
- Whether the sealed-build variants of any suite still pass — none was run;
  this audit's hard constraints forbid touching `data/releases`, and building
  a fresh sealed release was judged out of scope for an audit task.
- The full 120-minute soak's current pass/fail state — last real evidence is
  09-29; not re-run here for time budget reasons. The 0-minute smoke path
  that exercises the same harness's startup/instrumentation code did run and
  passed.
- Whether `scripts/check-dashboard-positions.mjs` / `check-dashboard-preview.mjs`
  would pass against a *private* dashboard instance on a non-production port
  — plausible, given their sibling browser suites all pass, but not verified,
  since standing up a private instance for two orphaned, unreferenced scripts
  was judged not worth the additional surface area in this session.


## Coordinator dateline and corrections

Added on review, 2026-09-30, after the audit branch was cut.

- The single `deployment_campaigns` row observed during this audit was not
  pre-existing. Production was emptied at 12:46 and the 13:14 cutover recorded
  zero campaigns before and after. The operator opened a paper campaign
  manually at 13:32 and closed it with a retain close at 14:30, on build
  `d648bf55`. The audit's safety claim still holds exactly as written — it
  neither created nor removed that row — only the attribution needed fixing.
- The unit count has moved from 953 to 956 since this was written: `main`
  gained three tests covering the calibration tick-range scoping.
- The advisory-lock hermeticity defect was rediscovered independently by the
  coordinator while running `npm run test:integration` against live production,
  and the two findings agree. The coordinator's earlier guess that the line-297
  failure was a stale selector on `#setup-open-status` was wrong; the harness
  wires `paperRetainWorkerReady:()=>store.paperOperationWorkerReady()` at
  `test/integration/dashboard-setup-command-browser.mjs:210`, so a live
  production worker makes the harness believe a worker is ready, the
  `tabs.js:777` unavailability note is never rendered, and the wait times out.
  Neither stale nor a product regression, as this audit concluded.
