# RangeKeeper wallet-backed live dashboard — review and delivery plan

Reviewed: October 2, 2026, at approximately 11:20–11:23 UTC.
Source reviewed: `741447f`. Scope: review and planning; activation is a later
operator decision. The operator selected a **dedicated server-side wallet**:
approve a bounded campaign, then let RangeKeeper execute automatically.

Revised scope — October 2: the operator explicitly deferred private access
implementation and requested live dashboard support for **all registered pools
with one wallet**, using the existing paper-style setup and controls. Private
access is no longer a dependency or release gate in this milestone. The plan
below targets **multiple active pools at once**, with separate allocations and
one shared transaction queue, as explicitly confirmed by the operator.

This is the current RangeKeeper live handoff under F4/F5 and W4–W7 of the
[authoritative Research/Positions plan](research-and-positions-sol-2026-09-21.md).
It supersedes older next-action lists for this slice, without declaring the
whole two-strategy live package complete.

October 3 delivery correction: the operator asked to avoid over engineering
and pointed out that the running dashboard still has no economics. The
[minimum delivery sequence](#next-action-and-readiness-decision) below now
sets the order: paper economics first, dashboard live admission second,
automatic management and one safe exit third, then a bounded release.
The existing RL checkpoints remain evidence and the broader feature backlog;
completion of every optional control is not a prerequisite for this first live
release. All registered pools and multiple campaigns sharing one wallet remain
the product scope.

## Implementation checkpoint — October 2

The first RL-1/2 source slice adds Live RangeKeeper setup for registered pools,
the fixed server wallet's token/native allocation review, and a read-only
profile-driven candidate/preflight endpoint. The real dashboard browser fixture
selects all 12 profiles and preserves the Paper path. Wallet overrides, key
material and arbitrary calldata are rejected. Live draft creation and all
execution/admission flags remain disabled: there is no durable allocation
reservation, signed transaction queue or live dashboard worker in this slice.

Wallet reads cover every registered token address, pending/canonical nonce,
zero allowances, manager code identity and complete NFT custody. Existing active
campaigns without allocation proof block free capital. Empty retired NFTs require
complete indexed ownership plus canonical zero-liquidity/zero-owed reads; missing
genesis-to-source transfer coverage stays unavailable and is never repaired by a
review request. RL-3 must persist and reconcile active campaign ownership.

Candidate construction uses only an initial token allocation within the requested
quote budget, then checks measured entry costs and a separate complete exit gas
reserve against the final native allocation. Gas estimates use owned-fork receipt
units padded by 30 percent and a fee ceiling padded by 25 percent. Entry cost
includes entry swap fee/shortfall; exit conversion fee/shortfall and subsequent
recenters are not represented as complete lifetime economics. The fork uses
explicit synthetic native funding; canonical native availability is checked
separately. Reviews expire and cannot authorize a later queued transaction.

An actual allocated AAPL/500 fork rehearsal passed at block `78211393`, source
hash `0x043422dc4561838869ad88b3a262bacb8ee3171f98f03257312d53b9a54973b6`.
It minted, cleaned entry allowances, withdrew/collected and converted the risky
allocation, preserving `26007227` raw USDG outside the $250 allocation. Terminal
liquidity, owed balances and allowances were zero. This is one profile's local
transaction-path evidence; the 12-profile lifecycle/concurrency matrix remains
an RL-6 gate. Reproduce with
`node --import tsx test/integration/rangekeeper-live-setup-fork.mjs .env`.
Log: `/tmp/conc-liq-live-setup-fork-20261002.log`.

Production has not been changed by this slice. RL-2 remains partial until a
server-persisted frozen review and atomic admission/reservation bind it to RL-3.

Final source validation: repository boundaries/registry/manifests and TypeScript
checks pass, followed by **1,111/1,111 tests in 90 suites**. Coverage includes
address-based token/native conservation, unresolved commitments, retired NFT
custody/code/source rechecks, both token orders and decimal conversion, fee tiers
500/3000/10000, one-sided initial swap funding, insufficient native gas,
malformed fork evidence and session/origin/CSRF controls. Full check log:
`/tmp/conc-liq-live-setup-check-20261002.log`. The actual browser fixture lives at
`test/integration/dashboard-live-setup-browser.mjs`; its separate run log is
`/tmp/conc-liq-dashboard-live-setup-browser-20261002.log`. Its final run passed
12 checks with five Live reviews, one Paper review, no draft/open submissions
and no browser runtime errors. Failure cases wait for their specific returned
blocker, so an earlier unchanged title cannot satisfy the test.

### RL-2/3 durable-wallet foundation checkpoint

The next source slice adds migration **v12**, persisted wallet generations,
frozen reviews, campaign allocations, NFT custody, operation leases and a
stage outbox. Admission reserves the reviewed token and native amounts and
queues its opening in one compatible wallet transaction. Multiple campaigns
can reserve shared token addresses independently; native spending and each
campaign's exit reserve remain separate. Same-key retries return the same job,
while changed requests and stale generation/source bindings reject.

The shared queue prioritizes recovery and exits, fences expired leases and
preserves signed transaction bytes and nonce across restart. Canonical receipt
reconciliation checks the mined transaction, source headers, complete wallet
balances/nonces/allowances/NFT set and assigned position. Its token deltas and
gas, including reverted gas, belong only to the initiating allocation. Queue
completion requires a trusted canonical cleanup/custody adapter. No public
request can submit receipt attestations or cleanup booleans.

The review reader now understands proven v12 allocations and managed NFT
custody. Updated legacy RangeKeeper and pilot stores refuse the wallet while
the shared ledger owns active allocations or unresolved stages. This source
guard cannot protect against an older deployed binary: the eventual cutover
must exclude predecessor workers before enabling new execution. New tables
are created only by the explicit migration. Existing paper services accept
verified v11 or v12 schemas; shared-wallet writes require v12.

This is **foundation evidence, not RL-3 completion**. The runtime has not yet
wired review persistence/admission, a campaign controller, the stage authorizer,
generic executable cost proof or canonical queue adapters. The queue itself
has no signing or publishing method. Live setup still advertises execution and
operation acceptance as unavailable. Existing controller runtime DDL, live and
paper pause/resume, both live exits, lifecycle/Positions adapters and the full
12-profile process/fork/browser matrix remain open. No production migration,
service replacement, wallet funding, signing, broadcast or activation occurred.

The isolated PostgreSQL migration and existing paper integration suite pass on
v12; the latter used a disposable database because the production paper worker
holds the database-wide readiness lease. The Live/Paper browser fixture again
passes all 12 checks with no acceptance submissions or browser errors. Receipt
attribution tests use canonical-reader fixtures; they do not qualify the new
queue on a chain fork. Follow-on queue admission deliberately rejects until
RL-4 supplies immutable operation reviews. Stage preparation requires a trusted
strategy authorizer; canonical receipt and cleanup adapters are also mandatory.

Final source validation passes **1,131/1,131 tests in 90 suites**, repository
checks and TypeScript. Isolated PostgreSQL allocation tests cover shared-token
and native conservation, frozen bindings, unknown custody, unexplained nonce
changes, guarded release and preserved retired NFT attribution. Admission tests
exercise the real review/store/queue bridge, including reservation-induced
generation changes, parser-valid config hashes, bigint plan/snapshot persistence,
same-stage replay and canonical-verifier rollback. Queue integration covers
concurrent claims, lease fencing, nonce uniqueness, signed-byte recovery,
adapter failure rollback and reverted gas charged once to the initiating
campaign while sibling capital remains unchanged. Queue receipt effects in
that integration use an explicit fixture adapter.

Logs: `/tmp/conc-liq-live-wallet-check-final-20261002.log`,
`/tmp/conc-liq-live-wallet-allocations-20261002.log`,
`/tmp/conc-liq-live-wallet-admission-20261002.log`,
`/tmp/conc-liq-live-wallet-queue-20261002.log`,
`/tmp/conc-liq-live-wallet-paper-integration-isolated-20261002.log` and
`/tmp/conc-liq-live-wallet-browser-20261002.log`.

Next implementation order recorded at the foundation checkpoint:

1. Persist complete canonical wallet/NFT snapshots and server reviews in the
   actual command runtime; retain v11 read-only behavior until explicit v12
   cutover. Qualify pinned revalidation against stable semantic reference proof
   identity: unchanged fetch-time metadata currently causes conservative rejects.
2. Supply the queue's actual strategy, canonical receipt and cleanup adapters,
   then connect a campaign-aware worker to the existing planner/controller.
   Use current whole-wallet evidence plus the campaign's allocation for every
   stage. A sibling reservation or receipt may advance wallet generation without
   making an unchanged allocation unusable. Remove legacy runtime DDL through
   explicit migration and preserve predecessor exclusion in both directions.
3. Implement persisted pause/resume and reviewed retain/convert exits; add
   immutable follow-on admission, terminal capital release and lifecycle history.
   Wire live Positions progress and actual accounting alongside paper parity.
4. Run the complete RL-6 all-profile and shared-wallet process/fork/browser
   matrix before enabling dashboard acceptance or preparing RL-7 cutover.

### RL-3 campaign runtime and executable stage proof checkpoint

This source slice adds explicit migration **v13** for campaign-addressed runtime
state, append-only effects, complete NFT custody snapshots and persisted stage
authorizations. Shared-wallet services accept v12/v13; the campaign runtime
requires v13. Existing paper services continue to accept verified v11–v13.
Runtime startup checks the schema and does not create these tables.

Stage planning uses the campaign's current liquid allocation and native spending
budget, separately from its protected exit reserve and all sibling funds. Exact
plan/state-revision identities distinguish positive approval from zero-allowance
cleanup. Each stage requires independent pinned references and an opaque,
expiring, one-use capability issued by the owned-fork runner. An audit report or
caller-supplied gas values cannot issue that capability. The authorizer checks
the exact source, profile, parsed policy, allocation, calldata, nonce, gas/fee
bounds and remaining action/campaign budgets before persisting the outbox.

Wallet refresh and review persistence now reject unresolved stages under the
same compatible wallet lock. Receipt persistence includes complete canonical
wallet and pool after images; the canonical queue adapter appends campaign
state/costs alongside the allocation, nonce, NFT and gas effects. Lease renewal preserves
fenced ownership. The opening worker defaults signing and publishing off,
reuses signed bytes after restart, revalidates unsigned evidence, charges
reverted receipts and recovers the cleanup-to-holding lifecycle handoff.
Follow-on operation admission and worker execution remain disabled for RL-4.
The composition uses actual independent-reference readers and the durable
receipt reducer by default, and attaches no signer or publisher. A canonical
mined receipt can recover without attempting to publish its bytes again.
Cleanup results are normalized identically on first completion and recovery.
The complete composed opening has not yet been exercised against PostgreSQL
plus an owned fork; helper and store tests do not establish that qualification.

The server-wallet policy now verifies both EOA and the existing EIP-7702 delegate
code at the pinned source; no private signing material is read by review or
simulation. Semantic reference identity omits only fetch-time metadata and its
derived digests, while binding feed identity, source, timestamps, answers, prices
and registry evidence.

An actual owned-fork stage proof passed at block `78265208`, source hash
`0xfac16d892db3085906130944fd85b4f9ad295a9fd4d1dc93969ab39243946ba1`.
The exact approval consumed `57952` gas; the padded bound was `75933` gas and
`2951895375000` wei. The harness rejected a caller-created report, rejected a
different stage binding, accepted the runner's capability once and rejected its
second consumption. Upstream mutations were zero. Reproduce with
`node --import tsx test/integration/rangekeeper-live-stage-fork.mjs .env`.
Log: `/tmp/conc-liq-live-stage-fork-20261002.log`. This qualifies one exact stage;
it does not qualify a full opening or the all-profile lifecycle matrix.

Production remains on schema **v11**. This work does not migrate production,
replace services, fund the wallet, sign or broadcast live transactions, or
enable public acceptance. The synthetic-key PostgreSQL worker test is separate
from live-wallet signing. RL-3 remains partial until the complete composed
worker is exercised through opening, cleanup and recovery on an owned fork.
Automatic holding/recenter monitoring, reviewed pause/resume and both exits,
terminal release, shared Positions accounting and RL-6 remain necessary.

Final source checks pass **1,156/1,156 tests in 94 suites**, TypeScript and
repository checks. The disposable PostgreSQL database migrates through v13;
the existing paper integration suite passes there. Wallet tests cover lease
renewal/fencing, unresolved-stage refresh/review rejection, transaction rollback
when the campaign effect fails, exactly-once receipt/gas attribution, durable
authorization replay, receipt-source valuation, reference/state tamper rejection,
and opening-to-holding persistence. Worker tests recover canonical receipts
without signing or publishing again. The readonly Live/Paper browser fixture
passes 12 checks with no acceptance calls or browser errors.

Logs: `/tmp/conc-liq-live-worker-check-final-20261002.log`,
`/tmp/conc-liq-live-worker-allocations-final-20261002.log`,
`/tmp/conc-liq-live-worker-queue-20261002.log`,
`/tmp/conc-liq-live-worker-admission-20261002.log`,
`/tmp/conc-liq-live-worker-review-runtime-20261002.log`,
`/tmp/conc-liq-live-worker-paper-integration-20261002.log` and
`/tmp/conc-liq-live-worker-browser-20261002.log`.

### Owned opening rehearsal and review persistence checkpoint

The setup runtime now supports explicit `persistReviews: true`; it remains off
in current server wiring. On v13 it observes every registered token, nonce,
allowance and complete NFT ownership at the pinned frame, persists wallet/NFT
evidence under the compatible wallet lock, then rereads independent reference
semantics before recording an inert frozen review. The response carries review
ID/hash/expiry separately from that frozen payload. Concurrent requests keep
their NFT observations separate. A first-seen retired-empty NFT rebinds the
wallet commitment fingerprint in the same transaction; an unchanged refresh
does not increase its generation. v11 stays read-only.

The owned-fork exercise revealed that production has no Position Manager
transfer cursor. Scanning the manager's full history hit RPC log-count and
timeout limits. The resolver now additionally supports an explicitly scoped
wallet index: genesis-to-source `from` and `to` queries, exact union/replay,
canonical checkpoints, `balanceOf` and every current `ownerOf`. It rejects a
different wallet scope, holes, duplicates, unknown outgoing ownership and
unowned self-transfers. The existing PostgreSQL transfer store remains global;
persisted wallet-scoped cursors need a separate explicit schema/store change
before production can use this path. A scoped scan must never populate a
global manager cursor.

The synthetic wallet's actual upstream history was queried in 16 bounded
requests through block `78301778`, hash
`0xa58e64b9b5527a871662d97e4f280f5054de6e043b8378d4c38d9f4928666a08`.
It had zero wallet-scoped NFT transfers. This is real coverage of that wallet,
not an asserted empty manager history. The rehearsal fixture starts from this
kind of complete query and extends with actual local stage transfers. Test
signing/publication require a branded, live fork handle created by
`openPaperFork`; a caller's loopback URL or fork-shaped object cannot authorize
them. Default worker signing and publication remain disabled.

The rehearsal uses the official Anvil `v1.8.4` binary in a temporary path;
the installed production tool was not replaced. The upstream proxy now accepts
an EIP-1898 account-read tag only when its hash equals the fixed fork source,
then forwards that exact source's number tag to the archive provider. Wrong
hashes, mixed tags, latest/future state and upstream mutations remain rejected.
Unsupported feature probes return the JSON-RPC method-not-found code. Local
publication waits for the exact transaction's inclusion before mining the
64 confirmation blocks. Zero local state roots do not establish historical
state equivalence; the attempted fallback using them was rejected and removed.

Admission must reload the full registered `MarketProfile` by `profileId` and
verify its hash before rereading references. The frozen review's `profile`
field contains display metadata and is not that full profile. The composed
test enforces this distinction rather than treating the displayed fields as
a replacement for registered policy/reference evidence.

The composed-path review found and corrected three execution defects. The
wallet reader now merges spender targets before taking the token/spender
cross product, and rejects configured tokens outside the registered scope.
After a confirmed, attributed stage, the worker yields its fenced lease while
the same active job retains wallet ownership; the next pass can continue
immediately and a queued sibling cannot enter its allowance window. Cleanup
must include every allowance identity recorded in the final canonical receipt,
and all observed allowances must be zero. Focused and PostgreSQL tests cover
the new fence, unresolved-stage rejection, immediate same-job reclaim and
sibling queue preservation. The stage-authorization store also converts its
validated bare calldata digest to the database's required prefixed format;
the frozen authorization retains its original hash and no constraint changes.
Actual mint reconciliation also exposed a checksum-cased manager address being
written to the lowercase custody key. Updates and inserts now normalize and
validate that address, preserving the database constraint.

Source validation passes **1,165/1,165 tests in 94 suites**, TypeScript and
repository checks. The isolated v13 paper PostgreSQL suite, wallet allocation,
queue and admission suites, review-runtime retired-empty NFT test, and
Live/Paper browser fixture pass. Production was rechecked at **v11**, with
**12 registered profiles**. No service replacement or production migration was
performed. The one-campaign composed opening/recovery now passes as recorded
below; this does not qualify the all-profile management lifecycle.

Logs: `/tmp/conc-liq-live-open-composed-source-check-20261002.log`,
`/tmp/conc-liq-live-open-paper-integration-final-20261002.log`,
`/tmp/conc-liq-live-open-queue-normalized-final-20261002.log`,
`/tmp/conc-liq-live-open-allocations-20261002.log`,
`/tmp/conc-liq-live-open-admission-20261002.log`,
`/tmp/conc-liq-live-open-browser-20261002.log` and
`/tmp/conc-liq-wallet-transfer-probe-20261002.log`.

Reproduce the composed rehearsal with the pinned Node, the official Anvil
`v1.8.4` binary and a disposable PostgreSQL database:

```sh
PATH=/root/conc-liq/.tools/node/bin:$PATH \
ANVIL_BINARY_TEST=/tmp/conc-liq-owned-anvil-v1.8.4/anvil \
TEST_DATABASE_URL='<disposable PostgreSQL URI>' \
node --import tsx test/integration/rangekeeper-live-worker-fork.mjs
```

The official Linux amd64 release archive used here has SHA-256
`699e2207a6a9b27ca17c48c81e56f1677ed9c58b623b59128b4e15ec9da0625e`.
The harness reads the registry from production using a read-only connection;
all migration, allocation and runtime writes use an isolated test schema. It
loads only its synthetic signer and only publishes to the branded owned fork.

### Composed one-campaign opening and recovery result

The actual setup runtime, frozen review persistence, admission store, queue,
worker, receipt reducer and campaign store passed together on one owned fork
and isolated v13 PostgreSQL schema. The selected registered profile is AAPL
fee 500 (`a8e7096f-17c3-452c-a72f-8fa962e586d2`). All 12 profiles and their seven
distinct tokens supplied the complete wallet inventory scope.

The clean run completed eight confirmed transactions: three bounded approvals,
one swap, one mint and three zero-approval cleanup transactions. NFT `1368644`
remained owned by the synthetic wallet with liquidity `1345217600146301`.
There were eight unique receipt-cost events and eight signer calls. Rebuilding
the runtime after a lost publish acknowledgement preserved and reconciled the
exact signed bytes without another signature. Rebuilding it again recovered
the crash between queue success and the campaign's active/holding handoff.
Every observed allowance was zero. Free native and token capital, including
the five other registered token balances, remained unchanged.

Upstream genesis custody coverage ended at block `78360996`, hash
`0xecdeaa2b9345cfcb5665d6d4bcebf4fb7bed31ea4657b26d97cc022edb48870d`;
16 actual filtered queries found no prior wallet NFT transfers. The owned fork
used 913 bounded upstream reads. Mutations and synthetic signing stayed local.
The clean run exited successfully and its fork/schema were removed.
Evidence: `/tmp/conc-liq-live-worker-fork-success.log`.

This is one opening and cleanup under a synthetic build identity, not a sealed
release or operating-system process restart qualification. The subsequent
two-pool result below extends opening evidence to concurrent positions.
Recentering, both exits, pause/resume, persistent wallet-scoped custody indexing,
production command wiring and shared Positions economics remain separate gates.
The product scope remains multiple active pools on one wallet.

### Composed two-pool opening result

The optional `--two-pools` run exited successfully with the first AAPL fee-500
campaign holding while a second registered AAPL fee-3000 campaign passed fresh
setup, frozen review persistence, allocation admission and the same wallet
worker queue. Its profile is `98e3f48d-f237-4510-a8c7-5f399dee4636`, pool
`0x783c9bbb765047cfdd2b84b92b2ca9f11d34b7ed`. Both campaigns share USDG and
AAPL token addresses but reserve and spend separately.

Each campaign completed eight confirmed transactions and recorded eight distinct
receipt-cost events. The wallet used 16 unique transaction nonces and 16 signer
calls. NFTs `1368838` and `1368839` remain separately attributed and owned by
the synthetic wallet, with liquidity `1345074812503729` and `134854032283094`.
Opening the second pool preserved the first campaign's exact state hash, state,
allocation and position tuple, including its receipt costs. Admission reduced
free capital by exactly the second reservation; its opening spent only that
allocation. All observed allowances were zero after cleanup. Both fresh-runtime
recovery checks from the first campaign passed again.

Upstream custody coverage used 16 actual filtered queries through block
`78371300`, hash
`0xc122269d7cf2af85cf9a3ec37d98881dcd4c0dc4e0b421ab139e8db8f3388065`.
The composed fork used 1,469 bounded upstream reads, no duplicate reads and zero
upstream mutations. The owned forks and isolated schema were removed after the
successful run. The disposable database `conc_liq_rl3_open_check_20261002` was
then removed after verifying it had no remaining connections; production was
unchanged. Evidence: `/tmp/conc-liq-live-worker-two-pools.log`.

Reproduce using the environment variables above and
`node --import tsx test/integration/rangekeeper-live-worker-fork.mjs .env --two-pools`.
This qualifies concurrent openings for these two fee-tier pools sharing one
position manager. It does not qualify every registered pool, automatic
recenter/exit lifecycle, a sealed deployment or an operating-system restart.
Production remains v11 with 12 registered profiles and live acceptance disabled.

### Durable wallet history and runtime selection checkpoint

Migration **v14** adds separate wallet-scoped Position Manager cursor,
checkpoint and event tables. Every key and predicate includes chain, manager,
wallet and start block. The store captures a wallet address that cannot be
reassigned or redefined at runtime. It persists contiguous chunks under a cursor
lock, validates the exact predecessor and event checkpoints, rejects conflicting
identities atomically, and loads replay evidence under repeatable-read isolation.
Rewinding one wallet does not change another wallet or the global index. The
old migration texts/checksums and global transfer tables are unchanged.

Existing checked paper services accept v11–v14; wallet services accept v12–v14
and campaign runtime services accept v13/v14. Wallet transfer writes require
v14. Snapshot/review runtime gates also accept checked v14. Unknown v15 and
modified migration histories fail readiness. No worker implicitly runs DDL.

The command process selects the dedicated wallet index only on v14 with a valid
configured wallet. Earlier versions retain the global diagnostic reader. Failed
v14 readiness closes initialized resources and fails startup without falling
back to global history. Review requests only read persisted evidence;
`persistReviews`, admission, signing and publication remain disabled in current
server wiring.

An explicit maintenance command builds or resumes the registered wallet's
history, validating that registered profiles share one Position Manager:

```sh
PATH=/root/conc-liq/.tools/node/bin:$PATH \
node --import tsx src/nft-wallet-index.ts --chunk-blocks 10000000 --max-blocks 100000000
```

Its environment is `DATABASE_URL`, `ROBINHOOD_READ_HTTP_URL` and
`DEPLOYMENT_OPERATOR_WALLET_ADDRESS`. It checks v14 and never migrates, signs or
publishes. Maintenance errors redact HTTP and PostgreSQL URLs. The wallet
scanner fixes genesis and caps a run at 100 million blocks,
with chunks at most 10 million. Each filtered direction and the merged result
are bounded; overlap cannot hide excess logs. The global scanner retains its
smaller limits. Scanning by itself never declares current NFT custody complete.
`--help` works without environment or network configuration. Partial coverage
remains unavailable to reviews and requires another explicit maintenance run.

Actual public/archive reads agreed on source block `78423838`, hash
`0x6eea80602932b8ceab28e0f96514580df33714a8d5a77ee91b8f6606333628f0`.
Sixteen filtered queries across eight chunks proved genesis-to-source history
for the synthetic wallet. Zero NFT transfers were observed. A fresh PostgreSQL
store instance retained the cursor and transfers, and canonical custody
reconciliation succeeded. The global index remained empty; all upstream calls
were reads. This tests persistence after reopening the store, not an
operating-system process restart or a funded production wallet.

The isolated v13-to-v14 upgrade test preserved populated global cursor,
checkpoint and event evidence exactly, and left the new wallet cursor absent
until an explicit wallet scan. PostgreSQL tests also cover two wallet namespaces,
from/to/self-transfer deduplication, ownership replay, interrupted coverage,
identity rollback, checkpoint conflicts and wallet-only rewind. The complete
paper integration suite, review runtime, admission, allocations and queue pass
on v14. Two stale allocation-fixture capability hashes were corrected to the
authorizer's bare digest; the test now checks that the SQL digest is prefixed
while frozen capability evidence remains bare. Source checks pass
**1,171/1,171 tests in 94 suites**, TypeScript and repository checks.

Evidence: `/tmp/conc-liq-wallet-index-canonical-20261002.log`,
`/tmp/conc-liq-position-manager-wallet-transfer-index-20261002.log`,
`/tmp/conc-liq-wallet-index-source-check-final-20261002.log`,
`/tmp/conc-liq-wallet-index-paper-integration-20261002.log`,
`/tmp/conc-liq-wallet-index-review-runtime-20261002.log`,
`/tmp/conc-liq-wallet-index-admission-20261002.log`,
`/tmp/conc-liq-wallet-index-allocations-20261002.log` and
`/tmp/conc-liq-wallet-index-queue-20261002.log`.

This closes the durable wallet-index foundation. A one-off backfill does not
keep up with new setup/queue sources: continuous bounded maintenance and exact
source/checkpoint coordination remain part of command/worker wiring. Dashboard
admission and the managed recenter/exit lifecycle are still separate gates.
Production was rechecked at v11 with 12 profiles; no production migration,
service replacement, signing, broadcast or activation was performed. All test
schemas and connections were cleaned up, then the exact disposable database
`conc_liq_rl3_wallet_index_check_20261002` was removed.

### Paper net economics checkpoint — October 3

The missing RangeKeeper adapter is now deployed on sealed build
`aebd50962ac487007925f8c2badda1045deb96ae4bd95398df172415cedf3ed7`,
source `1452e6d`. It reuses canonical observed-flow fee replay and the existing
v11 append-only accounting tables. No production migration was needed.
All six real campaigns produced modeled NAV, retained fees, costs and a matched
passive comparison in the canonical rehearsal, including recenter and closure.

Modeled fees remain cash outside historical simulated swaps/mints. NAV includes
remaining native; starting capital and passive comparison use the full original
token/native inventory. Selected reference validity, complete event coverage and
stable reorg audits remain required. Paper values are provisional; paid gas and
earned fees remain unavailable without live receipts.

New observations can temporarily lead indexer coverage and hide current economics
until the exact mark is accounted. The worker now skips another observation on a
pass that just caught up, leaving a complete endpoint visible. Skipped historical
minute marks are not backfilled with invented values. Production verification and
the remaining coverage limitation are recorded in the
[release review](../reviews/rangekeeper-paper-economics-2026-10-03.md).

The next implementation gate is bounded dashboard live admission using the
existing wallet queue, followed by automatic management, retain-only exit and
receipt-attributed Positions economics. Do not expand infrastructure first.

## Initial October 2 review snapshot

The dashboard has reached a usable RangeKeeper paper workflow. The next useful
milestone is one complete wallet-backed RangeKeeper workflow through the same
Positions interface. Reuse the existing live controller and receipt ledger;
the missing work is their product integration and lifecycle guarantees.

| Area | Verified status | Remaining boundary |
| --- | --- | --- |
| Running dashboard, command API and paper worker | All active on sealed build `0a2a39512709e68556157120e23e3fc53262567d2197ec9801f618b1482d304b`, source `e4a7e7c`, with zero restarts. Both local health endpoints and Positions APIs returned 200. | These services provide paper controls and read-only live history. |
| RangeKeeper paper | Setup/open, observations, automatic recenter and both exits are implemented. The October 2 sealed tests cover IDs above 999, restart continuity and desktop/mobile history. | Pause/resume is still a static/manual-only paper path; the complete F3 lifecycle contract is not closed. |
| Fresh production snapshot | One active paper campaign `25e1a8c9-c49a-45c3-a9d3-70cc66a37dd3`, latest mark 1120, epoch 0. Campaign `0fb38df7-442a-4b43-b90c-6bd4fcef3878` is closed with conversion mark 1113. Two opens, one recenter and one conversion operation have succeeded. | This snapshot supersedes the rollout review's earlier open-campaign state. Campaigns may advance after the snapshot. |
| Paper economics | Actual API reports accounting unavailable on both current paper rows. Fork gas and modeled costs retain provisional provenance. | Paper operation success does not establish paid fees, full custody, NAV or profit. |
| Existing live engine | `RangeKeeperLiveController` has staged entry/recenter/convert-exit, semantic calldata authorization, a private signer, persisted intents/raw transactions, canonical receipts, custody checks and recovery. Prior real-chain recovery is documented. | It operates through the CLI and separate `rangekeeper_v1` ledger, without a dashboard campaign/operation adapter. |
| Existing live service/history | `conc-liq-rangekeeper.service` is inactive. Both stored RangeKeeper live campaigns are closed, with no prepared/signed actions. Shared Positions serves their history. | Database closure and old balances are historical evidence; fresh canonical wallet custody remains a launch gate. |
| Live dashboard availability | `server.ts` advertises `live:false` for both strategies. Its command surface explicitly loads no signer. Live diagnostic evidence remains non-actionable. | Live setup, acceptance, worker execution and capability-specific controls are missing. |
| Operator access | `/api/session` is an automatic session/CSRF handshake. The public operator surface has no user identity check. | Private access is deferred by explicit operator decision. Once live controls are enabled there, URL holders can submit controls for the configured wallet within enforced limits. Keep existing origin/CSRF/session protections. |
| Fresh source validation | `npm run check` passed repository checks, typecheck and **1,079/1,079 tests in 90 suites** on Node v24.20.0. | This review did not rerun the archived sealed canonical/browser/fork lifecycle gates. New live changes need their own evidence. |

Evidence: [October 2 management/release review](../reviews/rangekeeper-paper-management-2026-10-02.md),
[prior live withdrawal and recenter recovery](../operations/rangekeeper-withdraw-gas-bound-2026-09-23.md),
and fresh systemd/API/read-only PostgreSQL checks. Fresh source check log:
`/tmp/conc-liq-live-dashboard-review-check-20261002.log`. The sandbox initially
blocked a child git process; the successful rerun used approved execution.

Known dashboard backlog includes hidden Positions polling, lost text/chart focus
on refresh, and the prepared Research index. These remain separate work unless
measured interference blocks live operation. The previous idle-worker soak does
not prove isolation during active live execution.

## First live milestone and limits

One provisioned wallet on chain 4663, **every registered pool available through
the same setup form**, one managed NFT per campaign and one pending transaction
across the wallet. Multiple campaigns may hold positions simultaneously; their
transactions execute through one durable wallet queue. The full operator
workflow is:

**Select Live and RangeKeeper → select any registered pool → enter capital/width
and limits → review fresh funding/custody/costs → approve campaign → open →
monitor → automatic recenter → pause/resume → retain-close or convert-close →
reconciled history.**

Use the previously accepted bounded launch envelope as the proposal: at most
250 USD-equivalent total across the funded wallet's initial campaigns, split
into at most 240 strategy inventory and 10 native-gas allocation. This is a
launch budget proposal, not a per-pool hardcoded product limit. Capital and
campaign limits are supplied through the existing dashboard workflow. Reconcile
this with fresh balances and the configured
deployment minimum; if infeasible, display the shortfall and block admission.
Budget entry, one admitted recenter, complete exit, cleanup and the existing
gas margin. Freeze finite duration/action/recenter limits and all existing
slippage, reference, share, loss, drawdown and cost guards in the reviewed
campaign. Do not inherit unlimited-count settings from a historical campaign.
Actual amounts and limits belong in the final launch approval.

The wallet is provisioned outside the browser. The browser selects a registered
wallet ID/address; it never supplies private keys, file paths, spenders or raw
calldata. Show token/native balances and the funding shortfall before approval.
Funding and gas replenishment are separately explicit actions.

The first slice enables RangeKeeper live only. Static/manual remains in the
catalog with its existing paper support. Additional wallets are deferred;
all registered pools belong to this milestone. Pool support means a complete
execution path with dynamic eligibility, not a promise that every pool has a
profitable or feasible opening at every source.

A fresh read-only registry query confirmed **12 profiles**: AAPL at fee tiers
500/3000/10000; NVDA, GOOGL, SPY and QQQ at 500/3000; MSFT at 3000. USDG is
token1 for GOOGL/SPY and token0 for the other registered assets. Derive pool
addresses, identities, decimals, fee, tick spacing and reference policy from
the registered profile; do not add an AAPL whitelist or a separate per-pool
configuration workflow.

## Shared-wallet operation model

The existing controller is not ready for concurrent campaigns merely because
its planner accepts a pool profile. `reserveLiveWallet` reserves the entire
wallet, `current(db, operator)` selects one campaign, and `exactCustody` expects
unchanged whole-wallet token/native balances, nonce, NFT count and allowances.
Sibling campaign transactions would currently violate those invariants.

Keep one execution process and extend its durable ownership model:

- Persist allocations by **campaign and token address**, plus reserved native
  gas and expected terminal-exit cost. Wallet-held allocations and pending
  spend commitments cannot exceed reconciled liquid wallet balances; record
  capital inside each NFT separately, without treating it as spendable wallet
  inventory. A second USDG pool cannot reuse another campaign's USDG or gas
  reserve.
- Keep one wallet owner/lease against predecessor CLI/pilot execution, while
  allowing multiple campaign allocations underneath it. Resolve controllers
  by campaign ID. Enumerate and reconcile the complete wallet NFT set, with
  one active NFT owned by each campaign and explicit retired/unmanaged records.
- Allocate nonces and persist/sign/publish through **one wallet transaction
  queue**. Monitoring and construction may cover multiple pools, but only one
  signed transaction is unresolved at once. Prioritize reconciliation and exits
  ahead of discretionary opens/recenters; retain bounded progress for other
  campaigns and protect each admitted exit reserve.
- After every canonical receipt, attribute token/native/NFT/allowance deltas
  to the initiating campaign and refresh the wallet snapshot for all campaigns.
  An unexplained transfer remains a wallet integrity block. Recognized sibling
  changes must not halt an unrelated campaign or contaminate its P&L.
- Shared token/router/manager allowances belong to the wallet executor. Keep
  grant, use and cleanup stages exclusive to their operation so another
  campaign cannot spend or revoke them midway. Persist that stage ownership
  across restart; cleanup precedes releasing operation ownership.
- A queued action needs fresh source/custody/reference/cost proof before signing.
  Waiting in the queue never extends the 90-second confirmation window or
  authorizes an expired preview. Rebuild proof within the accepted policy;
  changes outside its frozen allocation/limits require a new review.
- Close-retain preserves that campaign's two token balances; close-convert
  sells only its allocated risky inventory. Closing one campaign releases only
  its allocation, while the wallet owner continues serving the others. Preserve
  the closed campaign's baseline, receipts and history.

## Ordered implementation tasks

| ID | Work and source ownership | Dependencies | Acceptance gate |
| --- | --- | --- | --- |
| RL-1 | Reuse the existing operator surface. Register the one server-owned wallet and expose its address, reconciled balances, allocated/free capital and remaining gas through the same setup form. Replace global strategy flags with profile-aware live capability/status. Keep signing in the worker. | First task; no private-access implementation. | Every valid registered profile appears in Live RangeKeeper setup; invalid/retired/stale profiles show their specific reason. Wallet identity is fixed server-side. No HTTP input or response carries key material, arbitrary paths or calldata. Existing paper flow and origin/CSRF/session behavior remain functional. |
| RL-2 | Implement profile-driven live setup/preflight and frozen review for all registered pools using `live-preflight.ts`, complete custody/nonce/reference evidence and owned-fork simulation. Replace full-wallet funding assumptions with exact requested campaign allocations. Bind wallet, allocation, profile, policy/config, source and sealed build. | RL-1; shared-wallet allocation contract agreed with RL-3. | Both token orders and every registered fee/tick-spacing pair are supported. Review exposes exact range, minimum swap, free versus reserved capital, prospective costs and exit reserve. Per-profile source/code/reference/quote/funding failures block with concrete reasons. Repeated review/acceptance cannot reserve funds twice; no sibling allocation is spendable. |
| RL-3 | Connect durable dashboard campaigns/operations to `RangeKeeperLiveController` through one wallet executor implementing the shared-wallet model above. Add per-campaign lookup/allocation/NFT ownership and a durable shared nonce/receipt queue; preserve one authoritative economic ledger and compatible exclusion of predecessor workers. Move runtime DDL into an explicit migration and make worker startup validate schema. | RL-2 contract; RL-4 lifecycle contract. | Two campaigns on different pools can coexist with independent baselines and allocated inventory. Two fee tiers sharing the same risky token also remain isolated. Same-key replay returns the same operation; stale/conflicting requests reject before signing. Only one unresolved signed transaction exists wallet-wide. Restart/lost acknowledgement reconciles it once; known sibling receipts update custody without false integrity halts. Closing one campaign leaves the others intact. |
| RL-4 | Complete RangeKeeper management semantics. Add persisted pause/resume and explicit retain/convert exit intent to live state; add the missing RangeKeeper paper pause/resume path for the same UI contract. Reuse withdrawal, receipt and cleanup stages. Preserve legacy exit behavior on old records through a versioned reader/default. | RL-3, with its state contract designed together. | Pause stops new discretionary entry/recenter after settling in-flight work; monitoring, pending receipt reconciliation, cleanup and required safety exit continue. Resume preserves baseline and spent limits and resets confirmation continuity explicitly. Retain leaves both tokens; convert performs the bounded sale to the configured quote token. Both require no managed liquidity, reconciled NFTs/balances/nonces and allowance cleanup. Pending signed work resolves before close precedence takes effect. |
| RL-5 | Wire Live setup, stage/queue progress, pause/resume, both exits and bounded recovery controls into existing Positions, matching the paper workflow. Extend shared adapters for profile-driven asset labels/prices/units and per-campaign attribution. Record frozen predictions beside canonical actuals. | RL-3/4; initial-operation visibility alongside RL-3. | All registered pool selections reach their correct review route. Multiple live rows render from first acceptance through closure. API and desktop/mobile UI agree on wallet, pool/fee tier, NFT, inventory, pending nonce/hash, queued versus submitted work, reserve, limits, activity, charts and windows. Receipt costs including reverts are attributed once to their campaign. Missing economic evidence stays unavailable. |
| RL-6 | Prove the supervised workflow on an owned fork with isolated PostgreSQL, actual command/worker processes and browser controls. Parameterize the old AAPL/operator-specific fork harness. Freeze the registry snapshot and run a per-profile open/recenter/retain/convert matrix, plus shared-wallet concurrency/recovery cases. | RL-1–5. | All 12 current profiles have executable lifecycle evidence under feasible test conditions, or an explicit genuine market/funding block pending a feasible rerun; structural unsupported paths do not qualify. Test opposite token order, 500/3000/10000 fee tiers, multiple pools sharing USDG, two fee tiers sharing a risky token, simultaneous requests, queued exits, insufficient combined gas and closing one pool while another remains active. Interrupt signing/broadcast/withdraw/swap/mint stages; no duplicate nonce/swap, cross-campaign spend, allowance collision or contaminated P&L. Actual API/desktop/mobile parity and active-worker isolation pass. |
| RL-7 | Seal the qualified source, rerun RL-6 on that artifact, rehearse database backup/restore and migration/adoption, then prepare exact units, private wallet/config references, runbook and cutover proposal. Preserve current paper campaign identity and historical live readers. | RL-6. | Build/schema/config/Node identities are pinned; manifest and service readiness pass. No existing campaign silently adopts a new runtime. Rollback cannot erase signed actions. Restore preserves reservations, pending raw transactions, stage receipts and history. Report implemented, release-qualified and activation-ready separately. |
| RL-8 | Deploy the qualified all-pool capability, then exercise an explicitly approved bounded set of live campaigns through the dashboard using the one wallet. Take fresh per-pool and aggregate-wallet preflight before each admission. | RL-7 plus exact funding/campaign/limit authorization. | Every qualified registered pool is selectable; eligibility can change with fresh evidence. Receipt-reconciled openings appear immediately. Monitor a small funded set with independent custody/economics, without restricting the product to those exercised pools. Stop through the requested exit mode; preserve other active positions and closed history. Record actual live validation separately from all-pool fork qualification. |

Suggested delivery checkpoints:

1. **After RL-1/2:** every registered pool can be selected in Live mode and
   reviewed against the dedicated wallet; execution remains unavailable until
   the actual worker path qualifies.
2. **After RL-3–6:** the complete dashboard workflow works on a fork with real
   transaction/receipt state and process recovery.
3. **After RL-7:** a concrete release/launch package is ready for operator
   approval. RL-8 is the production action checkpoint.

## Specific implementation cautions

- `live-domain.ts` currently has `desired: running|stopped` and a single exit
  phase. `live-stage.ts` sells the risky leg during exit. Pause and retained
  exit need durable semantics; a UI label or service stop cannot implement them.
- `live-store.ts` uses the compatible wallet advisory lock but also performs
  CREATE/ALTER on runtime initialization. Its controller must honor wallet
  executor ownership and per-campaign allocations. Reuse the current journal,
  without letting independent controllers compete for the same wallet.
- The existing live Positions adapter uses legacy inventory names and quote
  defaults. Validate token identity/order/decimals and registered pool symbols
  at the adapter boundary. Keep historical rows readable while removing
  fallback assumptions from newly enabled campaigns.
- The October 2 paper numeric-ordering fix is already deployed. New live
  mapping/history queries must also sort bigint columns, including tests across
  the 999/1000 boundary.
- Current paper close/recenter proof does not qualify live execution. The
  current live diagnostic journal explicitly reports unavailable readiness;
  wire real executable evidence rather than changing its flags.
- Keep the reviewed source-exact feasibility proof, reference freshness and
  90-second observation guard. Faster generic gas sampling or reusable cost
  rows cannot replace per-attempt authorization/feasibility proof.
- The existing live controller's `cost.ts` retains its AAPL-only cost policy.
  The new generic review sampler does not replace that executable policy.
  RL-3 must consume qualified profile/allocation/stage-bound cost evidence in
  the actual shared queue before any non-AAPL campaign can sign.

## Next action and readiness decision

Keep the scope to one configured wallet, the existing wallet queue and the
existing deployment service. Do not add another worker/service. The paper
economics dashboard checkpoint is installed on `b7ac60b...`, source `4064cd6`;
actual API and desktop/mobile checks show all six campaigns with economics.
Newer unaccounted marks retain an explicitly timestamped, same-epoch complete
valuation. Modeled paper values remain distinct from live receipt evidence. The live path is not ready
for activation. Complete these gates in order:

1. **Hook up the composed runtime in the existing service, default closed.**
   `createRangeKeeperLiveRuntime` now composes the shared queue, campaign worker,
   observer, automatic planner and retain endpoints. The production service
   currently wires setup review/admission, but does not wire retain callbacks,
   construct this composed runtime or give the server its supervised
   worker-readiness callback. Wire it through the existing service lifecycle;
   keep management persistence, admission readiness, signing and publication
   disabled by default. The service must fail closed when v14 wallet history,
   complete custody or worker readiness is absent. No production migration or
   activation is part of this gate.
2. **Completed: retained-close Positions qualification.** The final real
   two-pool HTTP run admits and replays the persisted review, opens two allocated
   NFTs with sixteen canonical receipts, then completes retained withdrawal,
   cleanup, terminal lifecycle and allocation release with a seventeenth receipt.
   The sibling state/allocation remains unchanged. Actual Positions API shows
   recorded economics for both holdings, then terminal NAV/gas and history after
   closure; the exact request replays after release. Log:
   `/tmp/conc-liq-live-management-retain-closed-snapshot-20261003.log`.
   Earlier codec and retired-empty-NFT projection failures are fixed without
   weakening general ownership or source guards. External reference HTTP 503
   still blocks work; the supervised loop must exercise stale-lease recovery
   with fresh source/reference/budget checks before signing again.
3. **Prove automatic recenter and retain on the owned fork through that same
   composed runtime.** Exercise a source-pinned automatic holding observation,
   eligible recenter review, queue admission, canonical receipts, allowance
   cleanup, full retained exit and allocation release. Include exact-raw
   recovery after acknowledgement loss and ensure the sibling campaign stays
   funded, active and unchanged. Automatic recenter has planner/unit and
   PostgreSQL policy-CAS evidence, but no completed owned-fork management proof
   yet. Keep execution callbacks synthetic and fork-scoped in this qualification.
4. **Replace synthetic profile coverage with real registry coverage.** The
   twelve-profile HTTP/PostgreSQL result uses synthetic registry configurations
   that exercise token order, decimals, fee/spacing, shared USDG and replay
   contracts. It does not demonstrate twelve real registered pools executing
   on a fork. Run fresh, profile-driven preflight/reference/custody checks for
   every registered profile; then qualify each structurally supported and
   funded profile's opening and retained exit on the owned fork, reporting
   genuine market/funding blocks separately. Recheck the two-pool case with
   actual registered profiles and shared wallet allocations/NFT custody.
5. **Verify Positions evidence, then prepare the release.** Confirm actual API
   and browser points from open through recenter and retained closure use
   receipt-attributed inventory, gas and position-fee evidence; leave missing
   values unavailable. After all prior gates, seal the exact source, rehearse
   the existing v14 migration/backup/restore and supervised restart, and obtain
   a separate bounded live activation decision. Production remains on v11 until
   an explicitly reviewed migration; no live funding, signing, broadcast or
   activation is authorized by these rehearsals.

Pause/resume, conversion exit, additional wallets, private access, cosmetic
work and Research optimization remain deferred. Keep one safe retain exit as
the initial close path. Mandatory source, nonce, custody, allocation, budget,
receipt, allowance-cleanup and recovery checks remain launch gates.

Before the October 3 economics release: the deployed API returned six RangeKeeper paper rows
(five holding and one closed); all six had unavailable fees, gas, net NAV and
alpha. The worker's RangeKeeper branch bypasses the static/manual accounting
pipeline, and no paper fee-evidence rows have been recorded. This is unfinished
accounting integration, not a successful economics release. At that snapshot, services ran sealed build `0a2a395...`. The paper economics
checkpoint above supersedes that accounting/runtime status. Production remains
v11 and live execution remains disabled. This scope does not authorize funding, live signing/broadcast or
activation.

October 3 economics delivery: the deployed paper display is now `b7ac60b...`.
All six campaigns show modeled economics in the actual API and browser. During
indexer lag, valid same-epoch prior economics remain explicitly timestamped;
unaccounted history points remain unavailable. Proceed with the supervised live
runtime and automatic-recenter qualification using the existing all-pool,
multi-campaign wallet foundations.


### October 3 dashboard admission source checkpoint

The existing frozen-review admission/store is now connected to a guarded HTTP
route and dashboard approval control. Admission accepts only review ID/hash and
request ID; all wallet/capital/profile/config authority stays server-side.
It reserves the separate campaign allocation and shared OPEN job atomically.
The runtime performs exact-source canonical wallet/profile/reference revalidation
without a new snapshot write or acceptance-time fork. Shared Positions reads the
queued live job from first acceptance. The source remains compatible with v11
read-only operation; the live persistence path requires v14.

Real HTTP/PostgreSQL tests cover twelve synthetic registry configurations,
including opposite quote-token ordering, shared USDG/risky tokens, same-key replay,
changed-source rollback, closed readiness and unavailable economics. Browser
contract tests cover all selections and uncertain-response recovery. Source
checks passed 1,177 tests. See the
[admission checkpoint](../reviews/rangekeeper-live-dashboard-admission-2026-10-03.md)
for qualification limits and evidence.

Gate 2 is a source checkpoint, not production readiness: command admission stays
closed without the supervised management/retain executor. The new actual HTTP
boundary now passes two-pool opening, sixteen canonical stage receipts, allowance
cleanup and fresh-worker recovery on the owned fork. The Anvil missing-bytecode
failure was independently reduced and resolved using bounded in-memory fork
history; no token code, read or custody check was replaced.

Next: complete gates 1–3 through the existing service and wallet worker. Do not
reopen optional infrastructure or conversion/private-access scope. Production
paper release and live activation status are unchanged.
