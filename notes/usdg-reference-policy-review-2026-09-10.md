# USDG reference dependency: 10 September 2026

The recorded session #37 exit was triggered by the USDG price age crossing its exact 24-hour limit by four seconds. The next oracle round updated 22 seconds after the triggering checkpoint's block timestamp, still close to $1. This supports correcting freshness handling; it does not establish that USDG's market price is always exactly $1.

This review uses the frozen [paper performance source](../data/paper-performance-2026-09-10/source.json), fresh read-only queries of `risk_snapshot_runs`, and the current implementation. The initial review made no runtime or policy change. The subsequently approved heartbeat grace is described below.

## Why the dependency exists

Ordinary portfolio accounting is in USDG units. Counting USDG balances or measuring USDG-denominated P&L does not require an external USDG/USD price.

Two current operations do require a conversion convention:

- [The true-price guard](../src/paper/reference.ts) divides the multiplier-adjusted NVDA/USD answer by USDG/USD to obtain USDG per NVDA. The current acceptable pool deviation is +/-5%.
- [Paper execution gas valuation](../src/paper/executor.ts) converts ETH gas through ETH/USD and USDG/USD. It checks both feeds before entry, rebalance and exit simulations. Removing only the reference guard dependency would leave this dependency in place.

Assuming USDG/USD = 1 is mathematically valid as an explicitly declared model assumption. It makes the dollar valuation and converted gas cost approximate when USDG trades away from par. For example, an NVDA token worth $100 corresponds to 102.040816 USDG if USDG is worth $0.98. A fixed-$1 model would use 100 USDG instead. This does not alter actual pool swap quotes or token quantities.

Paxos describes USDG as redeemable one-for-one for US dollars in its [USDG overview](https://docs.paxos.com/guides/stablecoin/usdg). Redemption at par does not by itself establish the executable market price on our chain or our access to immediate redemption. Our own stored oracle answers below already differ slightly from $1.

## Exact session #37 evidence

Times below are UTC. Observation `1813`, checkpoint `3594`, and risk run `11430` identify the first exit signal. Its sole reason is `paper_usdg_oracle_price_stale`.

| Evidence | Value |
|---|---|
| USDG feed | `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2` |
| Directory heartbeat / effective paper limit | 86,400 seconds / 86,400 seconds |
| Triggering source block timestamp | 2026-09-09 15:31:57 |
| Previous oracle round | `18446744073709551712` |
| Previous round updatedAt | 2026-09-08 15:31:53 |
| Previous answer / decimals | `99982823` / 8 = $0.99982823 |
| Age at source block | 86,404 seconds |
| Signal processed | 2026-09-09 15:32:20.311 |
| Next oracle round | `18446744073709551713` |
| Next round updatedAt | 2026-09-09 15:32:19 |
| Next answer / decimals | `99985174` / 8 = $0.99985174 |
| Next snapshot | Risk run `11431`, source time 15:32:34 |
| Successful exit execution | Run `119`, source block `58656443`, processed 15:33:36.961 |

The next round's onchain timestamp precedes signal processing by about one second, but it was not in the recorded checkpoint/current-risk evidence used by that decision. This is a distinction between market/source time and processing time, not evidence that the worker had read and ignored the new round. The exit simulation used the refreshed USDG quote, then aged 37 seconds.

All structural oracle flags passed at the triggering snapshot. The stored general risk snapshot has a 300-second maximum age; the paper reference re-evaluates the same raw round under its own 86,400-second rule. The four-second excess is relative to that effective paper rule.

The observed successive round gaps from September 6 through September 9 were 86,430, 86,419 and 86,426 seconds. Prices in those four rounds ranged from $0.99982823 to $0.99993909. These observations show a repeated small overrun around the daily heartbeat. They do not measure unobserved intraround price movements or predict future outage duration.

[Chainlink's monitoring documentation](https://docs.chain.link/data-feeds#check-the-timestamp-of-the-latest-answer) explains that reaching the heartbeat initiates an update and that publication can be delayed. Using the heartbeat as an exact expiry therefore creates a predictable rejection window. Simply raising `maxGasPriceAgeSeconds` will not fix this: `evaluateOracleRisk` takes the minimum of that setting and the feed heartbeat.

Session #37's completed P&L was -0.056353 USDG, with 0.335744 in fees and 0.623191 in total entry/exit gas. These are observed session outcomes, not estimates of profit recoverable by preventing this exit. See the [performance audit](paper-performance-2026-09-10/README.md).

Recheck the two source records with:

```sql
SELECT id, block_timestamp, snapshot->'quoteOracle' AS quote_oracle
FROM risk_snapshot_runs
WHERE id IN (11430, 11431)
ORDER BY id;
```

## Initial alternative: fixed-$1 paper valuation (not adopted)

Use a declared `USDG = $1` convention for paper reference conversion and gas valuation, while retaining the USDG feed as a separate peg monitor. Report results in USDG; label any dollar equivalents and gas conversion as using that convention. Preserve raw ETH gas, actual swap results, observed oracle answers and historical accounting unchanged.

Separate feed delay from evidence of a material peg deviation. A briefly late USDG round should produce a monitoring warning rather than force an LP exit. A recorded material peg deviation must not disappear into a $1 fallback; new entries should pause and the peg condition should remain visible. A long monitoring outage needs an explicit bounded policy rather than an undocumented assertion that the peg is healthy.

Keep the NVDA reference, +/-5% band, ETH gas reference, token/multiplier protections and chain-source checks. A USDG peg event requires its own response: the existing exit sells NVDA into USDG, increasing USDG exposure, so it is not automatically a hedge against USDG losing value.

Before activation, implement the convention in both reference and gas paths, record it in policy/valuation evidence, and check the saved #37 decision plus stale, missing and off-peg quote cases. Apply the versioned policy at a session boundary. The running campaign and the ended four-strategy comparison are unchanged by this review.

## Approved change: 30-minute USDG heartbeat grace

The user chose increased stale-quote tolerance and authorized implementation. The continuous policy now opts into `referencePolicy.usdgHeartbeatGraceSeconds: 1800`. With the current 86,400-second USDG heartbeat and age cap, this accepts the observed quote through age 88,200 seconds inclusive. At 88,201 seconds the original stale-reference failure applies again. The normal exit simulation still requires an acceptable gas valuation; grace expiry is not a guarantee of immediately executable liquidation during an ongoing oracle outage.

The shared paper-only USDG evaluator is used by both reference conversion and execution gas valuation. It retains the actual observed price, timestamp, round and feed metadata. Original heartbeat freshness remains recorded; acceptance during grace is explicit under `freshness.basis = heartbeat_grace`, with a `paper_usdg_heartbeat_grace` warning. The reference decision records this as `usdgFreshness`; gas evidence retains it alongside the original quote. Warnings are separate from blocking reasons and do not trigger exits. No $1 substitution is made.

Grace applies only when age is the sole failed check. Missing or invalid answers, future/zero timestamps, incomplete rounds, decimal/description mismatches, and the +/-5% true-price band remain blocking. A configured age limit stricter than the feed heartbeat is not extended. General risk evaluation, ETH valuation, equity reference rules, chain readiness, inventory limits, widths and allocation are unchanged.

The optional field has no schema default: existing policies retain their hashes and old behavior. The new setting is applied only to a new linked session after a normal cash exit, conserving the campaign budget. The four-strategy comparison stays ended.

Verification covers the stored #37 reference decision, 86,400/86,401/88,200/88,201-second boundaries, refreshed-quote warning removal, malformed/missing/off-peg quotes, old policy hashes, actual-price gas conversion, and the ordinary position transition remaining open with a grace warning. The isolated PostgreSQL reference test exercises both checkpoint and current-risk selection through grace and expiry. The stored decision fixture is a regression case, not a replay claiming improved P&L.

The [boundary activation helper](../scripts/activate-paper-release.mjs) reads a reviewed deployment plan. While the specified parent is open it makes no changes. After that parent's ordinary cash exit, it pauses the paper timer, waits for the old invocation to finish, verifies the sealed release/configuration/unit and policy scope, then calls the ordinary `paper start --after` command. That command revalidates ancestry and carries the reconciled net cash into the new immutable session. The helper installs only the paper service unit, removes its temporary callback and resumes the timer. Manual stop or invalid history prevents continuation. A failed handoff restores the appropriate worker for whichever session was actually created.
