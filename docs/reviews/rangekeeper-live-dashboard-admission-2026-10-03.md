# RangeKeeper dashboard admission checkpoint, October 3

Current checkpoint: paper economics display is deployed on sealed `b7ac60b...`
and all six campaigns have visible modeled economics, including explicitly dated
prior complete valuations when current accounting is pending. Live source passes
1,204 tests and real HTTP opening of two concurrent pools followed by retained
closure, release, same-key replay, and actual Positions economics/history.
Automatic management composition is default-off; supervised production hookup,
automatic-recenter fork qualification, and bounded live cutover remain open.

This source checkpoint connects the existing Live setup review to the existing
shared-wallet reservation and OPEN job queue. It adds no transaction service,
signer, wallet, schema version or per-pool whitelist.

The command route accepts only server review ID/hash and request UUID, under
existing origin/session/CSRF checks. It requires an explicit ready admission
worker; absent/failed readiness stops before a callback or reservation. The
catalog and preflight expose that separate capability. A queued response does
not claim confirmed holding or execution eligibility.

The runtime uses its existing atomic admission adapter. It rereads the exact
registered profile, pinned confirmed source, frozen wallet code, full inventory,
commitments, nonce, complete NFT custody, allowances and selected independent
references. Exact candidate/cost/allocation hashes remain frozen. It returns the
original reviewed payload, preserving transport metadata, without replacing the
wallet generation or rerunning a fork at acceptance. The shared store rechecks
and reserves under its wallet transaction lock. Exact retries recover the same
campaign/allocation/job; another request digest conflicts.

An explicit `DEPLOYMENT_LIVE_REVIEW_PERSISTENCE=1` supplies a separate writable
review pool; default is closed. The command's indexer remains read-only. The
production command does not yet supply live admission worker readiness, so this
source cannot enable production approval or signing by itself. Wallet history
coordination is a read/check-only hook; HTTP does not scan the chain.

The dashboard shows approval only for a complete unexpired persisted review with
both capabilities present. It saves the request key before sending and retries
uncertain outcomes with the exact body. Shared Positions now reads live queue
progress as well as legacy operation progress, guarded for v11 compatibility.
Queued inventory, fees, NAV and paid costs remain unavailable until evidence
exists.

Validation:

- Final source repository checks, typecheck and 1,177 tests in 94 suites passed,
  including the simulation startup changes. Focused tests also passed 35/35.
- Real HTTP and isolated v14 PostgreSQL acceptance passed for twelve synthetic
  registered profile configurations matching the registry fee/spacing and
  quote-token ordering. GOOGL/SPY quote with token1; others with token0.
  Repeated fee tiers share their risky token, and all campaigns share USDG.
  Twelve campaign/allocation/jobs, exact retry, conflict, changed-source rollback,
  closed readiness, origin/CSRF/strict request and shared Positions visibility
  were checked. No stage outbox, signature or broadcast was created.
- The mocked-service browser acceptance passed all twelve selectable profiles,
  an uncertain 503 followed by same-key retry, unavailable/stale/malformed wallet
  cases, approval visible/usable at 1440 and 390 pixels, and unchanged Paper setup
  behavior. This is UI contract evidence, not
  real chain execution evidence.
- The existing two-pool owned-fork worker harness now has
  `--two-pools --dashboard-admission`, driving preflight and admission over real
  HTTP into the canonical runtime/worker. Its current qualification status and
  final diagnostics are recorded below; prior direct-worker fork successes do
  not substitute for this new boundary.

No production migration, restart, funding, live signing/broadcast or activation
was performed in this checkpoint. The paper economics release remains deployed.
Unrelated dirty source and previous live prerequisites are preserved.

Next work stays on the shortest live path: qualify the HTTP opening, connect the
existing shared-wallet worker to automatic management and retain-only exit, project
receipt-attributed economics, then qualify a sealed all-pool release/cutover.
Pause/resume, conversion exit, additional wallets and private access stay deferred.


The fork qualification exposed two fixture problems before signing: cold
metadata reads for sibling profiles, and setup simulation startup. The harness
now warms the immutable registry/pool/token/oracle metadata before generating
its short-lived funded source. The setup simulator uses zero generated accounts
and zero implicit RPC retries, matching the existing owned-fork runner, with
bounded redacted startup diagnostics. These changes do not extend review/source
freshness or relax eligibility.

Foundry RPC disk caching is disabled for source-pinned owned simulations. Its
shared directory is keyed by chain and block number, which can also identify
different synthetic histories; the owned read proxy provides reuse bound to the
exact source. Disabling disk caching alone did not resolve a later Anvil missing
bytecode error for an untouched SPY token during second-pool reconciliation.
An attempted fixture seed of hash-matched original token bytecode also did not
resolve that error and was removed. No contract-code mutation is retained in the
qualification fixture. Qualification must pin the simulator binary that passes
the composed path; no simulator version change has been deployed to production.

## Final owned-fork result

The final composed run used real registered AAPL fee-500 and fee-3000 profiles,
all twelve profiles for wallet custody scope, the real HTTP preflight/admission
routes, isolated v14 PostgreSQL, and one owned loopback fork. The upstream
boundary remained read-only. The synthetic wallet was funded and signed only
inside that owned fork; no production key was loaded.

Fee-500 passed HTTP review, persisted admission and exact replay, then opening
through swap, mint and allowance cleanup. All eight stages had canonical receipt
and effect evidence; the final stage had cleanup evidence. The harness also
passed exact signed-byte recovery after injected acknowledgement loss, fresh
worker composition after the queue-finish handoff fault, one cost event per
receipt, NFT custody, zero allowances, and conservation of capital outside the
allocation. This tests fresh runtime composition, not an OS process restart.

Fee-3000 passed its own real HTTP review/admission/replay and separate reservation
while the first position remained active. At the retained observation, its first
three stages were confirmed. The run then exited nonzero during whole-wallet
receipt reconciliation: Anvil reported `missing bytecode for code hash` while
reading `balanceOf` on the unrelated registered SPY token
`0x117cc2133c37b721f49de2a7a74833232b3b4c0c`. Warming each canonical token balance
path at the immutable base did not resolve it. No token read or receipt check was
skipped, and no balance was substituted. The composed two-pool execution gate is
therefore still open; twelve-profile synthetic admission success does not prove
twelve-profile execution readiness.

The simulator is the same v1.7.1 binary as the deployed paper release, SHA256
`10c1c727d6c1de973aeb160e59875b9a9a23464d6e74149ee8abb30b3500311b`.
The precise simulator failure should be reduced before choosing a fixture repair
or qualifying another pinned binary. Do not extend review deadlines, weaken
custody reconciliation, or add another trading service to work around it.

Retained evidence:

- `/tmp/conc-liq-live-dashboard-source-final-no-cache-20261003.log`
- `/tmp/conc-liq-live-dashboard-final-focused-20261003.log`
- `/tmp/conc-liq-live-dashboard-http-pg-20261003.log`
- `/tmp/conc-liq-live-dashboard-browser-final-20261003.log`
- `/tmp/conc-liq-live-dashboard-worker-fork-base-balances-20261003.log`
- `/tmp/conc-liq-live-dashboard-owned-fork-stage-progress-20261003.json`

The read-only production API check at `2026-10-03T03:29:52.482Z` found modeled NAV,
fees, passive comparison and cost bounds on four of six paper campaigns; newer
marks on the other two awaited accounting evidence. Snapshot:
`/tmp/conc-liq-live-dashboard-paper-economics-current-20261003.json`.
Dashboard, command and paper-worker services remained active; both live services
remained inactive. No production changes were made for this source checkpoint.
The owned fork was closed, its test schema was removed, and the exact disposable
database was dropped after verifying no tables or connected clients remained.
The private temporary fork environment file was removed; logs above are retained.

## October 3 simulator reduction follow-up

The failure was reduced independently of campaigns, PostgreSQL, and signing in
`test/integration/anvil-wallet-history-fork.mjs`. With token accounts retained
locally at their exact canonical native balances, historical calls failed after
hundreds of empty local blocks for several token contracts sharing identical
bytecode. Their original code and ERC20 storage were unchanged. Read-only calls
without those local account records passed the same history length.

In the installed Foundry commit, disk eviction serializes each account using
`contracts.remove(code_hash)`; subsequent accounts sharing that hash cannot all
retain their code in the serialized snapshot. This is the source-level explanation
consistent with the reduced failure, not a claim that RPC disk caching caused it.
See [the pinned serializer](https://github.com/foundry-rs/foundry/blob/4072e48705af9d93e3c0f6e29e93b5e9a40caed8/crates/anvil/src/eth/backend/db.rs#L323)
and [historical state eviction](https://github.com/foundry-rs/foundry/blob/4072e48705af9d93e3c0f6e29e93b5e9a40caed8/crates/anvil/src/eth/backend/mem/storage.rs#L143).

Owned forks now retain up to 4,096 historical states in memory with
`--prune-history 4096`, avoiding that disk serialization path. The reduced fixture
then passed twenty 64-block batches (1,280 local blocks), preserving the original
canonical token code hashes and balances. Confirmation/source/custody guards and
the simulator binary are unchanged. No such configuration has been deployed.
Logs: `/tmp/conc-liq-anvil-history-touched-20261003.log` (failure) and
`/tmp/conc-liq-anvil-history-memory-20261003.log` (pass).

A fresh composed attempt with the original four-spacing opening range was
correctly rejected as `inventory_deployment_unfeasible` before signing. A wider
reviewed twenty-spacing range then passed as an explicit setup parameter; the
rejection is not bypassed and no production campaign parameters are changed.

The real HTTP two-pool run now passes for AAPL fee-500 and fee-3000 with sixteen
confirmed stages and distinct NFTs. The second opening preserves the first
campaign's state, allocation and NFT position, and uses unique wallet nonces.
Each receipt is attributed once, all allowances are cleared, and free capital
is conserved. Signed-raw acknowledgement recovery and queue-finish handoff
recovery also pass. Log:
`/tmp/conc-liq-live-management-two-pool-wide-20261003.log`.

The next source slice funds finite campaign management gas in the initial
allocation: entry gas plus `(entry gas + complete exit gas) * maxRecenters`,
plus the protected exit reserve. A count-unlimited policy initially funds one
management bundle; it remains constrained by available native funds and cost
budgets. This is conservative reserved funding, not measured future spending.
The reviewed retain routes reuse immutable previews, atomic queue admission and
same-key replay; execution and allocation release await canonical withdrawal,
receipt and allowance/custody evidence. Qualification is in progress; these
source changes have not been deployed.

## Final management and Positions qualification

`/tmp/conc-liq-live-management-retain-closed-snapshot-20261003.log` passes the
complete real HTTP path on isolated v14 PostgreSQL and an owned loopback fork.
The twelve real registered profiles define custody/token/code scope; actual
executed pools are AAPL fee-500 and fee-3000. A reviewed twenty-spacing width is
an explicit test input, not a changed production campaign parameter.

Both openings have eight canonical receipts and distinct managed NFTs; wallet
nonces are unique, receipt costs are attributed once, allowances are zero, and
free/sibling capital is preserved. Lost acknowledgement recovery reuses persisted
raw bytes; queue-finish handoff recovery uses a fresh runtime composition. The
real Positions API shows two recorded live holdings with NAV, fees, gas and
passive values. One dashboard retain review/admission then withdraws/collects
with one additional canonical receipt, records the terminal lifecycle, releases
that allocation, and preserves the sibling state/allocation. Exact request retry
after closure returns the same job. Closed detail has recorded NAV/gas and at
least two history points with P&L; the run reports seventeen signer calls and
zero upstream mutations. This is local execution qualification, not live trading.

The integration found and fixed two persistence boundaries: management admission
now passes the exact marker-encoded saved review into the queue; terminal effects
decode their saved snapshot before checking its source. A lingering empty NFT is
normalized only for the terminal view after cleanup, retirement, owner/profile,
zero-liquidity and zero-owed checks. General campaign ownership guards remain.
Native capital includes its frozen opening valuation, avoiding a token-only P&L
baseline or a second gas subtraction; receipt/native spending remains measured.
History epochs use the producer's bound accounting state.

The default-off composed runtime reuses the existing queue, worker, observer,
planner and retain APIs. Policy observations persist before their valuation mark;
duplicate sources replay without advancing timers/events. Planner and PostgreSQL
tests verify campaign-scoped liquid/native inputs and persisted-review admission.
Automatic recenter still lacks a completed owned-fork proof. Its process-local
readiness cannot establish that another supervised worker is alive; the command
server still lacks that worker/build/wallet proof and remains closed. Reuse the
existing RangeKeeper service for the supervised loop, including stale-lease and
reference-outage recovery. Do not add another trading service or load a signer
in the command process just to expose readiness.

Full repository/type/source checks pass 1,204 tests in 95 suites:
`/tmp/conc-liq-live-management-closed-final-source-check-20261003.log`.
The fork is closed; its isolated schemas/database and private temporary environment
are removed. Logs are retained with the paper fallback backup. No production
live migration, funding, signing, broadcast or activation occurred. The actual
paper rollout and API/browser checks are documented separately in the economics
review; unrelated dirty prerequisites remain preserved.
