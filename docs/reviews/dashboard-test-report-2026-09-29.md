# Dashboard test report — September 29, 2026

Testing of the operator dashboard for usability, reliability, performance and
fitness for RWA liquidity management, against the checkout at `4004830` and the
deployment running sealed build `376dc50b…`. The working tree, `main` and both
web services served byte-identical dashboard assets throughout, so this tests
the deployed interface rather than an approximation.

This is a findings report. The executed plan, the method for each test and the
full observation records are in
[`dashboard-testing-2026-09-28.md`](../plans/dashboard-testing-2026-09-28.md).
Nothing here changed product behaviour: every defect is recorded, not fixed.

## Verdict

The accounting under the dashboard is trustworthy. A closed campaign's session
attribution reconciles against its lifetime totals to the raw unit on net P&L
and to fractions of a cent on gas and swap. Every gap found is therefore a
presentation or delivery gap rather than an accounting error, which is what
makes the rest of this report worth acting on.

The interface's weakest area is not its numbers but what it declines to say. It
holds fresh evidence that every tracked RWA asset is currently ineligible for
execution and does not show it; it cannot reach recorded evidence older than a
week; and it reports a healthy operator connection while the command service is
stopped. Concurrency, idempotency and recovery — the areas most likely to
corrupt state — are sound.

## Coverage

27 planned tests: 22 complete, 1 partial, 4 not run.

| Track | Complete | Partial | Not run |
| --- | --- | --- | --- |
| Usability | U1 U2 U3 U4 U5 U6 U7 | — | — |
| Reliability | R1 R3 R4 R5 R6 | — | R2 R7 |
| Performance | P1 P2 P3 | P5 | P4 P6 |
| LP fitness | D1 D2 D3 D4 D5 D6 D7 | — | — |

Reproduce with `PATH=/root/conc-liq/.tools/node/bin:$PATH` and
`TEST_DATABASE_URL` set:

- `npm run check` — 936 tests, 85 suites, exit 0, including 16 U5/U6/U7 units
- `npm run test:integration:dashboard-usability-browser` — 37 checks, exit 0
- `npm run test:integration:dashboard-reliability-browser` — 40 checks, exit 0

Thirteen usability checks and several reliability checks deliberately pin
current defective behaviour. Each is listed in its harness header as a check to
invert, not loosen, when the defect is fixed.

## Findings, ranked

### Act now

**1. Asset execution-eligibility is collected, fresh, and shown only on the
retired page.** `riskAssets` returns per-symbol `marketHours`,
`corporateActionPending`, `tradingCapabilitiesTradable`, `oraclePaused`,
`oracleAgeSeconds`, `executionEligible` and `reasons` from
`asset_risk_snapshots`, a table of 563,093 actively written rows. It is served
on `/api/dashboard`, which only `dashboard/legacy/app.js` renders. The current
interface contains no reference to that endpoint, and `/api/positions` carries
none of those fields. At the time of testing **all seven tracked assets read
`executionEligible: false`** — AAPL, NVDA and QQQ on `sequencer_feed_unavailable`
and `quote_oracle_unavailable`, GOOGL and MSFT adding `oracle_price_stale` at
2,816 s and 617 s of oracle age, GLD with no feed at all. An operator reading
the dashboard sees none of this. For tokenized equities, whose sessions, halts
and corporate actions govern whether acting is sane at all, this is the most
consequential omission found.

**2. Unrelated public traffic logs the operator out, and eviction targets the
operator by construction.** The command server holds sessions in a Map capped at
32 with `sessions.delete(sessions.keys().next().value)`, which removes the
oldest inserted entry, and `authenticated()` only reads the Map and never
re-inserts. Activity therefore does not protect a session, so the operator — who
has been connected longest — is always first evicted. 34 unauthenticated
handshakes from other clients evicted the operator server-side. The single
renew-and-retry path covers a silent eviction during a pending draft save with
inputs intact, but traffic arriving inside the renewal window logs the operator
out mid-flow. The operator surface is reachable over a public Funnel by recorded
decision, so this traffic need not be hostile or aware of the operator. This is
the one finding that no interface change fixes.

**3. The reconnect control cannot fail.** With the command service stopped,
pressing Retry connection reports "Operator connection ready."
`bootstrap()` returns `Promise.resolve(true)` without a network call whenever a
CSRF token is held, and `loadOperatorDataOnce` awaits a promise that is only
recreated after a failure. A retry that performs no I/O always succeeds, so a
visible outage becomes a silent one until the operator's next real action fails.

**4. Recorded evidence is unreachable past one week.** The detail endpoint
windows marks and events to the selected chart period, and the selector stops at
168 hours.

| Position | Ended | Events at 24h | Events at 168h |
| --- | --- | --- | --- |
| `live-rk-31802d63` | 2026-09-23 | 0 | 54 |
| `live-rk-470e5f84` | 2026-09-22 | 0 | 20 |
| `live-f8affe19` | 2026-09-15 | 0 | 0 |

At the default window every closed position in production opens to an empty
activity list, session table and chart beside a row showing complete economics.
The pilot that ended thirteen days ago has no reachable evidence at any offered
window while its row still reports 276.295 of initial capital. The evidence is
retained in the database throughout. The receipts panel additionally caps at the
latest five of fifty-four.

**5. The two close actions are indistinguishable in the DOM.** The convert mount
gives its preview and reconcile buttons no class at all and takes
`retain-action-status`, `retain-action-review` and `retain-confirm-button` for
everything else, so the action that irreversibly swaps the operator's tokens to
USDG has no CSS identity of its own anywhere. Visually the two previews sit
adjacent at the same y, differ by one word and by 9 px of width. The trap is
demonstrated rather than theoretical: it caused a careful reader to assert
against the lifecycle status while believing it was retain's.

### Act soon

**6. One missing index is 83 percent of a 44-second research build.** The build
was reproduced at 44.7 s and 44.2 s in separate processes. Its dominant query,
36.9 s, looks up `SetFeeProtocol` events and parallel-seq-scans the whole 11 GB,
6.25 M-row `v3_pool_events` table, removing 2,084,283 rows per worker and reading
907,011 shared buffers — roughly 7 GB of I/O — to return 15 rows. The table's
three indexes all lead on `stream_key` with pool or block; **none covers
`event_name`**, and `SetFeeProtocol` is 16 rows against 6,069,696 Swaps. A
partial index confined to non-Swap events would serve this and several other
lookups from a small structure. Creating it is a production DDL change needing
its own authorization; the gain is stated as a projection, not a measurement.
Behind a 300-second cache with no stale-while-revalidate, one request per cache
cycle waits the whole rebuild. The single-flight guard does work and a cached
read returns in 0.1 ms.

**7. Research ranks on the right metric at the wrong position size.** Default
sort is net of costs, which is the committed basis, but `modeledNetQuote` is
modeled fees minus a flat round trip, and both that column and APR are fixed to
a 1,000 USDG reference while the setup form defaults to 250 and the research page
has no capital control. On the live snapshot, two of fifteen pools rank
net-positive at the reference size and **both invert to losses at the default
size**: AAPL/500 and GOOGL/500 move from +0.53 to −1.61. Break-even gross fee
income is 2.32 USDG at the reference and 9.28 USDG at 250, a factor of four. The
page does disclose the reference position in prose, so this is not concealment;
it is that a sorted column drives the decision while the caveat sits in a muted
paragraph.

**8. The research payload is transfer-bound.** Interactive with all fifteen rows
in 141 ms unthrottled, 397 ms at 4x CPU on a local network, **3,310 ms on 4G and
14,642 ms on slow 4G**, almost entirely download of the same 2,660 KiB. Parsing
and rendering cost only about 330 ms of throttled CPU, so trimming the payload is
the only lever that matters; faster rendering would buy nothing. About 99 percent
of those bytes are per-pool bucket series the league table does not show until a
pool is selected.

**9. The research surface never recovers without a reload.** `research.js` calls
`load()` once with no interval, retry or visibility listener, so a 503 leaves
"Research unavailable" until the page is reloaded. Its failure copy says the
snapshot "is built in the background and takes a few seconds after the dashboard
starts", which invites the operator to wait for a recovery that cannot arrive.
The same absence freezes a successful snapshot at page-load time; the server
refreshes every 300 s but the page never asks again, and the only cue is an
absolute "Built" timestamp rather than the relative age Positions uses.

**10. The two staleness mechanisms disagree.** `condition()` appends
"source stale / unavailable" from the server's `p.reasons`, while the degraded
age label is derived in the browser from `age(sourceAt) > 180`. Driven
independently: an age past 180 s alone degrades the label while the condition
reads as normal, and a server-declared stale reason beside a fresh timestamp
shows the stale condition with an undegraded label. Either mechanism alone tells
the operator half the story. Both together behave correctly and clear without a
reload.

**11. The native exit-reserve default has no headroom, and it already cost a real
open.** `suggestedNativeAllocationWei` is open plus the greater of close and
reserve, carrying no margin against gas repricing between setup and open. The
strategy record shows a real draft that stayed unopened with zero operations,
rescued only when the operator manually entered 0.0011 native units.

**12. The first-run empty state is indistinguishable from a filter miss.** With
zero campaigns and untouched filters, both sections render "No matching current
positions / Try another asset or status / Clear filters", byte-identical to the
genuine filter-miss copy. Nothing points to setting up a position, and the totals
show 0.00 managed value and +0.00 P&L from a reduce over an empty list. The
remedy is cheap: the setup heading already sits 105 px above the fold at 1440.

### Backlog

- Every recognised server error reaches the operator as a bare `snake_case`
  identifier; `rawRequest` returns `data.error` with no translation layer, so a
  503 source outage and a 403 CSRF mismatch are indistinguishable in shape.
- No distance to range boundary, in price or ticks, and no drift-implied time to
  exit. In-range percentage exists and is well presented, but only per session
  in a drilldown, so it cannot serve triage across campaigns.
- Close-control accessible names are byte-identical across campaigns on
  different assets and carry neither asset nor campaign, so a screen-reader or
  keyboard operator gets no context. Keyboard behaviour itself is correct.
- Any text selection inside a portfolio section is destroyed every ten seconds,
  so copying a value is unreliable.
- `src/dashboard/research.ts:906` runs five window queries through `Promise.all`
  on one `PoolClient`. pg serialises them, so the concurrency is illusory, and it
  blocks a future pg major upgrade. The `^8.16.3` range excludes pg@9, so it is
  not an imminent break.
- Three redundant `information_schema.columns` probes run per snapshot call.
- `formatSetupTokenAmount` maps a negative raw amount to the same "Unavailable"
  string as an absent one, and `preflight_source_expired` is emitted both for a
  stale source and for a clock-skewed future source.

## What holds

Recording these so the report is not read as uniformly negative.

- **Accounting reconciles.** Net P&L matches to the raw unit, swap within 3 and
  gas within 26 raw units, covered hours exact at 30.864 across 3,338 marks with
  no gaps. The zero-hour boundary bucket exists precisely so movement across a
  session boundary is not dropped, and it works.
- **Concurrency and idempotency are sound.** A double-clicked acceptance submits
  one operation because the control disables inside its own handler; a
  double-clicked delete sends one DELETE; the losing tab of either race converges
  with a readable message rather than a stuck control; an interrupted acceptance
  with a reload and three retries leaves one operation under the original key.
  After a service restart the pending-recovery path replays an acceptance under
  its original key, and the `(campaign_id, idempotency_key)` unique constraint
  makes that reconcile rather than duplicate.
- **Degraded reads are handled honestly.** An unreachable database names the
  fault, keeps the last received rows, says they are historical, and both banner
  and poll recover without a reload. A slow database stays readable. An empty
  window draws axes with zero data paths rather than a phantom series.
- **The pool is adequate.** Four connections queue gracefully with zero failures
  to concurrency eight; worst single response 1.48 s against a 20-second abort.
- **The disqualifying render case does not occur.** Focus and typed input in the
  setup form survive a refresh, because that form sits outside the rebuilt
  sections.
- **Session-aware performance attribution already exists** and is well
  presented: market, premarket, non-market, boundary and unobserved buckets with
  in-range percentage, alpha against holding, an explicitly non-forecast APY and
  a methodology dialog.

## Outstanding

- **U6's second half.** Whether a real NAV, P&L or fee figure degrades beside a
  stale source is untested: the fixture carries no recorded economics, so every
  headline value is an em dash and the check that only the age sub-label changes
  is a weak positive. Needs a fixture with persisted paper accounting.
- **R2**, a two-to-four-hour uptime soak for heap, listener and DOM growth, and
  the cost of polling while the tab is hidden.
- **R7**, cross-service asset coherence. Verified once by hand — both services
  served identical bytes — but not registered as a release gate. The Funnel
  serves the page from 4173 and `tabs.js` from 4174, so a single-service rollout
  would publish mismatched ES modules.
- **P4** campaign-count scaling and the fifty-position render cost. Both blocked
  on the same thing: production has no active campaigns, so scaling cannot be
  observed against it and P5 had to use the History scope.
- **P6**, an hour of footprint measurement beside the paper worker.
- One unresolved observation: the RangeKeeper receipts `<details>` was closed
  after a refresh although `renderSection` contains logic to preserve it. Not
  pursued far enough to call a defect.

None of the outstanding items is likely to reorder the findings above.

## Method and safety

All stateful testing used isolated schemas with synthetic canonical frames;
PostgreSQL, the command HTTP routes, session and CSRF handling, the dashboard
assets and the browser were real. Performance work read the production database
through read-only transactions and served pages from a private dashboard
instance, so the live service was never loaded. No write path was used, no
service was started or stopped, and no production DDL was issued.

Verified after every phase: `deployment_campaigns` remained at zero rows, no
test schema leaked, and all five conc-liq services stayed active with zero
automatic restarts. Evidence is retained privately under
`data/dashboard-testing-2026-09-29/`: the P1, P3, P5 and R6 measurement scripts,
the P3 profile log, the two browser harness runs and the baseline check logs.
