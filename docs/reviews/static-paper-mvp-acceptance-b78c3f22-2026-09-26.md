# Static/manual paper MVP candidate acceptance — September 26, 2026

Authority: [revised plan, section 12](../plans/research-and-positions-sol-2026-09-21.md#12-september-26-mvp-review-and-sol-delivery-order).
Scope is static/manual paper. RangeKeeper, new live deployments and full W2
remain open. This review does not authorize a production cutover.

## Exact runtime and external test inputs

- Runtime source: `609e68feb95afd32ed3dd6df0ce0ec3ba15e9575`.
- Build: `b78c3f22bd0ffa11f5bf7f72cbcd0388464a65aac4b4f3c0d2e2af80d94dc9f3`.
- Artifact: `/tmp/conc-liq-static-mvp-releases-20260926/` plus the build ID.
- Node: bundled `v24.20.0`; its own `launch.mjs --verify` passed.
- External conversion harness: `633566a954e49e02e0c5833caa8ee4381ef240e6`.
  This later commit changes only the plan and test drivers. Runtime code and
  artifact bytes remain those of the clean reviewed runtime source.

The harness supplies disposable PostgreSQL schemas, a verified supported profile,
explicit paper allocation, operator authentication, local browser controls,
private temporary environment files, and a read-only pool using canonical public
replay data. The sealed command/worker execute server-owned setup, cost sampling,
preview/admission, canonical maintenance and terminal booking. Drafts and V2
predecessor snapshots are not manually seeded in the browser runs. A 2-USDG
token budget and explicit 10-native allocation are separate inputs; starting NAV
includes both. No signer is loaded and no chain transaction is broadcast.

## Critique and corrections

The revised plan correctly prioritized complete operator workflows over expanding
unfinished strategy paths. Actual process tests found defects that isolated
booking tests had missed:

1. Worker readiness, maintenance and preparation leases exhausted a three-client
   indexer pool before fee replay could acquire its client. The bounded pool now
   has four clients, preserving all leases and evidence gates.
2. Numeric identifiers were sometimes ordered through text aliases. Ordering is
   qualified numerically; a real-store 8/9/10/11 regression passes and fails on
   the baseline.
3. Ordinary maintenance stopped after V1 accounting caught up, while V3 admission
   requires a runtime-bound V2 predecessor. Maintenance now projects both versions
   within its existing budget. A real-store regression removes manual V2 priming
   and proves bounded continuation, resume and V3 admission.
4. The original 2000-USDG conversion fixture exceeded the existing 1% sampler
   share guard. The supported fixture uses 2 USDG; the guard and width are unchanged.
5. The unit renderer injected a worker flag that the sealed launcher strips.
   Activation is now explicitly configured in the private environment file and
   therefore included in the runtime config hash.

External browser assertions also require the expected runtime source and inspect
exact modeled ledger bindings, terminal withdrawal inventory, post-conversion V3
inventory, fee predecessor/terminal distinctions and native balances. Counts alone
are insufficient evidence of correct economic booking.

## Acceptance evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| Clean source checks | Passed: repository/type checks, 876/876 tests, 85 suites | `/tmp/static-mvp-check-609e68f-20260926.log` |
| Isolated integration and bounded maintenance | Passed; synthetic canonical anchors are explicit | `/tmp/paper-maintenance-v2-full-integration-20260926.log`; `/tmp/paper-maintenance-v2-v3-restore-20260926.log` |
| Manifest and offline units | Passed; 13 units rendered, not installed; prototype/preview excluded | `/tmp/static-mvp-release-build-609e68f-20260926.log`; `/tmp/static-mvp-render-units-609e68f-20260926.log` |
| Canonical sealed retain | Passed: actual browser setup/open/valuation/pause/resume/retain, one terminal mark, no paid gas | `/tmp/static-paper-retain-browser-609e68f-sealed-20260926.log` |
| Canonical sealed conversion | Passed: one V3 terminal/snapshot, three exactly matched modeled capital-out records, no paid gas | `/tmp/conc-liq-review-evidence/canonical-convert-sealed-609e68f-633566a-20260926.txt` |
| Canonical economic restart and same-key expiry recovery | Pending actual result | `/tmp/conc-liq-review-evidence/canonical-convert-recovery-sealed-609e68f-633566a-20260926.txt` |
| Restore of that restarted campaign | Pending actual result; synthetic mechanics do not substitute | Same recovery log |
| Changed accepted anchor after restart | Pending actual result; injected RPC response, not observed chain reorg | Separate negative process gate |

Both ordinary exit campaigns passed desktop 1440/mobile 390 history checks and
visual inspection. Retain campaign `c3f8e9b5-519d-487a-aa46-2d0a0078e8dc`
closed via operation `fa8ccea8-168b-41fb-9cce-42228d965834`; conversion campaign
`950e046e-2c9b-4a15-b0fb-c5cc7c191ff2` closed via operation
`6462e863-015f-4c57-9a33-6e68a465d900`. Retain inventory remains principal lower
bounds with complete custody/costs unavailable. Conversion inventory and costs
are provisional modeled outcomes, not paid execution or validated alpha.

## Operator cutover boundary

The [runbook](../operations/static-paper-mvp.md) and
[concrete cutover proposal/inventory](static-paper-mvp-cutover-inventory-2026-09-26.md)
describe private loopback command/worker configuration, explicit worker opt-in,
approved fork source, backup, 1–3 to 11 migration without a new baseline,
profile registration, rendering, ownership and rollback gates.

The proposed private environment remains absent; units were not installed.
Production schema/campaign visibility, predecessor custody and execution ownership,
and old-reader compatibility still need evidence. Exact production migration,
profile-registration and service changes need authorization. Passing disposable
paper rehearsals does not establish those operational facts.
