# Static/manual paper operator MVP

Delivery authority: [implementation plan, section 12](../plans/research-and-positions-sol-2026-09-21.md#12-september-26-mvp-review-and-sol-delivery-order).
This runbook accompanies release preparation. Its presence does not establish
MVP acceptance or authorize a production cutover. Record the exact reviewed
source and build in the release evidence before using it operationally.

The [September 27 rollout package](../reviews/static-paper-rollout-package-2026-09-27.md)
contains the current staged commands, profile, backup and approval scope. Its
measured compatibility findings supersede the earlier two-service-only proposal:
seven existing consumers reject schema 11 on their installed builds, and the
daily telemetry retention guard also needs its reviewed update. Preserve the
existing service arguments, environments and timer schedules during that
coordinated cutover. Old schema-3-only builds are not a rollback after migration.

The operator approved and executed that cutover on September 27; see the
[applied production record](../reviews/static-paper-production-cutover-2026-09-27.md).
The operator is also available through the approved Tailscale Funnel at
`https://dear-foxhound.tail106f9e.ts.net/operator`. The obsolete `/prototype`
route has been removed and returns 404. The local page remains `http://127.0.0.1:4174/operator`.
See the [Funnel rollout](../reviews/static-paper-operator-funnel-2026-09-27.md)
for the exact trusted origin and command-service release. Password sign-in has
been removed at the operator's request; the page connects automatically.
Anyone who can reach the Funnel URL can use the paper controls. Same-origin
and CSRF checks protect requests but do not restrict access to selected users.
The public read-only dashboard remains on its existing origin.

## Operator workflow

Open the approved operator URL and its Positions page.
Use the same origin for the page and commands. The public dashboard at `/`
remains read-only. No password or sign-in action is required on `/operator`.

1. In Positions setup, select a registered supported pool, static/manual paper,
   capital and centered tick half-width. Review the exact range, inventory,
   expected provisional costs and reviewed admission bound. An unavailable
   reference, source, cost profile or worker readiness blocks the next action.
2. Save the reviewed draft and review its open operation. Submit once. Keep
   the campaign identity visible until Positions reports the persisted open
   result. A pending operation or a stopped process does not establish success.
3. Read the shared position metrics, chart, activity and recorded history.
   Principal-only marks do not establish fee capture, complete NAV or net alpha.
   Provisional modeled gas is distinct from paid gas; gaps stay unavailable.
4. Pause and resume from the position controls. These change lifecycle without
   resetting initial inventory, budgets or the performance baseline.
5. Review and submit one exit. Close-retain records the withdrawn principal
   lower bounds; complete token balances, fees and native balance remain unavailable.
   Close-convert additionally models the supported conversion
   to the quote token, with explicit residuals and provisional costs. Wait for
   the terminal persisted operation and matching closed Positions history.
6. A second campaign can start after the prior campaign has reconciled closure
   and released its reservation. Keep the first campaign's history.

Ordinary operation requires no source/config edit, worker restart, manually
seeded draft or shell operation admission. If review expires before acceptance,
obtain a new review. If the acceptance response is lost, use the saved pending
request reconciliation control: it resends the original payload and key.
Do not replace an uncertain accepted request with a fresh key.

Open success does not establish later conversion availability. The conversion
sampler currently requires the saved candidate's diluted pool-liquidity share
to be at most 1%; the close review also requires complete fee evidence, eligible
references and exact scoped costs. Retain-close records principal lower bounds
without claiming complete converted balances or earned fees.

## Interrupted operations

Reload Positions and inspect the campaign and persisted operation. Saved
acceptance reconciliation remains available after a lifecycle change or closure.
Worker readiness only proves a connected database lease, not operation progress.
Inspect status, stage, reason, attempts and update time when work stalls; capture
bounded logs with credential-bearing URLs redacted.

The supervisor can restart the same pinned worker after an interruption. It must
claim and reconcile the existing operation, preserving completed economic stages
and exact-once marks/ledger rows. Canonical evidence changes block or invalidate
economics. Never delete accounting, mutate source anchors or mark success by hand
to unblock a campaign. An admission preview's expiry does not undo accepted work.

## Review and cutover record

Complete this record with measured results before a production approval request:

| Field | Required evidence |
| --- | --- |
| Source and runtime | Clean scoped commit; sealed build ID; manifest verification; pinned Node; command, worker and server-owned setup/cost preparation identity |
| Configuration | Private environment file path and config hash; loopback origin; registered profile/reference policy; enabled capabilities; no secrets in the record |
| Database | Current and target schema versions; isolated upgrade and restore rehearsal; backup identity; explicit production migration command |
| Operator acceptance | Separate canonical browser setup-to-retain and setup-to-convert campaigns, desktop/mobile screenshots, terminal evidence matching persisted lower bounds or modeled conversion balances, and explicit economic gaps |
| Recovery | Actual economic worker interruption/restart including pending conversion; same-key browser reconnect; no duplicate stage, terminal mark or ledger row; changed canonical evidence rejection |
| Services | Current owners and active campaigns; rendered command/worker units; intended enabled capabilities; predecessor workers/custody ownership preserved |
| Rollback | Prior build/config; schema compatibility; recovery and execution ownership after any accepted operation; no deletion of post-upgrade journal evidence |
| Authorization | Exact production migration/service/campaign actions authorized by the operator; remaining actions pending |

Use a clean worktree at the reviewed commit when unrelated source work is dirty.
Build with the repository's pinned Node, then verify the artifact with its own
`bin/node launch.mjs --verify`. Render units using
`scripts/render-release-units.mjs RELEASE PRIVATE_ENV OUTPUT`; rendering does
not install them. Run `systemd-analyze verify OUTPUT/*.service OUTPUT/*.timer`
before preparing concrete installation
and migration commands. Run the applicable integration, restore, economic
recovery and canonical browser gates against that same artifact.

The supervised paper worker is opt-in. Put the explicit setting
`DEPLOYMENT_PAPER_OPERATION_WORKER=1` in the private runtime environment file
used by the rendered command and worker units. `launch.mjs` strips inherited
application environment variables and hashes only values from that file into
the runtime config identity, so a systemd `Environment=` override is ignored
and cannot enable the worker. Keep the flag in the file and verify its
mode/ownership without printing its contents. After startup, `/healthz` proves
only command-server liveness; check `GET /api/market-profiles` after the automatic browser session handshake
for the registered profile and inspect the actual worker advisory lease in
PostgreSQL before treating worker readiness as established.

The private file must also configure `PAPER_FORK_RPC_URL` to the specifically
approved read-only source used by the temporary owned local Anvil fork. Setup's
owned-fork cost sampler and close-convert preview require it. The fork performs
simulated mutations only against its local Anvil process; do not point this
setting at a signing or production write endpoint. Keep its value private and
include it in the file's recorded config hash.

Profile registration writes to the production catalog. Obtain separate
explicit authorization for the exact target database and profile contents/hash,
chain/pool, reference policy and indexer stream/target set before invoking the
registration CLI. Migration or service authorization alone does not authorize
profile registration.

The canonical browser commands are
`test:integration:static-paper-canonical-retain-browser:sealed`,
`test:integration:static-paper-canonical-convert-browser:sealed` and
`test:integration:static-paper-canonical-convert-recovery:sealed`.
Set `TEST_SEALED_RELEASE_DIR`, `TEST_EXPECTED_RELEASE_COMMIT`, the local
`TEST_DATABASE_URL` and `TEST_BROWSER_EVIDENCE_DIR` for each recorded run. Add
`-- --restore-rehearsal` to the recovery command to combine actual interruption
and restart with the completed canonical campaign's backup/restore rehearsal.
The dedicated `test:integration:static-paper-canonical-convert-restore:sealed`
command rehearses backup/restore after ordinary conversion without interruption.
These fixtures use disposable schemas,
but worker readiness and maintenance advisory locks span the database: serialize
process fixtures against one database. Keep independent synthetic regression
work in a separate disposable database when running it in parallel.

The separate `test:integration:static-paper-canonical-convert-recovery-negative:sealed`
command changes one accepted anchor response through a test-only local RPC proxy
after restart. Its evidence class is `fault_injected_rpc_response_process_boundary`;
it tests rejection and absence of conversion booking, and does not establish an
observed chain reorganization. Keep this result separate from the successful
canonical lifecycle and restart-recovery evidence.

Enable only the capabilities demonstrated by that artifact. Static paper MVP
completion does not complete RangeKeeper paper, new live deployments or W2 in
full. No active predecessor campaign is automatically adopted by this release.
