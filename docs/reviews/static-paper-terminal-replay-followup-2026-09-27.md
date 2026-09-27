# Static paper terminal replay follow-up — September 27

The operator requested the next steps after the
[maintenance release review](sealed-paper-maintenance-followup-2026-09-27.md),
then instructed execution. This record separates the earlier unexplained
terminal rejection from newly measured results.

## Diagnostics and retained inputs

Commit `9bb54a570f7bfdb385f555377aa66934bdab035b` adds opt-in worker diagnostics
through the existing `DEPLOYMENT_PAPER_WORKER_DIAGNOSTICS` flag. They distinguish
terminal verification stages from final booking, record a sanitized reason and
source-frame mismatch category, and include source/gas observation ages. They
do not change admission, replay, freshness, claim or booking rules. Diagnostic
callback/logging failures cannot replace the original verification failure.

The canonical conversion fixture now captures a failure artifact before normal
cleanup: validated terminal model, its operation/preview binding, exact cached
fee context, source/hash snapshots and bounded diagnostic events. Artifacts use
private campaign directories (0700) and files (0600); full environment values,
arbitrary requests and raw provider error bodies are not exported. Inputs with
detected credential-bearing keys/URLs are omitted with a recorded reason.

Focused checks passed: 17 tests plus typecheck. The clean full check passed
**898/898 tests in 85 suites**, repository validators and typecheck. Unrelated
dirty hybrid/adaptive, manifest-validator and older review work remains outside
the source commit and clean checkout.

## Reproduction and sealed candidate

The source diagnostic run completed canonical conversion successfully for
campaign `4d515fc8-0ef8-40e5-bce5-3ea45136045f`, with actual command/worker
processes, desktop/mobile checks, signer unloaded and zero broadcasts. It did
not reproduce or explain the earlier terminal rejection. No speculative
functional repair or freshness extension was introduced.

- Clean checkout: `/root/conc-liq-worktrees/terminal-review-release`.
- Source: `9bb54a570f7bfdb385f555377aa66934bdab035b`.
- Sealed build: `55cc01207121fe0e863665e356964c23ba2a75d3726ff02f329715c8e5704fa4`.
- Artifact: `/root/conc-liq/data/releases/55cc01207121fe0e863665e356964c23ba2a75d3726ff02f329715c8e5704fa4`.
- Pinned Node: `v24.20.0`; bundled manifest verification passed.
- Private evidence directory: `/root/conc-liq/data/static-paper-terminal-review-2026-09-27`.
- Logs: `source-diagnostic.log`, `clean-check.log`, `build.log`, `verify.log`.

Canonical fixtures use `conc_liq_terminal_review_20260927`, a disposable database
with independent advisory locks. Five public canonical replay tables are exposed
through foreign tables with SELECT-only local privileges and a forced read-only
source connection. Deployment writes remain in temporary fixture schemas.

| Exact-artifact gate | Result |
| --- | --- |
| Ordinary conversion | Passed: campaign `786e86ec-75f4-460a-bc00-c647475b0acc`, verified sealed command/worker, canonical terminal conversion and desktop/mobile parity. |
| Retain browser lifecycle | Passed: campaign `94565251-4a6f-4e56-8074-4d7d386d59a5`, browser setup/open/pause/resume/retain, desktop/mobile and history parity, signer unloaded, zero broadcasts. |
| Economic worker interruption/restart plus canonical restore | Two attempts stopped before acceptance: first at replay-head freshness, second at `paper_conversion_prestate_fee_replay` / `AssertionError`. Recovery and restore not reached. |
| Changed-anchor rejection after restart | Passed: campaign `56373507-b059-4ab1-83de-543631c4913e`; same-key replay after expiry/lease loss, worker ready in 4.273s, injected changed anchor blocked with zero terminal conversion outputs. |

Production replacement remains pending these gates and the command/worker
configuration-identity review. At the start of this follow-up, production still
had zero deployment campaigns and operations. No production service or schema
has been changed by this follow-up.

## Configuration identity correction

Read-only source review confirmed that the command stores its runtime identity
on draft creation and both V2 and V3 accounting compare that identity with the
worker. The preceding staged package used different config hashes and would
therefore block accounting. All overlapping private values compared equal.
The new inactive shared command/worker file combines those existing keys and
enables the two existing diagnostic flags; dashboard configuration is separate.

- Shared file: `data/static-paper-mvp-shared-review-2026-09-27.env`, root-owned 0600.
- File SHA256: `ac874eb387b9f3ad72389b6d4624f9bf82cf70b1c079177c2dfb0cd61891aae6`.
- Runtime config hash: `4a67b9777fff565e6cd352f2997016e5836d71e43190b401d1122e9f63124e91`.
- All three staged units target `55cc0120…`; command and worker share that exact file.
- Original live unit bytes still match their preserved copies. Offline systemd
  verification passed with only the unrelated installed snapd `RestartMode` warning.
- Staged manifest and original fragments are retained in the private evidence directory.

The first recovery fixture used campaign `68528b4e-3328-4c78-b25f-b443f6b74693`.
It opened successfully and ultimately persisted fee carry and V2 accounting
through valuation mark 2, but preparation then refused a stale canonical replay
head. No conversion was accepted and restart/restore were not reached. The
failure artifact was saved before fixture cleanup. The log is
`canonical-recovery-restore-sealed.log`; this does not reproduce or explain the
previous terminal verifier rejection.

Read-only follow-up resolved this preparation failure specifically: at
16:11:16 UTC cursor block `74069445` had canonical timestamp 16:08:02 UTC,
so it was **194 seconds old** against the unchanged 180-second gate. Its
saved hash matched RPC. At 16:14:44 UTC the cursor had advanced to `74072431`
(timestamp 16:13:01 UTC), about 103 seconds behind the RPC head. The tail
service was active with successful canonicality-validated cycles. This is
observed transient replay staleness; no tail configuration, cursor or freshness
limit was changed. It does not explain the earlier terminal-replay rejection.

Changed-anchor gate log: `canonical-negative-sealed.log`. The actual sealed
worker restarted with identical environment bytes; an isolated test RPC proxy
then changed one persisted source-block response. Operation
`985a4d47-f8be-4a7e-a789-77ff3ae21193` blocked with
`paper_operation_canonical_or_evidence_invalid`. This proves refusal under the
injected fault; it is not evidence of a real chain reorg. After observed replay
freshness recovered, a second positive recovery/restore run started on the
unchanged artifact, logged separately as `canonical-recovery-restore-retry-sealed.log`.

The positive retry used campaign `067911ef-fcf1-42c2-937a-b21f3db6024c`.
It passed open and fee/V2 readiness through mark 2 at `74076893`, then stopped
before conversion acceptance at `paper_conversion_prestate_fee_replay`, with
sanitized reason `AssertionError` (16:21:25 UTC). The final diagnostic showed
replay cursor `74077136` and head `74077453`; this failure is not established as
staleness. Its exact assertion remains under investigation using the separately
retained failure artifact. No terminal conversion model or operation was
accepted. Restart/restore acceptance is still outstanding; staged services
remain inactive.

A bounded read-only historical probe subsequently replayed the retained previous
mark `74076893` to failure-time cursor `74077136`. The cursor hash matched RPC;
the interval produced two events/two segments, zero partial segments, and the
saved fee carry advanced successfully. Captured open/profile/config/carry
schemas, hashes and bindings also passed read-only checks. These results do not
reproduce the failure: the exact selected `PaperOpenFrame` was not retained,
and the original stage also rechecks persisted context. The cause remains
unconfirmed. The diagnostic-only follow-up now preserves the selected
source/pool state and reference-proof hash, verifies the normalized binding
hash before retaining it, and records its capture time. Known assertion text
maps to bounded internal codes; persisted-context assertions have explicit
labels. Diagnostic logging errors cannot mask preparation outcomes. Predicates,
replay retries, freshness and acceptance rules are unchanged. Fourteen focused
tests and typecheck passed. The existing incomplete-cursor assertion text and
15-second retry are unchanged.

Checkpoint commit `b94ddb2` records the passed gates and correct shared runtime
identity requirement. The private postrollout read-only browser verifier is
prepared and syntax-checked but has not been run against production. At
16:29:24 UTC, production still had zero campaigns, operations and marks, with
the existing worker's database-scoped readiness lease present. The retained
pre-cutover backup checksum was reverified; no database rollback is planned.

## Expanded preparation diagnostics candidate

Source `1819932964e463bc88c387302615fec5cd5d0cab` adds only the preparation
assertion codes and candidate binding capture described above. The clean full
check passed **900/900 tests**, validators and typecheck. Pinned Node remained
v24.20.0. New verified sealed build:
`91ea6c419ccf12be8254060ad988cf63907f5a636556da6d3bcbb574e226462e`.

Its separate logs, browser artifacts and staged units are under the private
`prestate-diagnostics/` evidence subdirectory. The shared private command/worker
file and its identity hash are unchanged. These units supersede the inactive
55cc candidate; installed production fragments still match the original hashes.
All earlier lifecycle passes retain their original 55cc build identity.

| New exact-artifact gate | Result |
| --- | --- |
| Positive conversion restart and backup/restore | Blocked: same-key recovery passed and worker restarted in 3.518s, but terminal gas replay rejected a source aged 216.359s against the unchanged 180s limit. Restore not reached. |
| Ordinary conversion | Not run on this artifact after the recovery blocker. |
| Retain browser lifecycle | Not run on this artifact after the recovery blocker. |
| Changed-anchor rejection after restart | Not run on this artifact after the recovery blocker. |

### Confirmed terminal freshness rejection

Campaign `893514a2-e082-4a03-89ae-2e9e1b7f524c` passed setup, open and
fee/V2 catch-up through valuation mark 2 at block `74092842`. Conversion
operation `69d51b67-dc3d-42d9-bcc1-4aaf8da557b7` was accepted, and lost-response
reconciliation after preview expiry and worker lease loss returned HTTP 202
with the same operation and `replayed: true`. The sealed worker restarted with
identical environment bytes in **3.518 seconds**. Its first attempt then blocked
at `paper_recovery_required`, reason
`paper_close_convert_v3_terminal_replay_invalid`. No terminal conversion mark
was written; canonical restore was not reached.

The retained exact model and fee context identify a specific failure:

- Source block `74093946`, canonical timestamp **16:49:03 UTC**, hash
  `0x9d4175b15feea326f6bdb86e10130beed44b6b5abd77862cb4899b8b45a2ccea`.
- Candidate captured at **16:50:30.308 UTC**; gas observed at **16:51:18.381 UTC**.
- Preview created at **16:51:23.828 UTC**, acceptance persisted at
  **16:51:42.627 UTC**, preview expired at **16:52:18.381 UTC**.
- Failure diagnostic at **16:52:39.359 UTC**, stage
  `terminal_gas_stage_replay`: source age **216,359ms**, gas observation age
  **80,978ms**. Model hash
  `c8b7d368b27af5b089d694268ee81caafe50d554c45f8b6bc6be8d83394fcf8a`.

A pure diagnostic invocation of the prestate sampler with these retained exact
inputs and the failure time reproduced **`Paper conversion source stale`**
before any network, fork or callback access (zero callbacks). The source-age
check is in `paper-close-convert-prestate-sampler.ts`; worker replay correctly
uses the current time. This establishes the cause of this run, not the earlier
opaque terminal rejection or the separate preparation fee-replay assertion.

The timing evidence warrants a freshness-budget investigation. Tail cycles
took roughly 59–63 seconds and then 117 seconds; at 16:49:10 the canonical
cursor was still 72 blocks short of valuation mark 2. The eventual candidate
was already 87 seconds old when captured, and preparation consumed another
48 seconds before the gas observation. Preview expiry and recovery then
crossed the 180-second boundary. Fast worker startup alone cannot resolve this
run's timing constraint. Freshness limits, retry predicates and clock semantics
were not changed.

Private evidence under `prestate-diagnostics/` includes
`canonical-recovery-restore-sealed.log` and campaign directory
`sealed-browser/893514a2-e082-4a03-89ae-2e9e1b7f524c/`, containing
`canonical-convert-failure.json` and `terminal-gas-staleness-probe.json` (0600).
The independent metadata audit confirms only the three intended runtime
diagnostic files changed relative to 55cc. Its historical gate passes do not
qualify 91ea for release.

### Checkpoint and next action

Production rollout is blocked. Next measure replay-cursor lag, preparation,
preview lifetime and terminal replay as one freshness budget; then make only
a demonstrated latency or fresh-canonical-anchor repair that preserves the
180-second gate. Do not substitute acceptance time for current time, extend
the freshness limit or bypass replay to pass the fixture. Rerun positive
recovery and canonical restore, plus ordinary conversion, retain and changed-
anchor rejection on the same verified artifact, before replacing the three
services. The first human AAPL/USDG paper retain-close remains outstanding;
RangeKeeper and live follow-ups remain deferred.

At **17:00:07 UTC**, all three original production unit files still matched
their preserved hashes; all services were active with zero restarts, and the
database-scoped worker readiness lease was present. Production had zero
deployment campaigns, operations and marks. The isolated fixture database
(verified OID `2300351`) had zero remaining fixture schemas and other backends,
and was dropped without force; its five foreign tables did not own source
data. Cleanup verification is retained in `checkpoint-cleanup.json`. No
production service, configuration or database was changed by this follow-up.
