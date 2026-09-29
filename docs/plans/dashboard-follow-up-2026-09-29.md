# Dashboard follow-up checkpoint — September 29, 2026

Authorized after the first five findings and the R7 release gate were deployed
as sealed build `463e2eef…`. The source baseline is `494223e`. Findings refer to
[the test report](../reviews/dashboard-test-report-2026-09-29.md).

## Parallel implementation

| Owner | Findings | Scope and acceptance |
| --- | --- | --- |
| Luna economics | 7, 11, 9 | Research models the selected capital (default 250 USDG), agrees with setup, and recomputes liquidity share using integer arithmetic. Native allocation exposes bounded headroom without bypassing fresh preflight. Research retries and refreshes with honest age and unavailable states. |
| Luna Positions | 10, 12 | Either aged/invalid source or server stale evidence consistently degrades current positions and their displayed figures. Historical closure remains distinct. Verify actual persisted accounting values. First-run empty state differs from filter miss, shows absent totals honestly, and leads to setup. |
| Luna delivery | 6, 8 | Compact Research summary and selected-pool detail preserve snapshot identity and economics. Measure transferred bytes and query cost. Prepare exact index DDL and rollback; benchmark in isolation. |

The economics agent owns `research.ts`, `research.js`, and `tabs.js`; delivery
owns repository/server routing; Positions owns `app.js`, shared markup/styles,
and existing dashboard browser harnesses. API changes are agreed between the
first two owners before integration. The coordinator owns this plan, package
commands, long-duration/scaling acceptance and final review.

## Acceptance sequence

1. Focused regression tests cover the changed contracts, budget-dependent ranking,
   fresh preflight, independent stale signals and unavailable values.
2. Run repository checks, typecheck, full unit suite, and dashboard browser suites.
3. Seed 1, 10 and 50 paper campaigns with persisted accounting and 168-hour
   detail evidence into an isolated schema. Measure response and render time,
   polling overlap, and operator input preservation (P4/P5).
4. Run a real two-hour browser soak with heap/DOM/listener samples, visible and
   hidden periods, and database request timing (R2). Include an hour beside an
   isolated paper-worker loop and report dashboard connection/statement costs
   and worker latency (P6). Distinguish an idle worker from economic completion.
5. Record durations, source/artifact identity, raw evidence and cleanup. A short
   smoke run does not satisfy the long-duration gates.

Production DDL is excluded from this batch. The prepared index change must be
reviewable, with measured evidence and rollback, before asking to apply it.
Preserve the public operator boundary and all unrelated `.claude/` work. No
funding, signing, broadcasts, or production campaigns are part of acceptance.
Stop at the completed checkpoint; broader strategy work remains deferred.


## Completed checkpoint

Source `aa64bd9` produced sealed candidate `ec686132…`. Repository/type checks
and 948 units passed, followed by sealed risk integration, 46 usability checks,
42 reliability checks, nine Research browser cases and 17 asset comparisons.
The real 120.003-minute soak completed at 14:14:54 UTC with both duration gates
qualified, 50-position scaling measured, bounded heap/DOM/listener samples and
fixture cleanup verified. Detailed measurements and limits are in the
[follow-up review](../reviews/dashboard-follow-up-2026-09-29.md).

Stop here. Production remains on `463e2eef…`. Next scoped work is review of the
prepared index and current campaign/runtime compatibility before any authorized
DDL or coordinated cutover. Production now has an existing campaign, so the
previous zero-campaign deployment procedure cannot be reused without review.
Text selection/chart focus and hidden Positions polling remain recorded backlog.
