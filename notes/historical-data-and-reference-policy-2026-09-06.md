# Historical data isolation and reference-policy comparison

Native HyperSync now supplies historical data for the running 15-pool collector.
The private node supplies near-head state and bounded canonicality checks.
The project has a working research platform; the LP strategy remains unproven
and execution remains disabled. The earlier project review is a separate snapshot.

## Current operational status

`HISTORY_SOURCE=hypersync` was activated at 10:40 UTC on September 6. At 11:36 UTC,
the restarted tail had completed 335 cycles with a median duration of 1,620 ms.
Three early native transport failures recovered through the existing tail retry
loop. The process did not restart and never fell back to private historical reads.
See [the runtime evidence](historical-evidence-2026-09-06/native-tail-runtime.json).

The hourly accounting pipeline was restored after a successful run at
11:36–11:37 UTC. At that time, with no independent archive endpoint,
the expensive fee-state snapshot reports `fee_accounting_snapshot_unavailable`
and performs no historical contract-state scans. Principal and baseline steps
validated their existing records, NFT collection skipped the empty token-ID list,
and action-cost run **22** saved 76 observations using native HyperSync.

A read-only database check confirmed all 76 new observations have
`sourceProvider=hypersync` and full calldata (75,462 bytes in total). The private
RPC health sample was healthy with zero reported lag at 11:38 UTC. This is a
point-in-time health observation, not a measured before/after load reduction.
See [the database verification](historical-evidence-2026-09-06/native-accounting-verification.json).

At 12:02 UTC, the supplied Alchemy endpoint was configured as
`RH_ARCHIVE_RPC_URL` after bounded historical-state validation. The first full
snapshot targeted block **55,962,325**, covering 15 pools, 1,483 ticks, and
10,363 positions. It checked every tick, then failed at 12:06 UTC on a provider
JSON-RPC error while reading a position. Retrying that exact call succeeded.
The original error code/message had been sanitized away, so its precise cause
is unavailable; a transient provider failure is an inference. The failed run
saved no partial accounting snapshot. See [initial activation evidence](historical-evidence-2026-09-06/alchemy-activation.json).

After the user confirmed that both providers have throughput and monthly
limits, full fee scans were disabled. `ACCOUNTING_FULL_SNAPSHOT_ENABLED=false`
skips that scheduled step before opening RPC/database connections. A separate
`ACCOUNTING_MAX_STATE_READS=500` cap rejects oversized full snapshots before
any provider request, even after opt-in. The last attempted source would need
**11,936 planned state reads**, or **8,593,920 per 30 days** at an hourly cadence,
excluding retries and metadata. Slowing those requests does not lower that
monthly total. The cap is a per-snapshot preflight, not a monthly usage meter.

Alchemy matched all 15 pools plus 15 sampled ticks and 15 sampled positions at
each of blocks **53,589,223** (September 3) and **55,889,182** (September 6).
Pool identity, price, liquidity, global fee growth, sampled outside/position fee
growth, and tokens owed agreed with the saved snapshots. Block hashes also
agreed between Alchemy, HyperSync, and the saved records. A fresh in-memory
sample reconciled all 15 pools, 30 boundary ticks, and 15 active positions at
block **55,960,725**. Validation made 378 Alchemy requests, 5 HyperSync requests,
zero private requests, and observed no provider errors.
See [state validation evidence](historical-evidence-2026-09-06/alchemy-state-validation.json).

The supplied Chainstack endpoint answered chain identity and current-head
requests, but returned HTTP 403 for historical block and contract-state reads:
its current plan excludes archive requests. Validation stopped without a bulk
scan (five diagnostic requests total). It is saved as a candidate endpoint in
ignored configuration and is not an active archive fallback.
See [the bounded validation](historical-evidence-2026-09-06/chainstack-state-validation.json)
and [the explicit plan response](historical-evidence-2026-09-06/chainstack-capability-probe.json).

The hourly pipeline completed successfully at 12:19 UTC with the full fee scan
skipped. Principal/baseline records were verified, NFT collection skipped its
empty configuration, and action-cost run **25** saved 79 observations through
HyperSync. The timer is enabled and the native tail remains active. Full fee
accounting remains at run 40. See [current budget and runtime evidence](historical-evidence-2026-09-06/archive-budget-activation.json).

## Provider boundary

| Work | Provider in `HISTORY_SOURCE=hypersync` mode |
| --- | --- |
| Pool creation evidence, historical/continuation logs, block metadata | Native HyperSync |
| Historical calldata and transaction fee fields for action-cost sampling | Native HyperSync, pinned to the indexed transaction block |
| Historical block proofs for principal, range, and policy replay | Native HyperSync |
| Budgeted historical pool/tick/position fee state, NFT state, allowances, oracle marks | Alchemy through explicit independent `RH_ARCHIVE_RPC_URL`; automatic full fee scans disabled |
| Chainstack candidate | Current-head access works; historical requests denied by the current plan |
| Current head, near-head manifest/risk/strategy state, canary checks | Private live node |
| Independent node-health quorum | Existing private/public quorum monitor |

The replacement credential permits native HyperSync `/query` and `/chain_id`.
Its HyperRPC requests are denied. The earlier credential permitted limited
HyperRPC access and was denied native access; those preliminary results are
retained in the evidence directory as historical records. Credentials are in
ignored `.env`, readable only by its owner, and are absent from these notes.

The native adapter follows the documented
[exclusive upper bounds, pagination, and rollback guards](https://docs.envio.dev/docs/HyperSync/hypersync-query).
It exposes only the block-metadata and log operations needed by existing readers;
it is not a general JSON-RPC server. Transaction sampling queries the known block
and selects the exact hash, so it never scans the chain looking for a transaction.
Calldata and receipt-derived fee fields come directly from native transaction
records. Optional missing L1 gas fields remain unavailable.

HyperSync history does not replace arbitrary historical `eth_call` state.
Historical-state access is required by the current retrospective accounting
implementation, rather than by every project feature. A source retaining the
requested block is sufficient; recent pinned reads do not inherently require
full archive retention. Persisting narrow forward snapshots can reduce future
archive dependence. Alchemy has now passed the sampled historical-state checks;
that does not establish availability for every past block or contract.
The separate archive provider must be on chain 4663 and accept explicitly pinned
state reads. The private host cannot be configured as either historical provider;
this configuration guard does not prove that differently named hosts are
operationally independent. The optional `HISTORY_SOURCE=envio` mode supports the
separate [HyperRPC product](https://docs.envio.dev/docs/HyperRPC/overview-hyperrpc).
`legacy` preserves the original single-node behavior for existing installations.

## Validation and guarantees

- At 10:31 UTC, native HyperSync matched **240 NVDA/500 events** across blocks
  **55,898,039–55,908,038**, including raw payloads, decoded arguments, and
  transaction/log inclusion fields. The terminal hash matched the captured DB
  checkpoint. Twenty sampled transactions matched inclusion and contained
  calldata plus L1 gas fields. This used no private-node calls or database writes.
  [Comparison evidence](historical-evidence-2026-09-06/native-comparison.jsonl).
- At 10:35 UTC, startup verified all 15 canonical pool identities using near-head
  private state and native creation evidence. The bounded dry run decoded
  **1,419 events** across the same 10,000 blocks, with no DB writes.
  [Startup evidence](historical-evidence-2026-09-06/native-backfill-smoke.jsonl).
- `npm run check` passes type checking and all 30 test files. Added coverage
  includes source isolation, chain identity, missing archive state, secret-free
  errors, exclusive pagination, invalid progress/ranges, cross-page reorgs,
  exact padded-hex quantities, missing L1 fields, malformed logs, event
  comparison, and rejection before cursor mutation.
- The native source verifies chain ID 4663 and follows every `next_block` page.
  It rejects invalid progress, rows outside a page, and inconsistent rollback
  guards. Existing cursor overlap and reorg recovery remain in use.
- Before cursor rewind, the requested terminal block must agree between native
  history and the private node. Each chunk's terminal hash is checked again
  before its atomic data/cursor write. This is not a proof of every provider row.
- No error falls back to private historical reads. Unsupported/signing methods
  and unpinned archive state are rejected. Manual writing backfills share the
  tail's advisory lock to prevent concurrent stream writers.
- Native history request pacing is 500 ms per URL within each process. Historical request
  timeout is 60 seconds including queueing. Native request failures surface to
  the caller; the integrated tail supplies bounded retry/recovery behavior.
  Archive/HyperRPC transports have at most two retries for transient network,
  HTTP 429/500/502/503/504, and selected JSON-RPC errors. Invalid parameters,
  ordinary contract reverts, and HTTP 403 do not retry. Retry logs include
  numeric error codes and provider roles without response text or credentials.
  Each retry repeats the same pinned request and is paced again. Account-wide
  pacing across independent processes is not coordinated.
  `Retry-After` seconds or HTTP dates are honored; an excessive delay stops
  the request instead of retrying early. Cancellation interrupts backoff.
- Archive pacing can be set independently with `ARCHIVE_REQUEST_INTERVAL_MS`;
  when absent it inherits history pacing. The Alchemy value was 100 ms for
  initial validation, then was set to **500 ms spacing** after pausing
  full snapshots. HyperSync remains at 500 ms. The accounting unit permits
  up to 30 minutes, but full snapshots now require both explicit opt-in and
  an adequate planned-read budget. Alchemy's [throughput limits are account-wide](https://www.alchemy.com/docs/reference/throughput);
  this pacing does not coordinate other applications sharing the account.
  Type checking and all **161 tests** pass, including independent pacing,
  bounded retry/rejection/cancellation behavior, credential-free error logs,
  disabled scheduled jobs without RPC/database access, and rejection of an
  oversized accounting snapshot before provider requests.
- New action-cost observations persist full input calldata and provider identity
  in their existing immutable JSON snapshots. Existing observations are not
  rewritten. This is a sampled transaction dataset, not a full-chain archive.
- The integrated tail still depends on the private-health circuit. Native
  historical availability does not override live-node or execution-risk gates.

## Operation and remaining work

The current ignored environment selects native HyperSync. A new installation
needs `HISTORY_SOURCE=hypersync`, `ENVIO_API_TOKEN`, and optionally
`HYPERSYNC_URL` (default `https://4663.hypersync.xyz`). Before activation, compare
an existing stream and run a complete manifest/startup dry run:

```bash
set -a
source .env
set +a
npm run history:compare -- --blocks 10000
```

The comparison chooses the latest stored terminal checkpoint, captures its data
in a repeatable-read, read-only transaction, and reports the exact window. The
maximum window is 25,000 blocks and transaction sampling is capped at 20. A named
older checkpoint may have been replaced by the tail's overlap scan; report a new
window under its actual identity, not as a reproduction of an old one.

After validation, restart `conc-liq-tail.service`; the existing units already
read `.env`. Watch `tail_historical_source`, `tail_cycle_complete`, and
`fee_accounting_snapshot_unavailable`. For a replacement archive provider,
validate a bounded exact-state snapshot before allowing full fee-state scans.
The read-only [validation script](historical-evidence-2026-09-06/validate-archive-state.mjs)
compares the oldest/newest saved accounting snapshots and a bounded current
sample. Run it from the repository root with `node --import tsx`; it writes
local evidence and performs no database writes. Run it separately from full
accounting to avoid combining independently paced archive workloads.
Restoring `HISTORY_SOURCE=legacy` intentionally restores private historical load
and is not an automatic recovery path.

Native HyperSync and sampled Alchemy historical-state access are resolved.
Full Alchemy accounting refreshes remain disabled. After the user's scope
correction, archive infrastructure and shared quota accounting are deferred;
the earlier question about provider allowances does not block the next
execution milestone. The [revised next slice](../README.md#next-slice) is one
NVDA/USDG mint/observe/decrease/collect lifecycle, simulated first, using recent
private-node state and our own persisted position observations. HyperSync
continues to cover bulk historical events and transaction evidence.

An archive provider can answer specific retrospective questions later. It
should not be used to make exhaustive historical accounting a prerequisite
for observing one actual position. The reference-policy comparison below
remains a future research specification; a first limited open-session trial
can use an already validated current mark. Such a trial establishes operational
behavior, not economic edge or weekend-policy validity.

## Reference decision

A continuously fresh equity quote is not a prerequisite for every possible LP
policy. The proposal to use an equity feed while available and a last valid
equity anchor during a verified market closure is a reasonable research
hypothesis. A fixed band restricts the strategy's liquidity range; it does not
bound economic losses or prevent adverse selection before a reopening gap.

Chainlink supplies an on-chain, timestamped token-denominated mark that can be
read at the same block as pool state. That is useful for reproducible accounting
and safety checks, but it is not the only permissible economic reference.
Nasdaq or another suitable equity feed can supply the underlying price. We still
need exact instrument mapping, exchange/source and availability timestamps,
bid/ask quality, verified session/holiday/halt state, and corporate-action data.
No Nasdaq subscription or historical quote source has been selected or validated.

Robinhood documents that its
[REST prices are raw underlying bid/ask and Chainlink is multiplier-adjusted](https://docs.robinhood.com/chain/stock-token-apis/).
Normalize raw equity marks once using shares per token, then translate USD into
USDG using an independently justified quote-token mark. Do not apply the
multiplier twice to Chainlink data or assume USDG is always exactly one dollar.
Changing the equity reference does not remove quote-token or chain-health risks.

Hyperliquid/trade[XYZ] supplies additional market information while cash-equity
quotes are unavailable. Its internal-weekend price may evolve without a new
external equity price. It can be a risk indicator in the experiment; it should
not silently replace the equity close or become a mandatory feed for every
variant. Keep the current perp path in research until the comparison supports
an explicit policy change.

## Fixed comparison specification

Compare the following policies on the **same complete decision timeline**:

| Policy | Available equity session | Verified closure |
| --- | --- | --- |
| Fresh-primary baseline | Admit only a valid fresh normalized equity/token mark | Do not add or recenter exposure; model the existing position and explicit removal rule |
| Equity-close anchor | Same fresh primary | Freeze the last valid anchor, use configured age-dependent bands/inventory limits, and prohibit chasing pool spot |
| Anchor plus optional perp signal | Same fresh primary | Same frozen anchor; a valid adverse perp signal may reduce exposure or widen the no-entry region; missing perp data follows the declared anchor policy |

These are specifications for the next replay change, not implemented execution
permissions or completed economic results. A closure must be established by the
instrument's calendar and venue status; a stale feed during an open session is
an outage, not an automatic invitation to use the closure policy. Unknown halt,
pending corporate action, expired anchor, or unavailable quote normalization
must be represented as explicit unavailable/blocked observations.

Persist source identity, instrument, raw bid/ask, source timestamp, receive time,
session status, multiplier and effective time, quote normalization, anchor
identity/age, decision time, and block hash. Information can influence a decision
only after it was available; model execution at a subsequent eligible pool state.
Preserve rejected intervals and mark-to-reopening inventory, including cases
that cross the LP range. Do not discard losing or unavailable intervals.

Use identical starting wealth, pool/fee tier, and declared cost/latency/size
assumptions. Compare passive inventory and static LP alongside active variants.
Report net alpha versus passive holding, absolute NAV P&L, drawdown, inventory
concentration, turnover, costs, coverage, rejected time, and reopening loss.
Select band/age parameters on training windows and evaluate later held-out
windows. A fixed-width anchor is an experiment, not a claim of predictable prices.

Before producing that comparison, repair the review's availability-time join,
rejected-interval handling, canonicality check, multi-day window limit, and
incomplete lifecycle cost model. Begin with a fully costed static LP lifecycle.
The archive provider and a validated equity-history source are outstanding data
requirements. The new native transaction samples can support comparable lifecycle
cost modeling; retain a narrow NVDA/500 strategy comparison before expanding it.
