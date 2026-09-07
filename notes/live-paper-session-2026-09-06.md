# Live paper session — 2026-09-06

**Superseded September 7:** the fixed charges and spot-price fills below were
illustrative. See the [execution realism correction](paper-execution-realism-2026-09-07.md).
This note preserves the original configuration and activation evidence.

Paper trading is now the next stage before any real-wallet preflight. Session
**1** started at **17:52:43 UTC** on the canonical NVDA/USDG 0.05% pool, with
1,000 simulated USDG. The first observation was recorded at **17:54:04 UTC**
from checkpoint **327**, block **56,171,280**, whose source time was 17:53:48 UTC.
It recorded a wait: the equity session was closed and the NVDA/USDG oracle inputs
were stale or excluded. No position was opened and no trading P&L was invented.

The [captured live API evidence](paper-evidence-2026-09-06/live-snapshot.json)
and [desktop](paper-evidence-2026-09-06/live-desktop.png) /
[mobile](paper-evidence-2026-09-06/live-mobile.png) screenshots are point-in-time
activation evidence. The session continues under `conc-liq-paper.timer`; inspect
the dashboard or database for its current state.

## Fixed experiment

| Setting | Initial session |
| --- | --- |
| Market | Canonical NVDA/USDG, fee 500 |
| Mode | Guarded; follows intended live market and data gates |
| Capital | 1,000 paper USDG |
| Range | Fixed, ±20 tick spacings; no rebalancing |
| Size limit | At most 1% of observed active liquidity |
| Holding limit | Six hours after simulated entry |
| Modeled costs | 1 USDG entry + 10 bps entry inventory haircut; 1 USDG exit |
| Decision/fill order | Fix the range at signal; fill at a later fresh checkpoint, cancel if price left the range |
| Guarded reference band | Pool/oracle deviation at most ±0.5% |
| Source freshness | At most 180 seconds at decision/fill |
| Gap limit | An open session with a checkpoint gap over 900 seconds becomes incomplete |
| Reference for reporting | Pool spot in USDG; explicitly simulated returns |

These parameters are an experimental starting point, not an optimized strategy,
a wallet allocation, or measured execution costs. The policy hash is stored
with the session. A changed policy requires a new session; previous observations
remain preserved. Wallet-specific balances, allowances, mint simulation and
broadcast approval are outside this paper worker.

The worker makes **no chain RPC calls**. It reads existing synchronized pool
checkpoints, risk/canonicality proofs, chain-health samples, and indexed swap
paths. PostgreSQL row locks and a per-session/checkpoint uniqueness constraint
prevent duplicate decisions. Only source blocks and captures after session
creation enter the forward journal. A missed decision cannot be filled later
at its old price.

Fee accrual uses exact bigint global-growth deltas only when the complete
observed swap path stayed inside the hypothetical range. The position adds no
liquidity to the actual pool, so self-dilution and price impact are unmodeled.
Fees are estimates; a range crossing stops economic claims because the existing
lightweight checkpoints cannot establish inside-range growth for that interval.
It does not trigger an archive backfill. Original journal evidence survives a
reorg, while the displayed economic result becomes invalid.

Entry costs reduce deployable capital and the initial passive benchmark uses
the same post-entry token holdings. Exit cash is reserved in paper inventory;
net value subtracts that reserve until exit charges it exactly once. Absolute
P&L compares net value with the 1,000 USDG starting balance. LP alpha compares
net value with those passive holdings. Maximum drawdown includes the initial
cost decrease. There is no annualized return extrapolation or claim of live
profitability.

## Operation and validation

- `npm run paper -- start [--policy FILE]` starts a session; one active session
  per stream is allowed.
- `npm run paper -- tick` processes the next unseen source checkpoint.
- `npm run paper -- stop` cancels a session before entry or signals a later exit.
- The timer runs every 15 seconds; source checkpoints arrive about every five
  minutes. A heartbeat is not a fresh valuation. The dashboard shows both.
- Full fee accounting remains paused. Tail, risk, checkpoint and RPC-health
  collection keep their existing cadences. Paper trading adds only local
  database work and does not ask for a wallet or key.

Typechecking and all **184 tests** passed, including forward-engine tests for
fee/cost/hold accounting, delayed fills, ordered source blocks, and invalidation.
The [isolated database audit](paper-evidence-2026-09-06/store-audit.mjs) verified
session uniqueness, policy serialization across restart, idle tick idempotency,
and stop-before/after-entry behavior; its temporary schema was removed.
[Database results](paper-evidence-2026-09-06/store-audit.json) are preserved.
The [browser audit](paper-evidence-2026-09-06/browser-audit.mjs) verified the live
waiting session on desktop/mobile and used in-browser fixtures to check the
performance curve and incomplete/missing data. Fixture profits were never
written to the database or captured as live results.

The next review should happen after an eligible paper lifecycle has produced
observations. Review absolute P&L and LP alpha together with modeled costs,
drawdown, data coverage and the decisions that produced them. Waiting through a
closed session does not establish a profitable strategy. A real wallet comes
only after that paper review and a separate execution preflight.
