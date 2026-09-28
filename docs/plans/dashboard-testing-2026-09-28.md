# Dashboard test plan — 2026-09-28

Recorded from the checkout at `4004830` against the running deployment. This is
a test plan and an observation record, not an acceptance, a cutover or a
authorization to change the dashboard. Nothing here was executed against
production write paths.

## Observed baseline

`npm run check` passed from this checkout: 920 tests, 85 suites, zero failures,
plus repository boundary, script registry, research manifest, reproduction and
pruned-artifact checks and TypeScript, exit code 0 in roughly 48 seconds. The
toolchain is the pinned `/root/conc-liq/.tools/node/bin` Node v24.20.0; `npm`
is not on the default `PATH`.

The working tree, `main` at `4004830` and both deployed web services serve
byte-identical dashboard assets. `dashboard/app.js`, `tabs.js`, `styles.css`,
`research.js`, `index.html`, `deployment-actions.js` and `operator-session.js`
hash the same in the tree and in release
`376dc50b509a276dd3ce61ef95228effd6fc0ce3f2174c6869e8eebfb58f2a85`, and the
dashboard service on 4173 and the command service on 4174 return the same bytes
for each shared asset. Testing this checkout is therefore testing the deployed
user interface. No commit after `27690c9` touched `dashboard/`, `src/dashboard/`
or `src/deployments/`.

`conc-liq-dashboard`, `conc-liq-deployment-command`,
`conc-liq-paper-operation-worker`, `conc-liq-tail` and `conc-liq-rpc-health`
were active. Read-only measurements taken from loopback:

| Surface | Payload | Time | Note |
| --- | --- | --- | --- |
| `/healthz` | 15 B | 1 ms | |
| `/api/positions` | 3.8 KB | 26 ms | three closed live positions, zero paper |
| `/api/dashboard` | 60 KB | 441 ms | seventeen serialized queries, pool max 4 |
| `/api/research` | 2.96 MB | 16 ms cached | `pools` is 99.4 percent of the payload |

Six parallel `/api/positions` reads stayed between 35 and 54 ms. The research
cache holds for `RESEARCH_REFRESH_MS` (300 s default) and its cold build is
documented in `src/dashboard.ts` as taking seconds; it is prefetched at start.

The deployment paper tables were deliberately reset today at 15:02 with a
retained `pg_dump` under `data/dashboard-paper-reset-2026-09-28/`.
`deployment_campaigns` and every related deployment table are at zero rows. The
dashboard is therefore in a genuine first-run empty state, which is the state a
new operator sees. The three positions still visible are closed live and
RangeKeeper history.

The public surface is a Tailscale Funnel: `/` proxies 4173, and `/api/`,
`/tabs.js` and `/operator/` proxy 4174. Passwordless operator access is an
explicit recorded decision in
[`static-paper-operator-funnel-2026-09-27.md`](../reviews/static-paper-operator-funnel-2026-09-27.md)
and is not reopened by this plan.

## Ground rules

- Production deployment tables stay empty and untouched. They were reset hours
  before this plan was written. No test writes through 4174. Read-only `GET`
  requests against 4173 and 4174 are permitted.
- Stateful tests use an isolated database and synthetic canonical frames, the
  pattern `test/integration/dashboard-setup-command-browser.mjs` already
  establishes: headless Chromium over raw CDP, with real PostgreSQL, real
  command HTTP routes, real session and CSRF handling and real saved state.
- Performance work does not copy the database. The retained
  `paper-records.dump` is 21 MB of deployment, paper and RangeKeeper records
  only; it does not contain the canonical tables that make the research and
  snapshot queries expensive. The canonical volume (6.1 M `v3_pool_events`,
  665 k `v3_strategy_pool_checkpoints`) lives in a 14 GB database on a host
  with 27 GB free, so a full restore is not viable. Canonical tables are
  reached read-only through `postgres_fdw`, the pattern the sealed review
  harnesses already use, with deployment tables isolated in a private schema.
  Wall-clock figures for the live read paths are taken against the read-only
  service on 4173 during a quiet window, never through 4174.
- New `test/integration/*.mjs` files need no registry entry. Any new top-level
  `scripts/*.mjs` does, because `validate-script-registry.mjs` hashes them.
- Every track reproduces the green baseline first and records the exact command,
  exit code and counts with its evidence.

## Track 1 — Usability

Whether an operator can decide and act correctly under time pressure.

| ID | Test | Method | Pass criterion |
| --- | --- | --- | --- |
| U1 | First-run empty state | Load `/operator` against an empty deployment schema, which is today's real state | Expected to fail as built. With zero positions and no filter applied, `renderSection` in `dashboard/app.js:62` renders "No matching current positions — Try another asset or status" with a Clear filters button. A first-run operator is directed to clear filters they never set, instead of to Set up a position. |
| U2 | Instrumented task cost | Extend the CDP harness to count clicks, keystrokes, scroll distance and elapsed time from load to saved draft to fresh preview to accepted open, at 1440 px and 390 px | A recorded budget that later changes must break. The existing harness asserts presence only and never measures effort. |
| U3 | Keyboard-only and accessibility semantics | `Accessibility.getFullAXTree`; arrow-key tab navigation; `<dialog>` focus trap, Escape and focus return | Every actionable control is keyboard reachable, and every dynamically mounted action control carries an accessible name identifying its campaign and asset. With several campaigns the page presents repeated identical "Close · retain tokens" names. |
| U4 | Destructive-action distinguishability | Adjacent retain, convert and pause roots, and draft deletion | Confirmation copy names the campaign, the asset and the irreversible part; retain and convert are not confusable by adjacency or label shape. This is the highest-consequence interface risk in the application. |
| U5 | Number and unit formatting | Unit tests beside the existing `test/dashboard-*.test.ts` | Fees below one cent; `fees === 0n` with nonzero cost; `costToFee` hundredths rounding; `formatSetupTokenAmount` with absent decimals; the U+2212 minus; and `formatSetupCreatedAt` across the 2026-11-01 EDT to EST boundary. |
| U6 | Staleness propagation | Source age beyond 180 s, `source_stale` and `source_unavailable` | Every figure derived from a stale source is visibly degraded, not only the status line. Today `condition()` appends one suffix while value, P&L and fee figures still render with full confidence. |
| U7 | Error legibility | Force `invalid_position_request`, `position_not_found`, `dashboard_read_source_unavailable`, `origin_mismatch`, `csrf_mismatch`, `authentication_required`, `paper_setup_draft_list_unavailable` and `request_too_large` | The operator reads an actionable sentence. `dashboard/operator-session.js` rethrows `data.error` verbatim, so raw identifiers are expected to surface. |

## Track 2 — Reliability

Whether the dashboard stays truthful when its dependencies do not.

| ID | Test | Method | Pass criterion |
| --- | --- | --- | --- |
| R1 | Degraded dependency matrix | PostgreSQL stopped; PostgreSQL slow behind a delaying TCP proxy; research 503; command service stopped; worker lease absent; stale indexer cursor; clock skew | The page stays readable, names the fault and recovers without a reload. The refresh timer is rescheduled in a `finally`, so the poll survives errors; the open question is whether the banner clears on recovery. |
| R2 | Long-uptime leak and drift | A tab held open two to four hours against a fixture database, with `Performance.getMetrics` and heap snapshots | Bounded heap, DOM node count and listener count. The `details` and `requests` Maps and the `mountedActionRoots` WeakSet are the candidates. The same run quantifies the database work spent while the tab is hidden, since the poll has no visibility gating. |
| R3 | Session contention | The command server holds sessions in an in-memory Map capped at 32 with first-in eviction, and `POST /api/session` is reachable unauthenticated from the public Funnel origin | Thirty-two handshakes from other clients must not silently evict an operator mid-review. The single renew-and-retry path on 401 in `operator-session.js` is the only mitigation; prove it covers a pending draft save, and that public crawling cannot lock the operator out. |
| R4 | Concurrency and idempotency through the interface | Double-clicked acceptance; two tabs accepting one campaign; acceptance followed by immediate reload; acceptance racing the worker lease | Server-side campaign locking is already covered by `test/integration/setup-draft-delete.mjs`. The untested path is the interface: a losing attempt must reach a coherent state rather than a stuck control. |
| R5 | Reload during a pending operation | `#pending-open-recovery` and `#pending-paper-acceptance-recovery` | Both pending states survive reload, and the retry control is idempotent across repeats. |
| R6 | Connection pool exhaustion | The dashboard pool is `max: 4` and `/api/dashboard` holds a repeatable-read transaction for roughly 441 ms | One, two, four, eight and sixteen concurrent readers against p95 latency and error rate, with no request starved past the 20 s `AbortSignal.timeout` in the browser. |
| R7 | Cross-service asset coherence | The Funnel mixes origins: the page and `app.js` come from 4173 while `tabs.js` comes from 4174 | Shared assets must be byte-identical across both services. They are identical now; a single-service rollout would publish a page with mismatched ES modules. This belongs in the release gates as a two-line check. |

## Track 3 — Performance

| ID | Test | Target |
| --- | --- | --- |
| P1 | Research payload budget | 2.96 MB of JSON across fifteen pools. Measure parse and first render under fourfold CPU throttling and emulated 4G, then set an interactive budget and decide on trimming or pagination. |
| P2 | Cold research build | Time `buildResearch()` against the canonical tables through the read-only foreign-table attachment; confirm the `researchInFlight` single-flight guard prevents a thundering herd; weigh the 300 s cache against the freshness an operator expects. |
| P3 | Snapshot query profile | Instrument the seventeen sequential awaits in `DashboardRepository.snapshot()` and run `EXPLAIN (ANALYZE, BUFFERS)` on the three slowest. `/api/dashboard` has no consumer besides `/legacy`, but the Wave 0 findings show it carries the asset eligibility evidence the current interface lacks, so it must not simply be removed; the 441 ms belongs to a payload that should be reaching the operator. |
| P4 | Campaign-count scaling | Seed one, ten and fifty campaigns with 168-hour detail windows and find where a ten-second poll stops keeping up. |
| P5 | Render cost and state preservation | With fifty positions, measure layout and recalculation cost per refresh. `renderSection` rewrites whole-section `innerHTML` every ten seconds; action roots and the RangeKeeper receipts state are preserved, but scroll position, focus, `<details>` state and text selection are not verified. Losing focus while typing would be disqualifying. |
| P6 | Footprint beside the worker | The dashboard's share of connection-seconds and statement time over an hour while the tail and paper worker run. The dashboard must not degrade the campaign worker. |

## Track 4 — Fitness for RWA LP management

Scripted decision scenarios against fixture campaigns. Each question is scored
as answered on the first screen, answered after a drilldown, or not answered,
with the interaction count. The output is a scored matrix and a prioritized
backlog, not a pass or fail.

| ID | Operator question | What is checked |
| --- | --- | --- |
| D1 | Am I earning, net of costs? | Fees, gas, swap, the cost-to-fee multiple and the passive-inventory comparison share one unit and one lifetime window, and no screen implies modeled paper costs were paid. This is the ranking basis the project already committed to. |
| D2 | Is my range still right, and how long do I have? | Partly answered already; see the Wave 0 findings. `positionWindow` computes `inRangePercent` per market session and the Market sessions table renders it as the default detail tab. What is absent is distance to each boundary in price and in ticks, and any drift-implied time to exit. Test the altitude question: in-range percentage is a drilldown, never a row or triage signal. |
| D3 | Is the market open, and is my reference trustworthy right now? | Confirmed gap; see the Wave 0 findings. Live per-asset eligibility is collected and fresh but is rendered only on `/legacy`. Test that a closed equity session, a pending corporate action, a paused oracle or a stale feed reaches the operator on the page actually in use, before any acceptance. This is the largest RWA-specific gap. |
| D4 | Can I get out, and what will it cost? | Native exit reserve against the close and convert bounds, warned at setup rather than at close. This is the recorded MVP-6 headroom gap; a test keeps it from regressing further. |
| D5 | What happened, and can I prove it? | A receipt or evidence trail reachable from each row. RangeKeeper has a receipts list; static and manual parity is unverified. |
| D6 | Where does the next 250 USDG go? | Research ranks pools on net-of-cost fee capture at the operator's actual capital and half-width, and continues to read as modeled rather than as an execution recommendation. |
| D7 | Cross-check against the canonical pipeline | Reconcile one closed campaign's dashboard row against `deployment_paper_accounting` and the accounting snapshot to the raw unit. A self-consistent dashboard proves nothing; this is the test that gives the other tracks meaning. |

## Sequencing

0. Baseline and state capture. Complete: the check is green, the deployment
   state is recorded above, and the tree matches the deployed release.
1. Unit-level formatting and staleness work: U5, U6, U7 and the D1 formatting
   assertions, landing beside the existing `test/dashboard-*.test.ts` files.
2. Browser harness extension: U1 through U4, R3 through R5, and the D2 to D4
   presence checks, against an isolated database with synthetic frames.
3. Performance laboratory: attach the canonical tables read-only, seed an
   isolated deployment schema from the retained 21 MB dump, and run P1 through
   P6 with CPU and network throttling.
4. Fitness review: the D1 through D7 scenarios, producing the scored matrix.
5. Gate adoption: fold R7 and the P1 and P3 budgets into the sealed-release
   gates already in use.

Tracks 1, 2 and 4 are correctness-shaped and tolerate a busy machine. Track 3
measures wall-clock time on a shared host and must run alone, after a restore
that is itself a serial prerequisite.

## Parallel execution

The host has six CPUs, roughly 4 GB of available memory, 27 GB of free disk and
PostgreSQL `max_connections` of 100 with 13 in use. A browser harness run costs
a headless Chromium, a Node process and a small connection pool. Memory, not
CPU or connections, is the binding constraint, so three concurrent harness
agents is the realistic ceiling.

Tracks 1, 2 and 4 can run concurrently. Each agent works in its own git
worktree and owns new files only; no agent edits an existing
`test/dashboard-*.test.ts`, because several tracks would otherwise touch the
same files. A worktree does not carry `node_modules` or `.tools`, both of which
are ignored, so each agent symlinks them from the primary checkout before
running anything. Each agent generates its own `dashboard_<track>_<uuid>`
schema, as the existing harness does, and drops it on exit; leaked schemas from
a crashed agent are checked for afterwards.

Track 3 runs alone. It measures wall-clock time on a shared host, so a
concurrent agent invalidates it. Two nominally Track 2 tests move into the same
serial slot for the same reason: R2, the long-uptime soak, and R6, pool
exhaustion under concurrent readers.

Parallel execution raises the production-safety cost of a mistake, because more
processes hold shell access while live services run. Every agent is constrained
to: no writes through the command service on 4174, no `systemctl`, no `psql`
against the public deployment tables, and no command that starts or restarts a
service. After any parallel phase the deployment campaign count is verified to
be unchanged.

## Expected findings

Wave 0 has since been executed and is recorded below; it confirmed D3, partly
refuted D2 and reversed the P3 recommendation. The remaining expectations,
ranked by consequence rather than by discovery cost: U1, the misleading empty
state, and U3, indistinguishable close controls, are interface defects. R3, the
32-session first-in eviction on a public Funnel, and P1, the 2.96 MB research
payload, are the reliability and performance items most likely to be felt
first.

## Wave 0 findings, 2026-09-28

Executed inline against the running deployment with read-only requests. No
write path was used and the deployment tables remained at zero rows.

### D3 confirmed: asset eligibility is collected, fresh and stranded

`riskAssets` in `src/dashboard/repository.ts:1085` reads the latest
`asset_risk_snapshots` run and returns, per RWA symbol, `marketHours`,
`corporateActionPending`, `tradingCapabilitiesTradable`, `oraclePaused`,
`oracleAgeSeconds`, `executionEligible`, `registryStatus`, multiplier
consistency and a `reasons` array. `asset_risk_snapshots` holds 563,093 rows
and is actively written.

That evidence is served on `/api/dashboard`, which is rendered only by
`dashboard/legacy/app.js`. The current interface never requests it: `app.js`,
`tabs.js`, `research.js`, `deployment-actions.js` and `index.html` contain no
reference to `/api/dashboard`, and the `/api/positions` payload contains none
of `eligible`, `marketHours`, `corporateAction` or `tradingTradable`. The only
`eligible` identifiers in `app.js` are the lifecycle-control predicate at
line 44 and the adaptive-paper reference flag at line 133; neither is execution
eligibility.

At the time of writing, all seven tracked RWA assets read
`executionEligible: false`. AAPL, NVDA and QQQ cite `sequencer_feed_unavailable`
and `quote_oracle_unavailable`; GOOGL and MSFT add `oracle_price_stale` at
2,816 s and 617 s of oracle age; GLD has no oracle feed at all. An operator
reading the current dashboard is shown nothing about any of this. The finding
is not that the data is missing but that it is one page away from the person
who needs it.

### D2 partly refuted: session attribution is already good

My earlier characterisation was wrong and is corrected here.
`src/dashboard/position-performance.ts` is market-session aware through
`sessionSegments` and `marketSession`, and `positionWindow` buckets every
interval into market, premarket, non-market, boundary and unobserved groups.
Each bucket carries `hours`, `activeHours`, `inRangePercent`, net P&L, alpha
against holding, fee income, gas, swap cost, recenter and swap counts and
`returnBpsPerHour`.

The interface renders this as the Market sessions table, which is the default
detail tab, with an In range column, an estimated APY column carrying an
explicit not-a-forecast note, and a methodology dialog. The chart shades
session bands. Time in range is therefore present and reasonably presented.

What remains genuinely absent is distance to either boundary, in price or in
ticks, and any drift-implied time to exit. The detail aside shows absolute
lower and upper bounds, a `rangeState` string and the pool price, leaving the
operator to subtract. The open question for testing is altitude rather than
existence: in-range percentage requires selecting a position and reading a
table, so it cannot serve triage across several campaigns.

### D6 confirmed in form, quantified as a sizing mismatch

The research league table ranks on `net`, net of costs, descending by default,
which is the basis the project committed to. The columns are pool, exact swaps,
volume, LP fees, your share, in range, modeled fees, net of costs, APR and
gate-valid.

`modeledNetQuote` is `modeledFeesQuote - roundTripQuote`. Modeled fees scale
with the position's liquidity share; the round trip is flat. Both the ranking
column and APR are computed against `RESEARCH_BUDGET_QUOTE`, a fixed 1,000 USDG
reference, while the setup form defaults to 250 USDG and admits 1 to 10,000.
The research page carries no capital control, only window and half-width.

Measured from the live snapshot at the 24-hour window and the third half-width,
with a round trip of 2.32 USDG:

| Pool | Gross at 1,000 | Net at 1,000 | Net at 250 |
| --- | --- | --- | --- |
| AAPL/500 | 2.85 | +0.53 | -1.61 |
| GOOGL/500 | 2.85 | +0.53 | -1.61 |
| NVDA/500 | 2.09 | -0.23 | -1.80 |
| remaining twelve | 1.30 and below | negative | negative |

Two of fifteen pools rank net-positive at the reference size, and both become
losses at the size the setup form defaults to. Break-even gross fee income is
2.32 USDG at the reference and 9.28 USDG at 250 USDG, a factor of four. The
ranking that drives pool selection is therefore computed at a size the operator
does not use, and the two pools that pass are exactly the ones an operator
would choose.

In fairness the page discloses this in prose: it states the reference position,
that it is never rebalanced, that fees are the LP side only, and that net
subtracts one mint and exit round trip. The finding is not concealment. It is
that disclosure sits in a muted paragraph while the decision is driven by a
sorted column, and no control exists to align the two.

### D4 sharpened: the headroom gap already cost a real open

MVP-6 is not hypothetical. The
[strategy plan](research-and-positions-sol-2026-09-21.md) records that the
default native gas suggestion proved too tight when gas was repriced between
setup and open: a real draft stayed unopened with zero operations, and a
replacement completed only after the operator manually entered 0.0011 native
units through the editable field.

`suggestedNativeAllocationWei` computes open plus the greater of close and
reserve, which carries no margin against the one input guaranteed to move
between setup and open. The D4 test should assert both halves of MVP-6: that a
headroom factor exists in the suggestion, and that an insufficient allocation
is reported legibly at the point of failure.

### D1 provisional: internal coherence holds on real data

The one completed live RangeKeeper campaign reports 1.857850 USDG of fees
against 0.912659 gas and 1.135344 swap, so costs are 2.048003 against fees of
1.857850. The cost-to-fee metric renders 1.10x with its negative styling, net
P&L is -1.186705 and the comparison against holding is -1.178417. The campaign
lost money net of costs and the interface says so without softening it. Modeled
and paid values stay labelled distinctly. D5 and D7 remain open.

### D7 passes: the accounting reconciles

Reconciled the one closed live RangeKeeper campaign's session attribution
against its lifetime totals at the one-week window, in raw six-decimal units:

| Quantity | Lifetime | Sum of session rows | Difference |
| --- | --- | --- | --- |
| Net P&L | -1,186,705 | -1,186,705 | 0 |
| Swap cost | 1,135,344 | 1,135,341 | 3 |
| Paid gas | 912,659 | 912,633 | 26 |
| LP fees | 1,857,850 | 1,848,727 | 9,123 |

Net P&L reconciles exactly. Gas and swap differ by 26 and 3 raw units, which is
0.0026 and 0.0003 of a cent. Fees differ by 9,123 raw units, about nine tenths
of a cent, which is worth one follow-up but is immaterial to any decision.
Covered hours reconcile exactly at 30.864 against a campaign duration of
30.864, with no recorded gaps across 3,338 marks.

The reconciliation only closes when the `mixed_boundary` bucket is included. It
carries zero hours but a net P&L of 197,537 and fees of 18,857, and it exists
precisely so that movement across a session boundary is not silently dropped.
A first reading here filtered it out and manufactured a 0.198 discrepancy that
does not exist; the design is correct and the earlier reading was not.

That bucket does expose a latent inconsistency between the two table renderers.
`renderBottom` includes a zero-hour bucket whenever any value is non-zero or
null, so the boundary interval appears. `renderDeploymentBottom` filters on
`b.hours>0||b.activeHours>0||modeled&&(...)`, so for a deployment position that
is not modeled the third clause never runs and a zero-hour bucket carrying real
P&L is dropped from the table. Today this is masked, because a non-modeled
deployment renders every economic column as an em dash anyway. It becomes a
live defect the moment paid-cost evidence lands for deployments while `modeled`
remains false.

### D5 fails: recorded evidence is unreachable past one week

The detail endpoint windows both marks and events to the selected chart period,
and the selector offers only 1, 6, 24 and 168 hours. Measured against the three
closed live positions in production:

| Position | Ended | Events at 24h | Events at 168h |
| --- | --- | --- | --- |
| `live-rk-31802d63` | 2026-09-23 | 0 | 54 |
| `live-rk-470e5f84` | 2026-09-22 | 0 | 20 |
| `live-f8affe19` | 2026-09-15 | 0 | 0 |

Two consequences, both current. First, at the default 24-hour window every
closed position in production opens to an empty Activity tab, an empty session
table and an empty chart, directly beside a row that displays complete
economics. The operator is shown a number and, one click later, nothing that
substantiates it. Second, `live-f8affe19` ended thirteen days ago, so its
evidence is unreachable at every window the interface offers, while its row
still reports 276.295 of initial capital and a closed lifecycle. The
RangeKeeper receipts panel compounds this by capping its list at the latest
five of fifty-four.

For a system whose entire discipline is retained, replayable evidence, the
interface cannot answer what happened for anything older than a week. This is
the D5 verdict and it is a defect, not an altitude question.

### Track 1a results

Sixteen unit cases landed in `test/dashboard-usability-format.test.ts`,
integrated onto main and verified independently here: `npm run check` passes
936 tests, 85 suites, zero failures, exit 0.

U7 is confirmed as suspected. Every recognised server error reaches the caller
as a bare identifier, because `rawRequest` returns `data.error` with no
translation layer; only the unrecognised fallback produces a sentence. A 503
`dashboard_read_source_unavailable` and a 403 `csrf_mismatch` are
indistinguishable in shape to any caller, so severity is not conveyed.

Two further findings came out of that work. `preflight_source_expired` is
emitted both for a stale source and for a future, clock-skewed source, so the
operator cannot tell old evidence from a wrong clock. And
`formatSetupTokenAmount` maps a negative raw amount to the same "Unavailable"
string as a genuinely absent one, so a corrupt server value and missing data
read identically.

U6 is substantially blocked rather than complete. The only staleness rule
reachable from an exported module is the 180-second preflight freshness window
inside `reviewStaticPaperDraftBinding`, which is not the live-data staleness
indicator U6 is about. `dashboard/app.js` has zero exports, so `money`, `units`,
`condition`, `costToFee`, `ageLabel`, `date`, `normalize` and `needsAttention`
are unreachable from unit tests. Completing U6 needs either the browser harness
or an export change, and the export change must be owned by one track rather
than raced.

### Track 1b results

`test/integration/dashboard-usability-browser.mjs` runs 31 checks at exit 0,
re-verified here independently: `npm run check` holds at 936 tests and the
harness leaves the public campaign count at zero with no leaked schemas and no
browser exceptions. It is registered as
`npm run test:integration:dashboard-usability-browser`. Thirteen of its checks
deliberately pin current defective behaviour and are listed in the file header
as checks to invert, not loosen, when each defect is fixed.

U1 is confirmed. With zero campaigns, zero drafts and both filters at `all`,
both portfolio sections render "No matching current positions / Try another
asset or status / Clear filters", byte-identical to the genuine filter-miss copy
verified by setting a status filter and comparing. Nothing mentions setting up a
position. The totals read "Managed value · available 0.00" and "Net P&L · since
start +0.00" from a reduce over an empty list, so a portfolio that does not
exist is presented with real-looking figures. The remedy is cheap: the setup
heading already sits 105 px above the fold at 1440 by 900, so the empty state
only has to point at what is already on screen.

The windowed-evidence case from D5 renders honestly, which is worth recording
as a non-defect. A position whose only mark is eight days old, viewed at 24
hours, reports zero marks, a null covered start, "No covered intervals in this
window", and a chart carrying axes and gridlines with zero data paths. It draws
no phantom series.

U2 records an identical interaction cost at both widths: two clicks, two fields
touched, 45 keystrokes and four interactions that begin off screen. The page is
4,396 px at 1440 and 9,034 px at 390 against a 900 px viewport, so the mobile
path is about ten screens of scrolling, with no horizontal overflow at either
width. The four off-screen interactions are the real cost, not the click count.
The harness's elapsed milliseconds are scripted automation time and are not a
human budget.

U3 is confirmed but narrower than this plan assumed, and the assumption is
corrected here. `lifecycleControls` renders only inside the selected position's
detail panel, so two campaigns never expose close controls at the same time and
there is no same-screen duplication. What is true is that the control names are
byte-identical across two campaigns on different assets — "Review pause",
"Review retain-close", "Review convert-close" — and the accessibility tree
exposes them with no asset and no campaign. Disambiguation exists only in the
detail heading. Keyboard behaviour is correct: the first retain control is
reached in eleven tab stops, the tablist keeps a single roving tab stop and
responds to arrow keys, and the dialog traps focus, closes on Escape and returns
focus to its opener.

U4 is confirmed, and the class-identity half is worse than the report stated.
Retain and convert previews sit adjacent on the same row at y 763, differ by one
word, and differ by 9 px in width, so they are separable only by reading a
single word. Reading `dashboard/deployment-actions.js` directly: the convert
mount gives its preview button and its reconcile button no class at all, and
takes `retain-action-status`, `retain-action-review` and `retain-confirm-button`
for everything else. The two opposite close semantics therefore share DOM class
identity, and the convert path — the one that irreversibly swaps the operator's
tokens to USDG — has no CSS identity of its own anywhere. A selector or style
intended for retain reaches convert as well.

That defect is not theoretical. The agent writing these tests read the lifecycle
status while believing it was retain's, because all three roots publish status
through `retain-action-status`, and had to rescope every read per root and
re-run. The trap caught someone working carefully and deliberately.

### Consequence for the plan

D3 becomes the first implementation candidate, and it is cheap: the evidence,
the query and the rendering precedent all exist. P3 is reversed, because the
441 ms `/api/dashboard` payload is not dead weight to delete but the carrier of
the missing signal.

D5 joins D3 as a first-rank candidate and is the more surprising of the two,
because the evidence is retained and replayable in the database while the
interface cannot reach it. The fix is a window selector that admits a campaign
lifetime rather than a fixed 168-hour ceiling, plus a default window that
accounts for a closed campaign's end date instead of the present moment.

D7 passing is what makes the other verdicts worth acting on: the figures the
interface reports do reconcile to the canonical record, so a gap in the
interface is a presentation gap rather than an accounting one.

The U4 class-identity defect is the cheapest high-consequence fix on this list
and should be taken before the cosmetic half of U4. Giving the convert mount its
own classes costs a few lines, removes a trap that has already misled a careful
reader, and is a precondition for testing the two close paths separately at all.
