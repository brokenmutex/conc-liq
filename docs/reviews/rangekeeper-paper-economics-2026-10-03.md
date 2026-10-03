# RangeKeeper paper economics, October 3

Current deployed release: `b7ac60b03059be5a784a84217b1311c9b47f636daaef107f9587325993305052`,
source `4064cd6779b202efc299a610f79d2a9c897efd81`. It preserves the last complete
same-epoch valuation while a newer observation awaits accounting, displaying the
economic timestamp separately. Actual API and desktop/mobile checks now return
economics for all six campaigns simultaneously. The earlier rollout below is
retained as predecessor evidence.

The paper worker previously skipped fee replay and accounting for RangeKeeper.
The dashboard consequently had principal valuations but no net economics for
its six paper campaigns. This release adds a RangeKeeper adapter to the existing
canonical observed-flow fee replay and v11 append-only accounting tables.

The adapter samples complete holding intervals, split at recenter and exit
boundaries, and checks any skipped valuation marks have unchanged epoch, range,
liquidity, revision and ordered canonical sources. Historical minute marks without
accounting stay unavailable. New fee endpoints are retained even if another mark
arrives before projection. Conservative integer fee allocations remain separate
cash; they are never retroactively reinvested in historical swaps or mints.

NAV includes position principal, idle tokens, retained modeled fees and the
remaining modeled native reserve. The passive comparison uses the same original
token and native inventory. Displayed starting capital comes from that complete
modeled baseline, preventing an unspent gas reserve from appearing as profit.
Model costs stay separate from receipt-paid costs, and missing evidence never
becomes zero. Reorg audits require stable repeated reads before permanently
invalidating the affected accounting suffix.

Reference validation checks the oracle selected under RangeKeeper's configured
policy. The asset diagnostic also contains an oracle evaluated under a different,
shorter risk age limit; that unused copy cannot override a valid selected oracle.
Stale selected references still withhold reference-derived economics.

Validation:

- Full source check: 1,173 tests in 94 suites passed before final narrow reference
  and baseline corrections. The isolated paper-only checkout passed 1,081 tests
  in 90 suites; final baseline changes passed typecheck and all 12 focused
  dashboard tests. The final catch-up stability change passed typecheck and all
  three focused paper-worker tests.
- Exact v11 PostgreSQL regression crosses IDs 999–1004, skips unchanged valuation
  marks, closes two recenter epochs, retains a smaller second carry correctly,
  checks full indexed events, incomplete coverage, replay, missing references,
  stable reorg invalidation and unstable-provider rejection.
- A disposable copy of all six actual paper campaigns consumed the real
  read-only production indexer and canonical RPC evidence. Seven complete fee
  intervals produced NAV, fees, cost bounds and passive comparison for all six,
  including the existing recenter and conversion close.
- Sealed API and Chromium checks passed at desktop 1440 and mobile 390 pixels,
  including closed history, visible modeled economics, no horizontal overflow
  and no browser exceptions. Runtime adoption of all five active campaigns
  preserved every historical mark on the disposable copy.

Paper-only source is committed on local branch
`rangekeeper-paper-economics-20261003`: `6779825`, `77a53cd` and `1452e6d`.
The deployed sealed release is
`aebd50962ac487007925f8c2badda1045deb96ae4bd95398df172415cedf3ed7`.
It preserves the production Node and Anvil binaries and requires no migration.
The main checkout retains the separate ongoing live work and unrelated changes.

## Production rollout

A consistent full backup, archive listing and SHA256 are retained privately at
`data/backups/rangekeeper-paper-economics-20261003/`, alongside deployment-table
backups taken after stopping the paper services. Only dashboard, deployment
command and paper worker units were replaced. All three are active and pinned
to the final sealed release. All five active campaigns received guarded,
append-only runtime adoption; historical mark fingerprints were unchanged.
Production schema stays v11, registry count stays 12, and live campaign/profile
fingerprints were preserved. No DDL, live signing, broadcast or activation was
performed; both RangeKeeper and live-pilot live services remain inactive.

Production fee replay has demonstrated complete current economics for the
individual campaigns. New observations sometimes lead indexer coverage; the
30-second cursor settle bound can expire and current economics remain unavailable
until a later pass. A catch-up pass now skips a new observation, exposing its
completed endpoint. This does not guarantee that all six latest rows are
simultaneously complete at every instant. No stale economics are silently
carried into a newer mark, and historical skipped minute marks stay blank.

Final production verification passed on the actual dashboard/command services:

- API observation saw modeled NAV, fees, passive comparison and cost bounds for
  every one of the six campaigns. At the final snapshot four latest rows were
  complete and two newer observations awaited coverage. These are separate
  verified snapshots, not a claim of simultaneous permanent completeness.
- Chromium at 1440 and 390 pixels showed modeled net value and modeled execution
  cost bounds, no horizontal overflow, working closed history and zero browser
  exceptions. Both service health endpoints returned HTTP 200.
- Actual readiness lock `[4663,18728]` was held once. All three running unit paths
  point to `aebd509...`; both live execution services stayed inactive.

Evidence: `/tmp/conc-liq-rk-economics-browser-production-20261003.log` and
`/tmp/conc-liq-rk-economics-api-after-20261003.json`, with copies retained in the
private backup directory. Disposable qualification databases were removed after
verification. The local paper-only branch retains the reviewed source commits;
unrelated main-checkout live work remains intact.

Next delivery work is gates 2–4 in the live plan: connect dashboard admission,
automatic recenter plus retain-only exit, and qualify/release that complete
workflow with receipt-attributed Positions values. Funding and bounded live
activation require the concrete wallet/campaign limits decision after release
qualification.

## Last-complete-valuation display correction

The indexer/accounting lag was a display gap: a newer raw mark could hide valid
economics already recorded for the held position. The fallback selects only an
earlier mark in the same campaign revision and holding epoch, with unchanged
ticks/liquidity, eligible source-bound independent references, valid accounting,
ordered source/mark identities, and no applicable invalidation. It retains the
newest operational source. The UI names the earlier economic valuation time and
pending current accounting; historical chart gaps are not filled and prices are
not made eligible for new trading decisions.

The isolated deployed-commit worktree passed 1,081 tests, typecheck, read-only
v11 clone projection, five guarded runtime adoptions with unchanged historical
marks, and actual sealed API/browser checks at 1440 and 390 pixels. The release
manifest changes only the projection, dashboard explanation, and an inert test
cache file. Worker/kernel, Node, Anvil, and environment bytes are unchanged.
Repository reproduction validation on the detached worktree still lacks an
approved local archive object; this is recorded rather than bypassed.

Production rollout used a fresh full consistent backup and stopped deployment
data backup in `data/backups/rangekeeper-paper-economics-fallback-20261003/`.
The paper worker exhausted its normal 45-second shutdown bound; its process and
control group exited before the stopped backup and guarded adoption. All five
active campaigns adopted the sealed identity without changing historical marks.
Dashboard, deployment command, and paper worker now run the same new release;
all are active, health is HTTP 200, and the paper readiness lease is held.
Schema stays v11; market-profile and live-campaign fingerprints are unchanged.
Both live execution units remain inactive. No live migration, funding, signing,
broadcast, or activation occurred.

Actual production browser/API evidence:
`/tmp/conc-liq-paper-economics-fallback-production-browser-20261003.log` and
`/tmp/conc-liq-paper-economics-fallback-production-current-20261003.json`.
The browser found all six modeled NAV/fee/passive/cost values, closed history,
no horizontal overflow at both sizes, and no exceptions. Evidence and unit
snapshots are retained with the backup. The primary dirty checkout is preserved.

A further actual production check observed three newer unaccounted marks while
all six campaigns retained economics. Desktop and mobile detail both displayed
the last complete economic timestamp and the current mark's pending accounting,
with no overflow or exceptions. Evidence:
`/tmp/conc-liq-paper-economics-fallback-pending-browser-verified-20261003.log`.
Both disposable qualification databases and private temporary fork/browser
environment files have been removed; the sealed source worktree is retained.
