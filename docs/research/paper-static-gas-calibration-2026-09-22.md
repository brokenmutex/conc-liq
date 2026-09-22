# Static/manual paper gas probe, AAPL/USDG

This is a development calibration probe for
`paper_static_manual_no_swap_v1`. It used a synthetic $250-equivalent paper
allocation, a 50 bps slippage limit, the configured AAPL/USDG profile and an
owned Anvil fork. It did not use the live operator wallet, sign or broadcast a
transaction, migrate a database, open a paper campaign, or register a
calibration profile. The full [evidence report](../../research/calibration/static-manual-aapl-usdg-fork-2026-09-22.json)
has report hash
`e78f373d7b4bf929ba5c6d0763e9d57e89b1937df09b5b2486568d947de38008`.

The source was confirmed Robinhood Chain block `69525309`, hash
`0xf07985a3fe92b6ac7f6e8a0ba0db8abbeb9bf733890982cd45e0d08c1325298c`.
The sampler verified the factory, pool, tokens, decimals and contract code at
that block; it required eligible independent references and a pool/reference
price band before building the candidate. A read-only pinned upstream proxy
served the fork. Local fixture token storage was derived from balance-getter
traces, then transferred to the paper account on Anvil. Every action was
simulated locally and against Nitro with the traced prestate. Local receipts
completed the six stages and the NFT closed with zero liquidity and owed tokens.

| Stage | Nitro estimated gas units |
| --- | ---: |
| Approve token 0 | 58,801 |
| Approve token 1 | 64,484 |
| Mint | 487,777 |
| Withdraw and collect | 273,537 |
| Cleanup token 0 allowance | 38,406 |
| Cleanup token 1 allowance | 47,065 |

These are exact-call fork estimates for one size, share, route and allowance
state. They are not paid gas, validation statistics, or generic AAPL stage
allowances. The report stores calldata, Nitro components, local receipt gas,
prestate overrides, source hashes, token funding proof and the paper candidate
identity. `test/paper-gas-evidence.test.ts` verifies internal consistency and
rejects a changed estimate even when the outer report hash is recomputed.

The modeled six-stage total excludes swaps, LP fee capture, execution delay,
failures and drift. A later paper adapter must use this exact route and stage
shape, or collect a new profile. The one-sample size/share/range band is exact; it
cannot support neighboring sizes, a confidence percentile or a validated
status. The probe itself did not populate `deployment_calibration_profiles`.
The registration command can import it within its 24-hour source window after
canonical replay and a matching verified profile/indexer target in an isolated
database. An isolated integration test imported and retried all six rows,
then discarded the test schema. No persistent calibration row was created;
the command API still reports costs unavailable for existing drafts.
The importer replays the source and candidate; it retains the sampler's fork
estimates as provisional evidence and does not independently rerun the fork.
A separate disposable-schema run verified the actual retained report against
the archive, registered six rows through the CLI, retried idempotently and
removed the schema.

`src/deployments-paper-gas-sample.ts` is the read-only development collector.
It requires a verified paper draft in an isolated migration-4 database, a
read-only archive URL, and Anvil. It writes a new JSON report with mode 0600.
The sampled source and reference proof must be fresh at collection time.
