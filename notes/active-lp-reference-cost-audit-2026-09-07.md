# Historical reference and action-cost audit

The August 10–12 reference backfill and bounded receipt audit are complete. The five-minute freshness ceiling admits **zero of 2,877 minute observations** when applied to both NVDA and USDG. This is now a measured policy incompatibility in this window, rather than missing oracle history alone. The window is Monday–Tuesday; it does not establish weekend performance.

## Reference evidence

The full token/proxy/aggregator event scan found 25 NVDA and two USDG oracle publications. Every AnswerUpdated event was checked against the proxy's archived latestRoundData at its publication block. Round IDs are consecutive, proxy aggregator endpoints agree, and reconstructed terminal states match direct archive reads. References become available from publication block time, never an earlier updatedAt timestamp. Start/end and oracle-publication token-risk snapshots were also collected; they are not continuous issuer/sequencer attestation.

At five-minute maximum age, NVDA qualifies at 125 observations and USDG at ten; their qualifying intervals never overlap. The source metadata lists a 24-hour heartbeat for both feeds. Heartbeat metadata does not establish that a held price is suitable for a particular strategy.

The user's weekend/overnight focus warrants a separate feed- and session-aware policy experiment. Chainlink documents that Robinhood equity feeds may hold prices during closed sessions and lack off-hours heartbeats. Its separate oraclePaused flag can freeze prices during corporate actions; this must not be treated as ordinary market closure. [Chainlink Robinhood feed behavior](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood).

Admission-only sensitivities, with no performance fitting or live configuration changes:

| NVDA maximum age | USDG maximum age | Both feeds qualify |
|---|---|---:|
| 5 minutes | 5 minutes | 0 / 2,877 (0%) |
| 5 minutes | 24 hours | 125 / 2,877 (4.34%) |
| 30 minutes | 24 hours | 664 / 2,877 (23.08%) |
| 1 hour | 24 hours | 1,071 / 2,877 (37.23%) |
| 24 hours | 24 hours | 2,877 / 2,877 (100%) |

These counts do not choose an acceptable age or prove the ±5% pool/reference guard passes. In particular, a stale closing anchor can remain within 5% of pool price while both differ from current economic value. Longer age allowances need explicit closed-session status, original timestamps, expiry/reopening rules, and separate handling of current quote-token and issuer risk. A continuously trading independent fallback can provide additional evidence where its quality and token normalization are verified.

## Receipt evidence

Selected the first ten chronological transactions per NVDA pool and non-swap event class, deduplicated across pools: **70 transactions**. Exact historical receipt gas and effective gas price were matched to the frozen block/transaction identities. Full manager multicalls were decoded with bounded recursion; opaque external calls remain opaque.

The sample contains 49 external calls, 17 other known manager paths, and **four decrease-and-collect path candidates** (three fee-500, one fee-3000). None matches a simple decrease/collect/mint rebalance. There are indexed rebalance-like event bundles in this window, but event co-occurrence does not establish that their costs are comparable to our execution path.

The four removal candidates cost 6,312,340,584,000; 6,379,440,612,000; 5,987,099,228,000; and 5,941,031,560,000 wei for their entire observed transactions. These are observed native-token fees, not USDG cost estimates. Full-position removal, other pools touched, transaction shape, gas valuation and size comparability still require validation. No receipt fee is counted once per inner call.

## Artifacts and validation

- [Compact evidence summary and fingerprints](active-lp-research-2026-09-07/reference-cost-audit-summary.json)
- [Freshness sensitivity](active-lp-research-2026-09-07/freshness-sensitivity.json)
- Full inputs/results: `data/lp-reference-2026-09-07/reference-logs.json`, `reference-events.json`, `registry-source.json`, `backfill/references.json`, and `cost-audit/receipts.json`.
- Capture: `scripts/lp-reference-events.mjs`; archive verification: `scripts/lp-reference-backfill.mjs OUTPUT_DIRECTORY`; receipt audit: `scripts/lp-cost-audit.mjs OUTPUT_DIRECTORY`. Run with `.tools/node/bin/node --import tsx`; output paths must be new. Scripts use isolated historical providers and perform no live transactions or database writes.

The filtered reference-events file retains every oracle log and a full token-event census from reference-logs.json; it omits token transfer/approval rows to keep the verification input small. The original raw-file digest is included. The stored September mapping locates feeds; historical issuer registry attestation remains unavailable.

TypeScript and all **228 tests** pass, including publication-time causality, inclusive age/band boundaries, stale rereads, nested manager calls and rejection of partial collection or mismatched NFT IDs. All research outputs retain executionEligible=false. The portfolio ledger and net-profit replay remain unfinished; no live freshness limit was changed.
