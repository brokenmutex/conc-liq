# Continuous NVDA paper experiment — September 8, 2026

Automatic paper reentry follows a valid full cash exit. Each successor uses the predecessor's final USDG NAV, after all estimated entry and exit gas, as its entire budget. There are no simulated top-ups. Session policies and execution records remain separate and immutable; the policy's `reentry.previousSessionId` links their funding history.

Policy: [paper-nvda-ticks20-continuous.json](../config/paper-nvda-ticks20-continuous.json). It preserves the selected fixed ±20 raw ticks, 80% LP allocation, 60% NVDA inventory exit, ±5% independent-reference bound, maximum 24-hour holding period per position, and existing source, slippage, liquidity-share, issuer and reference gates. Each entry centers a fresh range and freezes its quote before a later checkpoint simulation. Holding positions are not routinely recentered.

A successor may exist in `waiting` immediately after closure. No quote or entry is allowed until a checkpoint is at least **600 seconds after the persisted exit observation**, and the existing **300 seconds of continuously healthy RPC evidence** passes. These conditions may overlap; an outage can extend the wait indefinitely. Fresh reference checks still apply to both the price and the range. The existing session-aware held-reference policy is retained, including its heartbeat and 96-hour maximum; reentry does not loosen market-data freshness.

`paper stop` persistently disables automatic reentry and schedules an open position's full cash exit. Stopping during a quote or entry preflight prevents that result becoming a fill. A cancelled waiting session, invalid accounting, invalid ancestor evidence, or an unverified cash exit cannot automatically restart. Explicit `start --after` can resume a manually stopped, successfully liquidated session after validating its full history; invalid or unfunded history must first be investigated. Budgets above the existing 10,000 USDG simulator cap also stop automatic continuation.

A stream advisory lock and the existing unique active-session constraint prevent duplicate successors. Runtime identity is enforced on automatic continuation; closed historical ancestors keep their original identities, and an explicit continuation can adopt a newly sealed release. Every active descendant rechecks all ancestor policies, canonical observations and execution evidence, including after unlocked simulation. No database migration is needed; optional policy/state fields use the existing JSON records.

The dashboard adds cumulative P&L versus the original experiment budget, summed estimated gas, and alpha versus the **original** passive holdings valued at the latest session checkpoint. The passive comparator does not reset at each reentry. Its mark timestamp is explicit, including while the strategy waits in cash. Existing session metrics and charts remain labeled as session results. Invalid ancestry hides performance. Hypothetical LP fees and fork gas estimates remain estimates, not mainnet realized profit.

The boundary reader now copies only the tick bounds into each new fee proof. Previously, passing a full position into a structurally typed range parameter also copied its historical proof and wallet fields, nesting old position records in subsequent marks. Historical records remain untouched; future proofs have a bounded shape and retain the same fee inputs.

## Operations

Use the currently installed paper service's sealed release and pinned Node binary:

```text
<release>/bin/node <release>/launch.mjs /root/conc-liq/data/runtime-refactor.env paper start --policy config/paper-nvda-ticks20-continuous.json --after 5
<release>/bin/node <release>/launch.mjs /root/conc-liq/data/runtime-refactor.env paper stop
```

The first command is a one-time activation example. Do not repeat it after a successor exists; the latest-session requirement rejects it. The 15-second timer creates subsequent waiting sessions and processes canonical checkpoints. No wallet keys, real funds or upstream broadcasts are involved.

## Validation

TypeScript and all 256 unit tests pass. Unit coverage verifies loss/cost conservation, a non-resetting passive comparator, rejected incomplete/unreconciled exits, bounded boundary proofs across 100 marks, and actual dashboard rendering of cumulative and session results. The isolated PostgreSQL lifecycle additionally exercises duplicate prevention, restart, cooldown and unhealthy-recovery blocking, automatic creation followed by quote and later entry, runtime mismatch, cumulative accounting, durable manual stop, explicit recovery, and ancestor-evidence revocation. Synthetic fixtures are not profitability evidence.

## Activation

Source commit `e8e231ddf632c4fc83ff314fdec5bcb1b4054172` is deployed as sealed build `f30da7e894227a4ba2e684a5d24fb0f6aadb296a1712919662ba84c8c0ee7f1c` to the paper worker and dashboard. Data collectors retain their existing releases. All five relevant services/timers (paper, dashboard, tail, RPC health and strategy checkpoints) were active after deployment.

Session **6** was created at **11:57:47 UTC / 14:57:47 Vilnius**, explicitly continuing session **5**. Its starting cash is exactly **1,000.043983 USDG**, rather than a fresh 1,000 USDG allocation. The original session's 0.869274 USDG estimated gas remains in cumulative costs. Its original 1,000 USDG budget and acquired passive holdings remain the experiment baselines. Session 5's exit cooldown had already elapsed.

The new quote and entry both succeeded. Entry uses checkpoint source **11:59:46 UTC / 14:59:46 Vilnius**, with persistence completed at **12:00:25 UTC / 15:00:25 Vilnius**. The fresh range is **221850–221890**. Initial estimated entry gas is **0.501934 USDG** and exit reserve **0.338661 USDG**. Immediate NAV is **998.998414 USDG** after entry effects and the exit reserve; this is an entry mark, not a holding-period conclusion. The initial cumulative mark retains session 5's result and costs. Both sessions' source/transaction evidence revalidated, and the new boundary proof contains only the six intended fields.

[Continuous activation evidence](paper-narrow-evidence-2026-09-08/continuous-activation.json) records the source and runtime identities, linked budgets, quote/entry records, initial campaign marks, current health, and isolated lifecycle validation. Automatic successors after future valid cash exits are enabled; manual stop remains durable.
