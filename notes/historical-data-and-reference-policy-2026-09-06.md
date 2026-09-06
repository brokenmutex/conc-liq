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
11:36–11:37 UTC. Its timer is enabled. With no independent archive endpoint,
the expensive fee-state snapshot reports `fee_accounting_snapshot_unavailable`
and performs no historical contract-state scans. Principal and baseline steps
validated their existing records, NFT collection skipped the empty token-ID list,
and action-cost run **22** saved 76 observations using native HyperSync.

A read-only database check confirmed all 76 new observations have
`sourceProvider=hypersync` and full calldata (75,462 bytes in total). The private
RPC health sample was healthy with zero reported lag at 11:38 UTC. This is a
point-in-time health observation, not a measured before/after load reduction.
See [the database verification](historical-evidence-2026-09-06/native-accounting-verification.json).

Full fee-growth/position accounting remains unavailable until
`RH_ARCHIVE_RPC_URL` is configured. The previous accounting snapshot remains old;
the resumed timer does not imply fresh fee-state accounting.

## Provider boundary

| Work | Provider in `HISTORY_SOURCE=hypersync` mode |
| --- | --- |
| Pool creation evidence, historical/continuation logs, block metadata | Native HyperSync |
| Historical calldata and transaction fee fields for action-cost sampling | Native HyperSync, pinned to the indexed transaction block |
| Historical block proofs for principal, range, and policy replay | Native HyperSync |
| Historical pool/tick/position fee state, NFT state, allowances, oracle marks | Explicit independent `RH_ARCHIVE_RPC_URL` |
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
- Request pacing is 500 ms per URL within each process. Historical request
  timeout is 60 seconds including queueing. Native request failures surface to
  the caller; the integrated tail supplies bounded retry/recovery behavior.
  The optional HyperRPC mode has two bounded HTTP 429 retries. Account-wide
  pacing across independent processes is not coordinated.
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
`fee_accounting_snapshot_unavailable`. Once an archive provider is supplied,
validate a bounded exact-state snapshot before allowing full fee-state scans.
Restoring `HISTORY_SOURCE=legacy` intentionally restores private historical load
and is not an automatic recovery path.

The immediate remaining data requirements are an independent archive provider
and a validated equity-history source. Native HyperSync access is resolved.

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
