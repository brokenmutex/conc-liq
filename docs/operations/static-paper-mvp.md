# Static/manual paper operator MVP

Delivery authority: [implementation plan, section 12](../plans/research-and-positions-sol-2026-09-21.md#12-september-26-mvp-review-and-sol-delivery-order).
This runbook accompanies release preparation. Its presence does not establish
MVP acceptance or authorize a production cutover. Record the exact reviewed
source and build in the release evidence before using it operationally.

## Operator workflow

Connect privately to the loopback command server and open its Positions page.
Use the same origin for the page, login and commands. The public dashboard
remains read-only. Log in using the configured operator password.

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
5. Review and submit one exit. Close-retain preserves the modeled withdrawn
   token inventory. Close-convert additionally models the supported conversion
   to the quote token, with explicit residuals and provisional costs. Wait for
   the terminal persisted operation and matching closed Positions history.
6. A second campaign can start after the prior campaign has reconciled closure
   and released its reservation. Keep the first campaign's history.

Ordinary operation requires no source/config edit, worker restart, manually
seeded draft or shell operation admission. If review expires before acceptance,
obtain a new review. If the acceptance response is lost, use the saved pending
request reconciliation control: it resends the original payload and key.
Do not replace an uncertain accepted request with a fresh key.

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
| Operator acceptance | Separate canonical browser setup-to-retain and setup-to-convert campaigns, desktop/mobile screenshots, exact terminal inventories and explicit economic gaps |
| Recovery | Actual economic worker interruption/restart including pending conversion; same-key browser reconnect; no duplicate stage, terminal mark or ledger row; changed canonical evidence rejection |
| Services | Current owners and active campaigns; rendered command/worker units; intended enabled capabilities; predecessor workers/custody ownership preserved |
| Rollback | Prior build/config; schema compatibility; recovery and execution ownership after any accepted operation; no deletion of post-upgrade journal evidence |
| Authorization | Exact production migration/service/campaign actions authorized by the operator; remaining actions pending |

Use a clean worktree at the reviewed commit when unrelated source work is dirty.
Build with the repository's pinned Node, then verify the artifact with its own
`bin/node launch.mjs --verify`. Render units using
`scripts/render-release-units.mjs RELEASE PRIVATE_ENV OUTPUT`; rendering does
not install them. Verify rendered units before preparing concrete installation
and migration commands. Run the applicable integration, restore, economic
recovery and canonical browser gates against that same artifact.

Enable only the capabilities demonstrated by that artifact. Static paper MVP
completion does not complete RangeKeeper paper, new live deployments or W2 in
full. No active predecessor campaign is automatically adopted by this release.
