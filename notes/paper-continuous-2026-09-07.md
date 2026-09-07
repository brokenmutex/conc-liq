# Continuous forward paper session — September 7, 2026

Session **4** is the first forward paper position opened by the transaction
simulator. It evaluates entries around the clock, including overnight and
closed-market hours. The earlier regular-hours session 3 was closed without a
position, preserving its policy hash and ten observations. No real wallet,
signer or upstream transaction submission is involved.

## First entry and subsequent market observations

The successful entry used an order recorded at **09:12:01.123 UTC**, followed by
source block **56,717,784** at **09:12:47 UTC**. Simulation and persistence
completed at **09:13:19.295 UTC**. This ordering matters: the amount, minimum swap
output and LP range were fixed before the execution block arrived. The earlier
09:03 quote was not filled after the database interruption described below.

[First-fill evidence](paper-continuous-evidence-2026-09-07/first-fill.json)
contains the order, actual contract simulations, full node gas/prestate evidence,
fee-conversion rounds, and the first subsequent holding observation.

| Entry measurement | Value |
| --- | --- |
| Initial LP allocation | 1,000 paper USDG |
| Fixed tick range | 221610–222010 |
| Simulated liquidity minted | 3,211,439,772,439,956 |
| Share of observed active liquidity at entry | Approximately 0.02886% |
| Entry gas estimate | 0.000299887116240 ETH / 0.747725 USDG |
| Initial exit gas reserve | 0.000181262871230 ETH / 0.451953 USDG |
| Initial net LP value, after entry costs and reserve | 998.548052 USDG |
| Initial net P&L | −1.451948 USDG |
| Initial alpha versus acquired passive holdings | −1.009362 USDG |
| Execution fork reads | 140, below the 400-request cap |

These are simulated entry values, not final profit or mainnet receipts. The
first subsequent interval covered **39 real indexed swaps** and accumulated
**0.000479 USDG of estimated LP fees**. The process remains open at this audit
boundary. Its six-hour holding limit is **15:12:47 UTC / 18:12:47 Vilnius time**;
a later checkpoint triggers the exit simulation. Risk conditions can request
an earlier exit; invalid coverage can invalidate the performance result.

## Reference policy: continuous evaluation, explicit older prices

The immutable policy hash is
`99781c7894225d594a46f4087157f47983db12af074e31558ef5235083bd66d5`.
The `continuous_bounded_v1` policy uses an initial **±3%** bound around the
published NVDA token reference. This is a trial constraint, not a fitted or
proven profitable threshold. It is independent of the separate **0.5% swap
slippage limit**, which constrains actual contract execution.

A structurally valid equity round is accepted within its published heartbeat,
capped at 24 hours. When equity markets are closed, an older published round can
serve as a **held reference** for up to 96 hours, provided it updated during or
after the most recent regular equity session's opening. This includes long
weekends and holidays but prevents an outage through a later weekday from
being excused as another closure. The supported calendar is currently 2026.
The dashboard shows the held reference's original timestamp and price band.
It is not described as a current quote or an exact last-close price.

The source used here was published **September 4 at 17:46:24 UTC**. Its price is
approximately **230.250675 USDG/NVDA**, including the actual USDG/USD conversion.
At the preflight snapshot the pool was about 1.2% above that anchor. The policy
was evaluated against both the checkpoint's immutable risk snapshot and the
latest fresh canonical risk snapshot.

This behavior follows the distinction in Chainlink's
[Robinhood feed documentation](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood#off-hours-and-session-behavior):
equity feeds can hold their last publication during closed sessions, and
consumers need suitable age bounds. The same source explains that token prices
include the corporate-action multiplier. The worker therefore retains issuer
pause, multiplier consistency, pending-action, token identity, round completeness,
positive-price and canonicality checks. A held reference is never an exception
to those checks. No Nasdaq or Hyperliquid price was substituted in this run.

Gas conversion now uses ETH/USD and USDG/USD feed-specific heartbeats, capped
at 24 hours. Previously a blanket five-minute limit rejected USDG even within
its declared 86,400-second heartbeat. At entry, the actual ETH round was 2,404
seconds old and the USDG round 63,703 seconds old. Their ages and round identities
are saved. USDG is not assumed to equal one dollar; neither conversion is an
executable foreign-exchange quote. Gas remains visible separately in ETH.

## RPC replacement and checkpoint recovery

The configured reference pair is now **official Robinhood RPC + Alchemy**.
Blockreq was removed from the private `.env` reference list after intermittent
public-access refusals prevented a continuous healthy window. Both supplied
Alchemy and Chainstack endpoints were tested for chain ID 4663 and current
blocks. Chainstack remains an unpolled reserve; it is not used for history or
extra continuous checks. Endpoint credentials are intentionally absent here.

The existing monitor issues three read methods per successful reference poll:
chain ID, head block and confirmed anchor block. At a ten-second interval, the
Alchemy reference accounts for at most about **777,600 JSON-RPC requests per
30 days**, before timing overhead. This is a request-count estimate, not a
provider billing-unit or quota guarantee. The two-round-trip diagnostics are
separate. Historical events continue through HyperSync; transaction simulation
and checkpoint state reads use the private node.

A **checkpoint** is a saved, block-specific pool snapshot: price/tick, active
liquidity, cumulative fee growth, and associated reference/risk evidence. A
missing checkpoint means a scheduled collection did not complete. Blocks and
indexed swaps may still exist; the worker does not replace the missing snapshot
with zero fees or claim it made a decision at that time.

The targeted NVDA checkpoint timer now runs **once per minute**, instead of
once every five minutes. A just-collected snapshot may briefly be newer than
the last health poll's confirmed anchor. The paper worker now leaves such a
snapshot unconsumed and tries it after confirmation, rather than recording a
premature wait and discarding that opportunity. Event coverage and source-age
checks remain required.

## Database locking correction found during the first live attempt

The old paper tick held a repeatable-read transaction open while the external
simulation ran. Scheduled jobs perform additive schema setup at startup. A
queued schema lock waited for the paper transaction, while the simulator's
independent fresh-risk reader queued behind the schema lock. This application
lock cycle stalled the first live attempt and dashboard reads.

The paper timer/worker was briefly stopped to release the transaction. That
attempt committed no position and charged no gas. The corrected worker holds
a **session advisory lock**, commits its read transaction before network work,
then opens a short transaction to validate and record the result. It rereads
session state, source identity/coverage, and prior-source canonicality. An
operator cancellation or invalidated source during simulation cannot become a
fill. The executor's independent database reads now have a ten-second statement
timeout and check source age again after preflight.

This allows scheduled schema maintenance to finish while a simulation is in
progress. It also keeps concurrent ticks from duplicating an order without
blocking operator cancellation behind a long read transaction.

## Validation and operational follow-through

TypeScript and **204 tests** pass, including held-price holiday/session bounds,
feed-specific freshness, deviation limits, pause/multiplier/round checks and
preservation of the prior session's hash. The
[isolated PostgreSQL audit](paper-continuous-evidence-2026-09-07/store-audit.json)
checks confirmation deferral, restarts, duplicate ticks, entry gas/inventory,
failed-exit retry, reserve replacement, concurrent schema maintenance,
cancellation during preflight, and canonicality/evidence revocation. Its
synthetic test sessions were removed with their temporary schema.

[Browser evidence](paper-continuous-evidence-2026-09-07/live-snapshot.json)
shows the actual open position and subsequent holding observations on desktop
and mobile. The 24/7 policy, held-reference timestamp/band, simulated gas,
reserved exit cost and holding deadline are visible. Missing reference values
and absent sessions clear or mark unavailable values without browser errors.

The running worker should be left to gather the forward holding period and
perform its fresh exit simulation. The dashboard/DB is the current source of
truth; this note captures the initial opening, not a completed six-hour result.
Do not shorten the holding period merely to manufacture a completed test.
No scheduled message, funded trade or additional archival service was created.

Remaining paper-versus-live limits from the
[transaction simulation note](paper-transaction-simulation-2026-09-07.md)
still apply: fee income uses observed in-range growth with no counterfactual
liquidity dilution; marks use pool spot; inclusion queues, intervening trades
within the simulated action sequence, post-submission failures and MEV are not
fully reproduced. The first position is small relative to observed liquidity,
but that does not turn its estimated fees or gas into realized income.
