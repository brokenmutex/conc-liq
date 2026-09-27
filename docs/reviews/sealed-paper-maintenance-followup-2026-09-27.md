# Paper maintenance ordering follow-up — September 27

This follows the [two failed canonical conversion gates](sealed-paper-review-7c7f60b-2026-09-27.md).
Production remains unchanged. Source fix: `4e8e286533de11ac7bd7fe8f6e8dd48bdea1becd`.
Release status: blocked at canonical conversion terminal replay; the accounting
catch-up fix is verified, but ordinary conversion and subsequent recovery gates
have not passed on this artifact.

## Behavior and review

Maintenance now projects existing V1 and V2 accounting before sampling another
principal valuation. A pass that performs projection or fee-evidence work can
finish catch-up, then returns without adding another mark. Sampling resumes on
a later pass which starts with both journals current. This gives conversion's
latest-mark check a stable accounting target under delayed replay.

The same pass budget, audits, preparation lease, terminal rules, canonical
checks and freshness limits remain. A one-step pass can sample from a fully
current starting state; it then reports budget exhausted because the new mark
still needs projection. It cannot repeatedly append marks over a backlog.
No change was made to the fixture's latest-mark requirement or timeout.

Luna agents implemented source and tests independently and reviewed the V1/V2,
fee-evidence, terminal, lease and budget paths. Three new regressions failed
against the prior ordering and passed with the fix. The six focused tests cover
backlog/budget behavior and repeated replay failure followed by recovery. Their
valuation stub intentionally reports unavailable state, so those tests prove
sampling eligibility/order rather than successful valuation append.

## Exact-artifact validation

- Clean checkout: `/root/conc-liq-worktrees/review-maintenance-release`.
- Private evidence: `/root/conc-liq/data/static-paper-maintenance-review-2026-09-27`.
- Pinned Node: `v24.20.0`.
- Sealed build: `a81e12229c9eafab61d2e0263e73d25201e635e37a10bbaf920058d71e71a642`.
- Artifact: `/root/conc-liq/data/releases/a81e12229c9eafab61d2e0263e73d25201e635e37a10bbaf920058d71e71a642`.
- Clean check passed: repository validators, typecheck, **896/896 tests in 85 suites**.
- Isolated PostgreSQL V3 booking integration passed, including bounded
  maintenance exhaustion/resume and admission mechanics. Its chain anchors are
  synthetic; it is not canonical browser acceptance.
- Artifact verification passed using bundled Node and `launch.mjs --verify`.
- Canonical conversion: fee/accounting readiness passed; preview returned HTTP
  200 with `status=unavailable`, reason
  `static_manual_conversion_prestate_unavailable`. No conversion was accepted.
- Bounded diagnostic conversion run: preview and HTTP 202 acceptance succeeded,
  but the worker blocked at `paper_recovery_required` with reason
  `paper_close_convert_v3_terminal_replay_invalid`, attempt 1. This is not a
  completed conversion or recovery acceptance.
- Canonical browser setup/open/pause/resume/retain passed on this artifact;
  campaign `821c6075-2ad4-4c3a-a8e9-21c1df69ad79`. Actual sealed command/worker,
  desktop/mobile captures, signer unloaded, zero broadcasts, isolated schema.
- Economic conversion restart/restore and changed-anchor gates: not run on this
  artifact because ordinary conversion has not passed.

The new conversion campaign `00e478df-4715-4d86-85b8-ce1d354d26cb` demonstrated
the ordering correction before preview: at 15:12:14 UTC it held two marks,
latest block `74035409`, while replay covered only `74034300`. At 15:14:21 UTC
it still held the same two marks, with both fee evidence and accounting through
`74035409`, and replay through `74036017`. The fixture confirmed latest-mark
readiness without changing its wait or accounting checks. These observations
are retained in `maintenance-progress.jsonl`; they establish catch-up behavior,
not conversion completion. The final diagnostic kept latest mark, fee evidence
and accounting at `74035409`, with no missing persisted fee interval. Replay was
through `74036017` versus RPC head `74037958`. That lag alone does not establish
the reason for the separate unavailable-prestate response; the response does
not expose a more specific cause. The failure and zero conversion acceptances
are retained in `canonical-convert.log`.

The generic unavailable-prestate response comes from the conversion catch in
`src/deployments.ts`; the initial run did not enable the existing sanitized
stage/reason diagnostic. The bounded follow-up enabled
`DEPLOYMENT_PAPER_SETUP_DIAGNOSTICS=1` without changing source or timeouts.
Its preview succeeded, so it did not reproduce or explain the initial preview
failure. It reached a separate terminal-replay rejection:

- Campaign: `a2b72c3c-86fa-45e1-b10e-dc1ded809293`.
- Accepted conversion: `bbb4b17b-9283-4b97-9aeb-c8521e67909d`.
- Accepted at 15:23:36 UTC; blocked at 15:23:44 UTC on the first attempt.
- Latest persisted mark, fee evidence and accounting remained at block
  `74041193`; no terminal mark was present in the final mark diagnostic.
- Final replay cursor `74042621`; RPC head `74043016`.
- Log: `canonical-convert-diagnostic.log` in the private evidence directory.

The worker maps terminal replay exceptions to the reported conflict in
`src/deployments/paper-operation-worker.ts`. This log does not expose the
underlying verification exception, so it cannot establish an observed reorg,
gas mismatch, indexer-coverage failure or code defect as the cause. No guard was
bypassed and no production campaign was opened. The next narrow investigation
must capture the underlying terminal-verifier stage/reason and accepted input
identity before fixture cleanup, then reproduce it against canonical evidence.

The previous candidate's passed retain gate is historical evidence for
`7c7f60b` / `656364f3…`, not acceptance of this follow-up. The original failed
conversion logs and read-only provider diagnostics remain retained. No
production worker, command service, dashboard, database schema, profile,
campaign or timer has been modified by this follow-up.

## Staged replacement

The evidence directory contains three candidate service fragments in `units/`,
their preserved originals in `original-units/`, and a hash manifest. Each live
fragment was rechecked byte-for-byte against its preserved original before
staging. Only the release paths and the previously reviewed worker environment
path change. Offline service syntax validation passed with the same unrelated
installed snapd warning noted in the preceding record.

The candidate environment identities, schema-11/no-migration scope, original
production backup and rollback constraints are those in the
[preceding record](sealed-paper-review-7c7f60b-2026-09-27.md#production-snapshot-and-staged-replacement).
The candidate fragments in this follow-up replace the earlier blocked build's
staged fragments as the proposed three-service replacement. Production counts,
unit/environment hashes and backup applicability must be rechecked before any
later cutover. The accounting runtime remains frozen once a campaign is active.

The final production check still found zero campaigns, operations and marks;
all three prior services were active with zero restarts. Release replacement,
economic restart/restore, changed-anchor acceptance and the human-operated
retain-close milestone remain outstanding. The three staged fragments are
review material and must not be treated as an accepted release package.

Cleanup verified no fixture schemas or test database backends remained. The
disposable database `conc_liq_sealed_review_7c7f60b` was then dropped, including
its read-only foreign-table mappings. Logs, screenshots, sealed artifacts,
clean source checkouts and the private production backup were retained.
